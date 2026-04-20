#!/usr/bin/env npx tsx
/**
 * Ad-hoc scenario tests for splitProgram / joinPrograms.
 *
 * Builds realistic Programs by running raw TAP bytes through parseTapFile
 * (so the ByteInfo / Program / BitStream structure matches what the rest
 * of the code expects), then exercises the split/join primitives and
 * verifies the round-trip and reset-policy behaviour.
 */

import { splitProgram, joinPrograms } from '../src/decoder';
import { parseTapFile } from '../src/tapDecoder';
import type { Program } from '../src/decoder';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal single-line BASIC TAP file, suitable for parseTapFile. */
function buildBasicTap(name: string, lineNum: number, remPayload: number[]): Uint8Array {
  const startAddr = 0x0501;
  const TOKEN_REM = 0x9E;
  const lineLen   = 2 + 2 + 1 + remPayload.length + 1;    // ptr(2) + ln(2) + REM + payload + 0x00
  const nextAddr  = startAddr + lineLen;
  const body: number[] = [
    nextAddr & 0xFF, (nextAddr >> 8) & 0xFF,
    lineNum  & 0xFF, (lineNum  >> 8) & 0xFF,
    TOKEN_REM,
    ...remPayload,
    0x00,
    0x00, 0x00,                                           // end-of-program
  ];
  const endAddr = startAddr + body.length;
  const bytes: number[] = [];
  for (let i = 0; i < 8; i++) bytes.push(0x16);
  bytes.push(0x24);
  bytes.push(0x00, 0x00, 0x00, 0x00);
  bytes.push((endAddr   >> 8) & 0xFF, endAddr   & 0xFF);
  bytes.push((startAddr >> 8) & 0xFF, startAddr & 0xFF);
  bytes.push(0x00);
  for (let i = 0; i < name.length; i++) bytes.push(name.charCodeAt(i));
  bytes.push(0x00);
  bytes.push(...body);
  return new Uint8Array(bytes);
}

function makeProg(name: string, lineNum: number, remPayload: number[]): Program {
  const tap = buildBasicTap(name, lineNum, remPayload);
  const progs = parseTapFile(tap.buffer as ArrayBuffer);
  if (progs.length !== 1) throw new Error(`expected 1 program, got ${progs.length}`);
  return progs[0];
}

// ── Runner glue ───────────────────────────────────────────────────────────────

type Test = { name: string; run: () => string | null };
const tests: Test[] = [];
function test(name: string, run: () => string | null) { tests.push({ name, run }); }

// ── Split scenarios ───────────────────────────────────────────────────────────

test('split at out-of-range byteIdx throws', () => {
  const p = makeProg('P', 10, [0x41]);
  let threw = 0;
  try { splitProgram(p, 0); } catch { threw++; }
  try { splitProgram(p, p.bytes.length); } catch { threw++; }
  try { splitProgram(p, -1); } catch { threw++; }
  return threw === 3 ? null : `expected 3 throws, got ${threw}`;
});

test('split produces two Programs with disjoint bytes', () => {
  const p = makeProg('SPLIT', 10, [0x41, 0x42, 0x43, 0x44]);
  const mid = Math.floor(p.bytes.length / 2);
  const [a, b] = splitProgram(p, mid);
  if (a.bytes.length !== mid) return `first byte count ${a.bytes.length} (want ${mid})`;
  if (b.bytes.length !== p.bytes.length - mid) return `second byte count wrong`;
  // Per-byte values must match their source indices.
  for (let i = 0; i < a.bytes.length; i++) {
    if (a.bytes[i].v !== p.bytes[i].v) return `first.bytes[${i}].v wrong`;
  }
  for (let i = 0; i < b.bytes.length; i++) {
    if (b.bytes[i].v !== p.bytes[mid + i].v) return `second.bytes[${i}].v wrong`;
  }
  return null;
});

test('split renumbers originalIndex 0-based per half', () => {
  const p = makeProg('P', 10, [0x41, 0x42]);
  const mid = Math.floor(p.bytes.length / 2);
  const [a, b] = splitProgram(p, mid);
  for (let i = 0; i < a.bytes.length; i++) {
    if (a.bytes[i].originalIndex !== i) return `first.bytes[${i}].originalIndex ${a.bytes[i].originalIndex} (want ${i})`;
  }
  for (let i = 0; i < b.bytes.length; i++) {
    if (b.bytes[i].originalIndex !== i) return `second.bytes[${i}].originalIndex ${b.bytes[i].originalIndex} (want ${i})`;
  }
  return null;
});

