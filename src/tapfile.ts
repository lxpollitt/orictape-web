import type { ByteInfo, BitStream, Program } from './decoder';
import { readProgramLines } from './decoder';

/** A minimal empty BitStream for programs loaded from TAP (no waveform data). */
function emptyStream(): BitStream {
  return {
    bitCount:       0,
    bitV:           new Uint8Array(0),
    bitL1:          new Uint16Array(0),
    bitL2:          new Uint16Array(0),
    bitFirstSample: new Uint32Array(0),
    bitLastSample:  new Uint32Array(0),
    bitUnclear:     new Uint8Array(0),
    firstSample:    0,
    lastSample:     0,
    minVal:         0,
    maxVal:         0,
  };
}

/**
 * Parse an Oric-1 TAP file and return one Program per BASIC block found.
 *
 * Each TAP program block has the structure:
 *   [0x16 × N]  sync bytes  (N ≥ 4)
 *   [0x24]      sync marker
 *   [9 bytes]   header  —  byte[2] === 0x00 means BASIC
 *   [name\0]    null-terminated program name
 *   [BASIC…]    lines in Oric memory format
 *   [0x00 0x00] end-of-program marker
 *
 * We feed the raw bytes for each block directly into the existing
 * readProgramLines() parser so error detection and BASIC decoding remain
 * identical to the WAV path.
 */
export function parseTapFile(buffer: ArrayBuffer): Program[] {
  const data = new Uint8Array(buffer);
  const programs: Program[] = [];

  // ── Find all block start positions ──────────────────────────────────────────
  // A block starts at the first 0x16 in a run of ≥ 4 consecutive 0x16 bytes.
  const blockStarts: number[] = [];
  let i = 0;
  while (i < data.length) {
    if (data[i] === 0x16) {
      const runStart = i;
      while (i < data.length && data[i] === 0x16) i++;
      if (i - runStart >= 4) blockStarts.push(runStart);
    } else {
      i++;
    }
  }

  // ── Parse each block ─────────────────────────────────────────────────────────
  for (let b = 0; b < blockStarts.length; b++) {
    const start = blockStarts[b];
    // The block ends at the start of the next block (or EOF).  readProgramLines
    // will stop at the 0x00 0x00 end-of-program marker regardless, so giving it
    // extra trailing bytes is safe.
    const end = b + 1 < blockStarts.length ? blockStarts[b + 1] : data.length;

    // Build ByteInfo[] — all bytes are clean (no errors in a TAP file).
    const bytes: ByteInfo[] = [];
    for (let j = start; j < end; j++) {
      bytes.push({ v: data[j], firstBit: 0, lastBit: 0, unclear: false, chkErr: false });
    }

    const prog: Program = {
      stream: emptyStream(),
      bytes,
      lines:  [],
      name:   '',
    };

    readProgramLines(prog);

    if (prog.lines.length > 0) {
      programs.push(prog);
    }
  }

  return programs;
}
