#!/usr/bin/env npx tsx
/**
 * Ad-hoc scenario tests for findProgramBoundariesInBytes.
 *
 * Pure byte-pattern scanner — no Program construction needed.  Tests cover
 * the threshold boundary, multiple matches, runs not followed by 0x24,
 * suppression of the implicit position-0 sync, and various edge cases.
 */

import { findProgramBoundariesInBytes } from '../src/decoder';
import type { ByteInfo } from '../src/decoder';

function mkBytes(values: number[]): ByteInfo[] {
  return values.map((v, i) => ({
    v,
    firstBit: i,
    lastBit:  i,
    unclear:  false,
    chkErr:   false,
    originalIndex: i,
  }));
}

/** Helper: repeat a byte value N times. */
const rep = (val: number, n: number): number[] => new Array(n).fill(val);

// ── Runner glue ───────────────────────────────────────────────────────────────

type Test = { name: string; run: () => string | null };
const tests: Test[] = [];
function test(name: string, run: () => string | null) { tests.push({ name, run }); }

// ── Scenarios ─────────────────────────────────────────────────────────────────

test('empty input returns no boundaries', () => {
  const r = findProgramBoundariesInBytes(mkBytes([]));
  return r.length === 0 ? null : `got ${JSON.stringify(r)}`;
});

test('no 0x16 in input returns no boundaries', () => {
  const r = findProgramBoundariesInBytes(mkBytes([0x41, 0x42, 0x43]));
  return r.length === 0 ? null : `got ${JSON.stringify(r)}`;
});

test('pure scan (no startOffset): reports every matching sync including position 0', () => {
  // No "suppress position 0" behaviour in the scanner itself — caller's job
  // to pass a startOffset past the first program's sync + header + name.
  const bytes = mkBytes([...rep(0x16, 10), 0x24, 0x41, 0x42]);
  const r = findProgramBoundariesInBytes(bytes);
  return JSON.stringify(r) === JSON.stringify([0]) ? null : `got ${JSON.stringify(r)}`;
});

test('startOffset skips the first program region', () => {
  // 10 × 0x16 + 0x24 at position 0 (first program sync), body bytes, then
  // another sync at position 13.  With startOffset = 13, only the second
  // sync is reported (at its own position, from the whole-bytes view).
  const bytes = mkBytes([
    ...rep(0x16, 10), 0x24,   // positions 0..10
    0x50, 0x51,               // positions 11..12
    ...rep(0x16, 12), 0x24,   // positions 13..25
    0x60,
  ]);
  const r = findProgramBoundariesInBytes(bytes, 13);
  return JSON.stringify(r) === JSON.stringify([13]) ? null : `got ${JSON.stringify(r)}`;
});

test('two syncs beyond startOffset reported in order', () => {
  const bytes = mkBytes([
    ...rep(0x16, 10), 0x24,   // first sync at 0 — skipped by startOffset
    0x50, 0x51,
    ...rep(0x16, 12), 0x24,   // second sync at 13
    0x60,
    ...rep(0x16, 10), 0x24,   // third sync at 27
    0x70,
  ]);
  const r = findProgramBoundariesInBytes(bytes, 13);
  return JSON.stringify(r) === JSON.stringify([13, 27]) ? null : `got ${JSON.stringify(r)}`;
});

test('run of 0x16 below threshold is ignored', () => {
  // 9 × 0x16 + 0x24 is below the default 10 — not a sync.
  const bytes = mkBytes([0x01, ...rep(0x16, 9), 0x24, 0x02]);
  const r = findProgramBoundariesInBytes(bytes);
  return r.length === 0 ? null : `got ${JSON.stringify(r)}`;
});

test('run of 0x16 exactly at threshold is a match', () => {
  const bytes = mkBytes([0x01, ...rep(0x16, 10), 0x24, 0x02]);
  const r = findProgramBoundariesInBytes(bytes);
  return JSON.stringify(r) === JSON.stringify([1]) ? null : `got ${JSON.stringify(r)}`;
});

test('run of 0x16 not followed by 0x24 is ignored', () => {
  // 15 × 0x16 + 0x25 (not 0x24).  Should be ignored.
  const bytes = mkBytes([0x01, ...rep(0x16, 15), 0x25, 0x02]);
  const r = findProgramBoundariesInBytes(bytes);
  return r.length === 0 ? null : `got ${JSON.stringify(r)}`;
});

test('long 0x16 run followed by 0x24 is still detected', () => {
  // 100 × 0x16 + 0x24 — real tape leader runs can be hundreds long.
  const bytes = mkBytes([0x01, ...rep(0x16, 100), 0x24, 0x02]);
  const r = findProgramBoundariesInBytes(bytes);
  return JSON.stringify(r) === JSON.stringify([1]) ? null : `got ${JSON.stringify(r)}`;
});

test('tunable threshold — custom minSyncBytes = 3 matches 3 × 0x16 + 0x24', () => {
  const bytes = mkBytes([0x01, ...rep(0x16, 4), 0x24, 0x02]);
  const r = findProgramBoundariesInBytes(bytes, 0, 3);
  return JSON.stringify(r) === JSON.stringify([1]) ? null : `got ${JSON.stringify(r)}`;
});

test('startOffset past a sync excludes it from results', () => {
  // Sync at position 1; startOffset 10 skips past it.
  const bytes = mkBytes([0x01, ...rep(0x16, 10), 0x24, 0x02, 0x03, 0x04]);
  const r = findProgramBoundariesInBytes(bytes, 15);
  return r.length === 0 ? null : `got ${JSON.stringify(r)}`;
});

test('short 0x16 runs scattered in body do not match (below default threshold)', () => {
  // Various short runs of 0x16 with occasional 0x24 nearby — none ≥10.
  const bytes = mkBytes([
    0x41, 0x16, 0x16, 0x16, 0x16, 0x24,          // 4 × 0x16 + 0x24 — ignored
    0x42, 0x16, 0x16, 0x16, 0x24,                // 3 × 0x16 + 0x24 — ignored
    0x43, 0x16, 0x16, 0x16, 0x16, 0x16, 0x16, 0x16, 0x16, 0x16, 0x24,  // 9 × 0x16 + 0x24 — ignored (below 10)
  ]);
  const r = findProgramBoundariesInBytes(bytes);
  return r.length === 0 ? null : `got ${JSON.stringify(r)}`;
});

test('0x16 run at end of input without 0x24 is ignored', () => {
  const bytes = mkBytes([0x01, ...rep(0x16, 15)]);  // runs off end
  const r = findProgramBoundariesInBytes(bytes);
  return r.length === 0 ? null : `got ${JSON.stringify(r)}`;
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
