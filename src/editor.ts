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

import { KEYWORDS, TOKEN_REM, TOKEN_DATA, INVALID_CODE_LITERALS } from './decoder';
import type { Program, ByteInfo, LineInfo } from './decoder';
import {
  flagNonMonotonicLines, flagElementErrors, flagLenErrors, flagEarlyEnd,
  flagPointerAndTerminatorIssues, buildLineElements, invalidateLineHealth,
  lineFirstAddr,
} from './decoder';

/**
 * Verbose debug logging for edit-related operations — off by default to keep
 * tool output (snapshot.ts, compareTaps.ts) readable and the browser console
 * quiet.  Enable at runtime without rebuilding:
 *   - Browser: in devtools, run `localStorage.debug = '1'` and reload
 *   - Node (snapshot / compareTaps): run with `DEBUG=1 npx tsx …`
 * Evaluated once at module load so no per-call overhead when off.  console.warn
 * calls (genuine error conditions) are never gated.  We read `process.env` via
 * globalThis with a minimal structural cast to avoid needing @types/node just
 * for this one reference.
 */
const DEBUG = (() => {
  // Check Node first via process.versions.node (set only in real Node.js,
  // not in browsers even when process is polyfilled).  We MUST avoid
  // touching globalThis.localStorage in Node 22+ because just accessing it
  // triggers a --localstorage-file warning on stderr.
  const proc = (globalThis as {
    process?: { versions?: { node?: string }; env?: Record<string, string | undefined> };
  }).process;
  if (proc?.versions?.node) return proc.env?.DEBUG === '1';
  // Browser path — safely touch localStorage.
  const ls = (globalThis as { localStorage?: Storage }).localStorage;
  if (ls && typeof ls.getItem === 'function') {
    try { return ls.getItem('debug') === '1'; } catch { /* fall through */ }
  }
  return false;
})();

/**
 * Recompute every program-level and line-level flag in one go.  Called by each
 * editor operation at the end, after the operation has mutated prog.bytes /
 * prog.lines, so all status fields reflect the current state.  The order
 * matters: flagLenErrors must run before flagPointerAndTerminatorIssues (which
 * reads line.lenErr) and before flagEarlyEnd (not order-sensitive itself but
 * grouped with the other length-related flags for readability).
 */
export function flagAll(prog: Program): void {
  flagLenErrors(prog);  // TODO: development aid — comment out when not debugging editing.
  flagEarlyEnd(prog);
  flagPointerAndTerminatorIssues(prog);
  flagNonMonotonicLines(prog);
  flagTokenisationMismatches(prog);
  flagElementErrors(prog);
}

export interface ParsedLine {
  lineNum: number;
  bytes:   number[];   // line number (2 bytes LE) + content bytes (keyword tokens + ASCII) + null terminator
  hasDummyLineNumber: boolean;  // true if line number was not parsed from text (defaulted to 0)
}

export interface SyntaxIssue {
  byteOffset: number;  // offset within the line's bytes (relative to firstByte+2)
  message:    string;
}

// ── Byte-level syntax checking ────────────────────────────────────────────────

export interface ByteSyntaxResult {
  severity: 'ok' | 'warning' | 'error';
  expectNext: 'code' | 'literals';
  reason?: 'unknownKeyword' | 'keywordInLiteral' | 'invalidReservedChar' | 'invalidNonPrintable' | 'nonPrintableInLiteral';
}


/**
 * Byte-level syntax checker for Oric BASIC line content.
 * Tracks tokenisation context (code/string/rem/data) across a sequence of bytes.
 * Call with reset=true on the first content byte of each new line.
 *
 * For each byte, returns:
 *   - severity: whether this byte is expected in the current context
 *   - expectNext: the mode for the next byte (code or literals)
 */
let _syntaxState: 'code' | 'string' | 'rem' | 'data' = 'code';

export function byteSequenceSyntaxChecker(byte: number, reset?: boolean): ByteSyntaxResult {
  if (reset) _syntaxState = 'code';

  // End of line — reset and return ok.
  if (byte === 0x00) {
    const expectNext: 'code' | 'literals' = 'code';
    _syntaxState = 'code';
    return { severity: 'ok', expectNext };
  }

  // Literal modes: rem, string, data.
  if (_syntaxState === 'rem' || _syntaxState === 'string' || _syntaxState === 'data') {
    // Closing quote exits string mode.
    if (_syntaxState === 'string' && byte === 0x22) {
      _syntaxState = 'code';
      return { severity: 'ok', expectNext: 'code' };
    }
    // Colon exits data mode.
    if (_syntaxState === 'data' && byte === 0x3A) {
      _syntaxState = 'code';
      return { severity: 'ok', expectNext: 'code' };
    }
    // Printable ASCII is fine in literal context.
    if (byte >= 0x20 && byte <= 0x7E) return { severity: 'ok', expectNext: 'literals' };
    // Keyword token in literal context — error. Unknown keyword trumps keyword-in-literal.
    if (byte >= 0x80) {
      const reason = (byte - 0x80) >= KEYWORDS.length ? 'unknownKeyword' : 'keywordInLiteral';
      return { severity: 'error', expectNext: 'literals', reason };
    }
    // Non-printable in literal context — warning.
    return { severity: 'warning', expectNext: 'literals', reason: 'nonPrintableInLiteral' };
  }

  // Code mode.
  // Opening quote — enter string mode.
  if (byte === 0x22) {
    _syntaxState = 'string';
    return { severity: 'ok', expectNext: 'literals' };
  }

  // Keyword token.
  if (byte >= 0x80) {
    if (byte === TOKEN_REM) {
      _syntaxState = 'rem';
      return { severity: 'ok', expectNext: 'literals' };
    }
    if (byte === TOKEN_DATA) {
      _syntaxState = 'data';
      return { severity: 'ok', expectNext: 'literals' };
    }
    // `!` (TOKEN_BANG) is a user-redefinable command hook (JMP via
    // $02F4/$02F5 vector, defaulting to ILLEGAL QUANTITY ERROR at
    // $D336 — commonly redefined by DOS / extension ROMs).  It is
    // NOT a REM alias: the Oric tokeniser stays in code mode after
    // `!`, so subsequent keywords are tokenised and their
    // arguments execute normally.  Empirically verified: `! PRINT`
    // stores as [BANG][space][PRINT-token], not as literal ASCII.
    // Treating `!` like REM would mis-render any line that uses
    // the bang hook, and inside a type-2 `[[` region would cause
    // the assembler to see `«0xXX»` escape placeholders instead
    // of the real mnemonic / label text.
    if ((byte - 0x80) < KEYWORDS.length) return { severity: 'ok', expectNext: 'code' };
    return { severity: 'error', expectNext: 'code', reason: 'unknownKeyword' };
  }

  // Printable ASCII in code mode.
  if (byte >= 0x20 && byte <= 0x7E) {
    if (INVALID_CODE_LITERALS.has(byte)) return { severity: 'error', expectNext: 'code', reason: 'invalidReservedChar' };
    return { severity: 'ok', expectNext: 'code' };
  }

  // Non-printable in code mode — error.
  return { severity: 'error', expectNext: 'code', reason: 'invalidNonPrintable' };
}

