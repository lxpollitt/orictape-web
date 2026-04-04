// Copyright © 2015 The Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

export interface WavData {
  left:        Int16Array;
  right:       Int16Array;
  sampleRate:  number;
  sampleCount: number;
}

/** Read a 4-character chunk ID at the given byte offset. */
function chunkIdAt(view: DataView, off: number): string {
  return String.fromCharCode(
    view.getUint8(off), view.getUint8(off + 1),
    view.getUint8(off + 2), view.getUint8(off + 3),
  );
}

export function parseWavFile(buffer: ArrayBuffer): WavData {
  const view = new DataView(buffer);

  if (chunkIdAt(view, 0) !== 'RIFF') throw new Error('Not a RIFF file');
  if (chunkIdAt(view, 8) !== 'WAVE') throw new Error('Not a WAVE file');

  // ── Scan sub-chunks for 'fmt ' and 'data' ──────────────────────────────────
  // Some recording software (Audacity, Pro Tools, etc.) inserts JUNK or bext
  // chunks before 'fmt ', so we must not assume a fixed layout.
  let fmtOffset = -1;
  let dataOffset = -1;
  let dataSize   = 0;

  let off = 12; // first sub-chunk starts right after "WAVE"
  while (off < buffer.byteLength - 8) {
    const id   = chunkIdAt(view, off);
    const size = view.getUint32(off + 4, true);
    if (id === 'fmt ') fmtOffset = off + 8;
    if (id === 'data') { dataOffset = off + 8; dataSize = size; }
    if (fmtOffset >= 0 && dataOffset >= 0) break; // found both
    off += 8 + size;
  }

  if (fmtOffset < 0) throw new Error('No fmt chunk found in WAV file');
  if (dataOffset < 0) throw new Error('No data chunk found in WAV file');

  // ── Parse fmt chunk fields ─────────────────────────────────────────────────
  const tag           = view.getUint16(fmtOffset,      true);
  const channels      = view.getUint16(fmtOffset + 2,  true);
  const sampleRate    = view.getUint32(fmtOffset + 4,  true);
  const bitsPerSample = view.getUint16(fmtOffset + 14, true);

  if (tag !== 1)
    throw new Error('Only PCM WAV files are supported (not compressed)');
  if (channels < 1 || channels > 2)
    throw new Error(`Unsupported channel count: ${channels} (expected 1 or 2)`);
  if (bitsPerSample !== 8 && bitsPerSample !== 16)
    throw new Error(`Unsupported bit depth: ${bitsPerSample} (expected 8 or 16)`);
  if (sampleRate < 44100)
    throw new Error(`Sample rate ${sampleRate} Hz is too low — please convert to at least 44100 Hz`);

  // ── Decode sample data ─────────────────────────────────────────────────────
  const bytesPerSample = bitsPerSample >> 3;
  const frameSize      = channels * bytesPerSample;
  const sampleCount    = Math.floor(dataSize / frameSize);
  const left           = new Int16Array(sampleCount);
  const right          = new Int16Array(sampleCount);

  for (let i = 0; i < sampleCount; i++) {
    const base = dataOffset + i * frameSize;
    // 8-bit PCM is unsigned (0–255); convert to signed 16-bit range.
    const read = bitsPerSample === 8
      ? (o: number) => (view.getUint8(base + o) - 128) * 256
      : (o: number) => view.getInt16(base + o, true);

    left[i]  = read(0);
    right[i] = channels === 2 ? read(bytesPerSample) : left[i];
  }

  return { left, right, sampleRate, sampleCount };
}
