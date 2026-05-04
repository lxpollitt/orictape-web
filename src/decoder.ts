// Copyright © 2015 The Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { flagTokenisationMismatches, byteSequenceSyntaxChecker } from './editor';

// BitInfo is used by the UI when reading individual bits out of a BitStream.
export interface BitInfo {
  v: 0 | 1;
  l1: number;
  firstSample: number;
  lastSample: number;
  unclear: boolean;
}

export interface ByteInfo {
  v: number;       // 0-255
  firstBit: number;
  lastBit: number;
  unclear: boolean;
  chkErr: boolean;
  edited?: 'explicit' | 'automatic';  // set on bytes created or modified by editing (no waveform backing)
  originalIndex?: number;  // sequential position in the original (pre-edit) byte stream. Undefined for edited bytes.
}

export interface LineInfo {
  v: string;
  elements: string[];
  firstByte: number;
  lastByte: number;
  lenErr: boolean;
  /** Set on the last parsed line when the BASIC end-of-program null pointer
   *  was encountered before the header's declared end address.  The line
   *  itself may be byte-clean; the flag marks the point where the program
   *  ended unexpectedly early. */
  earlyEnd?: boolean;
  /** Set when the line's line number is not part of the longest increasing
   *  subsequence of line numbers in the program — i.e. it breaks the expected
   *  monotonic ordering, likely due to a corrupt line-number byte. */
  nonMonotonic?: boolean;
  /** Set when re-tokenising the line's text produces different bytes than
   *  the original — indicates the stored bytes aren't valid tokenised BASIC. */
  tokenisationMismatch?: boolean;
  /** Set when the line's total stored size (next-line pointer through
   *  null terminator inclusive) exceeds 255 bytes.  Above this limit
   *  Oric BASIC's editor can't load the line into its 255-byte line
   *  buffer — neither 1.0 nor 1.1 cope: 1.0 won't let you edit other
   *  lines in such a program either, and 1.1 hangs as soon as the
   *  program is loaded.  Computed as `lastByte - firstByte + 1 > 255`. */
  tooLong?: boolean;
  /** Per-element error severity. Null/undefined = no element-level issues.
   *  When present, one entry per element: 'error', 'warning', or null (clean). */
  elementErrors?: ('error' | 'warning' | null)[];
  // Syntax-level element issue counts, populated by buildLineElements.
  unknownKeywordCount?: number;        // error: keyword byte beyond KEYWORDS table
  keywordInLiteralCount?: number;      // error: keyword token inside string/rem/data
  invalidReservedCharCount?: number;   // error: literal byte in code mode that should be a keyword token
  invalidNonPrintableCount?: number;   // error: non-printable character in code mode
  nonPrintableInLiteralCount?: number; // warning: non-printable character in string/rem/data
  /** Delta of original bytes displaced by editing — only stores bytes no longer
   *  in the current line. Used with getFullOriginalBytes/storeOriginalBytesDelta
   *  to reconstruct the full original for LCS comparisons. */
  originalBytesDelta?: ByteInfo[];
  /** User has acknowledged the line's errors and wants them visually suppressed. */
  ignoreErrors?: boolean;
  /** Cached line health — set by lineHealth(), cleared by invalidateLineHealth(). */
  _health?: LineSeverity;
}

// ── Line health utilities ────────────────────────────────────────────────────

export type LineSeverity = 'error' | 'warning' | 'clean';

export interface LineStatus {
  message:  string;
  severity: 'error' | 'warning';
}

/**
 * Determine the overall health of a line: 'error', 'warning', or 'clean'.
 * Considers both line-level flags and byte-level flags.
 */
export function lineHealth(prog: Program, lineIdx: number): LineSeverity {
  const line = prog.lines[lineIdx];
  if (line._health !== undefined) return line._health;

  let health: LineSeverity = 'clean';

  // Line-level flags.
  if (line.lenErr || line.earlyEnd || line.nonMonotonic || line.tokenisationMismatch || line.tooLong) {
    health = 'error';
  }

  // Element-level syntax errors/warnings.
  if (health !== 'error' && line.elementErrors) {
    for (const e of line.elementErrors) {
      if (e === 'error') { health = 'error'; break; }
      if (e === 'warning') health = 'warning';
    }
  }

  // Byte-level waveform errors.
  if (health !== 'error') {
    for (let i = line.firstByte; i <= line.lastByte; i++) {
      if (prog.bytes[i]?.chkErr) { health = 'error'; break; }
    }
  }
  if (health !== 'error') {
    for (let i = line.firstByte; i <= line.lastByte; i++) {
      if (prog.bytes[i]?.unclear && health === 'clean') health = 'warning';
    }
  }

  line._health = health;
  return health;
}

/**
 * Invalidate the cached health for a line, forcing recalculation on next access.
 */
export function invalidateLineHealth(line: LineInfo): void {
  line._health = undefined;
}

/**
 * Oric memory address of this line's first byte.  For the first line this is
 * the header's start address; for subsequent lines it's the previous line's
 * next-line pointer value.  Pointer-driven: if a previous line had a corrupt
 * pointer, this line's firstAddr reflects what the pointer SAYS rather than
 * where the bytes actually sit in the canonical byte-position-to-address
 * mapping.  The divergence shows up as lenErr.
 */
export function lineFirstAddr(prog: Program, lineIdx: number): number {
  if (lineIdx === 0) return prog.header.startAddr;
  return lineNextAddr(prog, lineIdx - 1);
}

/**
 * Value of this line's next-line pointer (2 bytes at firstByte, little-endian)
 * \u2014 the memory address where the next line should start.  Read directly
 * from prog.bytes so it's always consistent with the current byte state.
 */
export function lineNextAddr(prog: Program, lineIdx: number): number {
  const line = prog.lines[lineIdx];
  return prog.bytes[line.firstByte].v | (prog.bytes[line.firstByte + 1].v << 8);
}

/**
 * Return true if the line has any hard error (chkErr bytes, structural issues).
 * Unclear-only lines return false.
 */
export function lineHasHardError(prog: Program, lineIdx: number): boolean {
  return lineHealth(prog, lineIdx) === 'error';
}

/**
 * Return a list of status messages for a line, describing each issue found.
 * Used by the status bar and other UI elements that need to display error details.
 */
export function lineStatuses(prog: Program, lineIdx: number): LineStatus[] {
  const line = prog.lines[lineIdx];
  const statuses: LineStatus[] = [];

  if (line.earlyEnd) {
    statuses.push({ message: 'Unexpected end of program · null pointer before header end address', severity: 'error' });
  }
  if (line.lenErr) {
    const expected = lineNextAddr(prog, lineIdx) - lineFirstAddr(prog, lineIdx);
    const actual   = line.lastByte - line.firstByte + 1;
    statuses.push({ message: `Line length error (expected ${expected} bytes, found ${actual})`, severity: 'error' });
  }
  if (line.nonMonotonic) {
    statuses.push({ message: 'Non-monotonic line number', severity: 'error' });
  }
  if (line.tokenisationMismatch) {
    statuses.push({ message: 'Tokenisation mismatch', severity: 'error' });
  }
  if (line.tooLong) {
    statuses.push({ message: 'Line exceeds 255-byte maximum', severity: 'error' });
  }

  // Element-level syntax issues (counts populated by buildLineElements).
  if (line.unknownKeywordCount) {
    const n = line.unknownKeywordCount;
    statuses.push({ message: `${n} unknown keyword${n !== 1 ? 's' : ''}`, severity: 'error' });
  }
  if (line.keywordInLiteralCount) {
    const n = line.keywordInLiteralCount;
    statuses.push({ message: `${n} unexpected keyword${n !== 1 ? 's' : ''} in literal`, severity: 'error' });
  }
  if (line.invalidReservedCharCount) {
    const n = line.invalidReservedCharCount;
    statuses.push({ message: `${n} invalid reserved character${n !== 1 ? 's' : ''}`, severity: 'error' });
  }
  if (line.invalidNonPrintableCount) {
    const n = line.invalidNonPrintableCount;
    statuses.push({ message: `${n} invalid non-printable character${n !== 1 ? 's' : ''}`, severity: 'error' });
  }
  if (line.nonPrintableInLiteralCount) {
    const n = line.nonPrintableInLiteralCount;
    statuses.push({ message: `${n} non-printable character${n !== 1 ? 's' : ''}`, severity: 'warning' });
  }

  // Byte-level waveform issues (summarised, not per-byte).
  let chkErrCount = 0;
  let unclearCount = 0;
  for (let i = line.firstByte; i <= line.lastByte; i++) {
    const b = prog.bytes[i];
    if (b?.chkErr)       chkErrCount++;
    else if (b?.unclear) unclearCount++;
  }
  if (chkErrCount > 0) {
    statuses.push({ message: `${chkErrCount} checksum error byte${chkErrCount !== 1 ? 's' : ''}`, severity: 'error' });
  }
  if (unclearCount > 0) {
    statuses.push({ message: `${unclearCount} unclear byte${unclearCount !== 1 ? 's' : ''}`, severity: 'warning' });
  }

  return statuses;
}

/**
 * Determine the highest severity across all lines in a program.
 */
export function programHealth(prog: Program): LineSeverity {
  let worst: LineSeverity = 'clean';
  for (let i = 0; i < prog.lines.length; i++) {
    const h = lineHealth(prog, i);
    if (h === 'error') return 'error';
    if (h === 'warning') worst = 'warning';
  }
  return worst;
}

/**
 * True if the program contains at least one byte marked as an explicit
 * (user-typed) edit.  Automatic edits (e.g. pointer fixups) don't count
 * because they get re-derived on reparse and aren't user-entered state.
 *
 * Used by destructive UI actions (e.g. split / join) to decide whether
 * to surface a "your edits will be lost" warning to the user.
 */
