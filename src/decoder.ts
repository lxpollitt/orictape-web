// Copyright © 2015 The Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

import { flagSyntaxErrors, checkLineSyntax } from './editor';

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
  edited?: boolean;  // set on bytes created by editing (no waveform backing)
}

export interface LineInfo {
  v: string;
  elements: string[];
  firstByte: number;
  lastByte: number;
  expectedLastByte: number;
  lenErr: boolean;
  /** Oric memory address of this line's first byte, derived from the
   *  header start address and the chain of next-line pointers. */
  memAddr: number;
  /** Set on the last parsed line when the BASIC end-of-program null pointer
   *  was encountered before the header's declared end address.  The line
   *  itself may be byte-clean; the flag marks the point where the program
   *  ended unexpectedly early. */
  earlyEnd?: boolean;
  /** Set when the line contains at least one byte in the keyword range
   *  (0x80–0xFF) that does not map to a known BASIC keyword. */
  unknownKeyword?: boolean;
  /** Set when the line's line number is not part of the longest increasing
   *  subsequence of line numbers in the program — i.e. it breaks the expected
   *  monotonic ordering, likely due to a corrupt line-number byte. */
  nonMonotonic?: boolean;
  /** Set when re-tokenising the line's text produces different bytes than
   *  the original — indicates the stored bytes aren't valid tokenised BASIC. */
  syntaxError?: boolean;
  /** Per-element error severity. Null/undefined = no element-level issues.
   *  When present, one entry per element: 'error', 'warning', or null (clean). */
  elementErrors?: ('error' | 'warning' | null)[];
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
  if (line.lenErr || line.earlyEnd || line.unknownKeyword || line.nonMonotonic || line.syntaxError) return 'error';
  for (let i = line.firstByte; i <= line.lastByte; i++) {
    const b = prog.bytes[i];
    if (b?.chkErr) return 'error';
  }
  for (let i = line.firstByte; i <= line.lastByte; i++) {
    const b = prog.bytes[i];
    if (b?.unclear) return 'warning';
  }
  return 'clean';
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
    const expected = line.expectedLastByte - line.firstByte + 1;
    const actual   = line.lastByte         - line.firstByte + 1;
    statuses.push({ message: `Line length error (expected ${expected} bytes, found ${actual})`, severity: 'error' });
  }
  if (line.unknownKeyword) {
    statuses.push({ message: 'Unknown keyword byte', severity: 'error' });
  }
  if (line.nonMonotonic) {
    statuses.push({ message: 'Non-monotonic line number', severity: 'error' });
  }
  if (line.syntaxError) {
    statuses.push({ message: 'Tokenisation mismatch', severity: 'error' });
  }

  // Byte-level issues (summarised, not per-byte).
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
 * Populate per-element error severities on each line in a program.
 * Consolidates all element-level error detection into one pass:
 *   - Non-monotonic line number (element 0) → 'error'
 *   - [UNKNOWN_KEYWORD] element → 'error'
 *   - Syntax mismatch at this element's byte → 'error'
 *   - Underlying byte has chkErr → 'error'
 *   - Underlying byte has unclear → 'warning'
 *
 * Only allocates the elementErrors array if at least one element has an issue.
 * Must be called after flagNonMonotonicLines and flagSyntaxErrors.
 */
