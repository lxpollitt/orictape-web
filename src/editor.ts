/*
 * Oric BASIC Line Editor
 *
 * Tokenisation rules (from Oric-1/Atmos ROM disassembly analysis):
 *
 * 1. STRINGS: Between " pairs, everything is literal ASCII. No escape for "
 *    inside strings (use CHR$(34) at runtime). Unterminated strings extend to
 *    end of line.
 *
 * 2. REM / !: After these tokens, rest of line is literal ASCII (no tokenisation).
 *
 * 3. DATA: After DATA token, suppress tokenisation until : or end of line.
 *    Colon resets the flag and resumes tokenisation.
 *
 * 4. ? → PRINT: Single character shorthand, replaced with PRINT token.
 *
 * 5. Spaces, digits (0-9), semicolons (;), colons (:) pass through without
 *    keyword matching.
 *
 * 6. Keyword matching is greedy, left-to-right: try to match from current
 *    position. If no match, output the single character as ASCII and retry from
 *    the next character. Variable names containing keywords DO get tokenised
 *    (e.g. FORTUNE → FOR token + TUNE). This is correct Oric behaviour.
 *
 * 7. Characters >= 0x80 pass through as-is.
 *
 * 8. The keyword table is ordered so that the tokeniser scans sequentially.
 *    Tokens are assigned from 0x80 based on position in the table. The ROM
 *    tokeniser at $C5FA processes left-to-right in a single pass.
 *
 * Sources:
 *   - Oric Atmos ROM 1.1b Disassembly (Sandacite) — tokeniser at $C5FA
 *   - Microsoft BASIC for 6502 Original Source (CRUNCH routine)
 *   - Oric Advanced User Guide ROM Disassembly (Defence-Force)
 */

import { KEYWORDS } from './decoder';
import type { Program, ByteInfo, LineInfo } from './decoder';
import { flagNonMonotonicLines, flagElementErrors } from './decoder';

export interface ParsedLine {
  lineNum: number;
  bytes:   number[];   // line number (2 bytes LE) + content bytes (keyword tokens + ASCII) + null terminator
  hasDummyLineNumber: boolean;  // true if line number was not parsed from text (defaulted to 0)
}

export interface SyntaxIssue {
  byteOffset: number;  // offset within the line's bytes (relative to firstByte+2)
  message:    string;
}

/**
 * Check whether a decoded BASIC line's text re-tokenises to the same bytes.
 * Returns null if the bytes match, or a SyntaxIssue describing the first mismatch.
 *
 * @param lineText  The line's element text joined (e.g. "100 PRINT \"Hello\"")
 * @param originalBytes  The original bytes from firstByte+2 to lastByte (line number + content + null)
 */
export function checkLineSyntax(lineText: string, originalBytes: number[]): SyntaxIssue | null {
  const parsed = parseLine(lineText);
  if (!parsed) return { byteOffset: 0, message: 'Failed to parse line' };

  for (let i = 0; i < Math.max(parsed.bytes.length, originalBytes.length); i++) {
    if (parsed.bytes[i] !== originalBytes[i]) {
      const origHex = i < originalBytes.length ? `0x${originalBytes[i].toString(16).padStart(2, '0')}` : 'missing';
      const parsedHex = i < parsed.bytes.length ? `0x${parsed.bytes[i].toString(16).padStart(2, '0')}` : 'missing';
      return { byteOffset: i, message: `Tokenisation mismatch at byte ${i}: original ${origHex}, expected ${parsedHex}` };
    }
  }
  return null;
}

/**
 * Check all lines in a program for syntax issues (re-tokenisation mismatches).
 * Sets `syntaxError` flag on any line whose text doesn't round-trip to the same bytes.
 */
export function flagSyntaxErrors(prog: Program): void {
  for (const line of prog.lines) {
    const lineText = line.elements.join('');
    // Extract original bytes: line number (2 bytes) + content + null terminator.
    const originalBytes: number[] = [];
    for (let b = line.firstByte + 2; b <= line.lastByte; b++) {
      originalBytes.push(prog.bytes[b].v);
    }
    const issue = checkLineSyntax(lineText, originalBytes);
    if (issue) {
      line.syntaxError = true;
    }
  }
}