export function programHasExplicitEdits(prog: Program): boolean {
  return prog.bytes.some(b => b.edited === 'explicit');
}

/**
 * Summarise error/warning counts across all lines in a program.
 * Returns a compact array of { label, count, severity } suitable for display.
 */
export function programSummary(prog: Program): { label: string; count: number; severity: LineSeverity }[] {
  let errorLines = 0;
  let warningLines = 0;
  let cleanLines = 0;
  for (let i = 0; i < prog.lines.length; i++) {
    const h = lineHealth(prog, i);
    if (h === 'error') errorLines++;
    else if (h === 'warning') warningLines++;
    else cleanLines++;
  }
  const result: { label: string; count: number; severity: LineSeverity }[] = [];
  result.push({ label: 'lines', count: prog.lines.length, severity: 'clean' });
  if (cleanLines > 0)   result.push({ label: 'clean', count: cleanLines, severity: 'clean' });
  if (errorLines > 0)   result.push({ label: 'errors', count: errorLines, severity: 'error' });
  if (warningLines > 0) result.push({ label: 'warnings', count: warningLines, severity: 'warning' });
  return result;
}


/**
 * Build the elements array and display text for a line from its bytes.
 * Uses byteSequenceSyntaxChecker to decide whether bytes need escaping
 * (e.g. literal ASCII that should have been a keyword token).
 * Sets line.v and line.elements.
 */
export function buildLineElements(line: LineInfo, bytes: ByteInfo[]): void {
  const elements: string[] = [];
  const errors: ('error' | 'warning' | null)[] = [];
  let hasAnyError = false;

  // Reset syntax-level counters.
  let unknownKeywordCount = 0;
  let keywordInLiteralCount = 0;
  let invalidReservedCharCount = 0;
  let invalidNonPrintableCount = 0;
  let nonPrintableInLiteralCount = 0;

  // Line number from bytes: firstByte+2 (lo) and firstByte+3 (hi).
  const lineNum = bytes[line.firstByte + 2].v + bytes[line.firstByte + 3].v * 256;
  elements.push(`${lineNum} `);
  errors.push(null);  // line number element — syntax checker doesn't cover this

  // Content bytes: firstByte+4 to lastByte. (The lastByte should be the 0x00 terminator,
  // but corrupt lines may have it earlier or missing in rare cases. Known example is from
  // the last line of the program, but this code is more defensive and copes with all lines.)
  byteSequenceSyntaxChecker(0x00, true);  // reset
  for (let i = line.firstByte + 4; i <= line.lastByte; i++) {
    const b = bytes[i].v;
    if (b === 0) break;  // terminator
    const syntax = byteSequenceSyntaxChecker(b);
    if (syntax.severity !== 'ok') {
      elements.push(`«0x${b.toString(16).toUpperCase().padStart(2, '0')}»`);
      errors.push(syntax.severity);
      hasAnyError = true;
      // Increment the appropriate counter using the reason from the syntax checker.
      if (syntax.reason === 'unknownKeyword') unknownKeywordCount++;
      else if (syntax.reason === 'keywordInLiteral') keywordInLiteralCount++;
      else if (syntax.reason === 'invalidReservedChar') invalidReservedCharCount++;
      else if (syntax.reason === 'invalidNonPrintable') invalidNonPrintableCount++;
      else if (syntax.reason === 'nonPrintableInLiteral') nonPrintableInLiteralCount++;
    } else if (b >= 0x20 && b <= 0x7E) {
      elements.push(String.fromCharCode(b));
      errors.push(null);
    } else if (b >= 0x80 && (b - 0x80) < KEYWORDS.length) {
      elements.push(KEYWORDS[b - 0x80]);
      errors.push(null);
    } else {
      elements.push(`«0x${b.toString(16).toUpperCase().padStart(2, '0')}»`);
      errors.push('error');
      hasAnyError = true;
    }
  }
  line.v = elements.join('');
  line.elements = elements;
  line.elementErrors = hasAnyError ? errors : undefined;
  // Stored line size = (lastByte - firstByte + 1), counting the
  // 2-byte next-line pointer, 2 line-number bytes, content bytes,
  // and the trailing 0x00 terminator.  Oric BASIC's line buffer
  // tops out at 255 bytes — anything bigger is unloadable on 1.1
  // and uneditable on 1.0.
  line.tooLong = (line.lastByte - line.firstByte + 1) > 255;
  line.unknownKeywordCount = unknownKeywordCount || undefined;
  line.keywordInLiteralCount = keywordInLiteralCount || undefined;
  line.invalidReservedCharCount = invalidReservedCharCount || undefined;
  line.invalidNonPrintableCount = invalidNonPrintableCount || undefined;
  line.nonPrintableInLiteralCount = nonPrintableInLiteralCount || undefined;
  invalidateLineHealth(line);
}

/**
 * Populate per-element error severities on each line in a program.
 * Consolidates all element-level error detection into one pass:
 *   - Non-monotonic line number (element 0) → 'error'
 *   - [UNKNOWN_KEYWORD] element → 'error'
 *   - Syntax mismatch at this element's byte → 'error'
 *   - Underlying byte has chkErr → 'error'
 *   - Underlying byte has unclear → 'warning'
 *
 * Only allocates the elementErrors array if at least one element has an issue.
 * Must be called after flagNonMonotonicLines and flagTokenisationMismatches.
 */
export function flagElementErrors(prog: Program): void {
  for (let li = 0; li < prog.lines.length; li++) {
    const line = prog.lines[li];
    // Start from syntax-level errors set by buildLineElements, or a fresh array.
    const errors: ('error' | 'warning' | null)[] = line.elementErrors
      ? [...line.elementErrors]
      : new Array(line.elements.length).fill(null);
    let hasAny = errors.some(e => e !== null);

    for (let ei = 0; ei < line.elements.length; ei++) {
      let severity = errors[ei];

      // Non-monotonic line number.
      if (ei === 0 && line.nonMonotonic && severity !== 'error') {
        severity = 'error';
      }

      // Byte-level flags (only if no harder error already set).
      if (!severity) {
        if (ei === 0) {
          const b2 = prog.bytes[line.firstByte + 2];
          const b3 = prog.bytes[line.firstByte + 3];
          if (b2?.chkErr || b3?.chkErr)       severity = 'error';
          else if (b2?.unclear || b3?.unclear) severity = 'warning';
        } else {
          const b = prog.bytes[line.firstByte + 3 + ei];
          if (b?.chkErr)       severity = 'error';
          else if (b?.unclear) severity = 'warning';
        }
      }

      errors[ei] = severity;
      if (severity) hasAny = true;
    }

    line.elementErrors = hasAny ? errors : undefined;
    invalidateLineHealth(line);
  }
}

// BitStream stores bit data in struct-of-arrays layout using TypedArrays.
// This is ~10x more memory-efficient than an array of BitInfo objects and
// reduces GC pressure significantly for large tape recordings.
// All parallel arrays have length === bitCount after decoding.
export interface BitStream {
  format: 'fast' | 'slow';
  bitCount: number;
  bitV: Uint8Array;            // bit value: 0 or 1
  bitL1: Uint16Array;          // first half-cycle length (samples; L2 = bitLength - L1)
  bitFirstSample: Uint32Array;
  bitLastSample: Uint32Array;
  bitUnclear: Uint8Array;      // 0 = clean, 1 = unclear
  bitMaxIndex: Uint32Array;    // debug: sample index of the max found by readCycle
  bitMinIndex: Uint32Array;    // debug: sample index of the min found by readCycle
  // Note: raw samples are NOT stored here. The UI holds them separately
  // (from the original WAV parse) to avoid duplicating 20MB per stream.
  firstSample: number;
  lastSample: number;
  minVal: number;
  maxVal: number;
}

// Helper to read a single bit as a plain object (for UI use).
export function streamBitAt(s: BitStream, i: number): BitInfo {
  return {
    v: s.bitV[i] as 0 | 1,
    l1: s.bitL1[i],
    firstSample: s.bitFirstSample[i],
    lastSample: s.bitLastSample[i],
    unclear: s.bitUnclear[i] === 1,
  };
}

/**
 * Build a minimal empty BitStream — used for Programs that have no waveform
 * data (e.g. loaded from TAP files, or synthesized by the merger).
 */
export function emptyBitStream(format: 'fast' | 'slow' = 'fast'): BitStream {
  return {
    format,
    bitCount:       0,
    bitV:           new Uint8Array(0),
    bitL1:          new Uint16Array(0),
    bitFirstSample: new Uint32Array(0),
    bitLastSample:  new Uint32Array(0),
    bitUnclear:     new Uint8Array(0),
    bitMaxIndex:    new Uint32Array(0),
    bitMinIndex:    new Uint32Array(0),
    firstSample:    0,
    lastSample:     0,
    minVal:         0,
    maxVal:         0,
  };
}

/**
 * Split a BitStream into two at a given bit position.
 *
 * Returns [first, second] where `first` holds bits [0, bitPos) and `second`
 * holds bits [bitPos, bitCount).  Per-bit typed arrays are sliced into fresh
 * compact copies so the two halves own their own buffers (the original can
 * be garbage-collected when no longer referenced).
 *
 * Per-stream metadata is computed as follows:
 *   - `format` inherited by both halves
 *   - `firstSample` / `lastSample`: outer edges match the parent; inner
 *      edges come from the bit at the split boundary
 *   - `minVal` / `maxVal` inherited by both halves.  Each half's true
 *      amplitude range is a subset of the parent's, so inheriting gives
 *      conservative bounds — re-scanning is unnecessary for the UI
 *      thresholds that consume these values
 *
 * Edge cases:
 *   - `bitPos === 0` → first is empty, second is the whole stream
 *   - `bitPos === bitCount` → first is the whole stream, second is empty
 *
 * Throws if `bitPos` is outside [0, bitCount].
 */