export function flagElementErrors(prog: Program): void {
  for (let li = 0; li < prog.lines.length; li++) {
    const line = prog.lines[li];
    const errors: ('error' | 'warning' | null)[] = new Array(line.elements.length).fill(null);
    let hasAny = false;

    // Determine syntax mismatch byte offset (if any).
    let syntaxMismatchByte = -1;
    if (line.syntaxError) {
      const lineText = line.elements.join('');
      const originalBytes: number[] = [];
      for (let b = line.firstByte + 2; b <= line.lastByte; b++) {
        originalBytes.push(prog.bytes[b].v);
      }
      const issue = checkLineSyntax(lineText, originalBytes);
      if (issue) syntaxMismatchByte = issue.byteOffset;
    }

    for (let ei = 0; ei < line.elements.length; ei++) {
      const el = line.elements[ei];
      let severity: 'error' | 'warning' | null = null;

      // Non-monotonic line number.
      if (ei === 0 && line.nonMonotonic) {
        severity = 'error';
      }

      // Unknown keyword.
      if (el === '[UNKNOWN_KEYWORD]') {
        severity = 'error';
      }

      // Syntax mismatch: map byte offset to element index.
      // Byte offset 0-1 = line number (element 0), offset N+2 = element N+1 content byte.
      if (syntaxMismatchByte >= 0) {
        const mismatchEi = syntaxMismatchByte <= 1 ? 0 : syntaxMismatchByte - 1;
        if (ei === mismatchEi) severity = 'error';
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

export interface ProgramHeader {
  /** Byte index of the first header byte (after the 0x24 sync marker)
   *  within the bytes[] array. */
  byteIndex:  number;
  /** 0x00 = BASIC, 0x01 = machine code. */
  fileType:   number;
  /** True if the program should auto-run on load (header byte 3 = 0x80). */
  autorun:    boolean;
  /** First byte of program data in Oric memory (big-endian from header). */
  startAddr:  number;
  /** First byte past program data in Oric memory (big-endian from header, exclusive). */
  endAddr:    number;
}

export interface Program {
  stream: BitStream;
  bytes: ByteInfo[];
  lines: LineInfo[];
  name: string;
  /** Parsed header fields. Set by readProgramLines. */
  header: ProgramHeader;
  /** Set when the BASIC end-of-program null pointer (0x00 0x00) was
   *  encountered before the address range declared in the tape header was
   *  exhausted.  Condition 1 already handles the normal case where the null
   *  pointer sits right at endAddr–2, so this flag fires only when the
   *  pointer appears unexpectedly early. */
  earlyTermination?: boolean;
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
    // The previous readCyle already had to find this cycle's maxIndex to workout the crossover point
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
      if (cycleKind === 'medium') mediumCycleCount++;
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

export function readPrograms(streams: BitStream[]): Program[] {
  const programs: Program[] = [];
  for (const stream of streams) {
    const prog = readProgramBytes(stream);
    if (prog.bytes.length > 0) {
      readProgramLines(prog);
      flagNonMonotonicLines(prog);
      flagSyntaxErrors(prog);
      flagElementErrors(prog);
      programs.push(prog);
    }
  }
  return programs;
}

export function readProgramBytes(stream: BitStream, skipSync = false): Program {
  const prog: Program = { stream, bytes: [], lines: [], name: '', header: { byteIndex: 0, fileType: 0, startAddr: 0, endAddr: 0, autorun: false } };
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
      else if (b === 0x24 && syncCount > 3) { break; }
      else { syncCount = 0; }
    }
    const headerByteIndex = nextByte;

    // 9-byte file header; byte[2] === 0 means BASIC file.
    const headerBytes: number[] = [];
    for (let i = 0; i < 9; i++) headerBytes.push(getByte());
    if (headerBytes[2] !== 0) return;

    // Start address from header (bytes 6–7, big-endian).  Used to anchor the
    // chain of next-line pointer addresses to real Oric memory addresses.
    const endAddr   = (headerBytes[4] << 8) | headerBytes[5];
    startAddr = (headerBytes[6] << 8) | headerBytes[7];

    // Store parsed header fields on the Program object.
    prog.header = {
      byteIndex:  headerByteIndex,
      fileType:   headerBytes[2],
      autorun:    headerBytes[3] === 0x80,
      startAddr,
      endAddr,
    };

    // Null-terminated program name.
    for (let b = getByte(); b > 0; b = getByte()) {
      prog.name += String.fromCharCode(b);
    }

    // Cap getByte to the address range declared in the header.
    // endAddr is exclusive (the first byte past the saved data), so the last
    // valid stream index is firstContentIdx + (endAddr - startAddr) - 1.
    const firstContentIdx = nextByte;
    endIdx = firstContentIdx + (endAddr - startAddr) - 1;
  }

  // Program lines.
  let correctionOffset = 0;
  let lineMemAddr = startAddr; // memory address of the line we are about to push
  while (true) {
    const lineStart = nextByte;

    // Condition 1: only attempt a new line if there are at least 3 bytes
    // remaining (2 for the next-line pointer + 1 beyond).  When exactly 2
    // bytes remain they can only be the end-of-program marker (0x00 0x00 or
    // whatever the ROM left in memory), not a real line — stop cleanly.
    if (nextByte > endIdx - 2) break;

    // Read the raw pointer first; a zero value signals end-of-program.
    // The correctionOffset is applied afterwards, matching the Go original.
    const rawLineStart = getByte() + 256 * getByte();
    if (!ok) break;
    if (rawLineStart === 0) {
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
    const nextLineStart = rawLineStart - correctionOffset;

    const elements: string[] = [];
    const lineNum = getByte() + 256 * getByte();
    const lineNumStr = `${lineNum} `;
    elements.push(lineNumStr);
    let line = lineNumStr;
    let unknownKeyword = false;

    while (true) {
      const b = getByte();
      if (b === 0) break;
      let element: string;
      if (b < 128) {
        element = String.fromCharCode(b);
      } else if ((b - 128) < KEYWORDS.length) {
        element = KEYWORDS[b - 128];
      } else {
        element = '[UNKNOWN_KEYWORD]';
        unknownKeyword = true;
      }
      elements.push(element);
      line += element;
    }

    prog.lines.push({
      v: line,
      elements,
      firstByte: lineStart,
      lastByte:  nextByte - 1,
      expectedLastByte: nextLineStart - 1,
      lenErr: nextLineStart !== nextByte,
      unknownKeyword: unknownKeyword || undefined,
      memAddr: lineMemAddr,
    });
    correctionOffset += nextLineStart - nextByte;
    // rawLineStart is the memory address of the *next* line.
    lineMemAddr = rawLineStart;
  }

  if (prog.lines.length > 0) {
    prog.lines[0].lenErr = false;
    prog.lines[0].expectedLastByte = prog.lines[0].lastByte;
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
  for (let i = 0; i < n; i++) {
    if (!inLIS[i]) {
      prog.lines[i].nonMonotonic = true;
    }
  }
}
