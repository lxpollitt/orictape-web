#!/usr/bin/env npx tsx
/**
 * Round-trip tests for the Oric tape-audio encoder (audioEncoder.ts).
 *
 *  1. SYNTHETIC self-test: encode a known program to square-wave audio, decode
 *     it back through the real pipeline, and confirm the program-proper bytes
 *     round-trip byte-exactly with no parity errors.  Proves framing / cells /
 *     parity are internally consistent.
 *
 *  2. REAL-CAPTURE round-trip: decode a genuine Oric-1 cassette recording,
 *     re-encode the program, decode that, and confirm the bytes AND the 3/4
 *     stop-bit cadence match the original from the 0x24 through the program
 *     terminator — validating our cadence against ground truth.  The extra byte
 *     past the terminator is RAM garbage on real hardware (vs our fixed 0x52),
 *     so the comparison stops at the terminator.  Skipped if the capture
 *     (personal data, not in the repo) is absent.
 *
 * Run: npx tsx tests/audioRoundtrip.ts
 */

import { existsSync, readFileSync } from 'fs';
import type { BitStream, ByteInfo, Program } from '../src/decoder';
import { emptyBitStream, readBitStreams, readPrograms } from '../src/decoder';
import { parseWavFile } from '../src/wavfile';
import { buildByteStream, encodeProgramSamples, encodeProgramWav, SAMPLE_RATE, SYNC_BYTES } from '../src/audioEncoder';

type Result = string | null;                 // null = pass, 'SKIP …' = skipped, else failure
type Test = { name: string; run: () => Result };
const tests: Test[] = [];
function test(name: string, run: () => Result) { tests.push({ name, run }); }

const hex = (v: number) => '0x' + v.toString(16).padStart(2, '0');

/** Count the run of 1-bits (stop bits) at the front of a decoded byte. */
function stopRun(s: BitStream, firstBit: number): number {
  let n = 0, i = firstBit;
  while (i < s.bitCount && s.bitV[i] === 1) { n++; i++; }
  return n;
}

// ── 1. Synthetic self-test ───────────────────────────────────────────────────

function mkByte(v: number): ByteInfo {
  return { v, firstBit: 0, lastBit: 0, unclear: false, chkErr: false };
}
function mkProgram(name: string, startAddr: number, data: number[]): Program {
  const endAddr = startAddr + data.length;
  const header  = [0x00, 0x00, 0x80, 0x00, (endAddr >> 8) & 0xFF, endAddr & 0xFF, (startAddr >> 8) & 0xFF, startAddr & 0xFF, 0x00];
  const bytes: ByteInfo[] = [];
  for (const h of header) bytes.push(mkByte(h));
  for (const c of name) bytes.push(mkByte(c.charCodeAt(0)));
  bytes.push(mkByte(0));
  for (const d of data) bytes.push(mkByte(d & 0xFF));
  return { stream: emptyBitStream(), bytes, lines: [], name, originalSource: '', progNumber: 0,
           header: { byteIndex: 0, fileType: 0x80, autorun: false, startAddr, endAddr } };
}

test('square-wave audio of a synthetic program decodes back byte-exactly', () => {
  const data = [0xA9, 0x2A, 0x8D, 0x00, 0x02, 0x60, 0x16, 0x24, 0x52, 0xFF];
  const prog = mkProgram('GAME', 0x0500, data);

  const samples = encodeProgramSamples(prog, false);
  const stream  = buildByteStream(prog, false);   // idempotent after the encoder's fixHeaderEndAddr

  const progs = readPrograms(readBitStreams(samples, SAMPLE_RATE));
  if (progs.length !== 1) return `decoded ${progs.length} programs, want 1`;
  const got = progs[0];
  if (got.name !== 'GAME') return `name "${got.name}", want "GAME"`;

  const proper = stream.slice(SYNC_BYTES + 1);     // drop the leader + 0x24
  const bi     = got.header.byteIndex;
  for (let i = 0; i < proper.length; i++) {
    const b = got.bytes[bi + i];
    if (!b)                return `decoded byte at proper index ${i} is missing`;
    if (b.v !== proper[i]) return `proper byte ${i}: got ${hex(b.v)}, want ${hex(proper[i])}`;
    if (b.chkErr)          return `proper byte ${i} (${hex(b.v)}) decoded with a parity error`;
  }
  return null;
});