export function splitBitStream(stream: BitStream, bitPos: number): [BitStream, BitStream] {
  const n = stream.bitCount;
  if (bitPos < 0 || bitPos > n) {
    throw new Error(`splitBitStream: bitPos ${bitPos} out of range [0, ${n}]`);
  }
  const first: BitStream = {
    format:         stream.format,
    bitCount:       bitPos,
    bitV:           stream.bitV.slice(0, bitPos),
    bitL1:          stream.bitL1.slice(0, bitPos),
    bitFirstSample: stream.bitFirstSample.slice(0, bitPos),
    bitLastSample:  stream.bitLastSample.slice(0, bitPos),
    bitUnclear:     stream.bitUnclear.slice(0, bitPos),
    bitMaxIndex:    stream.bitMaxIndex.slice(0, bitPos),
    bitMinIndex:    stream.bitMinIndex.slice(0, bitPos),
    firstSample:    stream.firstSample,
    lastSample:     bitPos > 0 ? stream.bitLastSample[bitPos - 1] : stream.firstSample,
    minVal:         stream.minVal,
    maxVal:         stream.maxVal,
  };
  const second: BitStream = {
    format:         stream.format,
    bitCount:       n - bitPos,
    bitV:           stream.bitV.slice(bitPos),
    bitL1:          stream.bitL1.slice(bitPos),
    bitFirstSample: stream.bitFirstSample.slice(bitPos),
    bitLastSample:  stream.bitLastSample.slice(bitPos),
    bitUnclear:     stream.bitUnclear.slice(bitPos),
    bitMaxIndex:    stream.bitMaxIndex.slice(bitPos),
    bitMinIndex:    stream.bitMinIndex.slice(bitPos),
    firstSample:    bitPos < n ? stream.bitFirstSample[bitPos] : stream.lastSample,
    lastSample:     stream.lastSample,
    minVal:         stream.minVal,
    maxVal:         stream.maxVal,
  };
  return [first, second];
}

/**
 * Concatenate one or more BitStreams into a single stream, in order.
 *
 * Per-bit typed arrays are concatenated in input order.  Each bit keeps its
 * original sample positions — so when the inputs came from non-adjacent
 * audio regions (e.g. user-initiated join across an audio gap), the result's
 * bitFirstSample / bitLastSample arrays are NOT monotonic: there will be a
 * jump at each seam.  This is fine for byte decoding (which indexes by bit
 * position, not sample position) and the waveform view renders the gap
 * naturally because it draws each bit at its own sample position.
 *
 * Per-stream metadata:
 *   - `format`: all inputs must match; throws otherwise
 *   - `firstSample`: first input's firstSample
 *   - `lastSample`:  last input's lastSample
 *   - `minVal` / `maxVal`: min / max across all inputs
 *
 * Throws if the input array is empty or the formats differ.  A single-stream
 * join returns the input unchanged (no defensive copy).
 */
export function joinBitStreams(streams: BitStream[]): BitStream {
  if (streams.length === 0) {
    throw new Error('joinBitStreams: need at least one stream to join');
  }
  if (streams.length === 1) return streams[0];

  const format = streams[0].format;
  for (let i = 1; i < streams.length; i++) {
    if (streams[i].format !== format) {
      throw new Error(
        `joinBitStreams: format mismatch at index ${i} ('${streams[i].format}' vs '${format}')`,
      );
    }
  }
  const total = streams.reduce((n, s) => n + s.bitCount, 0);

  const bitV           = new Uint8Array(total);
  const bitL1          = new Uint16Array(total);
  const bitFirstSample = new Uint32Array(total);
  const bitLastSample  = new Uint32Array(total);
  const bitUnclear     = new Uint8Array(total);
  const bitMaxIndex    = new Uint32Array(total);
  const bitMinIndex    = new Uint32Array(total);
  let offset = 0;
  let minVal = streams[0].minVal;
  let maxVal = streams[0].maxVal;
  for (const s of streams) {
    bitV          .set(s.bitV,           offset);
    bitL1         .set(s.bitL1,          offset);
    bitFirstSample.set(s.bitFirstSample, offset);
    bitLastSample .set(s.bitLastSample,  offset);
    bitUnclear    .set(s.bitUnclear,     offset);
    bitMaxIndex   .set(s.bitMaxIndex,    offset);
    bitMinIndex   .set(s.bitMinIndex,    offset);
    offset += s.bitCount;
    if (s.minVal < minVal) minVal = s.minVal;
    if (s.maxVal > maxVal) maxVal = s.maxVal;
  }

  return {
    format,
    bitCount:       total,
    bitV,
    bitL1,
    bitFirstSample,
    bitLastSample,
    bitUnclear,
    bitMaxIndex,
    bitMinIndex,
    firstSample: streams[0].firstSample,
    lastSample:  streams[streams.length - 1].lastSample,
    minVal,
    maxVal,
  };
}

export interface ProgramHeader {
  /** Byte index of the first header byte (after the 0x24 sync marker)
   *  within the bytes[] array. */
  byteIndex:  number;
  /** 0x00 = BASIC, 0x80 = machine code (as observed in real Oric
   *  TAPs; matches the `describeProgRegion` inspector labels).
   *  Other values appear occasionally in the wild and are passed
   *  through verbatim; downstream code treats any non-zero value
   *  as machine code. */
  fileType:   number;
  /** True if the program should auto-run on load.  The ROM checks
   *  bit 7 of header byte 3; specific values observed in real TAPs
   *  are `0x80` (autorun as BASIC) and `0xC7` (autorun as machine
   *  code — ROM JMPs to startAddr).  `0x00` means no autorun. */
  autorun:    boolean;
  /** First byte of program data in Oric memory (big-endian from header). */
  startAddr:  number;
  /** First byte past program data in Oric memory (big-endian from header, exclusive). */
  endAddr:    number;
  /** Delta of original header bytes displaced by editing — same pattern as
   *  LineInfo.originalBytesDelta, used with getHeaderOriginalBytes /
   *  storeHeaderOriginalBytesDelta. */
  originalBytesDelta?: ByteInfo[];
}

export interface Program {
  stream: BitStream;
  bytes: ByteInfo[];
  lines: LineInfo[];
  name: string;
  /** Human-readable identifier of where this program originally came from,
   *  snapshotted at load time.  For a WAV-decoded program, matches the
   *  status-bar format `${base}_${name}_${startSec}s`.  For a TAP-loaded
   *  program, comes from the TAP's ORICTAPE_META metadata if present, or
   *  falls back to the TAP filename.  For a merge result,
   *  `"Merge of ${a.originalSource} + ${b.originalSource}"`.  Preserved
   *  across split/join (split's first half keeps its value, second half
   *  is recomputed by the caller; join inherits the first input's).
   *  Persisted in TAP metadata as `source`.  Empty string means "not
   *  yet set by the caller" — decoder-level construction sites leave
   *  this empty; main.ts / merger.ts / split-join callers fill it in. */
  originalSource: string;
  /** Stable user-facing identifier assigned once at load time.  Monotonic:
   *  never reused after a program is closed.  Used for display in tab titles,
   *  merge source labels, TAP builder UI, etc.  Set by main.ts after the
   *  program is produced by readPrograms / parseTapFile. */
  progNumber: number;
  /** Parsed header fields. Set by readProgramLines. */
  header: ProgramHeader;
  /** Set when the BASIC end-of-program null pointer (0x00 0x00) was
   *  encountered before the address range declared in the tape header was
   *  exhausted.  Condition 1 already handles the normal case where the null
   *  pointer sits right at endAddr–2, so this flag fires only when the
   *  pointer appears unexpectedly early. */
  earlyTermination?: boolean;
  /** True when the program has one or more issues that
   *  fixPointersAndTerminators would address — i.e. a missing line
   *  terminator, missing end-of-program marker, or a next-line pointer
   *  inconsistent with a line's actual extent. */
  pointerAndTerminatorIssues?: boolean;
  /** True when the program has been modified since it was last
   *  saved (or loaded — fresh loads count as saved).  Set by the
   *  user-facing edit functions in editor.ts (`applyLineEdit`,
   *  `deleteLineEdit`, `splitLineWithEdits`, `joinLinesWithEdit`,
   *  `restoreLineToOriginalBytes`); cleared by the save paths in
   *  main.ts (Cmd/Ctrl+S quick-save and Build TAP).  Used to drive
   *  the `beforeunload` warning so users don't lose work to an
   *  accidental refresh, tab close, or dev-server reload. */
  unsaved?: boolean;
}

export const KEYWORDS: string[] = [
  'END', 'EDIT', 'STORE', 'RECALL', 'TRON', 'TROFF', 'POP', 'PLOT',
  'PULL', 'LORES', 'DOKE', 'REPEAT', 'UNTIL', 'FOR', 'LLIST', 'LPRINT', 'NEXT', 'DATA',
  'INPUT', 'DIM', 'CLS', 'READ', 'LET', 'GOTO', 'RUN', 'IF', 'RESTORE', 'GOSUB', 'RETURN',
  'REM', 'HIMEM', 'GRAB', 'RELEASE', 'TEXT', 'HIRES', 'SHOOT', 'EXPLODE', 'ZAP', 'PING',
  'SOUND', 'MUSIC', 'PLAY', 'CURSET', 'CURMOV', 'DRAW', 'CIRCLE', 'PATTERN', 'FILL',
  'CHAR', 'PAPER', 'INK', 'STOP', 'ON', 'WAIT', 'CLOAD', 'CSAVE', 'DEF', 'POKE', 'PRINT',
  'CONT', 'LIST', 'CLEAR', 'GET', 'CALL', '!', 'NEW', 'TAB(', 'TO', 'FN', 'SPC(', '@',
  'AUTO', 'ELSE', 'THEN', 'NOT', 'STEP', '+', '-', '*', '/', '^', 'AND', 'OR', '>', '=', '<',
  'SGN', 'INT', 'ABS', 'USR', 'FRE', 'POS', 'HEX$', '&', 'SQR', 'RND', 'LN', 'EXP', 'COS',
  'SIN', 'TAN', 'ATN', 'PEEK', 'DEEK', 'LOG', 'LEN', 'STR$', 'VAL', 'ASC', 'CHR$', 'PI',
  'TRUE', 'FALSE', 'KEY$', 'SCRN', 'POINT', 'LEFT$', 'RIGHT$', 'MID$',
];