/**
 * TODO: development aid — comment out when not debugging editing.
 * Recalculate lenErr for all lines by comparing each line's next-line pointer
 * against where its content ends.
 */
function flagLenErrors(prog: Program): void {
  if (prog.lines.length === 0) return;
  // Converts a memory address to a byte index: byteIdx = memAddr + addrToByte.
  // Adjusted after each length error to account for gaps in the byte stream.
  let addrToByte = prog.lines[0].firstByte - prog.header.startAddr;

  for (let li = 0; li < prog.lines.length; li++) {
    const line = prog.lines[li];
    const ptr = prog.bytes[line.firstByte].v | (prog.bytes[line.firstByte + 1].v << 8);
    const nextLineBytePos = ptr + addrToByte;
    const errorAmount = nextLineBytePos - (line.lastByte + 1);
    line.lenErr = (errorAmount !== 0);
    if (errorAmount !== 0) addrToByte -= errorAmount;
  }
}

/**
 * Delete a BASIC line from a program.
 * Removes the line's bytes from prog.bytes, removes the LineInfo entry,
 * shifts subsequent line indices, recalculates next-line pointers, and
 * re-runs post-processing flags.
 */
export function deleteLineEdit(prog: Program, lineIdx: number): void {
  // Validate parameters.
  if (lineIdx < 0 || lineIdx >= prog.lines.length) {
    console.warn('deleteLineEdit: invalid lineIdx', lineIdx);
    return;
  }

  const line = prog.lines[lineIdx];
  const oldFirst = line.firstByte;
  const oldLast  = line.lastByte;
  const oldLen   = oldLast - oldFirst + 1;
  const delta = -oldLen;

  // Remove the bytes from the byte stream.
  prog.bytes.splice(oldFirst, oldLen);

  // Remove the line from the lines array.
  prog.lines.splice(lineIdx, 1);

  // Adjust subsequent lines' byte stream pointers and line info.
  // (The predecessor line's pointer doesn't need adjusting — the new next line
  // now starts at oldFirst, which is where the deleted line was.)
  adjustLineOffsets(prog, delta, lineIdx);

  // Re-run all post-processing flags.
  flagLenErrors(prog);  // TODO: development aid — comment out when not debugging editing.
  flagNonMonotonicLines(prog);
  flagSyntaxErrors(prog);
  flagElementErrors(prog);
}

/**
 * Apply an edit to a BASIC line in a program using LCS-based minimal diff.
 * Preserves original ByteInfo entries (with waveform references, error flags)
 * for bytes that didn't change. Only creates new edited ByteInfo entries for
 * bytes that actually differ.
 */
/** A single LCS match: newValues[newIdx] matched oldValues[oldIdx]. */
export type LcsMatch = { newIdx: number; oldIdx: number };

/**
 * Compute the Longest Common Subsequence between two byte arrays.
 * Returns matches in forward order (lowest indices first).
 * Pure function — no knowledge of Program, ByteInfo, or lines.
 */
