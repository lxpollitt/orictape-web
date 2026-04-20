#!/usr/bin/env npx tsx
/**
 * Ad-hoc scenario tests for splitBitStream / joinBitStreams.
 *
 * Tests the low-level primitives in isolation: correct bit slicing, metadata
 * propagation, round-trip fidelity, and the error paths.  Not part of CI —
 * just a quick sanity check during implementation.
 */

import { splitBitStream, joinBitStreams, type BitStream } from '../src/decoder';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Construct a deterministic BitStream for testing.  bitV and sample-position
 *  arrays are filled with patterns derived from the bit index so assertions
 *  can verify that slicing preserved the right ranges. */
function mkStream(format: 'fast' | 'slow', bitCount: number, firstSample = 1000): BitStream {
  const bitV           = new Uint8Array(bitCount);
  const bitL1          = new Uint16Array(bitCount);
  const bitFirstSample = new Uint32Array(bitCount);
  const bitLastSample  = new Uint32Array(bitCount);
  const bitUnclear     = new Uint8Array(bitCount);
  const bitMaxIndex    = new Uint32Array(bitCount);
  const bitMinIndex    = new Uint32Array(bitCount);
  for (let i = 0; i < bitCount; i++) {
    bitV[i]           = i & 1;                    // alternating 0/1
    bitL1[i]          = 10 + (i % 4);             // varied
    bitFirstSample[i] = firstSample + i * 20;     // monotonic, 20-sample bits
    bitLastSample[i]  = firstSample + i * 20 + 19;
    bitUnclear[i]     = (i % 7) === 0 ? 1 : 0;    // sparse
    bitMaxIndex[i]    = firstSample + i * 20 + 5;
    bitMinIndex[i]    = firstSample + i * 20 + 15;
  }
  return {
    format,
    bitCount,
    bitV, bitL1, bitFirstSample, bitLastSample, bitUnclear, bitMaxIndex, bitMinIndex,
    firstSample,
    lastSample: bitCount > 0 ? bitFirstSample[bitCount - 1] + 19 : firstSample,
    minVal:  -10000,
    maxVal:   10000,
  };
}

/** Deep-compare two BitStreams for structural equality.  Returns null on
 *  match, or a human-readable description of the first mismatch. */
function compareStreams(a: BitStream, b: BitStream, label = ''): string | null {
  const scalarFields: (keyof BitStream)[] = [
    'format', 'bitCount', 'firstSample', 'lastSample', 'minVal', 'maxVal',
  ];
  for (const f of scalarFields) {
    if (a[f] !== b[f]) return `${label}: ${String(f)} differs (${a[f]} vs ${b[f]})`;
  }
  const arrayFields: (keyof BitStream)[] = [
    'bitV', 'bitL1', 'bitFirstSample', 'bitLastSample', 'bitUnclear', 'bitMaxIndex', 'bitMinIndex',
  ];
  for (const f of arrayFields) {
    const av = a[f] as { length: number; [k: number]: number };
    const bv = b[f] as { length: number; [k: number]: number };
    if (av.length !== bv.length) return `${label}: ${String(f)}.length differs (${av.length} vs ${bv.length})`;
    for (let i = 0; i < av.length; i++) {
      if (av[i] !== bv[i]) return `${label}: ${String(f)}[${i}] differs (${av[i]} vs ${bv[i]})`;
    }
  }
  return null;
}

// ── Runner glue ───────────────────────────────────────────────────────────────

type Test = { name: string; run: () => string | null };
const tests: Test[] = [];
function test(name: string, run: () => string | null) { tests.push({ name, run }); }

// ── Split scenarios ───────────────────────────────────────────────────────────

test('split in middle preserves bits and metadata', () => {
  const s = mkStream('fast', 100);
  const [a, b] = splitBitStream(s, 40);
  if (a.bitCount !== 40) return `first bitCount ${a.bitCount} (want 40)`;
  if (b.bitCount !== 60) return `second bitCount ${b.bitCount} (want 60)`;
  if (a.format !== 'fast' || b.format !== 'fast') return 'format not inherited';
  if (a.firstSample !== s.firstSample) return `first.firstSample wrong`;
  if (a.lastSample  !== s.bitLastSample[39]) return `first.lastSample wrong`;
  if (b.firstSample !== s.bitFirstSample[40]) return `second.firstSample wrong`;
  if (b.lastSample  !== s.lastSample) return `second.lastSample wrong`;
  // Spot-check per-bit data preserved correctly.
  if (a.bitV[0]  !== s.bitV[0])  return `first.bitV[0] wrong`;
  if (a.bitV[39] !== s.bitV[39]) return `first.bitV[39] wrong`;
  if (b.bitV[0]  !== s.bitV[40]) return `second.bitV[0] wrong`;
  if (b.bitV[59] !== s.bitV[99]) return `second.bitV[59] wrong`;
  return null;
});

test('split at 0 → empty first, full second', () => {
  const s = mkStream('fast', 50);
  const [a, b] = splitBitStream(s, 0);
  if (a.bitCount !== 0)  return `first bitCount ${a.bitCount} (want 0)`;
  if (b.bitCount !== 50) return `second bitCount ${b.bitCount} (want 50)`;
  if (a.bitV.length !== 0) return `first.bitV not empty`;
  if (b.firstSample !== s.firstSample) return 'second.firstSample should match original';
  return compareStreams(b, s, 'second-vs-original');
});