// Token bytes for keywords that trigger tokenisation state changes.
export const TOKEN_REM  = 0x80 + KEYWORDS.indexOf('REM');   // 0x9D
export const TOKEN_BANG = 0x80 + KEYWORDS.indexOf('!');     // 0xC0
export const TOKEN_DATA = 0x80 + KEYWORDS.indexOf('DATA');  // 0x91

// Token bytes for BASIC verbs that are back-patch targets.  Each takes
// a 16-bit address as its first argument (CALL/DOKE/POKE as a statement;
// PEEK/DEEK as a function inside an expression).  Used by asmApply to
// find patch sites after a re-assembly pass.
export const TOKEN_CALL = 0x80 + KEYWORDS.indexOf('CALL');  // 0xBF
export const TOKEN_POKE = 0x80 + KEYWORDS.indexOf('POKE');  // 0xB9
export const TOKEN_DOKE = 0x80 + KEYWORDS.indexOf('DOKE');  // 0x8A
export const TOKEN_PEEK = 0x80 + KEYWORDS.indexOf('PEEK');  // 0xE6
export const TOKEN_DEEK = 0x80 + KEYWORDS.indexOf('DEEK');  // 0xE7
// FOR / TO form a compound 2-patch-site (`FOR var=start TO end`).
// Both tokens are listed so asmApply can locate the two literals.
export const TOKEN_FOR  = 0x80 + KEYWORDS.indexOf('FOR');
export const TOKEN_TO   = 0x80 + KEYWORDS.indexOf('TO');
// Oric BASIC tokenises `=` into its own byte, so FOR's preamble walker
// needs to recognise it as the marker between variable name and
// start-address literal.  Exposed here so asmApply can consume it.
export const TOKEN_EQ   = 0x80 + KEYWORDS.indexOf('=');

// Literal byte values that are invalid in code mode — the Oric tokeniser would
// have produced keyword tokens for these, so seeing them as literals indicates
// corruption or non-standard program creation.
export const INVALID_CODE_LITERALS = new Set(
  KEYWORDS.filter(kw => kw.length === 1).map(kw => kw.charCodeAt(0))
    .concat(0x3F)  // ? (PRINT shorthand)
);

export function readBitStreams(samples: Int16Array, sampleRate = 44100): BitStream[] {
  // Compute file-level peak amplitude once, used to scale noise floor thresholds
  // to compensate for different ADC recording levels.
  let fileMin = 0, fileMax = 0;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i] < fileMin) fileMin = samples[i];
    if (samples[i] > fileMax) fileMax = samples[i];
  }
  const filePeakAmplitude = fileMax - fileMin;

  const streams: BitStream[] = [];
  let startSample = 0;
  while (true) {
    const { stream, samplesRead } = readBitStream(samples, startSample, sampleRate, filePeakAmplitude);
    if (samplesRead === 0) break;
    streams.push(stream);
    startSample += samplesRead;
  }

  // Adaptive amplitude filter: discard streams that look like noise rather than
  // a real tape signal.  The noise floor of a typical ADC + tape player is
  // 10–50× quieter than an actual recording, so we keep only streams whose
  // peak-to-peak amplitude is at least 10% of the loudest stream found.
  if (streams.length > 1) {
    const peakAmplitude = Math.max(...streams.map(s => s.maxVal - s.minVal));
    const threshold = peakAmplitude * 0.1;
    return streams.filter(s => s.maxVal - s.minVal >= threshold);
  }
  return streams;
}

