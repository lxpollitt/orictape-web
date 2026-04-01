// Copyright © 2015 The Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0

export interface WavData {
  left: Int16Array;
  right: Int16Array;
  sampleCount: number;
}

export function parseWavFile(buffer: ArrayBuffer): WavData {
  const view = new DataView(buffer);

  const sig = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (sig !== 'RIFF') throw new Error('Not a RIFF file');

  const waveSig = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
  if (waveSig !== 'WAVE') throw new Error('Not a WAVE file');

  const tag = view.getUint16(20, true);
  const channels = view.getUint16(22, true);
  const freq = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);

  if (tag !== 1 || channels !== 2 || freq !== 44100 || bitsPerSample !== 16) {
    throw new Error('Only 44.1kHz 16-bit stereo WAV files are supported');
  }

  // Locate the data chunk (it may not be at a fixed offset)
  const fmtSize = view.getUint32(16, true);
  let offset = 12 + 8 + fmtSize; // skip WAVE sig, fmt header, fmt body

  while (offset < buffer.byteLength - 8) {
    const chunkId = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === 'data') {
      const dataStart = offset + 8;
      const sampleCount = chunkSize / 4; // 2 bytes per sample * 2 channels
      const left = new Int16Array(sampleCount);
      const right = new Int16Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        left[i] = view.getInt16(dataStart + i * 4, true);
        right[i] = view.getInt16(dataStart + i * 4 + 2, true);
      }
      return { left, right, sampleCount };
    }
    offset += 8 + chunkSize;
  }

  throw new Error('No data chunk found in WAV file');
}
