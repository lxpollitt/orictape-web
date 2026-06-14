#!/usr/bin/env npx tsx
/**
 * Self-test for the WAV writer (encodeWavFile in wavfile.ts).
 *
 * Writing 16-bit mono PCM and reading it back through parseWavFile must
 * reproduce the samples and rate exactly, and the container header must
 * be a well-formed RIFF/WAVE/fmt/data layout.  Foundational for the
 * "save program as Oric tape audio" feature (the audio encoder builds on
 * this writer).
 *
 * Not part of CI — run: npx tsx tests/wavFileScenarios.ts
 */

import { encodeWavFile, parseWavFile } from '../src/wavfile';

type Test = { name: string; run: () => string | null };
const tests: Test[] = [];
function test(name: string, run: () => string | null) { tests.push({ name, run }); }

/** Read a 4-char chunk id from a byte array. */
function id(bytes: Uint8Array, off: number): string {
  return String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
}

// ── Round-trip: encode then parse reproduces samples + rate ──────────────────

test('mono 16-bit PCM round-trips through parseWavFile', () => {
  const rate = 48000;
  const samples = Int16Array.from([0, 1, -1, 32767, -32768, 12345, -6789, 100]);

  const wav    = encodeWavFile(samples, rate);
  const parsed = parseWavFile(wav.buffer as ArrayBuffer);

  if (parsed.sampleRate !== rate)            return `rate ${parsed.sampleRate}, want ${rate}`;
  if (parsed.sampleCount !== samples.length) return `count ${parsed.sampleCount}, want ${samples.length}`;
  for (let i = 0; i < samples.length; i++) {
    if (parsed.left[i]  !== samples[i]) return `sample ${i}: ${parsed.left[i]}, want ${samples[i]}`;
    // parseWavFile mirrors mono into the right channel.
    if (parsed.right[i] !== samples[i]) return `right ${i}: ${parsed.right[i]}, want ${samples[i]}`;
  }
  return null;
});

// ── Container header is a well-formed canonical 44-byte WAV header ────────────

test('container header is a well-formed RIFF/WAVE/fmt/data layout', () => {
  const rate = 48000;
  const samples = Int16Array.from([1, 2, 3, 4]);
  const dataSize = samples.length * 2;

  const wav = encodeWavFile(samples, rate);
  const v   = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

  if (wav.length !== 44 + dataSize)        return `file length ${wav.length}, want ${44 + dataSize}`;
  if (id(wav, 0)  !== 'RIFF')              return `id@0 "${id(wav, 0)}", want RIFF`;
  if (v.getUint32(4, true) !== 36 + dataSize) return `RIFF size ${v.getUint32(4, true)}, want ${36 + dataSize}`;
  if (id(wav, 8)  !== 'WAVE')              return `id@8 "${id(wav, 8)}", want WAVE`;
  if (id(wav, 12) !== 'fmt ')              return `id@12 "${id(wav, 12)}", want "fmt "`;
  if (v.getUint32(16, true) !== 16)        return `fmt size ${v.getUint32(16, true)}, want 16`;
  if (v.getUint16(20, true) !== 1)         return `audio format ${v.getUint16(20, true)}, want 1 (PCM)`;
  if (v.getUint16(22, true) !== 1)         return `channels ${v.getUint16(22, true)}, want 1`;
  if (v.getUint32(24, true) !== rate)      return `rate ${v.getUint32(24, true)}, want ${rate}`;
  if (v.getUint32(28, true) !== rate * 2)  return `byte rate ${v.getUint32(28, true)}, want ${rate * 2}`;
  if (v.getUint16(32, true) !== 2)         return `block align ${v.getUint16(32, true)}, want 2`;
  if (v.getUint16(34, true) !== 16)        return `bits/sample ${v.getUint16(34, true)}, want 16`;
  if (id(wav, 36) !== 'data')              return `id@36 "${id(wav, 36)}", want data`;
  if (v.getUint32(40, true) !== dataSize)  return `data size ${v.getUint32(40, true)}, want ${dataSize}`;
  return null;
});

// ── Edge: zero-length sample buffer still produces a valid 44-byte header ─────
// (Not round-tripped: parseWavFile's chunk-scan loop won't accept a data
//  chunk of size 0 — a pre-existing edge case, irrelevant to real output.)

test('zero-length sample buffer produces a valid 44-byte header', () => {
  const wav = encodeWavFile(new Int16Array(0), 48000);
  const v   = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  if (wav.length !== 44)              return `length ${wav.length}, want 44`;
  if (id(wav, 0) !== 'RIFF')          return `id@0 "${id(wav, 0)}", want RIFF`;
  if (v.getUint32(40, true) !== 0)    return `data size ${v.getUint32(40, true)}, want 0`;
  return null;
});

// ── Invalid sample rate is rejected up front ─────────────────────────────────

test('invalid sample rate is rejected', () => {
  for (const bad of [0, -48000, 48000.5, NaN]) {
    let threw = false;
    try { encodeWavFile(new Int16Array(4), bad); } catch { threw = true; }
    if (!threw) return `rate ${bad} should have thrown`;
  }
  return null;
});

// ── Runner ───────────────────────────────────────────────────────────────────

let allPass = true;
for (const t of tests) {
  let err: string | null;
  try { err = t.run(); }
  catch (e) { err = `threw: ${(e as Error).message}`; }
  const pass = err === null;
  if (!pass) allPass = false;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${t.name}${err ? `\n      ${err}` : ''}`);
}
console.log(`\n${allPass ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'}`);
process.exit(allPass ? 0 : 1);