function readBitStream(samples: Int16Array, startSample: number, sampleRate: number, filePeakAmplitude: number): { stream: BitStream; samplesRead: number } {
  // Cycle classification thresholds, all scaled with sample rate.
  //
  // At 48000 Hz the three expected full-cycle lengths are:
  //   short  (2400 Hz) ≈ 20 samples  - bit 1 in both fast and slow format
  //   medium (1600 Hz) ≈ 30 samples  - bit 0 in fast format only
  //   long   (1200 Hz) ≈ 40 samples  - bit 0 (×4) in slow format only
  //
  // Scaled to 44100 Hz (our scaling will round to nearest integer):
  //   short  (2400 Hz) ≈ 18 (18.3750) samples  - bit 1 in both fast and slow format
  //   medium (1600 Hz) ≈ 28 (27.5625) samples  - bit 0 in fast format only
  //   long   (1200 Hz) ≈ 37 (36.7500) samples  - bit 0 (×4) in slow format only
  //
  const SHORT_MIN     = Math.round(18 * sampleRate / 48000);  // 15 at 44100 Hz
  const SHORT_MAX     = Math.round(22 * sampleRate / 48000);  // 20 at 44100 Hz
  const MEDIUM_MIN    = Math.round(26 * sampleRate / 48000);  // 24 at 44100 Hz
  const MEDIUM_MAX    = Math.round(34 * sampleRate / 48000);  // 31 at 44100 Hz
  const LONG_MIN      = Math.round(38 * sampleRate / 48000);  // 35 at 44100 Hz
  const LONG_MAX      = Math.round(44 * sampleRate / 48000);  // 42 at 44100 Hz
  
  // Search window sizes for searching from current peak to next (opposite polarity) peak
  //
  // At 48000 Hz:
  //   short 1/2 cycle  = 10
  //   medium 1/2 cycle = 15
  //   long 1/2 cycle   = 20
  //   medium 3/4 cycle = 0.5*10+20 or 0.5*20+10 = 25 or 20
  //   long 3/4 cycle   = 0.75*40 = 30
  //
  // Short search window = 16 -> 16/20 or 16/25 = 0.8 or 0.64 * 3/4 medium cycle 
  // Long search window = 33 -> 33/30 = 1.1 * 3/4 long cycle 
  // 
  const SMALLEST_SEARCH_WINDOW = Math.round(16 * sampleRate / 48000);   // 15 at 44100 Hz
  const LONGEST_SEARCH_WINDOW  = Math.round(33 * sampleRate / 48000);   // 30 at 44100 Hz
  const TURNAROUND_PCT  = 10;  // % of peak-to-threshold distance to confirm signal has turned around from peak

  // Triggers for unreadable, noisefloor, sync, and abandon etc
  const MIN_UREADABLE_CYCLE_LENGTH = Math.round(55 * sampleRate / 48000);  // Must be > LONG_MAX && < 2*LONGEST_SEARCH_WINDOW
  const NOISE_FLOOR       = Math.max(100, Math.round(filePeakAmplitude * 0.02));   // ~2% of file peak
  const SYNC_NOISE_FLOOR  = Math.max(100, Math.round(filePeakAmplitude * 0.04));   // ~4% of file peak
  const MIN_SYNC_BITS     = 200;  // min continuous cycles before accepting a sync run
  const MAX_POOR_SIGNAL_CYCLES = 180; // max number of poor cycles to accept before terminating a post sync bitstream

  // Pre-allocate TypedArrays sized to the theoretical maximum number of bits
  // (every cycle is the shortest possible). We'll slice to actual size at the end.
  const maxBits = Math.ceil((samples.length - startSample) / SHORT_MAX) + 1;
  const _bitV            = new Uint8Array(maxBits);
  const _bitL1           = new Uint16Array(maxBits);
  const _bitFirstSample  = new Uint32Array(maxBits);
  const _bitLastSample   = new Uint32Array(maxBits);
  const _bitUnclear      = new Uint8Array(maxBits);
  const _bitMaxIndex     = new Uint32Array(maxBits);
  const _bitMinIndex     = new Uint32Array(maxBits);
  let bitCount = 0;

  // Working state shared with readCycle (mirrors the Go closure pattern).
  let minVal = 0, maxVal = 0, threshold = 0;
  let minIndex = 0, maxIndex = startSample, nextMaxIndex = startSample;
  let belowIndex = 0, aboveIndex = startSample;
  let lengthBelow = 0, lengthAbove = 0, length = 0;
  let streamFirstSample = startSample;
  let streamMinVal = 0, streamMaxVal = 0;

  // Cycle classification output (set by readCycle, consumed by pushBit).
  type CycleKind = 'short' | 'medium' | 'long' | 'unreadable';
  let cycleKind:    CycleKind = 'short';
  let cycleUnclear = false;

  /** Measure one waveform cycle and classify it as short, medium, or long.
   *  Returns false if bit is unreadbale / no useful signal found (for section of ~cycle length). */
  const readCycle = (): boolean => {
    // The previous readCycle already had to find this cycle's maxIndex to workout the crossover point
    maxIndex = nextMaxIndex;

    // Find the cycle's minimum. Start searching from the cycle's max.
    // Always search at least SMALLEST_SEARCH_WINDOW samples, but extend up to
    // LONGEST_SEARCH_WINDOW if the signal hasn't turned around enough yet
    // for us to be confident we found the minimum.
    // (Accommodates long cycles without overshooting on short ones, while
    // also being resilient to zero offset wiggle.)
    const minSearchShortestEnd = Math.min(maxIndex + SMALLEST_SEARCH_WINDOW, samples.length);
    const minSearchLongestEnd  = Math.min(maxIndex + LONGEST_SEARCH_WINDOW, samples.length);
    let maxValSinceMin = -32768;
    let turnaroundThreshold = 32767;  // Recalculated each time minVal is updated
    minVal = maxVal;
    minIndex = minSearchLongestEnd;   // Move forwad by search window length if don't find a minVal
    for (let i = maxIndex + 1; i < minSearchLongestEnd; i++) {
      if (samples[i] < minVal) {
        minVal = samples[i]; minIndex = i; maxValSinceMin = minVal;
        turnaroundThreshold = minVal + ((maxVal - minVal) * TURNAROUND_PCT / 100);
      } else if (samples[i] > maxValSinceMin) {
        maxValSinceMin = samples[i];
      }
      if (i >= minSearchShortestEnd && maxValSinceMin >= turnaroundThreshold) break;
    }
    if (minVal < streamMinVal) streamMinVal = minVal;

    // Find the cycle's mid point (the crossover point between the high half of the cycle 
    // and the low half of the cycle).
    threshold = (maxVal + minVal) >> 1;
    belowIndex = maxIndex + 1;
    for (let i = maxIndex + 1; i < minSearchLongestEnd; i++) {
      if (samples[i] <= threshold) { belowIndex = i; break; }
    }
    lengthBelow = belowIndex - aboveIndex;

    // Find next maximum (the maximum in the first half of the next cycle).
    // Same adaptive window: at least SMALLEST, extend up to LONGEST.
    const maxSearchShortestEnd = Math.min(minIndex + SMALLEST_SEARCH_WINDOW, samples.length);
    const maxSearchLongestEnd  = Math.min(minIndex + LONGEST_SEARCH_WINDOW, samples.length);
    let minValSinceMax = 32767;
    turnaroundThreshold = -32768;   // Recalculated each time maxVal is updated
    maxVal = minVal; 
    nextMaxIndex = maxSearchLongestEnd;   // Move forwad by search window length if don't find a minVal
    for (let i = minIndex + 1; i < maxSearchLongestEnd; i++) {
      if (samples[i] > maxVal) {
        maxVal = samples[i]; nextMaxIndex = i; minValSinceMax = maxVal;
        turnaroundThreshold = maxVal - ((maxVal - minVal) * TURNAROUND_PCT / 100);
      } else if (samples[i] < minValSinceMax) {
        minValSinceMax = samples[i];
      }
      if (i >= maxSearchShortestEnd && minValSinceMax <= turnaroundThreshold) break;
    }
    if (maxVal > streamMaxVal) streamMaxVal = maxVal;

    // Find the crossover point rising above threshold.
    threshold = (maxVal + minVal) >> 1;
    aboveIndex = minIndex + 1;
    for (let i = minIndex + 1; i < maxSearchLongestEnd; i++) {
      if (samples[i] >= threshold) { aboveIndex = i; break; }
    }
    lengthAbove = aboveIndex - belowIndex;
    length = lengthBelow + lengthAbove;

    // TODO: Simplify readCycle to returns every GAP, and have higher layer decide how many milliseconds of gaps it cares about
    // so it can make sync decision vs inside a program decision
    // Plus simplify this function as much as possible
    // Same for quiet cycle counting: move to higher level funcion

    // Tri-value cycle classification.
    if (length <= SHORT_MAX) {
      cycleKind = 'short';
    } else if (length < MEDIUM_MIN) {
      // Unclear zone between short and medium — use half-cycle asymmetry heuristic.
      cycleKind = Math.abs(lengthBelow - lengthAbove) <= (MEDIUM_MIN - SHORT_MAX) >> 1
        ? 'medium' : 'short';
    } else if (length <= MEDIUM_MAX) {
      cycleKind = 'medium';
    } else if (length < LONG_MIN) {
      // Unclear zone between medium and long — classify as nearest.
      cycleKind = (length - MEDIUM_MAX) <= (LONG_MIN - length) ? 'medium' : 'long';
    } else if (length < MIN_UREADABLE_CYCLE_LENGTH) {
      cycleKind = 'long'; 
    } else {
      cycleKind = 'unreadable';
    }

    // Unclear flag: set when the cycle falls outside confident bands or near noise floor.
    cycleUnclear = maxVal - minVal < NOISE_FLOOR                 // below noise floor
                || length < SHORT_MIN                            // too short
                || (length > SHORT_MAX  && length < MEDIUM_MIN)  // short/medium boundary
                || (length > MEDIUM_MAX && length < LONG_MIN)    // medium/long boundary
                || length > LONG_MAX;                            // long/gap boundary

    return length < MIN_UREADABLE_CYCLE_LENGTH;
  };

  /** Convert the most recent cycle into a bit (fast format: 1 cycle = 1 bit). */
  const pushBitFast = (): void => {
    _bitV[bitCount] = (cycleKind === 'short' || cycleKind === 'unreadable') ? 1 : 0;
    _bitL1[bitCount] = Math.min(lengthBelow, 65535);
    _bitFirstSample[bitCount] = aboveIndex - length;
    _bitLastSample[bitCount]  = aboveIndex - 1;
    _bitUnclear[bitCount] = cycleUnclear ? 1 : 0;
    _bitMaxIndex[bitCount] = maxIndex;
    _bitMinIndex[bitCount] = minIndex;
    bitCount++;
  };

  // ── Slow format bit extraction (Oricutron-style) ───────────────────────────
  // Bit 1 = 8 short cycles, bit 0 = 4 long cycles.
  // Emit the bit after 2 consecutive matching cycles, then absorb the rest
  // (up to 8 for short, 4 for long). Counters reset when cycle type changes.
  //
  // Medium cycles are transitions: one short half-cycle + one long half-cycle
  // (exactly 1600 Hz = harmonic mean of 2400 and 1200 Hz). We use lengthBelow
  // and lengthAbove to determine which half is short and which is long, credit
  // the short half to the short count and the long half to the long count.
  let slow1s = 0;   // consecutive short half-cycle pairs (counting full short cycles)
  let slow0s = 0;   // consecutive long half-cycle pairs (counting full long cycles)
  let slowBitFirstSample = 0;
  let slowBitUnclear = false;

  // Sample range tracking for slow half-cycle credits.
  let slowSampleFrom = 0;   // start of current half-credit's sample range
  let slowSampleTo   = 0;   // end of current half-credit's sample range

  /** Record a short cycle (or short half of a transition). */
  const slowShort = (): void => {
    if (slow1s === 0) slowBitFirstSample = slowSampleFrom;
    slow1s++;
    // Type change from long → short: if the long run had an incomplete bit
    // (slow0s was 1 after a wrap), extend the previous bit to cover the orphan.
    if (slow0s === 1 && bitCount > 0) {
      _bitLastSample[bitCount - 1] = slowSampleFrom - 1;
    }
    slow0s = 0;
    slowBitUnclear = slowBitUnclear || cycleUnclear;
    if (slow1s === 2) {
      _bitV[bitCount] = 1;
      _bitL1[bitCount] = 0;
      _bitFirstSample[bitCount] = slowBitFirstSample;
      _bitLastSample[bitCount]  = slowSampleTo;
      _bitUnclear[bitCount] = slowBitUnclear ? 1 : 0;
      bitCount++;
      slowBitUnclear = false;
    } else if (slow1s > 2 && slow1s <= 8 && bitCount > 0) {
      _bitLastSample[bitCount - 1] = slowSampleTo;
      if (cycleUnclear) _bitUnclear[bitCount - 1] = 1;
    }
    if (slow1s >= 8) slow1s = 0;
  };

  /** Record a long cycle (or long half of a transition). */
  const slowLong = (): void => {
    if (slow0s === 0) slowBitFirstSample = slowSampleFrom;
    slow0s++;
    // Type change from short → long: if the short run had an incomplete bit
    // (slow1s was 1 after a wrap), extend the previous bit to cover the orphan.
    if (slow1s === 1 && bitCount > 0) {
      _bitLastSample[bitCount - 1] = slowSampleFrom - 1;
    }
    slow1s = 0;
    slowBitUnclear = slowBitUnclear || cycleUnclear;
    if (slow0s === 2) {
      _bitV[bitCount] = 0;
      _bitL1[bitCount] = 0;
      _bitFirstSample[bitCount] = slowBitFirstSample;
      _bitLastSample[bitCount]  = slowSampleTo;
      _bitUnclear[bitCount] = slowBitUnclear ? 1 : 0;
      bitCount++;
      slowBitUnclear = false;
    } else if (slow0s > 2 && slow0s <= 4 && bitCount > 0) {
      _bitLastSample[bitCount - 1] = slowSampleTo;
      if (cycleUnclear) _bitUnclear[bitCount - 1] = 1;
    }
    if (slow0s >= 4) slow0s = 0;
  };

  const pushBitSlow = (): void => {
    const cycleFirst = aboveIndex - length;
    const cycleLast  = aboveIndex - 1;
    // The crossover midpoint between the two half-cycles.
    const midSample  = cycleFirst + lengthBelow;

    if (cycleKind === 'short' || cycleKind == 'unreadable') {
      slowSampleFrom = cycleFirst;
      slowSampleTo   = cycleLast;
      slowShort();
    } else if (cycleKind === 'long') {
      slowSampleFrom = cycleFirst;
      slowSampleTo   = cycleLast;
      slowLong();
    } else {
      // Medium cycle = transition (short half + long half).
      // Split at the crossover midpoint and credit each half separately.
      // The first half completes the previous bit's run; extend its sample range.
      // The second half starts the next bit's run.
      if (bitCount > 0) {
        _bitLastSample[bitCount - 1] = midSample - 1;
      }
      if (lengthBelow <= lengthAbove) {
        // First half is short, second is long.
        slowSampleFrom = cycleFirst;
        slowSampleTo   = midSample - 1;
        slowShort();
        slowSampleFrom = midSample;
        slowSampleTo   = cycleLast;
        slowLong();
      } else {
        // First half is long, second is short.
        slowSampleFrom = cycleFirst;
        slowSampleTo   = midSample - 1;
        slowLong();
        slowSampleFrom = midSample;
        slowSampleTo   = cycleLast;
        slowShort();
      }
    }
  };

  // Phase 1: Sync search — find a continuous run of at least MIN_SYNC_BITS cycles.
  // Uses both length-based gaps AND noise-floor to avoid locking onto noise.
  // Track cycle types to auto-detect fast vs slow format afterwards.
  // Uses fast-format pushBit since the training signal is the same in both
  // formats (all short/bit-1 cycles).
  // Save readCycle state at the start of each sync run so we can rewind
  // for slow format re-decoding if needed.
  let mediumCycleCount = 0;
  let longCycleCount = 0;
  let syncRunMaxIndex = nextMaxIndex;
  let syncRunAboveIndex = aboveIndex;
  let syncRunMaxVal = maxVal;
  let syncRunThreshold = threshold;
  while (nextMaxIndex < samples.length && bitCount < MIN_SYNC_BITS) {
    bitCount = 0;  // reset without reallocating
    mediumCycleCount = 0;
    longCycleCount = 0;
    streamFirstSample = aboveIndex;
    // Save state at the start of this sync run attempt.
    syncRunMaxIndex = nextMaxIndex;
    syncRunAboveIndex = aboveIndex;
    syncRunMaxVal = maxVal;
    syncRunThreshold = threshold;
    while (nextMaxIndex < samples.length && bitCount < MIN_SYNC_BITS) {
      if (!readCycle()) break;
      if (maxVal - minVal < SYNC_NOISE_FLOOR) break; // noise floor (silence, noise, or slow ramp)
      // TS can't see that readCycle() mutates cycleKind via closure — ignore the narrowing warning.
      // @ts-expect-error
      if (cycleKind === 'medium') mediumCycleCount++;
      // @ts-expect-error
      else if (cycleKind === 'long') longCycleCount++;
      pushBitFast();
    }
  }
  

  // Auto-detect format: fast format uses medium cycles (1600 Hz) for bit 0,
  // slow format uses long cycles (1200 Hz).  Compare relative counts so that
  // a few stretched fast-format cycles don't trigger a false slow detection.
  const format: 'fast' | 'slow' = longCycleCount > mediumCycleCount ? 'slow' : 'fast';
  let pushBit = pushBitFast;
  if (format === 'slow') {
    pushBit = pushBitSlow;

    // Reset to the start of the sync run so we re-decode with slow-format
    // bit extraction.  Phase 1 consumed all cycles as fast-decoded bits
    // which are wrong for slow format.
    bitCount = 0;
    nextMaxIndex = syncRunMaxIndex;
    aboveIndex = syncRunAboveIndex;
    maxVal = syncRunMaxVal;
    threshold = syncRunThreshold;
    streamMinVal = 0;
    streamMaxVal = 0;
    streamFirstSample = aboveIndex;
    slow1s = 0;
    slow0s = 0;
    slowBitUnclear = false;
  }

  let consecutivePoorCycles = 0;
  while (nextMaxIndex < samples.length) {
    if (readCycle() && (maxVal - minVal >= NOISE_FLOOR)) {
      consecutivePoorCycles = 0;
    } else {
      consecutivePoorCycles++;
      if (consecutivePoorCycles > MAX_POOR_SIGNAL_CYCLES) break;
    }
    pushBit();
  }


  const samplesRead = aboveIndex - startSample;

  // Trim TypedArrays to actual size. .slice() creates a compact copy,
  // freeing the oversized pre-allocated buffers.
  const stream: BitStream = {
    format,
    bitCount,
    bitV:           _bitV.slice(0, bitCount),
    bitL1:          _bitL1.slice(0, bitCount),
    bitFirstSample: _bitFirstSample.slice(0, bitCount),
    bitLastSample:  _bitLastSample.slice(0, bitCount),
    bitUnclear:     _bitUnclear.slice(0, bitCount),
    bitMaxIndex:    _bitMaxIndex.slice(0, bitCount),
    bitMinIndex:    _bitMinIndex.slice(0, bitCount),
    firstSample: streamFirstSample,
    lastSample:  aboveIndex,
    minVal: streamMinVal,
    maxVal: streamMaxVal,
  };

  return { stream, samplesRead };
}

