// Copyright © 2015 The Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

// BitInfo is used by the UI when reading individual bits out of a BitStream.
export interface BitInfo {
  v: 0 | 1;
  l1: number;
  l2: number;
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
}

// BitStream stores bit data in struct-of-arrays layout using TypedArrays.
// This is ~10x more memory-efficient than an array of BitInfo objects and
// reduces GC pressure significantly for large tape recordings.
// All parallel arrays have length === bitCount after decoding.
export interface BitStream {
  bitCount: number;
  bitV: Uint8Array;            // bit value: 0 or 1
  bitL1: Uint16Array;          // first half-cycle length (samples)
  bitL2: Uint16Array;          // second half-cycle length (samples)
  bitFirstSample: Uint32Array;
  bitLastSample: Uint32Array;
  bitUnclear: Uint8Array;      // 0 = clean, 1 = unclear
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
    l2: s.bitL2[i],
    firstSample: s.bitFirstSample[i],
    lastSample: s.bitLastSample[i],
    unclear: s.bitUnclear[i] === 1,
  };
}

export interface Program {
  stream: BitStream;
  bytes: ByteInfo[];
  lines: LineInfo[];
  name: string;
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
  const streams: BitStream[] = [];
  let startSample = 0;
  while (true) {
    const { stream, samplesRead } = readBitStream(samples, startSample, sampleRate);
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

function readBitStream(samples: Int16Array, startSample: number, sampleRate: number): { stream: BitStream; samplesRead: number } {
  // All thresholds and windows are expressed in samples and scale linearly with
  // sample rate.  The base values are calibrated for 44100 Hz.
  const SHORT_THRESHOLD     = Math.round(20 * sampleRate / 44100); // short cycle  → bit 1
  const LONG_THRESHOLD      = Math.round(24 * sampleRate / 44100); // long  cycle  → bit 0
  const NO_SIGNAL_THRESHOLD = Math.round(46 * sampleRate / 44100); // gap / silence
  const SEARCH_WINDOW       = Math.round(20 * sampleRate / 44100); // peak-search half-window
  const MIN_SYNC_BITS       = Math.round(8820 * sampleRate / 44100); // 0.2 s minimum sync run

  // Pre-allocate TypedArrays sized to the theoretical maximum number of bits
  // (every cycle is the shortest possible). We'll slice to actual size at the end.
  const maxBits = Math.ceil((samples.length - startSample) / SHORT_THRESHOLD) + 1;
  const _bitV            = new Uint8Array(maxBits);
  const _bitL1           = new Uint16Array(maxBits);
  const _bitL2           = new Uint16Array(maxBits);
  const _bitFirstSample  = new Uint32Array(maxBits);
  const _bitLastSample   = new Uint32Array(maxBits);
  const _bitUnclear      = new Uint8Array(maxBits);
  let bitCount = 0;

  // Working state shared with readCycle (mirrors the Go closure pattern).
  let minVal = 0, maxVal = 0, threshold = 0;
  let minIndex = 0, maxIndex = startSample;
  let belowIndex = 0, aboveIndex = startSample;
  let lengthBelow = 0, lengthAbove = 0, length = 0;
  let streamFirstSample = startSample;
  let streamMinVal = 0, streamMaxVal = 0;

  const readCycle = (): boolean => {
    // Find next minimum within a SEARCH_WINDOW after the current max.
    minVal = 32767;
    minIndex = maxIndex + 1;
    const minEnd = Math.min(maxIndex + SEARCH_WINDOW, samples.length);
    for (let i = maxIndex + 1; i < minEnd; i++) {
      if (samples[i] < minVal) { minVal = samples[i]; minIndex = i; }
    }
    if (minVal < streamMinVal) streamMinVal = minVal;

    // Find the crossover point falling below threshold.
    threshold = (maxVal + minVal) >> 1;
    belowIndex = maxIndex + 1;
    for (let i = maxIndex + 1; i < minEnd; i++) {
      if (samples[i] <= threshold) { belowIndex = i; break; }
    }
    lengthBelow = belowIndex - aboveIndex;

    // Find next maximum within a SEARCH_WINDOW after the current min.
    maxVal = -32768;
    maxIndex = minIndex + 1;
    const maxEnd = Math.min(minIndex + SEARCH_WINDOW, samples.length);
    for (let i = minIndex + 1; i < maxEnd; i++) {
      if (samples[i] > maxVal) { maxVal = samples[i]; maxIndex = i; }
    }
    if (maxVal > streamMaxVal) streamMaxVal = maxVal;

    // Find the crossover point rising above threshold.
    threshold = (maxVal + minVal) >> 1;
    aboveIndex = minIndex + 1;
    for (let i = minIndex + 1; i < maxEnd; i++) {
      if (samples[i] >= threshold) { aboveIndex = i; break; }
    }
    lengthAbove = aboveIndex - belowIndex;
    length = lengthBelow + lengthAbove;

    if (length > NO_SIGNAL_THRESHOLD) return true; // gap in tape signal

    let v: 0 | 1;
    let unclear: boolean;
    if (length >= LONG_THRESHOLD) {
      v = 0; unclear = false;
    } else if (length <= SHORT_THRESHOLD) {
      v = 1; unclear = false;
    } else if (Math.abs(lengthBelow - lengthAbove) <= (LONG_THRESHOLD - SHORT_THRESHOLD) >> 1) {
      v = 0; unclear = true;
    } else {
      v = 1; unclear = true;
    }
    _bitV[bitCount] = v;
    _bitL1[bitCount] = Math.min(lengthBelow, 65535);
    _bitL2[bitCount] = Math.min(lengthAbove, 65535);
    _bitFirstSample[bitCount] = aboveIndex - length;
    _bitLastSample[bitCount]  = aboveIndex - 1;
    _bitUnclear[bitCount] = unclear ? 1 : 0;
    bitCount++;
    return false;
  };

  // Keep searching until we find a continuous run of at least 0.2 s (MIN_SYNC_BITS).
  while (maxIndex < samples.length && bitCount < MIN_SYNC_BITS) {
    bitCount = 0;  // reset without reallocating
    streamFirstSample = aboveIndex;
    while (maxIndex < samples.length) {
      if (readCycle()) break;
    }
  }

  const samplesRead = aboveIndex - startSample;

  // Trim TypedArrays to actual size. .slice() creates a compact copy,
  // freeing the oversized pre-allocated buffers.
  const stream: BitStream = {
    bitCount,
    bitV:           _bitV.slice(0, bitCount),
    bitL1:          _bitL1.slice(0, bitCount),
    bitL2:          _bitL2.slice(0, bitCount),
    bitFirstSample: _bitFirstSample.slice(0, bitCount),
    bitLastSample:  _bitLastSample.slice(0, bitCount),
    bitUnclear:     _bitUnclear.slice(0, bitCount),
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
      programs.push(prog);
    }
  }
  return programs;
}

function readProgramBytes(stream: BitStream): Program {
  const prog: Program = { stream, bytes: [], lines: [], name: '' };
  let currentBit = 0;
  let byteUnclear = false;

  const getBit = (): { bt: 0 | 1; ok: boolean } => {
    if (currentBit < stream.bitCount) {
      byteUnclear = byteUnclear || (stream.bitUnclear[currentBit] === 1);
      return { bt: stream.bitV[currentBit++] as 0 | 1, ok: true };
    }
    return { bt: 0, ok: false };
  };

  // Scan for sync byte 0x16, assembled LSB-first from the raw bit stream.
  let by = 0;
  while (by !== 0x16) {
    const { bt, ok } = getBit();
    if (!ok) return prog;
    by = ((by >>> 1) | (bt << 7)) & 0xFF;
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

export function readProgramLines(prog: Program): void {
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

  // Find sync: 4+ × 0x16 bytes followed by 0x24.
  let syncCount = 0;
  while (true) {
    const b = getByte();
    if (!ok) return;
    if (b === 0x16) { syncCount++; }
    else if (b === 0x24 && syncCount > 3) { break; }
    else { syncCount = 0; }
  }

  // 9-byte file header; byte[2] === 0 means BASIC file.
  const header: number[] = [];
  for (let i = 0; i < 9; i++) header.push(getByte());
  if (header[2] !== 0) return;

  // Start address from header (bytes 6–7, big-endian).  Used to anchor the
  // chain of next-line pointer addresses to real Oric memory addresses.
  const endAddr   = (header[4] << 8) | header[5];
  const startAddr = (header[6] << 8) | header[7];

  // Null-terminated program name.
  for (let b = getByte(); b > 0; b = getByte()) {
    prog.name += String.fromCharCode(b);
  }

  // Cap getByte to the address range declared in the header.
  // endAddr is exclusive (the first byte past the saved data), so the last
  // valid stream index is firstContentIdx + (endAddr - startAddr) - 1.
  const firstContentIdx = nextByte;
  endIdx = firstContentIdx + (endAddr - startAddr) - 1;

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
