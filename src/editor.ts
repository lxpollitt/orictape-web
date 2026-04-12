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
 * Apply an edit to a BASIC line in a program.
 * Replaces the line's bytes in prog.bytes, updates all line indices,
 * recalculates next-line pointers, and re-runs post-processing flags.
 *
 * @param prog     The program to modify (mutated in place)
 * @param lineIdx  Index into prog.lines of the line being edited
 * @param parsed   The parsed line from parseLine()
 */
export function applyLineEdit(prog: Program, lineIdx: number, parsed: ParsedLine): void {
  const line = prog.lines[lineIdx];
  const oldFirst = line.firstByte;
  const oldLast  = line.lastByte;
  const oldLen   = oldLast - oldFirst + 1;

  // Build the full line bytes: next-line pointer (2 bytes placeholder) + parsed bytes
  // (line number + content + null terminator).
  // The pointer will be recalculated below.
  const newContentBytes = parsed.bytes;  // lineNum(2) + content + 0x00
  const newLineBytes: number[] = [0x00, 0x00, ...newContentBytes];  // placeholder ptr + content
  const newLen = newLineBytes.length;
  const delta = newLen - oldLen;

  // Create ByteInfo entries for the new bytes.
  const newByteInfos: ByteInfo[] = newLineBytes.map(v => ({
    v,
    firstBit: 0,
    lastBit:  0,
    unclear:  false,
    chkErr:   false,
    edited:   true,
  }));

  // Splice: remove old bytes, insert new ones.
  prog.bytes.splice(oldFirst, oldLen, ...newByteInfos);

  // Shift all subsequent lines' byte indices by delta.
  for (let li = lineIdx + 1; li < prog.lines.length; li++) {
    prog.lines[li].firstByte += delta;
    prog.lines[li].lastByte  += delta;
    prog.lines[li].expectedLastByte += delta;
  }

  // Update the edited line's byte range.
  line.lastByte = oldFirst + newLen - 1;
  line.expectedLastByte = line.lastByte;
  line.lenErr = false;

  // Recalculate next-line pointers throughout the program.
  // The pointer at each line's firstByte+0,+1 is the memory address of the
  // NEXT line (or 0x0000 for the last line). Memory addresses start at startAddr.
  const startAddr = prog.header.startAddr;
  // Find the byte offset of the first line's content relative to the header.
  const firstLineOffset = prog.lines[0].firstByte;

  for (let li = 0; li < prog.lines.length; li++) {
    const l = prog.lines[li];
    let ptrValue: number;
    if (li < prog.lines.length - 1) {
      // Point to the next line's memory address.
      const nextLineByteOffset = prog.lines[li + 1].firstByte - firstLineOffset;
      ptrValue = startAddr + nextLineByteOffset;
    } else {
      // Last line: pointer = 0x0000 (end of program).
      ptrValue = 0x0000;
    }
    // Write the pointer (little-endian) into the byte stream.
    prog.bytes[l.firstByte].v     = ptrValue & 0xFF;
    prog.bytes[l.firstByte + 1].v = (ptrValue >> 8) & 0xFF;
  }

  // Update the edited line's elements and line number from the parsed data.
  // Re-decode elements from the new bytes (simplest way to get elements right).
  const elements: string[] = [];
  const lineNumStr = `${parsed.lineNum} `;
  elements.push(lineNumStr);
  // Walk content bytes (after the 2-byte line number, before the null terminator).
  for (let i = 2; i < newContentBytes.length - 1; i++) {
    const b = newContentBytes[i];
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