/**
 * Check whether a decoded BASIC line's text re-tokenises to the same bytes.
 * Returns null if the bytes match, or a SyntaxIssue describing the first mismatch.
 *
 * @param lineText  The line's element text joined (e.g. "100 PRINT \"Hello\"")
 * @param originalBytes  The original bytes from firstByte+2 to lastByte (line number + content + null)
 */
export function checkTokenisationMatch(lineText: string, originalBytes: number[]): SyntaxIssue | null {
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
 * Sets `tokenisationMismatch` on any line whose text doesn't round-trip to the
 * same bytes; clears it on lines that do round-trip cleanly (so the flag always
 * reflects current state, not a historical observation).
 */
export function flagTokenisationMismatches(prog: Program): void {
  for (const line of prog.lines) {
    const lineText = line.elements.join('');
    // Extract original bytes: line number (2 bytes) + content + null terminator.
    const originalBytes: number[] = [];
    for (let b = line.firstByte + 2; b <= line.lastByte; b++) {
      originalBytes.push(prog.bytes[b].v);
    }
    const issue = checkTokenisationMatch(lineText, originalBytes);
    line.tokenisationMismatch = issue ? true : undefined;
    invalidateLineHealth(line);
  }
}

/**
 * Reconstruct the full original bytes for a byte-stream range from its stored
 * delta and current non-edited bytes.  Combines them and sorts by originalIndex.
 * Range is inclusive: [firstByte, lastByte].
 */
function getFullOriginalBytesInRange(
  prog: Program,
  firstByte: number,
  lastByte: number,
  delta: ByteInfo[] | undefined,
): ByteInfo[] {
  const currentBytes = prog.bytes.slice(firstByte, lastByte + 1);
  const nonEdited = currentBytes.filter(b => !b.edited);
  const deltaBytes = delta || [];
  const result = [...nonEdited, ...deltaBytes].sort((a, b) => (a.originalIndex ?? 0) - (b.originalIndex ?? 0));
  if (DEBUG) {
    const hx = (b: ByteInfo) => `${b.v.toString(16).padStart(2, '0')}${b.edited ? '(' + b.edited[0] + ')' : ''}`;
    console.log(`getFullOriginalBytesInRange [${firstByte}..${lastByte}]: ${result.length} original (${nonEdited.length} non-edited + ${deltaBytes.length} delta)`,
      `\n  current: [${currentBytes.map(hx).join(' ')}]`,
      `\n  non-edited: [${nonEdited.map(hx).join(' ')}]`,
      `\n  delta: [${deltaBytes.map(hx).join(' ')}]`,
      `\n  result: [${result.map(hx).join(' ')}]`);
  }
  return result;
}

/**
 * Compute the delta of original bytes that are no longer in the given byte-stream
 * range (i.e. bytes that have been replaced by edits).  Returns undefined when
 * all original bytes are still present.  Range is inclusive: [firstByte, lastByte].
 */
function computeOriginalBytesDelta(
  prog: Program,
  firstByte: number,
  lastByte: number,
  fullOriginal: ByteInfo[],
): ByteInfo[] | undefined {
  const keptIndices = new Set(
    prog.bytes.slice(firstByte, lastByte + 1)
      .filter(b => !b.edited)
      .map(b => b.originalIndex)
  );
  const delta = fullOriginal.filter(b => !keptIndices.has(b.originalIndex));
  if (DEBUG) {
    const hx = (b: ByteInfo) => `${b.v.toString(16).padStart(2, '0')}${b.edited ? '(' + b.edited[0] + ')' : ''}`;
    const currentBytes = prog.bytes.slice(firstByte, lastByte + 1);
    console.log(`computeOriginalBytesDelta [${firstByte}..${lastByte}]: ${fullOriginal.length} original, ${delta.length} delta`,
      `\n  fullOriginal: [${fullOriginal.map(hx).join(' ')}]`,
      `\n  current: [${currentBytes.map(hx).join(' ')}]`,
      `\n  kept: [${currentBytes.filter(b => !b.edited).map(hx).join(' ')}]`,
      `\n  delta: [${delta.map(hx).join(' ')}]`);
  }
  return delta.length > 0 ? delta : undefined;
}

/**
 * Reconstruct the full original bytes for a line from its delta and current bytes.
 * Combines non-edited current bytes with the stored delta, sorted by originalIndex.
 */
export function getFullOriginalBytes(prog: Program, line: LineInfo): ByteInfo[] {
  return getFullOriginalBytesInRange(prog, line.firstByte, line.lastByte, line.originalBytesDelta);
}

/**
 * Compute and store the delta of original bytes that are no longer in the current line.
 * If all original bytes are still present (no edits), clears line.originalBytesDelta.
 */
export function storeOriginalBytesDelta(prog: Program, line: LineInfo, fullOriginal: ByteInfo[]): void {
  line.originalBytesDelta = computeOriginalBytesDelta(prog, line.firstByte, line.lastByte, fullOriginal);
}

/**
 * Header-level analogue of getFullOriginalBytes: reconstruct the original 9-byte
 * program header from its delta and current non-edited bytes.
 */
export function getHeaderOriginalBytes(prog: Program): ByteInfo[] {
  const first = prog.header.byteIndex;
  return getFullOriginalBytesInRange(prog, first, first + 8, prog.header.originalBytesDelta);
}

/**
 * Header-level analogue of storeOriginalBytesDelta: store any displaced header
 * bytes in prog.header.originalBytesDelta.
 */
export function storeHeaderOriginalBytesDelta(prog: Program, fullOriginal: ByteInfo[]): void {
  const first = prog.header.byteIndex;
  prog.header.originalBytesDelta = computeOriginalBytesDelta(prog, first, first + 8, fullOriginal);
}

/**
 * Delete a BASIC line from a program.
 * Removes the line's bytes from prog.bytes, removes the LineInfo entry,
 * shifts subsequent line indices, recalculates next-line pointers, and
 * re-runs post-processing flags.
 */
export function deleteLineEdit(prog: Program, lineIdx: number): void {
  // Validate parameters.
  if (lineIdx < 0 || lineIdx >= prog.lines.length || prog.lines.length < 2) {
    console.warn('deleteLineEdit: invalid lineIdx or only one line', lineIdx);
    return;
  }

  const line = prog.lines[lineIdx];
  const oldFirst = line.firstByte;
  const oldLast  = line.lastByte;
  const oldLen   = oldLast - oldFirst + 1;
  const delta = -oldLen;

  // Get original bytes for the deleted line before removing it.
  const deletedOriginal = getFullOriginalBytes(prog, line);

  // Determine which neighbour inherits the deleted line's original bytes.
  // Previous line if available, otherwise next line.
  const inheritIdx = lineIdx > 0 ? lineIdx - 1 : lineIdx + 1;
  const neighbour = prog.lines[inheritIdx];
  const neighbourOriginal = getFullOriginalBytes(prog, neighbour);
  // Concatenate in stream order.
  const inheritOriginal = inheritIdx < lineIdx
    ? [...neighbourOriginal, ...deletedOriginal]
    : [...deletedOriginal, ...neighbourOriginal];

  // Remove the bytes from the byte stream.
  prog.bytes.splice(oldFirst, oldLen);

  // Remove the line from the lines array.
  prog.lines.splice(lineIdx, 1);

  // Adjust subsequent lines' byte stream pointers and line info.
  // (The predecessor line's pointer doesn't need adjusting — the new next line
  // now starts at oldFirst, which is where the deleted line was.)
  adjustLineOffsets(prog, delta, lineIdx);
  adjustHeaderEndAddr(prog, delta);

  // Store the combined original bytes on the inheriting neighbour.
  // Done after adjustLineOffsets so the neighbour's byte indices are correct.
  const adjustedInheritIdx = inheritIdx < lineIdx ? inheritIdx : inheritIdx - 1;
  storeOriginalBytesDelta(prog, prog.lines[adjustedInheritIdx], inheritOriginal);

  // Re-run all post-processing flags.
  flagAll(prog);
  prog.unsaved = true;
}

/**
 * Restore a line to its original bytes from the tape.
 * Splices the full original bytes back into the byte stream, updates line info,
 * and clears the original bytes delta.
 */
export function restoreLineToOriginalBytes(prog: Program, lineIdx: number): void {
  if (lineIdx < 0 || lineIdx >= prog.lines.length) {
    console.warn('restoreLineToOriginalBytes: invalid lineIdx', lineIdx);
    return;
  }
  const line = prog.lines[lineIdx];
  const fullOriginal = getFullOriginalBytes(prog, line);

  if (fullOriginal.length === 0) {
    // No original bytes — line is entirely synthetic. Delete it.
    deleteLineEdit(prog, lineIdx);
    return;
  }

  const oldFirst = line.firstByte;
  const oldLast = line.lastByte;

  // Splice original bytes back into the byte stream.
  // The original bytes may contain multiple lines (e.g. after a join).
  // We may need to insert missing bytes for incomplete segments.
  const restoredBytes = [...fullOriginal];
  const editedZero = (): ByteInfo => ({ v: 0x00, firstBit: 0, lastBit: 0, unclear: false, chkErr: false, edited: 'explicit' });

  // Walk the bytes to find line boundaries (0x00 terminators) and
  // insert missing bytes for any incomplete final segment.
  const newLines: { startOffset: number; endOffset: number }[] = [];
  let pos = 0;
  while (pos < restoredBytes.length) {
    const segStart = pos;
    // Each line needs 2 pointer bytes + 2 line number bytes (4 total header).
    // Pad with edited zeros if we run out of bytes.
    while (pos < segStart + 4) {
      if (pos === restoredBytes.length) restoredBytes.push(editedZero());
      pos++;
    }
    // Scan content for 0x00 terminator (after the 4 header bytes).
    while (pos < restoredBytes.length && restoredBytes[pos].v !== 0x00) pos++;
    if (pos === restoredBytes.length) {
      // Ran out of bytes without a terminator — add one.
      restoredBytes.push(editedZero());
    }
    pos++;  // include the 0x00
    newLines.push({ startOffset: segStart, endOffset: pos - 1 });
  }

  const delta = spliceMergedBytes(prog.bytes, oldFirst, oldLast, restoredBytes);

  // Create LineInfo entries for each restored line.
  const lineInfos: LineInfo[] = [];
  for (const seg of newLines) {
    const segOriginal = fullOriginal.slice(seg.startOffset, Math.min(seg.endOffset + 1, fullOriginal.length));
    const lineFirstByte = oldFirst + seg.startOffset;
    const lineLastByte = oldFirst + seg.endOffset;
    const newLine: LineInfo = {
      v: '',
      elements: [],
      firstByte: lineFirstByte,
      lastByte: lineLastByte,
      lenErr: false,  // flagLenErrors (called via flagAll) will set correctly.
    };
    buildLineElements(newLine, prog.bytes);
    storeOriginalBytesDelta(prog, newLine, segOriginal);
    lineInfos.push(newLine);
  }

  // Replace the single LineInfo with the restored line(s).
  prog.lines.splice(lineIdx, 1, ...lineInfos);

  // Adjust subsequent lines.
  adjustLineOffsets(prog, delta, lineIdx + lineInfos.length);
  adjustHeaderEndAddr(prog, delta);

  // Re-run all post-processing flags.
  flagAll(prog);
  prog.unsaved = true;
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
 * Compute the Longest Common Subsequence between two value arrays.
 *
 * Returns matches in forward order (lowest indices first).  Pure function —
 * no knowledge of Program, ByteInfo, or lines.
 *
 * When multiple alignments achieve the maximum LCS length (which is common
 * whenever the inputs share repeated characters), the secondary objective is
 * to **minimise the number of contiguous match runs**.  This keeps insertions
 * and deletions as contiguous blocks rather than scattering them across the
 * ambiguous region — matching the naive user expectation that a small edit
 * to a BASIC line should show up as one change, not several.
 *
 * Concrete examples motivating the two-tier objective:
 *
 *   1. pies: old = "5 REM *By A.Pollitt.               *"
 *            new = "5 REM *By A.Pollitt who likes pies!               *"
 *      With a plain LCS + fixed tie-break, the 15 trailing spaces in old can
 *      be matched against any 15 of the 19 spaces in new.  A match-earliest
 *      tie-break matches the leading + internal spaces, leaving four bits of
 *      the inserted phrase scattered around six separate "insertion" runs
 *      (including three stray trailing spaces).  A match-latest tie-break
 *      matches the trailing 15 spaces as one run — one contiguous insertion.
 *      Minimising run count picks the latter.
 *
 *   2. 100 → 1000: three alignments achieve LCS=3 (insert at new[1], new[2],
 *      or new[3]).  Run count is 1 for the new[3] placement (old matches
 *      new[0..2] as one run; trailing 0 is insertion) and 2 for the others.
 *      Minimising run count picks the trailing placement — matches the user
 *      expectation that "I typed a 0 at the end".
 *
 *   3. 100 PRINT X → 1000 PRINT X: three alignments all have 2 runs, so the
 *      primary and secondary objectives tie.  Tertiary tie-break in the
 *      backtrack (prefer skip-new over skip-old on equal run-count) matches
 *      the historical "match-earliest" behaviour and places the insertion at
 *      new[3] — the boundary between "100" and " PRINT X".
 *
 * Algorithm: two DP passes over an (n+1) × (m+1) grid, where n = |old| and
 * m = |new|.
 *
 *   Pass 1 (lcs): standard LCS length.
 *   Pass 2 (f0, f1): among alignments achieving lcs[i][j], track the minimum
 *     number of match runs, split by whether the last action was a match
 *     (f1) or a non-match / origin (f0).  Splitting the state lets us
 *     distinguish "just extending an existing run" (no cost) from "starting
 *     a new run" (+1 cost) when a match happens.
 *
 * O(n·m) time and space, same asymptotic as the vanilla LCS this replaces.
 * For line-level inputs (n, m < ~100) this is negligible.
 */
export function computeLcs(newValues: number[], oldValues: number[]): LcsMatch[] {
  const n = oldValues.length;
  const m = newValues.length;

  // Pass 1: standard LCS length.
  const lcs: Uint16Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) lcs[i] = new Uint16Array(m + 1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      lcs[i][j] = oldValues[i - 1] === newValues[j - 1]
        ? lcs[i - 1][j - 1] + 1
        : Math.max(lcs[i - 1][j], lcs[i][j - 1]);
    }
  }

  // Pass 2: among alignments achieving lcs[i][j], find minimum match runs.
  //   f0[i][j] = min runs when last action was non-match (or at origin)
  //   f1[i][j] = min runs when last action was match (just matched
  //              old[i-1] with new[j-1])
  // INF marks unreachable states — e.g. f1[0][0] (no match has happened).
  const INF = 0x3fffffff;
  const f0: Int32Array[] = new Array(n + 1);
  const f1: Int32Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    f0[i] = new Int32Array(m + 1).fill(INF);
    f1[i] = new Int32Array(m + 1).fill(INF);
  }
  f0[0][0] = 0;

  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      if (i === 0 && j === 0) continue;
      // State 0: arrived by skip-old or skip-new (valid only if skipping
      // doesn't reduce LCS length at this cell).
      if (i > 0 && lcs[i - 1][j] === lcs[i][j]) {
        const r = Math.min(f0[i - 1][j], f1[i - 1][j]);
        if (r < f0[i][j]) f0[i][j] = r;
      }
      if (j > 0 && lcs[i][j - 1] === lcs[i][j]) {
        const r = Math.min(f0[i][j - 1], f1[i][j - 1]);
        if (r < f0[i][j]) f0[i][j] = r;
      }
      // State 1: arrived by match (valid only if chars equal and taking
      // the match is on an optimal path).
      if (i > 0 && j > 0
          && oldValues[i - 1] === newValues[j - 1]
          && lcs[i - 1][j - 1] + 1 === lcs[i][j]) {
        const fromSkip  = f0[i - 1][j - 1] + 1;  // starts a new run
        const fromMatch = f1[i - 1][j - 1];      // continues run
        const r = Math.min(fromSkip, fromMatch);
        if (r < f1[i][j]) f1[i][j] = r;
      }
    }
  }

  // Backtrack.  On ties, prefer skip-new over skip-old and prefer continuing
  // an existing run over starting a new one.  These tertiary tie-breaks
  // preserve the historical match-earliest behaviour for cases the
  // run-minimising rule doesn't distinguish (e.g. the 100 PRINT X case).
  const matches: LcsMatch[] = [];
  let oi = n, ni = m;
  let state: 0 | 1 = (f1[n][m] < f0[n][m]) ? 1 : 0;

  while (oi > 0 || ni > 0) {
    if (state === 1) {
      matches.push({ newIdx: ni - 1, oldIdx: oi - 1 });
      const fromSkip  = f0[oi - 1][ni - 1] + 1;
      const fromMatch = f1[oi - 1][ni - 1];
      // Strict '<' on fromMatch: on equal run-count the predecessor is
      // treated as "non-match", which ends the run going backward.  In the
      // forward view this places the start of the run as late as possible,
      // which combined with the skip-new preference in the state-0 branch
      // realises the historical match-earliest tie-break for cells the
      // primary and secondary objectives don't distinguish.
      state = (fromMatch < fromSkip) ? 1 : 0;
      oi--; ni--;
    } else {
      const canSkipOld = oi > 0 && lcs[oi - 1][ni] === lcs[oi][ni];
      const canSkipNew = ni > 0 && lcs[oi][ni - 1] === lcs[oi][ni];
      let doSkipNew: boolean;
      if (canSkipOld && canSkipNew) {
        const runsViaOld = Math.min(f0[oi - 1][ni],     f1[oi - 1][ni]);
        const runsViaNew = Math.min(f0[oi][ni - 1],     f1[oi][ni - 1]);
        doSkipNew = (runsViaNew <= runsViaOld);
      } else {
        doSkipNew = canSkipNew;
      }
      if (doSkipNew) {
        const r0 = f0[oi][ni - 1];
        const r1 = f1[oi][ni - 1];
        state = (r1 <= r0) ? 1 : 0;
        ni--;
      } else if (canSkipOld) {
        const r0 = f0[oi - 1][ni];
        const r1 = f1[oi - 1][ni];
        state = (r1 <= r0) ? 1 : 0;
        oi--;
      } else {
        // Boundary cleanup — no valid skip transition, just walk toward
        // the origin.  Any remaining old / new are unmatched by definition.
        if (oi > 0) oi--;
        else ni--;
      }
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
 * then shifts firstByte/lastByte.
 */
function adjustLineOffsets(prog: Program, delta: number, firstLineIdx: number, lastLineIdx?: number): void {
  if (delta === 0) return;
  const last = lastLineIdx ?? prog.lines.length - 1;
  for (let li = firstLineIdx; li <= last; li++) {
    const l = prog.lines[li];
    // Update line info first so getFullOriginalBytes reads the correct position.
    l.firstByte += delta;
    l.lastByte  += delta;
    // Snapshot original bytes before replacing the pointer.
    const fullOriginal = getFullOriginalBytes(prog, l);
    // Offset existing pointer values in the byte stream by delta.
    // If the new value matches the original, restore the original ByteInfo.
    const oldPtr = prog.bytes[l.firstByte].v | (prog.bytes[l.firstByte + 1].v << 8);
    const newPtr = oldPtr + delta;
    const newPtrLo = newPtr & 0xFF;
    const newPtrHi = (newPtr >> 8) & 0xFF;
    prog.bytes[l.firstByte]     = fullOriginal.length > 0 && newPtrLo === fullOriginal[0].v ? fullOriginal[0]
      : { v: newPtrLo, firstBit: 0, lastBit: 0, unclear: false, chkErr: false, edited: 'automatic' };
    prog.bytes[l.firstByte + 1] = fullOriginal.length > 1 && newPtrHi === fullOriginal[1].v ? fullOriginal[1]
      : { v: newPtrHi, firstBit: 0, lastBit: 0, unclear: false, chkErr: false, edited: 'automatic' };
    // Store only the displaced original bytes.
    storeOriginalBytesDelta(prog, l, fullOriginal);
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
        edited: 'explicit',
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

  // Reconstruct the full original bytes for optimal LCS.
  const fullOriginal = getFullOriginalBytes(prog, line);

  // Calculate the correct next-line pointer value.
  // Based on where the next line will be after the splice:
  // this line's start + 2 (pointer bytes) + content length.
  const firstAddr = lineFirstAddr(prog, lineIdx);
  const ptrValue  = firstAddr + 2 + parsed.bytes.length;

  // Include pointer bytes in the LCS so matching originals are preserved.
  // Always LCS against original bytes to get the minimum diff from the tape.
  const newValues = [ptrValue & 0xFF, (ptrValue >> 8) & 0xFF, ...parsed.bytes];
  const oldValues = fullOriginal.map(b => b.v);

  const matches = computeLcs(newValues, oldValues);
  const mergedLine = buildMergedBytes(newValues, fullOriginal, matches, 0, newValues.length - 1);

  // Pointer bytes created by editing are automatic, not explicit.
  if (mergedLine[0].edited === 'explicit') mergedLine[0].edited = 'automatic';
  if (mergedLine[1].edited === 'explicit') mergedLine[1].edited = 'automatic';

  // --- Splice edited line into the byte stream and update its line info ---

  const delta = spliceMergedBytes(prog.bytes, oldFirst, oldLast, mergedLine);
  line.lastByte = oldFirst + mergedLine.length - 1;
  line.lenErr = false;

  // Update the edited line's elements and display text from its bytes.
  buildLineElements(line, prog.bytes);

  // Store only the displaced original bytes (or clear if line matches original).
  storeOriginalBytesDelta(prog, line, fullOriginal);

  // --- Adjust subsequent lines: byte stream pointers then line info ---

  adjustLineOffsets(prog, delta, lineIdx + 1);
  adjustHeaderEndAddr(prog, delta);

  // Re-run all post-processing flags.
  flagAll(prog);
  // The program has been modified.  The save paths (Cmd/Ctrl+S and
  // Build TAP) clear this back to false.  Used by the
  // `beforeunload` warning to protect against accidental loss.
  prog.unsaved = true;
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

  const oldLine = prog.lines[lineIdx];
  const oldFirstByteIndex = oldLine.firstByte;
  const oldLastByteIndex = oldLine.lastByte;

  // --- Get full original bytes and compute pointers ---
  const fullOriginalBytes = getFullOriginalBytes(prog, oldLine);

  // Build content for each half excluding their next-line pointers.
  // Exclude dummy line number bytes from LCS so they can't steal matches.
  const firstForLcs = parsedFirst.hasDummyLineNumber ? parsedFirst.bytes.slice(2) : parsedFirst.bytes;
  const secondForLcs = parsedSecond.hasDummyLineNumber ? parsedSecond.bytes.slice(2) : parsedSecond.bytes;

  // Calculate next-line pointer values.
  // First line's pointer: points to where the second new line will start.
  const firstAddr1 = lineFirstAddr(prog, lineIdx);
  const ptr1Value  = firstAddr1 + 2 + parsedFirst.bytes.length;
  const ptr2Value  = ptr1Value  + 2 + parsedSecond.bytes.length;

  // --- Build full new values and run LCS against original bytes ---

  // Include pointers in the LCS new values: [ptr1_lo, ptr1_hi, firstContent, ptr2_lo, ptr2_hi, secondContent]
  const newValues = [ptr1Value & 0xFF, (ptr1Value >> 8) & 0xFF, ...firstForLcs, ptr2Value & 0xFF, (ptr2Value >> 8) & 0xFF, ...secondForLcs];
  const splitPoint = 2 + firstForLcs.length; // index where second line values start

  const oldValues = fullOriginalBytes.map(b => b.v);
  const matches = computeLcs(newValues, oldValues);

  // Debug: log the LCS results for verification.
  if (DEBUG) {
    const hex = (arr: number[]) => arr.map(b => '0x' + b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    console.log('splitLineWithEdits LCS:', {
      firstText,
      secondText,
      newFirstHalf: hex(newValues.slice(0, splitPoint)),
      newSecondHalf: hex(newValues.slice(splitPoint)),
      oldValues: hex(oldValues),
      splitPoint,
      matches,
      matchesInFirst: matches.filter(m => m.newIdx < splitPoint).length
        + ' — ' + hex(matches.filter(m => m.newIdx < splitPoint).map(m => newValues[m.newIdx])),
      matchesInSecond: matches.filter(m => m.newIdx >= splitPoint).length
        + ' — ' + hex(matches.filter(m => m.newIdx >= splitPoint).map(m => newValues[m.newIdx])),
    });
  }

  // --- Build merged bytes for each half ---
  const firstMerged = buildMergedBytes(newValues, fullOriginalBytes, matches, 0, splitPoint - 1);
  const secondMerged = buildMergedBytes(newValues, fullOriginalBytes, matches, splitPoint, newValues.length - 1);

  // Add back in any dummy line number bytes (deliberately left out of the LCS matching).
  if (parsedFirst.hasDummyLineNumber) {
    const dummyLo: ByteInfo = { v: 0x00, firstBit: 0, lastBit: 0, unclear: false, chkErr: false, edited: 'explicit' };
    const dummyHi: ByteInfo = { v: 0x00, firstBit: 0, lastBit: 0, unclear: false, chkErr: false, edited: 'explicit' };
    firstMerged.splice(2, 0, dummyLo, dummyHi);
  }
  if (parsedSecond.hasDummyLineNumber) {
    const dummyLo: ByteInfo = { v: 0x00, firstBit: 0, lastBit: 0, unclear: false, chkErr: false, edited: 'explicit' };
    const dummyHi: ByteInfo = { v: 0x00, firstBit: 0, lastBit: 0, unclear: false, chkErr: false, edited: 'explicit' };
    secondMerged.splice(2, 0, dummyLo, dummyHi);
  }

  // Adjust the edited status of the first line's next-line pointer bytes that didn't match original bytes. (buildMergedBytes marks 
  // all edits as explicit edits but we want them marked as automatic as we are just updating the existing pointer byte values.)
  // Note that in contrast, we want to treat the second line's pointer bytes as new bytes (if they didn't match
  // original bytes) because we're creating a new line and effectively inserted these as the line's required header.)
  if (firstMerged[0].edited === 'explicit') firstMerged[0].edited = 'automatic';
  if (firstMerged[1].edited === 'explicit') firstMerged[1].edited = 'automatic';

  // Debug: log the merged results for verification.
  if (DEBUG) {
    const hexBI = (arr: ByteInfo[]) => arr.map(b => (b.edited ? '*' : '') + '0x' + b.v.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    console.log('splitLineWithEdits merged:', {
      firstMerged: hexBI(firstMerged),
      secondMerged: hexBI(secondMerged),
    });
  }

  // --- Partition original bytes between the two lines ---

  // Find the first oldIdx matched by the second half.
  const splitPointFirstMatch = matches.find(m => m.newIdx >= splitPoint);
  const secondOrigStart = splitPointFirstMatch
    ? splitPointFirstMatch.oldIdx
    : fullOriginalBytes.length;
  const firstOriginalBytes = fullOriginalBytes.slice(0, secondOrigStart);
  const secondOriginalBytes = fullOriginalBytes.slice(secondOrigStart);

  // --- Splice into the byte stream and setup the lines to point to the new byte indexes ---
  const delta = spliceMergedBytes(prog.bytes, oldFirstByteIndex, oldLastByteIndex, [...firstMerged, ...secondMerged]);

  // Update the first line's info.
  const firstLineLastByteIndex = oldFirstByteIndex + firstMerged.length - 1;
  oldLine.lastByte = firstLineLastByteIndex;
  oldLine.lenErr = false;
  buildLineElements(oldLine, prog.bytes);
  storeOriginalBytesDelta(prog, oldLine, firstOriginalBytes);

  // Create the second line's LineInfo and insert it.
  const secondLineFirstByteIndex = firstLineLastByteIndex + 1;
  const secondLineLastByteIndex = secondLineFirstByteIndex + secondMerged.length - 1;
  const newLine: LineInfo = {
    v: '',
    elements: [],
    firstByte: secondLineFirstByteIndex,
    lastByte: secondLineLastByteIndex,
    lenErr: false,
  };
  prog.lines.splice(lineIdx + 1, 0, newLine);
  buildLineElements(newLine, prog.bytes);
  storeOriginalBytesDelta(prog, newLine, secondOriginalBytes);

  // --- Adjust subsequent lines (after the two new lines) ---

  adjustLineOffsets(prog, delta, lineIdx + 2);
  adjustHeaderEndAddr(prog, delta);

  // Re-run all post-processing flags.
  flagAll(prog);
  prog.unsaved = true;

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

  // --- Get full original bytes from both lines ---

  const fullOriginalFirst = getFullOriginalBytes(prog, first);
  const fullOriginalSecond = getFullOriginalBytes(prog, second);
  const fullOriginal = [...fullOriginalFirst, ...fullOriginalSecond];

  // Calculate the next-line pointer for the merged line.
  const firstAddr = lineFirstAddr(prog, firstIdx);
  const ptrValue  = firstAddr + 2 + parsed.bytes.length;

  // --- Build new values with pointer and run LCS against original bytes ---

  const newValues = [ptrValue & 0xFF, (ptrValue >> 8) & 0xFF, ...parsed.bytes];
  const oldValues = fullOriginal.map(b => b.v);
  const matches = computeLcs(newValues, oldValues);
  const mergedLine = buildMergedBytes(newValues, fullOriginal, matches, 0, newValues.length - 1);

  // We mark pointer bytes updated by editing as automatic, not explicit.
  if (mergedLine[0].edited === 'explicit') mergedLine[0].edited = 'automatic';
  if (mergedLine[1].edited === 'explicit') mergedLine[1].edited = 'automatic';

  // --- Splice and update ---

  const delta = spliceMergedBytes(prog.bytes, first.firstByte, second.lastByte, mergedLine);

  // Update the first (surviving) line's info.
  first.lastByte = first.firstByte + mergedLine.length - 1;
  first.lenErr = false;
  buildLineElements(first, prog.bytes);
  storeOriginalBytesDelta(prog, first, fullOriginal);

  // Remove the second (deleted) line from prog.lines.
  prog.lines.splice(secondIdx, 1);

  // Adjust subsequent lines (from secondIdx onwards, since second was removed).
  adjustLineOffsets(prog, delta, secondIdx);
  adjustHeaderEndAddr(prog, delta);

  // Re-run all post-processing flags.
  flagAll(prog);
  prog.unsaved = true;

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
  if (DEBUG && originalBytes) {
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
 * Uses byteSequenceSyntaxChecker to track tokenisation context.
 */
function tokenise(content: string): number[] {
  const bytes: number[] = [];
  let i = 0;
  let mode = byteSequenceSyntaxChecker(0x00, true).expectNext;  // reset, get initial mode

  while (i < content.length) {
    const ch = content[i];
    const code = ch.charCodeAt(0);

    // Escaped byte token «0xNN» — emit the byte directly, in any context.
    if (ch === '«' && content.startsWith('«0x', i) && content[i + 5] === '»') {
      const hexStr = content.slice(i + 3, i + 5);
      const byteVal = parseInt(hexStr, 16);
      if (!isNaN(byteVal)) {
        bytes.push(byteVal);
        mode = byteSequenceSyntaxChecker(byteVal).expectNext;
        i += 6;
        continue;
      }
    }

    // Characters outside the Oric's 7-bit range — silently drop.
    if (code > 0x7E) {
      i++;
      continue;
    }

    // Literal mode — emit byte as-is.
    if (mode === 'literals') {
      bytes.push(code);
      mode = byteSequenceSyntaxChecker(code).expectNext;
      i++;
      continue;
    }

    // Code mode — try keyword matching.

    // ? is shorthand for PRINT.
    if (ch === '?') {
      const token = KEYWORDS.indexOf('PRINT') + 0x80;
      bytes.push(token);
      mode = byteSequenceSyntaxChecker(token).expectNext;
      i++;
      continue;
    }

    // Spaces, digits, semicolons pass through without keyword matching.
    if (ch === ' ' || (code >= 0x30 && code <= 0x39) || ch === ';') {
      bytes.push(code);
      mode = byteSequenceSyntaxChecker(code).expectNext;
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
        mode = byteSequenceSyntaxChecker(token).expectNext;
        i += kw.length;
        matched = true;
        break;
      }
    }

    if (!matched) {
      // No keyword match — output the character as ASCII and advance.
      bytes.push(code);
      mode = byteSequenceSyntaxChecker(code).expectNext;
      i++;
    }
  }

  return bytes;
}

// ── Pointers & terminators fix ────────────────────────────────────────────────

/**
 * Recalculate every line's next-line pointer from the current byte layout,
 * replacing the existing pointer bytes (at line.firstByte, firstByte+1) with
 * automatic-edit ByteInfo entries when they disagree.  Preserves the original
 * ByteInfo when the computed value happens to match the original tape byte.
 *
 * Clears lenErr on every line — the pointer now matches the line's actual
 * extent by construction.
 *
 * Safe to call at any time: if every line's pointer already agrees with its
 * layout, this is a no-op on prog.bytes.
 */
function fixLinePointers(prog: Program): void {
  if (prog.lines.length === 0) return;

  const progStartAddr   = prog.header.startAddr;
  const firstLineOffset = prog.lines[0].firstByte;

  for (let li = 0; li < prog.lines.length; li++) {
    const line = prog.lines[li];
    // Pointer value = memory address of the byte immediately after this
    // line's terminator (i.e. where the next line, or end-of-program marker,
    // begins).
    const newPtrValue = progStartAddr + (line.lastByte + 1 - firstLineOffset);
    const newPtrLo = newPtrValue & 0xFF;
    const newPtrHi = (newPtrValue >> 8) & 0xFF;

    const currentPtrValue = prog.bytes[line.firstByte].v | (prog.bytes[line.firstByte + 1].v << 8);

    if (currentPtrValue !== newPtrValue) {
      // Snapshot original bytes before replacing the pointer so we can store
      // displaced originals in originalBytesDelta (matches adjustLineOffsets).
      const fullOriginal = getFullOriginalBytes(prog, line);
      prog.bytes[line.firstByte]     = fullOriginal.length > 0 && newPtrLo === fullOriginal[0].v ? fullOriginal[0]
        : { v: newPtrLo, firstBit: 0, lastBit: 0, unclear: false, chkErr: false, edited: 'automatic' };
      prog.bytes[line.firstByte + 1] = fullOriginal.length > 1 && newPtrHi === fullOriginal[1].v ? fullOriginal[1]
        : { v: newPtrHi, firstBit: 0, lastBit: 0, unclear: false, chkErr: false, edited: 'automatic' };
      storeOriginalBytesDelta(prog, line, fullOriginal);
    }

    line.lenErr = false;
  }
}

/**
 * Recalculate the header's end-address bytes to match the program's actual
 * final size (after any line-terminator or end-marker insertions done by
 * earlier phases of fixPointersAndTerminators).  Replaces the two header
 * bytes at byteIndex+4 (hi) and byteIndex+5 (lo) when they disagree;
 * preserves original ByteInfo entries where the new value happens to match,
 * and tracks displaced originals in prog.header.originalBytesDelta.
 *
 * Also updates the parsed prog.header.endAddr field to the new value, so
 * both the raw bytes and the materialised view stay in sync.
 *
 * No-op on programs with no lines.
 */
/**
 * Adjust the header's end address by a byte delta — analogous to how
 * adjustLineOffsets shifts each line's next-line pointer.  Called by
 * edit functions after a byte-stream length change, before flagAll.
 *
 * Preserves any pre-existing error in endAddr: if the stored value was
 * already off by N before the edit, it stays off by N afterwards (same
 * semantics as next-line pointer adjustment).  To recalibrate endAddr
 * to match the actual program layout use fixHeaderEndAddr instead.
 *
 * No-op on programs with no lines or a zero delta.
 */
function adjustHeaderEndAddr(prog: Program, delta: number): void {
  if (delta === 0 || prog.lines.length === 0) return;
  const newEndAddr = prog.header.endAddr + delta;
  const newEndHi   = (newEndAddr >> 8) & 0xFF;
  const newEndLo   = newEndAddr & 0xFF;
  const hiIdx      = prog.header.byteIndex + 4;
  const loIdx      = prog.header.byteIndex + 5;

  // Same originalBytesDelta pattern as fixHeaderEndAddr — snapshot the
  // full header originals before replacing, so displaced values round-
  // trip through save/load metadata.
  const fullOriginal = getHeaderOriginalBytes(prog);
  prog.bytes[hiIdx] = fullOriginal.length > 4 && newEndHi === fullOriginal[4].v ? fullOriginal[4]
    : { v: newEndHi, firstBit: 0, lastBit: 0, unclear: false, chkErr: false, edited: 'automatic' };
  prog.bytes[loIdx] = fullOriginal.length > 5 && newEndLo === fullOriginal[5].v ? fullOriginal[5]
    : { v: newEndLo, firstBit: 0, lastBit: 0, unclear: false, chkErr: false, edited: 'automatic' };
  storeHeaderOriginalBytesDelta(prog, fullOriginal);

  prog.header.endAddr = newEndAddr;
}

export function fixHeaderEndAddr(prog: Program): void {
  if (prog.lines.length === 0) return;
  const lastLine = prog.lines[prog.lines.length - 1];
  const firstLineOffset = prog.lines[0].firstByte;
  // End marker sits at lastLine.lastByte + 1 and +2; the first byte past it
  // (i.e. the exclusive end address in program-byte terms) is +3.
  const bytesPastEndMarker = lastLine.lastByte + 3;
  const newEndAddr = prog.header.startAddr + (bytesPastEndMarker - firstLineOffset);
  if (prog.header.endAddr === newEndAddr) return;

  const newEndHi = (newEndAddr >> 8) & 0xFF;
  const newEndLo = newEndAddr & 0xFF;
  const hiIdx = prog.header.byteIndex + 4;
  const loIdx = prog.header.byteIndex + 5;

  // Snapshot full header originals before replacing, so displaced values can
  // be stored in originalBytesDelta — same pattern as fixLinePointers.
  const fullOriginal = getHeaderOriginalBytes(prog);
  prog.bytes[hiIdx] = fullOriginal.length > 4 && newEndHi === fullOriginal[4].v ? fullOriginal[4]
    : { v: newEndHi, firstBit: 0, lastBit: 0, unclear: false, chkErr: false, edited: 'automatic' };
  prog.bytes[loIdx] = fullOriginal.length > 5 && newEndLo === fullOriginal[5].v ? fullOriginal[5]
    : { v: newEndLo, firstBit: 0, lastBit: 0, unclear: false, chkErr: false, edited: 'automatic' };
  storeHeaderOriginalBytesDelta(prog, fullOriginal);

  // Keep the parsed header field in sync with the rewritten bytes.
  prog.header.endAddr = newEndAddr;
}

/**
 * Normalise the structural bytes of a BASIC program in place, so it round-trips
 * cleanly through the TAP encoder/decoder cycle:
 *
 *   1. Ensure every line ends with a 0x00 terminator (inserting one where
 *      missing, e.g. the recovered-last-line case where the decoder hit
 *      end-of-stream before finding a terminator).
 *   2. Ensure the 0x00 0x00 end-of-program marker is present immediately
 *      after the last line.
 *   3. Recalculate every line's next-line pointer to match the final byte
 *      layout (catching both layout changes from step 1 and any pre-existing
 *      pointer corruption).
 *   4. Recalculate the header's end address (byteIndex+4..+5) to match the
 *      program's actual final size.
 *
 * All inserted and replaced bytes are marked edited: 'automatic'.  Displaced
 * originals are preserved in line.originalBytesDelta for phase 3 replacements
 * and prog.header.originalBytesDelta for phase 4; the inserted terminators
 * and end-of-program bytes have no prior original.
 *
 * Trailing or preceding bytes in prog.bytes are never removed — the user may
 * still care about them, and the TAP encoder simply doesn't include them in
 * the serialised output.
 *
 * Idempotent: calling on an already-clean program produces no byte changes.
 */
export function fixPointersAndTerminators(prog: Program): void {
  // Phase 1 — insert missing line terminators.
  for (let li = 0; li < prog.lines.length; li++) {
    const line = prog.lines[li];
    if (prog.bytes[line.lastByte]?.v !== 0x00) {
      const zero: ByteInfo = { v: 0x00, firstBit: 0, lastBit: 0, unclear: false, chkErr: false, edited: 'automatic' };
      prog.bytes.splice(line.lastByte + 1, 0, zero);
      line.lastByte += 1;
      // Shift subsequent lines' byte-stream positions to account for the
      // inserted byte.  Pointer values are intentionally left stale here;
      // phase 3 (fixLinePointers) recomputes them all from scratch.
      for (let lj = li + 1; lj < prog.lines.length; lj++) {
        prog.lines[lj].firstByte += 1;
        prog.lines[lj].lastByte  += 1;
      }
    }
  }

  // Phase 2 — insert missing end-of-program marker (0x00 0x00).
  if (prog.lines.length > 0) {
    const lastLine = prog.lines[prog.lines.length - 1];
    const endMarkerStart = lastLine.lastByte + 1;
    // Count contiguous 0x00 bytes already present from endMarkerStart.  We
    // want 2; insert however many are missing.  Never replace existing
    // non-zero bytes — just splice zeros in before them.
    let existing = 0;
    while (existing < 2 && prog.bytes[endMarkerStart + existing]?.v === 0x00) existing++;
    const needed = 2 - existing;
    if (needed > 0) {
      const insertPos = endMarkerStart + existing;
      const toInsert: ByteInfo[] = [];
      for (let i = 0; i < needed; i++) {
        toInsert.push({ v: 0x00, firstBit: 0, lastBit: 0, unclear: false, chkErr: false, edited: 'automatic' });
      }
      prog.bytes.splice(insertPos, 0, ...toInsert);
      // No LineInfo positions to update — the marker sits after the last line.
    }
  }

  // Phase 3 — recalculate every line's next-line pointer.
  fixLinePointers(prog);

  // Phase 4 — recalculate the header's end address to match the final program size.
  fixHeaderEndAddr(prog);

  // Re-run post-processing flags to reflect the now-normalised state.
  flagAll(prog);
}