/**
 * Default minimum-0x16 count for the in-stream sync scanner.  The Oric ROM
 * accepts any run ≥3 × 0x16 followed by 0x24 as a valid sync (see 1a fix
 * in tapDecoder.ts), but we use a stricter threshold here because this
 * scanner operates *inside* a single BitStream — where 0x16 is a byte
 * value that can legitimately appear in body content.  The ROM avoids
 * false mid-body matches by skipping past the body using endAddr; we
 * can't rely on that because the overwrite scenario (v2 CSAVE recorded
 * over partial v1) invalidates v1's endAddr.  A stricter count keeps
 * false positives on body content extremely rare (10 × 0x16 in a row in
 * a real BASIC body is almost unheard of), while still matching the
 * much larger leader runs real tape sync preambles produce.
 */
const DEFAULT_IN_STREAM_SYNC_MIN = 10;

/**
 * Scan a byte stream for positions where a new program's sync pattern
 * (run of ≥ minSyncBytes × 0x16 immediately followed by 0x24) begins.
 *
 * Pure byte scanner — returns every matching pattern's starting position
 * within [startOffset, bytes.length).  The caller decides where to start
 * scanning (typically the first program's body start, so the first
 * program's own sync + header + name region is excluded from the scan).
 *
 * Each returned index is the position of the first 0x16 of the detected
 * run (the starting byte of the next program's block).
 *
 * Used by readPrograms to split a single BitStream into multiple
 * Programs when a WAV recording contains two (or more) CSAVEs in the
 * same bit stream — either two back-to-back CSAVEs recorded without a
 * usable audio gap, or a partial overwrite where CSAVE #2 was recorded
 * over the middle of CSAVE #1.  See splitProgram for how the detected
 * boundaries are applied.
 *
 * This scanner does *not* use the first program's header endAddr to
 * bound the scan, unlike the TAP decoder's equivalent logic, because
 * the overwrite case makes endAddr unreliable (it may describe a body
 * length that extends into the overwriting program's bytes).  The
 * stricter sync threshold is what keeps false positives rare inside
 * real program bodies.
 */
export function findProgramBoundariesInBytes(
  bytes:         ByteInfo[],
  startOffset:   number = 0,
  minSyncBytes:  number = DEFAULT_IN_STREAM_SYNC_MIN,
): number[] {
  const boundaries: number[] = [];
  let i = Math.max(0, startOffset);
  while (i < bytes.length) {
    while (i < bytes.length && bytes[i].v !== 0x16) i++;
    if (i >= bytes.length) break;
    const runStart = i;
    while (i < bytes.length && bytes[i].v === 0x16) i++;
    // A valid sync requires ≥ minSyncBytes consecutive 0x16s followed
    // immediately by 0x24.  Anything shorter, or not terminated by 0x24,
    // is just body data that happens to contain 0x16 — keep scanning.
    if (i - runStart >= minSyncBytes && i < bytes.length && bytes[i].v === 0x24) {
      boundaries.push(runStart);
      i++;  // step past the 0x24
    }
  }
  return boundaries;
}

export function readPrograms(streams: BitStream[]): Program[] {
  const programs: Program[] = [];
  for (const stream of streams) {
    const prog = readProgramBytes(stream);
    if (prog.bytes.length === 0) continue;

    // Parse lines on the initial Program so we know where body starts.
    // (Flag functions are deferred: if we end up splitting, splitProgram
    // runs them on each half via rebuildProgram — running them here first
    // would be wasted work.  If we don't split, we run them below.)
    readProgramLines(prog);

    // Determine body start.  prog.lines[0].firstByte is the clean answer
    // when BASIC lines parsed.  Otherwise fall back to just past the
    // header (byteIndex + 9) — still safe because the header is only 9
    // bytes so it can't contain a ≥10 × 0x16 run.  If byteIndex === 0
    // and no lines parsed, readProgramLines didn't find a valid sync at
    // all: the stream is all noise / unparseable, so there's no
    // meaningful body start and no secondary program to find.
    const bodyStart = prog.lines.length > 0
      ? prog.lines[0].firstByte
      : (prog.header.byteIndex > 0 ? prog.header.byteIndex + 9 : prog.bytes.length);

    const boundaries = findProgramBoundariesInBytes(prog.bytes, bodyStart);

    if (boundaries.length === 0) {
      flagNonMonotonicLines(prog);
      flagTokenisationMismatches(prog);
      flagElementErrors(prog);
      flagPointerAndTerminatorIssues(prog);
      programs.push(prog);
    } else {
      // boundaries[] are indices into the original (undivided) byte
      // array.  After each split, `current` is the remaining tail whose
      // byte indexing starts at 0, so we subtract the running offset
      // (= position of the previous split in the original) to get the
      // local split point.  splitProgram runs the full parse pipeline
      // (readProgramLines + all flag functions) on each half via
      // rebuildProgram — no extra work needed here.
      let current: Program = prog;
      let offset = 0;
      for (const byteIdx of boundaries) {
        const [first, rest] = splitProgram(current, byteIdx - offset);
        programs.push(first);
        current = rest;
        offset  = byteIdx;
      }
      programs.push(current);
    }
  }
  return programs;
}

