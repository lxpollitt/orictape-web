/**
 * Shared bit-stream round-trip comparison for the Oric tape-audio encoder.
 *
 * Used by both the single-capture test (audioRoundtrip.ts) and the bulk
 * regression test (audioBulkRoundtrip.ts) so the (subtle) comparison logic
 * lives in exactly one place.
 *
 * The contract: take a Program decoded from a *real* recording, re-encode it to
 * WAV, decode that, and confirm the re-decode's bit stream matches the original
 * recording's bits from the 0x24 marker through the last program byte — every
 * bit, byte by byte.  The only legitimate differences are the frame bits
 * (start/data/parity) of bytes the encoder deliberately changes (the TAP-save
 * paradigm normalises the autorun byte and the endAddr); those are detected
 * byte-aware via a value difference and must still keep matching stop bits.
 * This validates framing, parity AND the 3/4 cadence + name->data gap against
 * ground truth.
 *
 * The comparison is purely byte/bit level: the program's extent comes from the
 * header (endAddr - startAddr), not from BASIC line structure, so it works for
 * machine-code programs too.  Deciding *which* programs are clean enough to
 * compare is the caller's job (see audioBulkRoundtrip.ts's filter).
 *
 * Byte indices in messages use the UI convention: byte 0 is the first header
 * byte (immediately after the 0x24 marker), matching what the app displays.
 */

import type { BitStream, Program } from '../src/decoder';
import { readBitStreams, readPrograms } from '../src/decoder';
import { parseWavFile } from '../src/wavfile';
import { buildByteStream, encodeProgramWav, SYNC_BYTES } from '../src/audioEncoder';

export const hex = (v: number) => '0x' + v.toString(16).padStart(2, '0');

/** Decode a WAV byte buffer to programs + its sample rate (left channel). */
export function decodeWav(bytes: Uint8Array): { programs: Program[]; sampleRate: number } {
  const ab  = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const wav = parseWavFile(ab);
  return { programs: readPrograms(readBitStreams(wav.left, wav.sampleRate)), sampleRate: wav.sampleRate };
}

/** Decode a WAV byte buffer to programs (left channel), as the app would. */
export function decodeWavBytes(bytes: Uint8Array): Program[] {
  return decodeWav(bytes).programs;
}

/**
 * Stable program label matching the bulk TAP snapshot + UI convention
 * (`<wav-base>_<NAME>_<startSec>s`), so a program can be located by file, name
 * and position in the recording.  startSec is the program's first BASIC line —
 * or byte 0 (the program's first decoded byte) for machine-code programs with
 * no lines — in seconds, floored.  Reference byte MUST match snapshot.ts and
 * the UI (computeOriginalSource / status bar in main.ts), which both use
 * `lines[0].firstByte` else byte 0; using the header byte instead would land
 * ~1s later (past the 0x16 leader) and mislabel machine-code programs.
 */
export function programLabel(base: string, prog: Program, sampleRate: number): string {
  const refByteIdx = prog.lines.length > 0 ? prog.lines[0].firstByte : 0;
  const refBit     = prog.bytes[refByteIdx]?.firstBit ?? 0;
  const sample     = prog.stream.bitFirstSample[refBit] ?? 0;
  const startSec   = Math.floor(sample / sampleRate);
  return `${base}_${prog.name}_${startSec}s`;
}

/** UI-style byte label: byte 0 = first header byte, just after the 0x24. */
const uiByte = (k: number) => (k === 0 ? 'the 0x24 marker' : `byte ${k - 1}`);

/** Count the run of 1-bits (stop bits) at the front of a decoded byte. */
export function stopRun(s: BitStream, firstBit: number): number {
  let n = 0, i = firstBit;
  while (i < s.bitCount && s.bitV[i] === 1) { n++; i++; }
  return n;
}

export interface ProgramWindow {
  ai:      number;   // byte index of the 0x24 marker (start of the compared region)
  dataEnd: number;   // byte index one past the last program byte (the $52 extra byte sits here)
  count:   number;   // bytes to compare: 0x24 .. last program byte (dataEnd - ai)
}

/**
 * Locate a program's byte extent purely from the header — no line structure.
 *
 * Layout from the 0x24 marker: 0x24, 9 header bytes, NUL-terminated name, then
 * `endAddr - startAddr` program-data bytes, then the extra byte.  Returns the
 * compared region [0x24 .. last program byte] (excludes the extra byte, whose
 * value is RAM garbage on real hardware).  Returns a reason string if the
 * program is structurally unusable for comparison (no marker, name not
 * terminated, degenerate length, or data running past the decoded bytes).
 */
