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
 * This validates framing, parity, the 3/4 cadence + name->data gap, AND the
 * long-half phase of every shared 0-cell against ground truth.
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

/**
 * A decoded byte's trailing stop-bit count.  The decoder frames every byte as
 * start + 8 data + parity (10 bits) followed by its stop bits, read up to the
 * next byte's start bit - so the stops are exactly bits [firstBit+10 .. lastBit].
 */
export function stopRun(b: { firstBit: number; lastBit: number }): number {
  return b.lastBit - b.firstBit + 1 - 10;
}

/**
 * A 0-cell's phase: true if its long half is the HIGH half ("long-half-high").
 * readCycle splits each cycle at the rising edge, so bitL1 is the high portion;
 * for a 0-cell (short+long) the high portion is the long half iff it is more than
 * half the whole cell.  This asks which *half* is long, not which way the signal
 * swung, so the original recording and our (mirror-shaped) re-encode are measured
 * on the same footing - see oric-tape-format.md §4.
 */
export const phaseHigh = (s: BitStream, bi: number): boolean =>
  2 * s.bitL1[bi] > s.bitLastSample[bi] - s.bitFirstSample[bi] + 1;

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
  // Anchor on the decoder's sync scan (4+ 0x16 then 0x24) via header.byteIndex,
  // not a naive search for the first 0x24 - a stray 0x24 in the leader would
  // otherwise mis-anchor the window onto garbage.  byteIndex points just past
  // the marker, so the marker itself is byteIndex - 1.
  if (prog.header.byteIndex <= 0) return 'no 0x24 marker';
  const ai = prog.header.byteIndex - 1;

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
 * Per byte it also checks the *phase* (which half of each 0-cell is the long one)
 * at every position both sides decoded as 0 - the start bit always, plus every
 * shared 0 in data/parity.  The bit *values* are phase-blind, so this is the only
 * check that the encoder placed each long half-cycle the same side the real Oric
 * did - i.e. that we stay in phase with a genuine save (§4).
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
  if (reenc.header.byteIndex <= 0) return 're-encode has no 0x24 marker';
  const bi = reenc.header.byteIndex - 1;              // anchor on the decoder's marker, not findIndex

  // Bit-exact comparison, byte by byte so a mismatch points at a specific byte.
  for (let k = 0; k < count; k++) {
    const a  = snap[k];
    const bB = reenc.bytes[bi + k];
    if (!bB) return `re-encode ran out at ${uiByte(k)}`;
    const want = stream[SYNC_BYTES + k];
    if (bB.v !== want) return `${uiByte(k)} decoded to ${hex(bB.v)}, encoded ${hex(want)}`;
    const normalised = a.v !== want;                  // a byte the encoder deliberately changed (the endAddr correction; or a non-canonical autorun byte, normalised to 0xC7 - none in the corpus)

    const aLen = a.lastBit - a.firstBit + 1, bLen = bB.lastBit - bB.firstBit + 1;
    if (aLen !== bLen) return `${uiByte(k)} (${hex(a.v)} vs ${hex(bB.v)}): bit length ${aLen} (recording) vs ${bLen} (ours)`;
    const FRAME = 10;                                 // first 10 bits = start + 8 data + parity; the rest are stop bits
    for (let j = 0; j < aLen; j++) {
      const av = origBitV[a.firstBit + j], bv = reenc.stream.bitV[bB.firstBit + j];

      // Phase (§4): only a 0-cell has a long half, so phase is comparable wherever
      // both sides decoded a 0 - the start bit always, plus every shared 0 in the
      // data/parity (so normalised bytes are still checked at the positions they
      // share).  Phase is value-independent (the cadence sets it) and value +
      // length are phase-blind, so this is the sole guard that each long
      // half-cycle landed the side (low/high) the real Oric put it.
      if (av === 0 && bv === 0) {
        const op = phaseHigh(orig.stream, a.firstBit + j);
        const rp = phaseHigh(reenc.stream, bB.firstBit + j);
        if (op !== rp) return `${uiByte(k)} (${hex(want)}) frame bit ${j}: phase long-${op ? 'high' : 'low'} (recording) vs long-${rp ? 'high' : 'low'} (ours)`;
      }

      if (av === bv) continue;
      if (j >= FRAME || !normalised) {
        const where = j >= FRAME ? `stop bit ${j - FRAME}` : `frame bit ${j}`;
        return `bit mismatch in ${uiByte(k)} (recording ${hex(a.v)}, ours ${hex(bB.v)}) ${where}: recording=${av} ours=${bv}`;
      }
    }
  }
  return null;
}