export function computeLcs(newValues: number[], oldValues: number[]): LcsMatch[] {
  const n = oldValues.length;
  const m = newValues.length;
  const dp: Uint16Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint16Array(m + 1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = oldValues[i - 1] === newValues[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to collect matches in reverse, then reverse.
  const matches: LcsMatch[] = [];
  let oi = n, ni = m;
  while (oi > 0 && ni > 0) {
    if (oldValues[oi - 1] === newValues[ni - 1]) {
      matches.push({ newIdx: ni - 1, oldIdx: oi - 1 });
      oi--; ni--;
    } else if (dp[oi][ni - 1] >= dp[oi - 1][ni]) {
      ni--;
    } else {
      oi--;
    }
  }
  matches.reverse();
  return matches;
}

/**
 * Replace a range of bytes in the byte stream with merged bytes.
 * Returns the delta (new length minus old length) so the caller
 * can adjust line indices as needed.
 */
function spliceMergedBytes(
  byteStream: ByteInfo[],
  replaceStart: number,
  replaceEnd: number,
  merged: ByteInfo[],
): number {
  const oldCount = replaceEnd - replaceStart + 1;
  byteStream.splice(replaceStart, oldCount, ...merged);
  return merged.length - oldCount;
}

/**
 * Adjust a range of lines' byte stream pointers and line info by a delta.
 * For each line: offsets the next-line pointer value in the byte stream,
 * then shifts firstByte/lastByte/expectedLastByte.
 */
function adjustLineOffsets(prog: Program, delta: number, firstLineIdx: number, lastLineIdx?: number): void {
  if (delta === 0) return;
  const last = lastLineIdx ?? prog.lines.length - 1;
  for (let li = firstLineIdx; li <= last; li++) {
    const l = prog.lines[li];
    // Offset existing pointer values in the byte stream by delta.
    // Note: line info not yet updated, so use l.firstByte + delta to find the bytes post-splice.
    const oldPtr = prog.bytes[l.firstByte + delta].v | (prog.bytes[l.firstByte + delta + 1].v << 8);
    const newPtr = oldPtr + delta;
    prog.bytes[l.firstByte + delta].v     = newPtr & 0xFF;
    prog.bytes[l.firstByte + delta + 1].v = (newPtr >> 8) & 0xFF;
    // Update line info.
    l.firstByte += delta;
    l.lastByte  += delta;
    l.expectedLastByte += delta;
  }
}

/**
 * Build a merged ByteInfo array from new byte values and LCS matches.
 * For matched positions, preserves the original ByteInfo; for unmatched
 * positions, creates fresh edited ByteInfo entries.
 *
 * The filter (newIdxFirst/newIdxLast) selects which portion of the
 * matches and newValues to process.
 */
function buildMergedBytes(
  newValues: number[],
  oldBytes: ByteInfo[],
  matches: LcsMatch[],
  newIdxFirst: number,
  newIdxLast: number,
): ByteInfo[] {
  const result: ByteInfo[] = [];
  let matchIdx = 0;
  // Advance past matches before our range.
  while (matchIdx < matches.length && matches[matchIdx].newIdx < newIdxFirst) matchIdx++;
  for (let ni = newIdxFirst; ni <= newIdxLast; ni++) {
    if (matchIdx < matches.length && matches[matchIdx].newIdx === ni) {
      // Match — preserve original ByteInfo.
      result.push(oldBytes[matches[matchIdx].oldIdx]);
      matchIdx++;
    } else {
      // No match — create edited byte.
      result.push({
        v: newValues[ni],
        firstBit: 0, lastBit: 0,
        unclear: false, chkErr: false,
        edited: true,
      });
    }
  }
  return result;
}

export function applyLineEdit(prog: Program, lineIdx: number, text: string): void {
  // Validate parameters.
  if (lineIdx < 0 || lineIdx >= prog.lines.length) {
    console.warn('applyLineEdit: invalid lineIdx', lineIdx);
    return;
  }
  const parsed = parseLine(text) || parseLine('0 ' + text);
  if (!parsed) {
    console.warn('applyLineEdit: failed to parse text', text);
    return;
  }
  const line = prog.lines[lineIdx];
  const oldFirst = line.firstByte;
  const oldLast  = line.lastByte;

  // --- Compute the merged bytes for the edited line ---

  // Extract old byte values and ByteInfo (skipping the 2-byte pointer).
  const oldValues: number[] = [];
  for (let i = oldFirst + 2; i <= oldLast; i++) oldValues.push(prog.bytes[i].v);
  const oldBytes = prog.bytes.slice(oldFirst + 2, oldLast + 1);

  // LCS between new content bytes and old content bytes.
  const newValues = parsed.bytes;
  const matches = computeLcs(newValues, oldValues);
  const mergedContent = buildMergedBytes(newValues, oldBytes, matches, 0, newValues.length - 1);

  // Build the next-line pointer for the edited line.
  // Calculate based on where the next line will be after the splice:
  // this line's start + 2 (pointer bytes) + merged content length.
  let ptrValue: number;
  if (lineIdx < prog.lines.length - 1) {
    const startAddr = prog.header.startAddr;
    const firstLineOffset = prog.lines[0].firstByte;
    ptrValue = startAddr + (oldFirst + 2 + mergedContent.length - firstLineOffset);
  } else {
    ptrValue = 0x0000;
  }

  // Assemble full line: pointer (2 bytes) + merged content.
  const mergedLine: ByteInfo[] = [
    { ...prog.bytes[oldFirst],     edited: undefined, v: ptrValue & 0xFF },
    { ...prog.bytes[oldFirst + 1], edited: undefined, v: (ptrValue >> 8) & 0xFF },
    ...mergedContent,
  ];

  // --- Splice edited line into the byte stream and update its line info ---

  const delta = spliceMergedBytes(prog.bytes, oldFirst, oldLast, mergedLine);
  line.lastByte = oldFirst + mergedLine.length - 1;
  line.expectedLastByte = line.lastByte;
  line.lenErr = false;

  // Update the edited line's elements and line number from the parsed data.
  const elements: string[] = [];
  elements.push(`${parsed.lineNum} `);
  for (let i = 2; i < newValues.length - 1; i++) {
    const b = newValues[i];
    if (b < 128) {
      elements.push(String.fromCharCode(b));
    } else if ((b - 128) < KEYWORDS.length) {
      elements.push(KEYWORDS[b - 128]);
    } else {
      elements.push('[UNKNOWN_KEYWORD]');
    }
  }
  line.v = elements.join('');
  line.elements = elements;

  // --- Adjust subsequent lines: byte stream pointers then line info ---

  adjustLineOffsets(prog, delta, lineIdx + 1);

  // Re-run all post-processing flags.
  flagLenErrors(prog);  // TODO: development aid — comment out when not debugging editing.
  flagNonMonotonicLines(prog);
  flagSyntaxErrors(prog);
  flagElementErrors(prog);
}

/**
 * Split a BASIC line into two at a text boundary.
 * Tokenises both halves, uses LCS against the original bytes to
 * optimally partition them, then splices both lines into the byte stream.
 *
 * Returns the index of the newly created second line, or null on failure.
 */
export function splitLineWithEdits(
  prog: Program,
  lineIdx: number,
  firstText: string,
  secondText: string,
): number | null {
  // Validate parameters.
  if (lineIdx < 0 || lineIdx >= prog.lines.length) {
    console.warn('splitLineWithEdits: invalid lineIdx', lineIdx);
    return null;
  }

  // Parse both halves.
  const parsedFirst = parseLine(firstText) || parseLine('0 ' + firstText);
  if (!parsedFirst) {
    console.warn('splitLineWithEdits: failed to parse firstText', firstText);
    return null;
  }
  // If cursor was at the start (firstText empty), the second part is the whole line —
  // try parsing with a line number first to match original line number bytes.
  // Otherwise, the second part is mid-line content with no line number expected.
  const parsedSecond = firstText === ''
    ? (parseLine(secondText) || parseLine(secondText, true))
    : parseLine(secondText, true);
  if (!parsedSecond) {
    console.warn('splitLineWithEdits: failed to parse secondText', secondText);
    return null;
  }

  // Concatenate the two halves' content bytes (excluding pointers) for a single LCS.
  // Exclude dummy line number bytes from the concatenation so they can't steal LCS matches.
  const firstForLcs = parsedFirst.hasDummyLineNumber ? parsedFirst.bytes.slice(2) : parsedFirst.bytes;
  const secondForLcs = parsedSecond.hasDummyLineNumber ? parsedSecond.bytes.slice(2) : parsedSecond.bytes;
  const concatenated = [...firstForLcs, ...secondForLcs];
  const splitPoint = firstForLcs.length;   // index where second half starts in concatenated

  // Extract old line byte values (skipping the 2-byte pointer).
  const line = prog.lines[lineIdx];
  const oldFirst = line.firstByte;
  const oldLast = line.lastByte;
  const oldValues: number[] = [];
  for (let i = oldFirst + 2; i <= oldLast; i++) oldValues.push(prog.bytes[i].v);

  // LCS across the full concatenation against the original bytes.
  const matches = computeLcs(concatenated, oldValues);

  // Debug: log the LCS results for verification.
  const hex = (arr: number[]) => arr.map(b => '0x' + b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  console.log('splitLineWithEdits LCS:', {
    firstText,
    secondText,
    firstForLcs: hex(firstForLcs),
    secondForLcs: hex(secondForLcs),
    oldValues: hex(oldValues),
    splitPoint,
    matches,
    matchesInFirst: matches.filter(m => m.newIdx < splitPoint).length
      + ' — ' + hex(matches.filter(m => m.newIdx < splitPoint).map(m => concatenated[m.newIdx])),
    matchesInSecond: matches.filter(m => m.newIdx >= splitPoint).length
      + ' — ' + hex(matches.filter(m => m.newIdx >= splitPoint).map(m => concatenated[m.newIdx])),
  });

  // Build merged ByteInfo arrays for each half.
  const oldBytes = prog.bytes.slice(oldFirst + 2, oldLast + 1);
  const firstMerged = buildMergedBytes(concatenated, oldBytes, matches, 0, splitPoint - 1);
  const secondMerged = buildMergedBytes(concatenated, oldBytes, matches, splitPoint, concatenated.length - 1);

  // Prepend dummy line number bytes for halves that didn't have a parsed line number.
  const makeDummyLineNum = (): ByteInfo[] => [
    { v: 0x00, firstBit: 0, lastBit: 0, unclear: false, chkErr: false, edited: true },
    { v: 0x00, firstBit: 0, lastBit: 0, unclear: false, chkErr: false, edited: true },
  ];
  const firstContent = parsedFirst.hasDummyLineNumber ? [...makeDummyLineNum(), ...firstMerged] : firstMerged;
  const secondContent = parsedSecond.hasDummyLineNumber ? [...makeDummyLineNum(), ...secondMerged] : secondMerged;

  // Debug: log the merged results for verification.
  const hexBI = (arr: ByteInfo[]) => arr.map(b => (b.edited ? '*' : '') + '0x' + b.v.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  console.log('splitLineWithEdits merged:', {
    firstContent: hexBI(firstContent),
    secondContent: hexBI(secondContent),
  });

  // --- Assemble full bytes for both lines and splice ---

  const startAddr = prog.header.startAddr;
  const firstLineOffset = prog.lines[0].firstByte;

  // First line's pointer: points to where the second new line will start.
  // That's oldFirst + 2 (ptr1) + firstContent.length (which already includes line number bytes).
  const ptr1Value = startAddr + (oldFirst + 2 + firstContent.length - firstLineOffset);

  // Second line's pointer: points to where the line after both new lines will start.
  // That's oldFirst + 2 (ptr1) + firstContent + 2 (ptr2) + secondContent.
  let ptr2Value: number;
  if (lineIdx < prog.lines.length - 1) {
    ptr2Value = startAddr + (oldFirst + 2 + firstContent.length + 2 + secondContent.length - firstLineOffset);
  } else {
    ptr2Value = 0x0000;
  }

  // Build pointer ByteInfo entries (fresh objects, not shared).
  const makePtr = (v: number): ByteInfo[] => [
    { ...prog.bytes[oldFirst],     edited: undefined, v: v & 0xFF },
    { ...prog.bytes[oldFirst + 1], edited: undefined, v: (v >> 8) & 0xFF },
  ];

  const fullMerged: ByteInfo[] = [
    ...makePtr(ptr1Value),
    ...firstContent,
    ...makePtr(ptr2Value),
    ...secondContent,
  ];

  // Single splice replaces the original line's bytes with both new lines.
  const delta = spliceMergedBytes(prog.bytes, oldFirst, oldLast, fullMerged);

  // --- Update the first (edited) line's info ---

  const firstLineEnd = oldFirst + 2 + firstContent.length - 1;
  line.lastByte = firstLineEnd;
  line.expectedLastByte = firstLineEnd;
  line.lenErr = false;

  // Build elements for the first line.
  const firstElements: string[] = [];
  firstElements.push(`${parsedFirst.lineNum} `);
  for (let i = 2; i < parsedFirst.bytes.length - 1; i++) {
    const b = parsedFirst.bytes[i];
    if (b < 128) {
      firstElements.push(String.fromCharCode(b));
    } else if ((b - 128) < KEYWORDS.length) {
      firstElements.push(KEYWORDS[b - 128]);
    } else {
      firstElements.push('[UNKNOWN_KEYWORD]');
    }
  }
  line.v = firstElements.join('');
  line.elements = firstElements;

  // --- Create the second line's LineInfo and insert it ---

  const secondLineFirstByte = firstLineEnd + 1;  // starts right after first line
  const secondLineLastByte = secondLineFirstByte + 2 + secondContent.length - 1;

  const secondElements: string[] = [];
  secondElements.push(`${parsedSecond.lineNum} `);
  for (let i = 2; i < parsedSecond.bytes.length - 1; i++) {
    const b = parsedSecond.bytes[i];
    if (b < 128) {
      secondElements.push(String.fromCharCode(b));
    } else if ((b - 128) < KEYWORDS.length) {
      secondElements.push(KEYWORDS[b - 128]);
    } else {
      secondElements.push('[UNKNOWN_KEYWORD]');
    }
  }

  const newLine: LineInfo = {
    v: secondElements.join(''),
    elements: secondElements,
    firstByte: secondLineFirstByte,
    lastByte: secondLineLastByte,
    expectedLastByte: secondLineLastByte,
    lenErr: false,
    memAddr: 0,
  };
  prog.lines.splice(lineIdx + 1, 0, newLine);

  // --- Adjust subsequent lines (after the two new lines) ---

  adjustLineOffsets(prog, delta, lineIdx + 2);

  // Re-run all post-processing flags.
  flagLenErrors(prog);  // TODO: development aid — comment out when not debugging editing.
  flagNonMonotonicLines(prog);
  flagSyntaxErrors(prog);
  flagElementErrors(prog);

  return lineIdx + 1;
}

/**
 * Join two adjacent BASIC lines into one.
 * Concatenates their text, tokenises the result, uses LCS against both
 * lines' original bytes to optimally preserve them, then splices the
 * merged line into the byte stream.
 *
 * @param lineIdx    The line currently being edited (or the anchor line for a non-edit join)
 * @param editedText Current textarea content for the edited line. If omitted, uses the line's saved text.
 * @param direction  -1 = join with previous line, 1 = join with next line
 * @returns          Cursor position (character offset) at the join point, or null on failure
 */
export function joinLinesWithEdit(
  prog: Program,
  lineIdx: number,
  editedText: string | undefined,
  direction: -1 | 1,
): number | null {
  // Validate parameters.
  if (lineIdx < 0 || lineIdx >= prog.lines.length) {
    console.warn('joinLinesWithEdit: invalid lineIdx', lineIdx);
    return null;
  }
  if (editedText === undefined) editedText = prog.lines[lineIdx].elements.join('');
  const neighbourIdx = lineIdx + direction;
  if (neighbourIdx < 0 || neighbourIdx >= prog.lines.length) {
    console.warn('joinLinesWithEdit: no neighbour line at', neighbourIdx);
    return null;
  }

  // Determine the combined text and join point.
  const neighbourLine = prog.lines[neighbourIdx];
  const neighbourText = neighbourLine.elements.join('');
  let combinedText: string;
  let joinPoint: number;
  if (direction === -1) {
    // Backspace: neighbour text comes first.
    combinedText = neighbourText + editedText;
    joinPoint = neighbourText.length;
  } else {
    // Delete: edited text comes first.
    combinedText = editedText + neighbourText;
    joinPoint = editedText.length;
  }

  // Parse the combined text.
  const parsed = parseLine(combinedText) || parseLine('0 ' + combinedText);
  if (!parsed) {
    console.warn('joinLinesWithEdit: failed to parse combined text', combinedText);
    return null;
  }

  // First line keeps the merged result; second line will be removed.
  // (The first line in the stream is always the survivor.)
  const firstIdx = Math.min(lineIdx, neighbourIdx);
  const secondIdx = Math.max(lineIdx, neighbourIdx);
  const first = prog.lines[firstIdx];
  const second = prog.lines[secondIdx];

  const oldBytes: ByteInfo[] = [
    ...prog.bytes.slice(first.firstByte + 2, first.lastByte + 1),
    ...prog.bytes.slice(second.firstByte, second.lastByte + 1),
  ];
  const oldValues = oldBytes.map(b => b.v);

  // LCS between tokenised combined text and the concatenated original bytes.
  const newValues = parsed.bytes;
  const matches = computeLcs(newValues, oldValues);
  const mergedContent = buildMergedBytes(newValues, oldBytes, matches, 0, newValues.length - 1);

  // Build the next-line pointer for the merged line.
  // Calculate based on where the next line will be after the splice:
  // this line's start + 2 (pointer bytes) + merged content length.
  let ptrValue: number;
  const afterIdx = secondIdx + 1;
  if (afterIdx < prog.lines.length) {
    const startAddr = prog.header.startAddr;
    const firstLineOffset = prog.lines[0].firstByte;
    ptrValue = startAddr + (first.firstByte + 2 + mergedContent.length - firstLineOffset);
  } else {
    ptrValue = 0x0000;
  }

  // Assemble full line: pointer (2 bytes) + merged content.
  const mergedLine: ByteInfo[] = [
    { ...prog.bytes[first.firstByte],     edited: undefined, v: ptrValue & 0xFF },
    { ...prog.bytes[first.firstByte + 1], edited: undefined, v: (ptrValue >> 8) & 0xFF },
    ...mergedContent,
  ];

  // Splice: replace both lines' byte ranges with the single merged line.
  const spliceEnd = second.lastByte;
  const delta = spliceMergedBytes(prog.bytes, first.firstByte, spliceEnd, mergedLine);

  // Update the first (surviving) line's info.
  first.firstByte = first.firstByte;
  first.lastByte = first.firstByte + mergedLine.length - 1;
  first.expectedLastByte = first.lastByte;
  first.lenErr = false;

  // Build elements for the merged line.
  const elements: string[] = [];
  elements.push(`${parsed.lineNum} `);
  for (let i = 2; i < newValues.length - 1; i++) {
    const b = newValues[i];
    if (b < 128) {
      elements.push(String.fromCharCode(b));
    } else if ((b - 128) < KEYWORDS.length) {
      elements.push(KEYWORDS[b - 128]);
    } else {
      elements.push('[UNKNOWN_KEYWORD]');
    }
  }
  first.v = elements.join('');
  first.elements = elements;

  // Remove the second (deleted) line from prog.lines.
  prog.lines.splice(secondIdx, 1);

  // Adjust subsequent lines (from secondIdx onwards, since second was removed).
  adjustLineOffsets(prog, delta, secondIdx);

  // Re-run all post-processing flags.
  flagLenErrors(prog);  // TODO: development aid — comment out when not debugging editing.
  flagNonMonotonicLines(prog);
  flagSyntaxErrors(prog);
  flagElementErrors(prog);

  return joinPoint;
}

/**
 * Parse a BASIC line from user text into a line number and tokenised byte array.
 *
 * Input format: "100 PRINT \"Hello\"" — line number, space, then content.
 * Returns null if the line number is missing or invalid.
 *
 * If originalBytes is provided, compares the parsed output against the original
 * and logs the result to the console (for testing during development).
 */
export function parseLine(text: string, noLineNumber?: boolean, originalBytes?: number[]): ParsedLine | null {
  let lineNum: number;
  let content: string;

  if (noLineNumber) {
    // Tokenise the entire text as content, no line number expected.
    lineNum = 0;
    content = text;
  } else {
    // Extract line number from the start.
    const match = text.match(/^(\d+)\s?/);
    if (!match) return null;
    lineNum = parseInt(match[1], 10);
    if (isNaN(lineNum) || lineNum < 0 || lineNum > 65535) return null;
    content = text.slice(match[0].length);
  }

  const contentBytes = tokenise(content);

  // Build full line bytes: line number (2 bytes LE) + content + null terminator.
  const bytes = [
    lineNum & 0xFF,
    (lineNum >> 8) & 0xFF,
    ...contentBytes,
    0x00,
  ];

  // Debug comparison against original bytes (if provided).
  if (originalBytes) {
    const hex = (arr: number[]) => arr.map(b => b.toString(16).padStart(2, '0')).join(' ');
    if (bytes.length === originalBytes.length && bytes.every((b, i) => b === originalBytes[i])) {
      console.log(`%c✓ Line ${lineNum}: bytes match (${bytes.length} bytes)`, 'color: #4ec94e');
    } else {
      console.log(`%c✗ Line ${lineNum}: bytes differ`, 'color: #c94040');
      console.log(`  original: ${hex(originalBytes)}`);
      console.log(`  parsed:   ${hex(bytes)}`);
      // Find first difference.
      for (let i = 0; i < Math.max(bytes.length, originalBytes.length); i++) {
        if (bytes[i] !== originalBytes[i]) {
          console.log(`  first diff at index ${i}: original=0x${(originalBytes[i] ?? -1).toString(16)} parsed=0x${(bytes[i] ?? -1).toString(16)}`);
          break;
        }
      }
    }
  }

  return { lineNum, bytes, hasDummyLineNumber: !!noLineNumber };
}

/**
 * Tokenise a BASIC line's content (everything after the line number).
 * Returns an array of bytes: keyword tokens (0x80+) and ASCII characters.
 */
function tokenise(content: string): number[] {
  const bytes: number[] = [];
  let i = 0;
  let inString = false;
  let afterRem  = false;
  let inData    = false;

  while (i < content.length) {
    const ch = content[i];
    const code = ch.charCodeAt(0);

    // After REM or !, everything is literal to end of line.
    if (afterRem) {
      bytes.push(code);
      i++;
      continue;
    }

    // Inside a string literal — copy verbatim until closing quote or end of line.
    if (inString) {
      bytes.push(code);
      if (ch === '"') inString = false;
      i++;
      continue;
    }

    // Opening quote — start string literal.
    if (ch === '"') {
      inString = true;
      bytes.push(code);
      i++;
      continue;
    }

    // Colon resets DATA suppression and is output as-is.
    if (ch === ':') {
      inData = false;
      bytes.push(code);
      i++;
      continue;
    }

    // Inside DATA — suppress tokenisation until : or end of line.
    if (inData) {
      bytes.push(code);
      i++;
      continue;
    }

    // ? is shorthand for PRINT.
    if (ch === '?') {
      const printIdx = KEYWORDS.indexOf('PRINT');
      bytes.push(printIdx + 0x80);
      i++;
      continue;
    }

    // Spaces, digits, semicolons pass through without keyword matching.
    if (ch === ' ' || (code >= 0x30 && code <= 0x39) || ch === ';') {
      bytes.push(code);
      i++;
      continue;
    }

    // Characters >= 0x80 pass through as-is.
    if (code >= 0x80) {
      bytes.push(code);
      i++;
      continue;
    }

    // Try to match a keyword at the current position (greedy, longest match).
    let matched = false;
    for (let ki = 0; ki < KEYWORDS.length; ki++) {
      const kw = KEYWORDS[ki];
      if (content.startsWith(kw, i)) {
        const token = ki + 0x80;
        bytes.push(token);
        i += kw.length;
        matched = true;

        // Check if this keyword suppresses further tokenisation.
        if (kw === 'REM' || kw === '!') afterRem = true;
        if (kw === 'DATA') inData = true;

        break;
      }
    }

    if (!matched) {
      // No keyword match — output the character as ASCII and advance.
      bytes.push(code);
      i++;
    }
  }

  return bytes;
}