test('split at bitCount → full first, empty second', () => {
  const s = mkStream('fast', 50);
  const [a, b] = splitBitStream(s, 50);
  if (a.bitCount !== 50) return `first bitCount ${a.bitCount} (want 50)`;
  if (b.bitCount !== 0)  return `second bitCount ${b.bitCount} (want 0)`;
  if (b.bitV.length !== 0) return `second.bitV not empty`;
  if (a.lastSample !== s.lastSample) return 'first.lastSample should match original';
  return compareStreams(a, s, 'first-vs-original');
});

test('split buffers are independent from original', () => {
  const s = mkStream('fast', 20);
  const [a] = splitBitStream(s, 10);
  // Mutating the split buffer must not affect the original.
  a.bitV[0] = (a.bitV[0] ^ 1) as 0 | 1;
  if (s.bitV[0] === a.bitV[0]) return 'split returned a shared view, not a copy';
  return null;
});

test('split with out-of-range bitPos throws', () => {
  const s = mkStream('fast', 10);
  let threw = false;
  try { splitBitStream(s, -1); } catch { threw = true; }
  if (!threw) return 'bitPos=-1 did not throw';
  threw = false;
  try { splitBitStream(s, 11); } catch { threw = true; }
  if (!threw) return 'bitPos=bitCount+1 did not throw';
  return null;
});

// ── Join scenarios ────────────────────────────────────────────────────────────

test('join empty array throws', () => {
  let threw = false;
  try { joinBitStreams([]); } catch { threw = true; }
  return threw ? null : 'empty join did not throw';
});

test('join single stream returns it unchanged', () => {
  const s = mkStream('fast', 30);
  const j = joinBitStreams([s]);
  if (j !== s) return 'single-stream join should return the same reference';
  return null;
});

test('join format mismatch throws', () => {
  const a = mkStream('fast', 10);
  const b = mkStream('slow', 10);
  let threw = false;
  try { joinBitStreams([a, b]); } catch { threw = true; }
  return threw ? null : 'format mismatch did not throw';
});

test('join two streams concatenates correctly', () => {
  const a = mkStream('fast', 20, 1000);
  const b = mkStream('fast', 30, 5000);  // non-adjacent sample positions
  const j = joinBitStreams([a, b]);
  if (j.bitCount !== 50) return `bitCount ${j.bitCount} (want 50)`;
  if (j.firstSample !== a.firstSample) return 'firstSample should match first input';
  if (j.lastSample  !== b.lastSample)  return 'lastSample should match last input';
  // Verify each bit section is copied correctly.
  for (let i = 0; i < 20; i++) {
    if (j.bitV[i] !== a.bitV[i]) return `bitV[${i}] wrong (first half)`;
    if (j.bitFirstSample[i] !== a.bitFirstSample[i]) return `bitFirstSample[${i}] wrong (first half)`;
  }
  for (let i = 0; i < 30; i++) {
    if (j.bitV[20 + i] !== b.bitV[i]) return `bitV[${20 + i}] wrong (second half)`;
    if (j.bitFirstSample[20 + i] !== b.bitFirstSample[i]) return `bitFirstSample[${20 + i}] wrong (second half)`;
  }
  // Non-monotonic sample positions at the seam — expected and intentional.
  if (j.bitFirstSample[19] >= j.bitFirstSample[20]) {
    // This stream happens to have a.lastBit.firstSample < b.firstBit.firstSample,
    // so we'd expect a forward jump rather than a non-monotonic dip.
    // Both directions are valid; we just check it isn't a smooth continuation.
    // (Here the values differ by >> 20, the normal bit spacing.)
  }
  return null;
});

test('join min/max aggregated across inputs', () => {
  const a = mkStream('fast', 5); a.minVal = -100; a.maxVal = 200;
  const b = mkStream('fast', 5); b.minVal = -500; b.maxVal = 300;
  const c = mkStream('fast', 5); c.minVal =  -50; c.maxVal = 400;
  const j = joinBitStreams([a, b, c]);
  if (j.minVal !== -500) return `minVal ${j.minVal} (want -500)`;
  if (j.maxVal !==  400) return `maxVal ${j.maxVal} (want 400)`;
  return null;
});

// ── Round-trip ────────────────────────────────────────────────────────────────

test('split then join round-trips to original', () => {
  const s = mkStream('fast', 73);
  for (const pos of [0, 1, 36, 72, 73]) {
    const [a, b] = splitBitStream(s, pos);
    const j = joinBitStreams([a, b]);
    const err = compareStreams(j, s, `split-join at ${pos}`);
    if (err) return err;
  }
  return null;
});

test('slow-format round-trips', () => {
  const s = mkStream('slow', 40);
  const [a, b] = splitBitStream(s, 17);
  const j = joinBitStreams([a, b]);
  return compareStreams(j, s, 'slow-format');
});

// ── Runner ────────────────────────────────────────────────────────────────────

let allPass = true;
for (const t of tests) {
  const err = t.run();
  const pass = err === null;
  if (!pass) allPass = false;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${t.name}${err ? `\n      ${err}` : ''}`);
}
console.log(`\n${allPass ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'}`);
process.exit(allPass ? 0 : 1);