export function programWindow(prog: Program): ProgramWindow | string {
  const bytes = prog.bytes;
  const ai = bytes.findIndex(x => x.v === 0x24);
  if (ai < 0) return 'no 0x24 marker';

  const nameStart = ai + 10;                 // 0x24 + 9 header bytes
  let nul = nameStart;
  while (nul < bytes.length && bytes[nul].v !== 0x00) nul++;
  if (nul >= bytes.length) return 'name not NUL-terminated (truncated)';

  const dataLen = prog.header.endAddr - prog.header.startAddr;
  if (dataLen <= 0) return 'degenerate program length (endAddr <= startAddr)';

  const dataEnd = nul + 1 + dataLen;
  if (dataEnd > bytes.length) return 'program data runs past decoded bytes (truncated)';

  return { ai, dataEnd, count: dataEnd - ai };
}

/**
 * Round-trip one program decoded from a real recording and bit-compare the
 * re-decode against the original's bits.  Returns null on a (normalisation-
 * tolerant) bit-exact match, else a human-readable mismatch description (byte
 * indices in the UI convention: byte 0 = first header byte).
 *
 * Mutates `orig`'s header via the encoder's TAP-paradigm normalisation, so the
 * original byte values are snapshotted up front; the original *bits*
 * (`orig.stream.bitV`) are never touched by encoding, so they are read live.
 * Callers should only pass programs whose compared region decoded cleanly
 * (see audioBulkRoundtrip.ts's filter); a structurally unusable program
 * returns the programWindow reason string.
 */
export function roundTripMismatch(orig: Program): string | null {
  const w = programWindow(orig);
  if (typeof w === 'string') return w;
  const { ai, count } = w;

  // Snapshot the original byte values + bit boundaries BEFORE the encoder
  // mutates the header.  The bitV array itself is not mutated by encoding.
  const origBitV = orig.stream.bitV;
  const snap: { v: number; firstBit: number; lastBit: number }[] = [];
  for (let k = 0; k < count; k++) {
    const b = orig.bytes[ai + k];
    if (!b) return `original ran out at ${uiByte(k)}`;
    snap.push({ v: b.v, firstBit: b.firstBit, lastBit: b.lastBit });
  }

  const stream = buildByteStream(orig);               // the exact bytes we put on tape (mutates orig.header)
  const reenc  = decodeWavBytes(encodeProgramWav(orig))[0];
  if (!reenc) return 're-encode decoded no program';
  const bi = reenc.bytes.findIndex(x => x.v === 0x24);
  if (bi < 0) return '0x24 not found in re-encode';

  // Bit-exact comparison, byte by byte so a mismatch points at a specific byte.
  for (let k = 0; k < count; k++) {
    const a  = snap[k];
    const bB = reenc.bytes[bi + k];
    if (!bB) return `re-encode ran out at ${uiByte(k)}`;
    const want = stream[SYNC_BYTES + k];
    if (bB.v !== want) return `${uiByte(k)} decoded to ${hex(bB.v)}, encoded ${hex(want)}`;
    const normalised = a.v !== want;                  // a byte the encoder deliberately changed (autorun / endAddr)

    const aLen = a.lastBit - a.firstBit + 1, bLen = bB.lastBit - bB.firstBit + 1;
    if (aLen !== bLen) return `${uiByte(k)} (${hex(a.v)} vs ${hex(bB.v)}): bit length ${aLen} (recording) vs ${bLen} (ours)`;
    const frameStart = aLen - 10;                     // last 10 bits = start + 8 data + parity; before = stop bits
    for (let j = 0; j < aLen; j++) {
      const av = origBitV[a.firstBit + j], bv = reenc.stream.bitV[bB.firstBit + j];
      if (av === bv) continue;
      if (j < frameStart || !normalised) {
        const where = j < frameStart ? `stop bit ${j}` : `frame bit ${j - frameStart}`;
        return `bit mismatch in ${uiByte(k)} (recording ${hex(a.v)}, ours ${hex(bB.v)}) ${where}: recording=${av} ours=${bv}`;
      }
    }
  }
  return null;
}