// ── 2. Real-capture round-trip ───────────────────────────────────────────────

const CAPTURE = 'tests/audio/FiiO CP13 - Boots C90 - Space Station A - first.L.wav';

function decodeWav(bytes: Uint8Array): Program[] {
  const ab  = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const wav = parseWavFile(ab);
  return readPrograms(readBitStreams(wav.left, wav.sampleRate));
}

test('real Oric-1 capture: bit-exact vs the recording (header TAP-normalised)', () => {
  if (!existsSync(CAPTURE)) return `SKIP capture not present: ${CAPTURE}`;

  // Decode the recording twice: `a` is the untouched baseline (its real bits);
  // `enc` is a fresh copy handed to the encoder, which mutates it via the
  // TAP-paradigm endAddr fix, so we must not let that perturb `a`'s bits.
  const a = decodeWav(readFileSync(CAPTURE))[0];
  if (!a || a.lines.length === 0) return `capture decoded no BASIC lines`;
  const enc = decodeWav(readFileSync(CAPTURE))[0];

  const ai = a.bytes.findIndex(x => x.v === 0x24);
  if (ai < 0) return `0x24 not found in capture`;
  if (stopRun(a.stream, a.bytes[ai].firstBit) !== 3) return `capture 0x24 leading stop-run is not 3`;

  const stream = buildByteStream(enc);             // the exact bytes we put on tape (TAP-normalised header)
  const b = decodeWav(encodeProgramWav(enc))[0];    // decode of our WAV
  if (!b) return `re-encode decoded no program`;
  const bi = b.bytes.findIndex(x => x.v === 0x24);
  if (bi < 0) return `0x24 not found in re-encode`;

  const lastLine = a.lines[a.lines.length - 1];
  const count    = (lastLine.lastByte + 3) - ai;   // 0x24 .. program terminator (excludes the $52 filler)

  // Bit-exact comparison, byte by byte so a mismatch points at a specific byte.
  // Every bit must match the recording, EXCEPT the frame bits (start/data/parity)
  // of the TAP-normalised header bytes (autorun byte + endAddr fix), which
  // legitimately differ - but even those must keep matching stop bits and must
  // decode to OUR encoded value.
  for (let k = 0; k < count; k++) {
    const aB = a.bytes[ai + k], bB = b.bytes[bi + k];
    if (!bB) return `re-encode ran out at byte ${k}/${count}`;
    const want = stream[SYNC_BYTES + k];
    if (bB.v !== want) return `byte ${k} decoded to ${hex(bB.v)}, encoded ${hex(want)}`;
    const normalised = aB.v !== want;              // a header byte the TAP paradigm changed

    const aLen = aB.lastBit - aB.firstBit + 1, bLen = bB.lastBit - bB.firstBit + 1;
    if (aLen !== bLen) return `byte ${k} (${hex(aB.v)} vs ${hex(bB.v)}): bit length ${aLen} (recording) vs ${bLen} (ours)`;
    const frameStart = aLen - 10;                  // last 10 bits = start + 8 data + parity; before = stop bits
    for (let j = 0; j < aLen; j++) {
      const av = a.stream.bitV[aB.firstBit + j], bv = b.stream.bitV[bB.firstBit + j];
      if (av === bv) continue;
      if (j < frameStart || !normalised) {
        const where = j < frameStart ? `stop bit ${j}` : `frame bit ${j - frameStart}`;
        return `bit mismatch in byte ${k} (recording ${hex(aB.v)}, ours ${hex(bB.v)}) ${where}: recording=${av} ours=${bv}`;
      }
    }
  }
  return null;
});

// ── Runner ───────────────────────────────────────────────────────────────────

let allPass = true;
for (const t of tests) {
  let err: Result;
  try { err = t.run(); }
  catch (e) { err = `threw: ${(e as Error).message}`; }
  if (err && err.startsWith('SKIP')) { console.log(`SKIP  ${t.name}\n      ${err.slice(4).trim()}`); continue; }
  const pass = err === null;
  if (!pass) allPass = false;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${t.name}${err ? `\n      ${err}` : ''}`);
}
console.log(`\n${allPass ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'}`);
process.exit(allPass ? 0 : 1);