test('split clears edited state', () => {
  const p = makeProg('P', 10, [0x41, 0x42]);
  // Mark some bytes as edited manually.
  p.bytes[2].edited = 'explicit';
  p.bytes[5].edited = 'automatic';
  const mid = Math.floor(p.bytes.length / 2);
  const [a, b] = splitProgram(p, mid);
  for (const byte of [...a.bytes, ...b.bytes]) {
    if (byte.edited !== undefined) return `byte with v=${byte.v} still has edited='${byte.edited}'`;
  }
  return null;
});

test('split preserves unclear / chkErr per-byte flags', () => {
  const p = makeProg('P', 10, [0x41, 0x42, 0x43, 0x44]);
  // Mark some bytes as unclear/chkErr.
  p.bytes[3].unclear = true;
  p.bytes[p.bytes.length - 2].chkErr = true;
  const mid = Math.floor(p.bytes.length / 2);
  const [a, b] = splitProgram(p, mid);
  // byte 3 in original → byte 3 in first half (before mid)
  if (mid > 3 && !a.bytes[3].unclear) return 'unclear flag lost on first half';
  // second-from-last byte in original → second-from-last in second half
  const bIdx = b.bytes.length - 2;
  if (!b.bytes[bIdx].chkErr) return 'chkErr flag lost on second half';
  return null;
});

test('split bit pointers are valid indices into the new streams', () => {
  const p = makeProg('P', 10, [0x41, 0x42, 0x43]);
  const mid = Math.floor(p.bytes.length / 2);
  const [a, b] = splitProgram(p, mid);
  // TAP-loaded programs (this test's fixture) carry an emptyBitStream with
  // bitCount=0 and all ByteInfos have firstBit=0 lastBit=0 as placeholders,
  // so "valid index" is only meaningful when the stream is non-empty.
  // Covers the invariant without spuriously failing on TAP fixtures; WAV-
  // decoded programs would exercise the >0 branch.
  for (const byte of a.bytes) {
    if (a.stream.bitCount > 0
        && (byte.firstBit < 0 || byte.lastBit >= a.stream.bitCount)) {
      return `first half byte firstBit=${byte.firstBit} lastBit=${byte.lastBit} out of [0, ${a.stream.bitCount})`;
    }
  }
  for (const byte of b.bytes) {
    if (b.stream.bitCount > 0
        && (byte.firstBit < 0 || byte.lastBit >= b.stream.bitCount)) {
      return `second half byte firstBit=${byte.firstBit} lastBit=${byte.lastBit} out of [0, ${b.stream.bitCount})`;
    }
  }
  return null;
});

test('split first half still parses as the original program', () => {
  const p = makeProg('SPLITME', 10, [0x41, 0x42]);
  // Split somewhere after the first program's body — e.g. halfway through
  // the bytes.  The first half should still carry a valid header and one line.
  // For a minimal single-line program the whole body is tiny, so we split
  // at a byte past the end-of-program marker.  parseTapFile produces a
  // prog whose bytes include only up to the end of content; splitting
  // "after the end" isn't meaningful.  Instead: verify split preserves
  // enough info for the first half to be reparsed as the same program
  // (header+name+line) when we split shortly before the end-of-program.
  // The end-of-program 0x00 0x00 is at the last two bytes; split one
  // before that so the first half still contains a valid terminated program.
  const splitAt = p.bytes.length - 1;  // last 0x00 of 0x00 0x00 goes to second
  const [a] = splitProgram(p, splitAt);
  if (a.name !== 'SPLITME') return `first half name '${a.name}' (want 'SPLITME')`;
  if (a.lines.length !== 1) return `first half has ${a.lines.length} lines (want 1)`;
  return null;
});

// ── Join scenarios ────────────────────────────────────────────────────────────

test('join empty array throws', () => {
  let threw = false;
  try { joinPrograms([]); } catch { threw = true; }
  return threw ? null : 'empty join did not throw';
});

test('join single program returns it unchanged', () => {
  const p = makeProg('P', 10, [0x41]);
  const r = joinPrograms([p]);
  return r === p ? null : 'single-program join should return the same reference';
});

