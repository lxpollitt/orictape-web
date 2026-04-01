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
}

const SHORT_THRESHOLD = 20;
const LONG_THRESHOLD = 24;
const NO_SIGNAL_THRESHOLD = 46;

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

export function readBitStreams(samples: Int16Array): BitStream[] {
  const streams: BitStream[] = [];
  let startSample = 0;
  while (true) {
    const { stream, samplesRead } = readBitStream(samples, startSample);
    if (samplesRead === 0) break;
    streams.push(stream);
    startSample += samplesRead;
  }
  return streams;
}

function readBitStream(samples: Int16Array, startSample: number): { stream: BitStream; samplesRead: number } {
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
    // Find next minimum within a 20-sample window after the current max.
    minVal = 32767;
    let swi = 0;
    const minEnd = Math.min(maxIndex + 20, samples.length);
    for (let i = maxIndex + 1; i < minEnd; i++) {
      if (samples[i] < minVal) { minVal = samples[i]; swi = i - maxIndex - 1; }
    }
    minIndex = maxIndex + 1 + swi;
    if (minVal < streamMinVal) streamMinVal = minVal;

    // Find the crossover point falling below threshold.
    threshold = (maxVal + minVal) >> 1;
    swi = 0;
    for (let i = maxIndex + 1; i < minEnd; i++) {
      if (samples[i] <= threshold) { swi = i - maxIndex - 1; break; }
    }
    belowIndex = maxIndex + 1 + swi;
    lengthBelow = belowIndex - aboveIndex;

    // Find next maximum within a 20-sample window after the current min.
    maxVal = -32768;
    swi = 0;
    const maxEnd = Math.min(minIndex + 20, samples.length);
    for (let i = minIndex + 1; i < maxEnd; i++) {
      if (samples[i] > maxVal) { maxVal = samples[i]; swi = i - minIndex - 1; }
    }
    maxIndex = minIndex + 1 + swi;
    if (maxVal > streamMaxVal) streamMaxVal = maxVal;

    // Find the crossover point rising above threshold.
    threshold = (maxVal + minVal) >> 1;
    swi = 0;
    for (let i = minIndex + 1; i < maxEnd; i++) {
      if (samples[i] >= threshold) { swi = i - minIndex - 1; break; }
    }
    aboveIndex = minIndex + 1 + swi;
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

  // Keep searching until we find a continuous run of at least 0.2s (8820 bits at 44100 Hz).
  while (maxIndex < samples.length && bitCount < 8820) {
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

function readProgramLines(prog: Program): void {
  let nextByte = 0;
  let ok = true;

  const getByte = (): number => {
    if (nextByte < prog.bytes.length) {
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

  // Null-terminated program name.
  for (let b = getByte(); b > 0; b = getByte()) {
    prog.name += String.fromCharCode(b);
  }

  // Program lines.
  let correctionOffset = 0;
  while (true) {
    const lineStart = nextByte;
    // Read the raw pointer first; a zero value signals end-of-program.
    // The correctionOffset is applied afterwards, matching the Go original.
    const rawLineStart = getByte() + 256 * getByte();
    if (rawLineStart === 0 || !ok) break;
    const nextLineStart = rawLineStart - correctionOffset;

    const elements: string[] = [];
    const lineNum = getByte() + 256 * getByte();
    const lineNumStr = `${lineNum} `;
    elements.push(lineNumStr);
    let line = lineNumStr;

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
    });
    correctionOffset += nextLineStart - nextByte;
  }

  if (prog.lines.length > 0) {
    prog.lines[0].lenErr = false;
    prog.lines[0].expectedLastByte = prog.lines[0].lastByte;
  }
}
