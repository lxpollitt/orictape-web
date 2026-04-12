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

export interface ParsedLine {
  lineNum: number;
  bytes:   number[];   // line number (2 bytes LE) + content bytes (keyword tokens + ASCII) + null terminator
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