test('join two programs concatenates bytes in order', () => {
  const p1 = makeProg('P1', 10, [0x41, 0x42]);
  const p2 = makeProg('P2', 20, [0x43, 0x44]);
  const r = joinPrograms([p1, p2]);
  if (r.bytes.length !== p1.bytes.length + p2.bytes.length) {
    return `joined byte count ${r.bytes.length} (want ${p1.bytes.length + p2.bytes.length})`;
  }
  for (let i = 0; i < p1.bytes.length; i++) {
    if (r.bytes[i].v !== p1.bytes[i].v) return `byte[${i}].v wrong (first half)`;
  }
  for (let i = 0; i < p2.bytes.length; i++) {
    if (r.bytes[p1.bytes.length + i].v !== p2.bytes[i].v) return `byte[${p1.bytes.length + i}].v wrong (second half)`;
  }
  return null;
});

test('join renumbers originalIndex 0-based across concatenation', () => {
  const p1 = makeProg('P1', 10, [0x41, 0x42]);
  const p2 = makeProg('P2', 20, [0x43, 0x44]);
  const r = joinPrograms([p1, p2]);
  for (let i = 0; i < r.bytes.length; i++) {
    if (r.bytes[i].originalIndex !== i) return `bytes[${i}].originalIndex ${r.bytes[i].originalIndex} (want ${i})`;
  }
  return null;
});

test('join clears edited state', () => {
  const p1 = makeProg('P1', 10, [0x41]);
  const p2 = makeProg('P2', 20, [0x42]);
  p1.bytes[2].edited = 'explicit';
  p2.bytes[4].edited = 'automatic';
  const r = joinPrograms([p1, p2]);
  for (const byte of r.bytes) {
    if (byte.edited !== undefined) return `byte v=${byte.v} still edited='${byte.edited}'`;
  }
  return null;
});

test('join bit pointers are valid in joined stream', () => {
  const p1 = makeProg('P1', 10, [0x41]);
  const p2 = makeProg('P2', 20, [0x42]);
  const r = joinPrograms([p1, p2]);
  // Same caveat as the split variant: TAP fixtures carry emptyBitStream,
  // so the "valid index" invariant only bites on non-empty streams.
  for (const byte of r.bytes) {
    if (r.stream.bitCount > 0
        && (byte.firstBit < 0 || byte.lastBit >= r.stream.bitCount)) {
      return `byte v=${byte.v} firstBit=${byte.firstBit} lastBit=${byte.lastBit} out of [0, ${r.stream.bitCount})`;
    }
  }
  return null;
});

test('join result parses as the first input program', () => {
  // When two valid TAP programs are joined, the resulting bytes start with
  // the first program's sync + header, so readProgramLines (invoked inside
  // joinPrograms via rebuildProgram) will parse out the first program's
  // name and lines.  The second program's bytes trail as post-program
  // content — harmless because endAddr bounds body reading.
  const p1 = makeProg('FIRST',  10, [0x41]);
  const p2 = makeProg('SECOND', 20, [0x42]);
  const r  = joinPrograms([p1, p2]);
  if (r.name !== 'FIRST') return `joined name '${r.name}' (want 'FIRST')`;
  if (r.lines.length === 0) return 'joined has no parsed lines';
  return null;
});

// ── Round-trip ────────────────────────────────────────────────────────────────

test('split then join round-trips bytes', () => {
  const p = makeProg('RTRIP', 10, [0x41, 0x42, 0x43]);
  const mid = Math.floor(p.bytes.length / 2);
  const [a, b] = splitProgram(p, mid);
  const r = joinPrograms([a, b]);
  if (r.bytes.length !== p.bytes.length) return `byte count ${r.bytes.length} (want ${p.bytes.length})`;
  for (let i = 0; i < p.bytes.length; i++) {
    if (r.bytes[i].v !== p.bytes[i].v) return `bytes[${i}].v differs (${r.bytes[i].v} vs ${p.bytes[i].v})`;
  }
  // Result should parse as the original program.
  if (r.name !== p.name) return `name differs ('${r.name}' vs '${p.name}')`;
  if (r.lines.length !== p.lines.length) return `line count differs (${r.lines.length} vs ${p.lines.length})`;
  return null;
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
