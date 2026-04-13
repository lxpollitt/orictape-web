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
import type { Program, ByteInfo } from './decoder';
import { flagNonMonotonicLines, flagElementErrors } from './decoder';

export interface ParsedLine {
  lineNum: number;
  bytes:   number[];   // line number (2 bytes LE) + content bytes (keyword tokens + ASCII) + null terminator
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
 * Delete a BASIC line from a program.
 * Removes the line's bytes from prog.bytes, removes the LineInfo entry,
 * shifts subsequent line indices, recalculates next-line pointers, and
 * re-runs post-processing flags.
 */
export function deleteLineEdit(prog: Program, lineIdx: number): void {
  const line = prog.lines[lineIdx];
  const oldFirst = line.firstByte;
  const oldLast  = line.lastByte;
  const oldLen   = oldLast - oldFirst + 1;

  // Remove the bytes from the byte stream.
  prog.bytes.splice(oldFirst, oldLen);

  // Remove the line from the lines array.
  prog.lines.splice(lineIdx, 1);

  // Shift all subsequent lines' byte indices.
  for (let li = lineIdx; li < prog.lines.length; li++) {
    prog.lines[li].firstByte -= oldLen;
    prog.lines[li].lastByte  -= oldLen;
    prog.lines[li].expectedLastByte -= oldLen;
  }

  // Recalculate next-line pointers throughout the program.
  const startAddr = prog.header.startAddr;
  const firstLineOffset = prog.lines.length > 0 ? prog.lines[0].firstByte : 0;

  for (let li = 0; li < prog.lines.length; li++) {
    const l = prog.lines[li];
    let ptrValue: number;
    if (li < prog.lines.length - 1) {
      const nextLineByteOffset = prog.lines[li + 1].firstByte - firstLineOffset;
      ptrValue = startAddr + nextLineByteOffset;
    } else {
      ptrValue = 0x0000;
    }
    prog.bytes[l.firstByte].v     = ptrValue & 0xFF;
    prog.bytes[l.firstByte + 1].v = (ptrValue >> 8) & 0xFF;
  }

  // Re-run all post-processing flags.
  flagNonMonotonicLines(prog);
  flagSyntaxErrors(prog);
  flagElementErrors(prog);
}

/**
 * Result of applyLineEdit when keepTrailingBytes is true and there are
 * meaningful trailing bytes from the original line.
 */
export interface SplitResult {
  /** Byte index in prog.bytes where the trailing content starts
   *  (immediately after the saved first-half line). */
  trailingStart: number;
  /** Number of trailing content bytes (original bytes preserved in place). */
  trailingCount: number;
}

/**
 * Apply an edit to a BASIC line in a program using LCS-based minimal diff.
 * Preserves original ByteInfo entries (with waveform references, error flags)
 * for bytes that didn't change. Only creates new edited ByteInfo entries for
 * bytes that actually differ.
 *
 * @param prog     The program to modify (mutated in place)
 * @param lineIdx  Index into prog.lines of the line being edited
 * @param parsed   The parsed line from parseLine()
 * @param keepTrailingBytes  If true, don't delete trailing unmatched original bytes.
 *                           Used for line splitting — returns info about the trailing bytes.
 * @returns  SplitResult if keepTrailingBytes and there are meaningful trailing bytes, else null.
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

export function applyLineEdit(prog: Program, lineIdx: number, parsed: ParsedLine, keepTrailingBytes = false): SplitResult | null {
  const line = prog.lines[lineIdx];
  const oldFirst = line.firstByte;
  const oldLast  = line.lastByte;

  // Extract old byte values (skipping the 2-byte pointer — we always recalculate it).
  const oldValues: number[] = [];
  for (let i = oldFirst + 2; i <= oldLast; i++) oldValues.push(prog.bytes[i].v);

  // New content bytes: lineNum(2) + content + 0x00.
  // When keepTrailingBytes, strip the terminator from new bytes before LCS
  // so it doesn't anchor to the original's terminator.
  const fullNewContent = parsed.bytes;
  const newValues = keepTrailingBytes
    ? fullNewContent.slice(0, -1)  // strip trailing 0x00
    : fullNewContent;

  // LCS on the content bytes (excluding pointer) to find minimal diff.
  const matches = computeLcs(newValues, oldValues);

  // Build merged byte array from the LCS matches.
  const mergedContent: ByteInfo[] = [];
  const matchedOldIndices: number[] = [];
  let matchIdx = 0;
  for (let ni = 0; ni < newValues.length; ni++) {
    if (matchIdx < matches.length && matches[matchIdx].newIdx === ni) {
      // Match — preserve original ByteInfo.
      const oi = matches[matchIdx].oldIdx;
      mergedContent.push(prog.bytes[oldFirst + 2 + oi]);
      matchedOldIndices.push(oi);
      matchIdx++;
    } else {
      // No match — create edited byte.
      mergedContent.push({
        v: newValues[ni],
        firstBit: 0, lastBit: 0,
        unclear: false, chkErr: false,
        edited: true,
      });
    }
  }

  // Determine truly trailing bytes: old bytes after the last LCS-matched position.
  // These are the bytes that belong to the second half of a split.
  let splitResult: SplitResult | null = null;
  if (keepTrailingBytes) {
    const lastMatchedOldIdx = matchedOldIndices.length > 0
      ? matchedOldIndices[matchedOldIndices.length - 1]
      : -1;
    const trailingStartIdx = lastMatchedOldIdx + 1;  // relative to oldFirst+2
    const trailingCount = oldValues.length - trailingStartIdx;

    if (trailingCount > 0) {
      const trailingAbsStart = oldFirst + 2 + trailingStartIdx;
      // Meaningful trailing = more than 1 byte, or 1 byte that isn't 0x00.
      const hasContent = trailingCount > 1
        || prog.bytes[trailingAbsStart].v !== 0x00;
      if (hasContent) {
        // Add an edited 0x00 terminator to the first half.
        mergedContent.push({
          v: 0x00, firstBit: 0, lastBit: 0,
          unclear: false, chkErr: false, edited: true,
        });
      } else {
        // Trailing is just the original terminator — include it in the merge.
        mergedContent.push(prog.bytes[trailingAbsStart]);
      }
    }
  }

  // Build the full merged line: pointer (2 bytes, preserved from original) + merged content.
  const mergedLine: ByteInfo[] = [
    { ...prog.bytes[oldFirst],     edited: undefined },  // pointer byte 0
    { ...prog.bytes[oldFirst + 1], edited: undefined },  // pointer byte 1
    ...mergedContent,
  ];

  // How many old bytes to replace: for a split with trailing bytes, don't consume them.
  let oldBytesToReplace = oldLast - oldFirst + 1;  // default: whole line
  if (keepTrailingBytes) {
    const lastMatchedOldIdx = matchedOldIndices.length > 0
      ? matchedOldIndices[matchedOldIndices.length - 1]
      : -1;
    const trailingStartIdx = lastMatchedOldIdx + 1;
    const trailingCount = oldValues.length - trailingStartIdx;
    const trailingAbsStart = oldFirst + 2 + trailingStartIdx;
    const hasContent = trailingCount > 0
      && (trailingCount > 1 || prog.bytes[trailingAbsStart].v !== 0x00);
    if (hasContent) {
      oldBytesToReplace = trailingAbsStart - oldFirst;  // up to but not including trailing bytes
    }
  }

  // Splice the merged line into prog.bytes.
  prog.bytes.splice(oldFirst, oldBytesToReplace, ...mergedLine);

  const delta = mergedLine.length - oldBytesToReplace;

  // Shift all subsequent lines' byte indices by delta.
  for (let li = lineIdx + 1; li < prog.lines.length; li++) {
    prog.lines[li].firstByte += delta;
    prog.lines[li].lastByte  += delta;
    prog.lines[li].expectedLastByte += delta;
  }

  // Update the edited line's byte range.
  line.lastByte = oldFirst + mergedLine.length - 1;
  line.expectedLastByte = line.lastByte;
  line.lenErr = false;

  // Compute split result if applicable.
  if (keepTrailingBytes) {
    const lastMatchedOldIdx2 = matchedOldIndices.length > 0
      ? matchedOldIndices[matchedOldIndices.length - 1]
      : -1;
    const trailingCount2 = oldValues.length - (lastMatchedOldIdx2 + 1);
    if (trailingCount2 > 0) {
      const trailingAbsStart2 = line.lastByte + 1;
      const hasContent2 = trailingCount2 > 1
        || prog.bytes[trailingAbsStart2]?.v !== 0x00;
      if (hasContent2) {
        splitResult = {
          trailingStart: trailingAbsStart2,
          trailingCount: trailingCount2,
        };
      }
    }
  }

  // Recalculate next-line pointers throughout the program.
  const startAddr = prog.header.startAddr;
  const firstLineOffset = prog.lines[0].firstByte;

  for (let li = 0; li < prog.lines.length; li++) {
    const l = prog.lines[li];
    let ptrValue: number;
    if (li < prog.lines.length - 1) {
      const nextLineByteOffset = prog.lines[li + 1].firstByte - firstLineOffset;
      ptrValue = startAddr + nextLineByteOffset;
    } else {
      ptrValue = 0x0000;
    }
    prog.bytes[l.firstByte].v     = ptrValue & 0xFF;
    prog.bytes[l.firstByte + 1].v = (ptrValue >> 8) & 0xFF;
  }

  // Update the edited line's elements and line number from the parsed data.
  const elements: string[] = [];
  const lineNumStr = `${parsed.lineNum} `;
  elements.push(lineNumStr);
  // Walk content bytes — use fullNewContent (with terminator) for element building.
  for (let i = 2; i < fullNewContent.length - 1; i++) {
    const b = fullNewContent[i];
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

  // Re-run all post-processing flags.
  flagNonMonotonicLines(prog);
  flagSyntaxErrors(prog);
  flagElementErrors(prog);

  return splitResult;
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
export function parseLine(text: string, originalBytes?: number[]): ParsedLine | null {
  // Extract line number from the start.
  const match = text.match(/^(\d+)\s?/);
  if (!match) return null;
  const lineNum = parseInt(match[1], 10);
  if (isNaN(lineNum) || lineNum < 0 || lineNum > 65535) return null;

  const content = text.slice(match[0].length);
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

  return { lineNum, bytes };
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