/**
 * Wrap a byte array + bit stream into a fresh Program and run the parse
 * pipeline (readProgramLines + all flag functions).  Used by splitProgram
 * and joinPrograms to produce Programs with fully-derived metadata from
 * their new byte slices.
 *
 * Caller is responsible for ensuring each ByteInfo's firstBit / lastBit
 * values are valid indices into `stream`.  The returned Program has
 * progNumber = 0 (placeholder — the UI stamps the real value).
 */
function rebuildProgram(bytes: ByteInfo[], stream: BitStream): Program {
  const prog: Program = {
    stream,
    bytes,
    lines: [],
    name: '',
    originalSource: '',
    progNumber: 0,
    header: { byteIndex: 0, fileType: 0, startAddr: 0, endAddr: 0, autorun: false },
  };
  readProgramLines(prog);
  flagNonMonotonicLines(prog);
  flagTokenisationMismatches(prog);
  flagElementErrors(prog);
  flagPointerAndTerminatorIssues(prog);
  return prog;
}

/**
 * Produce a fresh ByteInfo that preserves the decode-level facts of the
 * source byte (value, bit pointers, signal-quality flags) but resets all
 * user-level state (edit flags, originalIndex).  Called during split / join
 * when we're rebuilding Programs and the caller wants a clean slate.
 *
 * `bitOffset` is subtracted from firstBit/lastBit — used when the byte is
 * moving into a BitStream whose bit-indexing has shifted (e.g. the second
 * half of a split, whose new stream starts at the original's bit position
 * `bitOffset`).
 */
function resetByteInfo(b: ByteInfo, newOriginalIndex: number, bitOffset = 0): ByteInfo {
  return {
    v:             b.v,
    firstBit:      b.firstBit - bitOffset,
    lastBit:       b.lastBit  - bitOffset,
    unclear:       b.unclear,
    chkErr:        b.chkErr,
    originalIndex: newOriginalIndex,
  };
}

/**
 * Split a Program into two at byte index `byteIdx`.
 *
 * The first returned Program holds bytes [0, byteIdx); the second holds
 * bytes [byteIdx, length).  The underlying BitStream is also split at the
 * corresponding bit position (stream.bytes[byteIdx].firstBit), so the 1:1
 * invariant between a Program and its BitStream is preserved.
 *
 * Both halves are reparsed from their raw bytes: header, name, lines, and
 * all flag fields are rebuilt from scratch.  Per-byte edit state is
 * cleared and `originalIndex` is renumbered 0-based in each half — any
 * prior edits (explicit or automatic) and line-level metadata (line
 * deltas, ignoreErrors) are discarded.  Per-byte decode-quality flags
 * (`unclear`, `chkErr`) and bit pointers are preserved.  Per the design
 * decision: split is a power action that rebuilds Program structure, so
 * user-level state resets by policy.  The UI is expected to confirm with
 * the user before calling this.
 *
 * Throws if byteIdx <= 0 or byteIdx >= bytes.length — the caller must
 * ensure the split point produces two non-empty halves.
 */
export function splitProgram(prog: Program, byteIdx: number): [Program, Program] {
  const n = prog.bytes.length;
  if (byteIdx <= 0 || byteIdx >= n) {
    throw new Error(`splitProgram: byteIdx ${byteIdx} out of range (1, ${n - 1})`);
  }
  const bitPos = prog.bytes[byteIdx].firstBit;
  const [firstStream, secondStream] = splitBitStream(prog.stream, bitPos);

  const firstBytes  = prog.bytes.slice(0, byteIdx).map((b, i) => resetByteInfo(b, i, 0));
  const secondBytes = prog.bytes.slice(byteIdx)   .map((b, i) => resetByteInfo(b, i, bitPos));

  return [
    rebuildProgram(firstBytes,  firstStream),
    rebuildProgram(secondBytes, secondStream),
  ];
}

/**
 * Concatenate two or more Programs into a single Program, in input order.
 *
 * The joined Program's byte array is the concatenation of all inputs'
 * bytes; the joined BitStream is the concatenation of all inputs'
 * BitStreams (see `joinBitStreams` for the sample-position behaviour at
 * seams).  Per-byte bit pointers are shifted so they index correctly into
 * the joined stream.
 *
 * The result is reparsed from scratch: the header comes from whatever
 * sync + header the first bytes happen to contain (so in practice this
 * means the first input's header carries through, assuming its bytes
 * haven't been trimmed).  Per-byte edit state is cleared; `originalIndex`
 * is renumbered 0-based across the whole concatenation.  Same reset
 * policy as splitProgram — this is a power action.
 *
 * A single-Program input is returned unchanged (no defensive copy,
 * mirroring joinBitStreams).  Throws on an empty input array.
 */
export function joinPrograms(progs: Program[]): Program {
  if (progs.length === 0) {
    throw new Error('joinPrograms: need at least one program to join');
  }
  if (progs.length === 1) return progs[0];

  const joinedStream = joinBitStreams(progs.map(p => p.stream));
  const joinedBytes: ByteInfo[] = [];
  let bitOffset = 0;
  for (const p of progs) {
    for (const b of p.bytes) {
      // Shift bit pointers by the negative of the running offset so that
      // the byte's firstBit/lastBit become indices into the joined stream.
      joinedBytes.push(resetByteInfo(b, joinedBytes.length, -bitOffset));
    }
    bitOffset += p.stream.bitCount;
  }
  return rebuildProgram(joinedBytes, joinedStream);
}

export function readProgramBytes(stream: BitStream, skipSync = false): Program {
  // progNumber is a placeholder here; main.ts stamps the real value after load.
  const prog: Program = { stream, bytes: [], lines: [], name: '', originalSource: '', progNumber: 0, header: { byteIndex: 0, fileType: 0, startAddr: 0, endAddr: 0, autorun: false } };
  let currentBit = 0;
  let byteUnclear = false;

  const getBit = (): { bt: 0 | 1; ok: boolean } => {
    if (currentBit < stream.bitCount) {
      byteUnclear = byteUnclear || (stream.bitUnclear[currentBit] === 1);
      return { bt: stream.bitV[currentBit++] as 0 | 1, ok: true };
    }
    return { bt: 0, ok: false };
  };

  let by = 0;
  if (!skipSync) {
    // Scan for sync byte 0x16, assembled LSB-first from the raw bit stream.
    while (by !== 0x16) {
      const { bt, ok } = getBit();
      if (!ok) return prog;
      by = ((by >>> 1) | (bt << 7)) & 0xFF;
    }
  }

  // Read bytes until the bit stream is exhausted.
  while (true) {
    byteUnclear = false;
    const byteStart = currentBit;

    let r = getBit();
    if (!r.ok) return prog;

    // Skip stop bits until the start bit (0) appears.
    r = getBit();
    if (!r.ok) return prog;
    while (r.bt !== 0) {
      r = getBit();
      if (!r.ok) return prog;
    }

    // Read 8 data bits, LSB first.
    by = 0;
    let chk = 0;
    for (let i = 0; i < 8; i++) {
      r = getBit();
      if (!r.ok) return prog;
      by  = ((by  >>> 1) | (r.bt << 7)) & 0xFF;
      chk = (chk + r.bt) & 0xFF;
    }

    // Parity bit: error when it equals chk&1 (odd-parity scheme).
    r = getBit();
    if (!r.ok) return prog;
    prog.bytes.push({
      v: by,
      firstBit: byteStart,
      lastBit:  currentBit - 1,
      unclear:  byteUnclear,
      chkErr:   r.bt === (chk & 1),
      originalIndex: prog.bytes.length,
    });
  }
}

export function readProgramLines(prog: Program, skipHeader = false): void {
  let nextByte = 0;
  let ok = true;
  // Hard fence: getByte() will not read past this stream index.
  // Initialised to unlimited; capped to the header's address range once known.
  let endIdx = Number.MAX_SAFE_INTEGER;

  const getByte = (): number => {
    if (nextByte < prog.bytes.length && nextByte <= endIdx) {
      ok = true;
      return prog.bytes[nextByte++].v;
    }
    ok = false;
    return 0;
  };

  const START_ADDR = 0x0501;
  let startAddr = START_ADDR;

  if (skipHeader) {
    // Force decode: skip sync/header/name, assume BASIC.
    // Scan forward for a 0x00 (previous line's terminator) so we start on a
    // clean line boundary.  Fall back to byte 0 if none found within first 256 bytes.
    let startOffset = 0;
    for (let i = 0; i < Math.min(prog.bytes.length, 256); i++) {
      if (prog.bytes[i].v === 0x00) { startOffset = i + 1; break; }
    }
    nextByte = startOffset;
    prog.header = {
      byteIndex: startOffset,
      fileType:  0,
      autorun:   false,
      startAddr: START_ADDR,
      endAddr:   START_ADDR + prog.bytes.length - startOffset,
    };
    prog.name = '(force decoded)';
  } else {
    // Find sync: 4+ × 0x16 bytes followed by 0x24.
    let syncCount = 0;
    while (true) {
      const b = getByte();
      if (!ok) return;
      if (b === 0x16) { syncCount++; }
      else if (b === 0x24 && syncCount >= 3) { break; }
      else { syncCount = 0; }
    }
    const headerByteIndex = nextByte;

    // 9-byte file header; byte[2] === 0 means BASIC file, other values indicate
    // non-BASIC (e.g. machine code has byte[2] === 0x80).
    const headerBytes: number[] = [];
    for (let i = 0; i < 9; i++) headerBytes.push(getByte());

    // Start address from header (bytes 6–7, big-endian).  Used to anchor the
    // chain of next-line pointer addresses to real Oric memory addresses.
    const endAddr   = (headerBytes[4] << 8) | headerBytes[5];
    startAddr = (headerBytes[6] << 8) | headerBytes[7];

    // Store parsed header fields on the Program object.
    prog.header = {
      byteIndex:  headerByteIndex,
      fileType:   headerBytes[2],
      // High-bit set on byte 3 = autorun (0x80 for BASIC, 0xC7 for
      // machine code — the specific bits distinguish the ROM's
      // dispatch path but both count as "autorun on" semantically).
      autorun:    (headerBytes[3] & 0x80) !== 0,
      startAddr,
      endAddr,
    };

    // Null-terminated program name.
    for (let b = getByte(); b > 0; b = getByte()) {
      prog.name += String.fromCharCode(b);
    }

    // Non-BASIC programs (machine code, etc.) — header fields are populated
    // but we skip the BASIC line parsing below.
    if (headerBytes[2] !== 0) return;

    // Cap getByte to the address range declared in the header.
    // endAddr is exclusive (the first byte past the saved data), so the last
    // valid stream index is firstContentIdx + (endAddr - startAddr) - 1.
    const firstContentIdx = nextByte;
    endIdx = firstContentIdx + (endAddr - startAddr) - 1;
  }

  // Program lines.  lenErr is computed per-line via the self-consistency
  // equation (declared size = nextAddr - firstAddr vs actual = lastByte -
  // firstByte + 1), with firstAddr tracked across iterations.
  let currentFirstAddr = startAddr;
  while (true) {
    const lineStart = nextByte;

    // Condition 1: only attempt a new line if there are at least 3 bytes
    // remaining (2 for the next-line pointer + 1 beyond).  When exactly 2
    // bytes remain they can only be the end-of-program marker (0x00 0x00 or
    // whatever the ROM left in memory), not a real line — stop cleanly.
    if (nextByte > endIdx - 2) break;

    // Read the raw pointer first; a zero value signals end-of-program.
    const rawNextAddr = getByte() + 256 * getByte();
    if (!ok) break;
    if (rawNextAddr === 0) {
      // Condition 1 handles the common end-of-program where only 2 bytes
      // (the 0x00 0x00 marker) remain.  However, endAddr (exclusive) sometimes
      // points one byte past the marker, leaving one extra byte in range when
      // the pointer is read (nextByte === endIdx after consuming 2 bytes).
      // That single trailing byte is not a genuine early end — only flag when
      // two or more bytes remain after the null pointer.
      if (nextByte < endIdx) {
        prog.earlyTermination = true;
        if (prog.lines.length > 0)
          prog.lines[prog.lines.length - 1].earlyEnd = true;
      }
      break;
    }

    // Read line number (2 bytes) and content bytes (until 0x00 terminator)
    // to advance nextByte.
    getByte(); getByte();  // line number bytes
    while (true) {
      const b = getByte();
      if (b === 0) break;
    }

    const declaredSize = rawNextAddr - currentFirstAddr;
    const actualSize   = nextByte - lineStart;
    const lineInfo: LineInfo = {
      v: '',
      elements: [],
      firstByte: lineStart,
      lastByte:  nextByte - 1,
      lenErr: declaredSize !== actualSize,
    };
    prog.lines.push(lineInfo);
    buildLineElements(lineInfo, prog.bytes);
    currentFirstAddr = rawNextAddr;  // next iteration's first line starts here
  }

  // Without a header, startAddr is guessed — derive it from the first line's
  // pointer and suppress the first line's length check.
  if (skipHeader && prog.lines.length > 0) {
    const firstLine = prog.lines[0];
    const ptr = prog.bytes[firstLine.firstByte].v | (prog.bytes[firstLine.firstByte + 1].v << 8);
    prog.header.startAddr = ptr - (firstLine.lastByte - firstLine.firstByte + 1);
    firstLine.lenErr = false;
  }

}

/**
 * Flag lines whose line numbers are not part of the longest increasing
 * subsequence (LIS) of line numbers in the program.  These are likely
 * corrupt line-number bytes rather than intentionally out-of-order lines.
 *
 * Uses O(n log n) patience sort — the same algorithm the merger uses.
 */
export function flagNonMonotonicLines(prog: Program): void {
  const n = prog.lines.length;
  if (n === 0) return;

  // Parse line numbers from elements[0] (the line-number string, e.g. "100 ").
  const lineNums = prog.lines.map(l => {
    const num = parseInt(l.elements[0] ?? '', 10);
    return isNaN(num) ? -1 : num;
  });

  // Patience sort to find the LIS.
  const tailNums: number[] = [];  // smallest tail ending an IS of length i+1
  const tailPos:  number[] = [];  // index into lineNums[] of that tail
  const parent = new Int32Array(n).fill(-1);

  for (let i = 0; i < n; i++) {
    const v = lineNums[i];
    if (v < 0) continue;  // unparseable line number — skip (will be flagged)

    // Binary search: first pile whose tail >= v (strict increase).
    let lo = 0, hi = tailNums.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tailNums[mid] < v) lo = mid + 1; else hi = mid;
    }
    tailNums[lo] = v;
    tailPos[lo]  = i;
    parent[i]    = lo > 0 ? tailPos[lo - 1] : -1;
  }

  // Reconstruct the LIS indices.
  const inLIS = new Uint8Array(n);  // 1 = in LIS
  if (tailNums.length > 0) {
    let idx = tailPos[tailNums.length - 1];
    while (idx >= 0) {
      inLIS[idx] = 1;
      idx = parent[idx];
    }
  }

  // Flag lines not in the LIS (or with unparseable line numbers).
  // Clear the flag for lines that are in the LIS (editing may have fixed them).
  for (let i = 0; i < n; i++) {
    prog.lines[i].nonMonotonic = !inLIS[i] || undefined;
    invalidateLineHealth(prog.lines[i]);
  }
}

/**
 * TODO: development aid — comment out when not debugging editing.
 * Recalculate lenErr for all lines by comparing each line's declared extent
 * (nextAddr - firstAddr) against its actual extent (lastByte - firstByte + 1).
 * Per-line self-consistency check — no accumulator needed.
 */
export function flagLenErrors(prog: Program): void {
  for (let li = 0; li < prog.lines.length; li++) {
    const line = prog.lines[li];
    const declaredSize = lineNextAddr(prog, li) - lineFirstAddr(prog, li);
    const actualSize   = line.lastByte - line.firstByte + 1;
    line.lenErr = (declaredSize !== actualSize);
    invalidateLineHealth(line);
  }
}

/**
 * Re-evaluate earlyEnd (on the last line) and earlyTermination (program-level)
 * from current state.  Idempotent: callable at any time after a byte-count
 * change to keep the flags in sync with reality.
 *
 * Mirrors the decoder's original check in readProgramLines: the program-end
 * marker (0x00 0x00) is present and its position is at least 2 bytes before
 * the byte position implied by the header's endAddr.  The "at least 2"
 * tolerance absorbs a known off-by-one case where endAddr sometimes points
 * exactly one byte past the marker (not treated as genuinely early).
 */
export function flagEarlyEnd(prog: Program): void {
  // Clear across all lines defensively, in case line structure has changed
  // (e.g. lines added/removed by an edit).  Only the last line may genuinely
  // carry this flag on re-evaluation.
  for (const line of prog.lines) {
    if (line.earlyEnd) {
      line.earlyEnd = undefined;
      invalidateLineHealth(line);
    }
  }
  prog.earlyTermination = undefined;

  if (prog.lines.length === 0) return;

  const lastLine = prog.lines[prog.lines.length - 1];
  const endMarkerIdx = lastLine.lastByte + 1;

  // If the end-of-program marker isn't present at the expected position,
  // the early-end condition doesn't apply in its usual form.
  const hasEndMarker =
    prog.bytes[endMarkerIdx]?.v === 0x00 &&
    prog.bytes[endMarkerIdx + 1]?.v === 0x00;
  if (!hasEndMarker) return;

  const firstLineOffset = prog.lines[0].firstByte;
  const endIdx = firstLineOffset + (prog.header.endAddr - prog.header.startAddr) - 1;
  const nextByteIdx = endMarkerIdx + 2;

  if (nextByteIdx < endIdx) {
    prog.earlyTermination = true;
    lastLine.earlyEnd = true;
    invalidateLineHealth(lastLine);
  }
}

/**
 * Set prog.pointerAndTerminatorIssues to reflect whether fixPointersAndTerminators
 * would make any byte change on the program: missing line terminator, missing
 * end-of-program marker, or a next-line pointer inconsistent with a line's
 * actual extent.
 *
 * Relies on line.lenErr being fresh — callers should invoke this after
 * flagLenErrors in the flag cascade.
 */
export function flagPointerAndTerminatorIssues(prog: Program): void {
  prog.pointerAndTerminatorIssues = hasPointerAndTerminatorIssues(prog) || undefined;
}

function hasPointerAndTerminatorIssues(prog: Program): boolean {
  if (prog.lines.length === 0) return false;

  // 1. Any line missing its 0x00 terminator?
  for (const line of prog.lines) {
    if (prog.bytes[line.lastByte]?.v !== 0x00) return true;
  }

  // 2. End-of-program marker absent?
  const lastLine = prog.lines[prog.lines.length - 1];
  const endMarkerIdx = lastLine.lastByte + 1;
  if (prog.bytes[endMarkerIdx]?.v !== 0x00 ||
      prog.bytes[endMarkerIdx + 1]?.v !== 0x00) return true;

  // 3. Any line with an incorrect next-line pointer?  Uses the lenErr flag,
  //    which reflects "pointer doesn't match extent".
  for (const line of prog.lines) {
    if (line.lenErr) return true;
  }

  // 4. Header end address doesn't match the program's actual size?  Expected
  //    end address = startAddr + (one past the end-of-program marker) measured
  //    in program-data bytes from the first line's start.
  const firstLineOffset = prog.lines[0].firstByte;
  const expectedEndAddr = prog.header.startAddr + (lastLine.lastByte + 3 - firstLineOffset);
  if (prog.header.endAddr !== expectedEndAddr) return true;

  return false;
}
