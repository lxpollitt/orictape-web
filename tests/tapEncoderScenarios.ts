#!/usr/bin/env npx tsx
/**
 * Scenario tests for the TAP encoder (tapEncoder.ts).
 *
 * Primary purpose: a regression guard for the spread-into-`push`
 * stack-overflow bug.  `encodeTapFile` used to assemble its byte
 * stream with `out.push(...blockBytes)` / `out.push(...metadata)`.
 * The spread form passes every array element as a separate call
 * argument, which overflows V8's argument-count limit once a program
 * (or, more commonly, its edit-history-scaled metadata) gets large
 * enough — surfacing as `RangeError: Maximum call stack size
 * exceeded`, which masquerades as runaway recursion.  A heavily-
 * edited real program tripped it in production.  The fix switched to
 * element-wise append; this suite proves a large program now encodes
 * without throwing, and a tiny one still round-trips byte-exactly.
 *
 * Not part of CI — run: npx tsx tests/tapEncoderScenarios.ts
 */

import type { ByteInfo, Program } from '../src/decoder';
import { emptyBitStream } from '../src/decoder';
import { encodeTapFile } from '../src/tapEncoder';

type Test = { name: string; run: () => string | null };
const tests: Test[] = [];
function test(name: string, run: () => string | null) { tests.push({ name, run }); }

function mkByte(v: number, edited?: 'explicit' | 'automatic'): ByteInfo {
  return { v, firstBit: 0, lastBit: 0, unclear: false, chkErr: false, edited };
}

/**
 * Build a synthetic machine-code Program (no BASIC lines) with `dataLen`
 * data bytes.  Layout of `prog.bytes`:
 *   [0..8]   nine header bytes (zeros)
 *   [9..12]  name "BIG" + 0x00 terminator
 *   [13..]   `dataLen` data bytes (value = index & 0xFF)
 * With startAddr=0 / endAddr=dataLen the encoder's no-lines path emits
 * exactly those data bytes.  When `markEdited` is set every data byte
 * is flagged `edited: 'explicit'`, which makes `encodeTapMetadata`
 * serialise a `dataLen`-length index array — the path that overflowed
 * in production (metadata scales with edit count, not program size).
 */
function mkMachineCodeProgram(dataLen: number, markEdited: boolean): Program {
  const bytes: ByteInfo[] = [];
  for (let i = 0; i < 9; i++) bytes.push(mkByte(0));          // header
  for (const c of 'BIG') bytes.push(mkByte(c.charCodeAt(0))); // name
  bytes.push(mkByte(0x00));                                   // name terminator
  for (let i = 0; i < dataLen; i++) {
    bytes.push(mkByte(i & 0xFF, markEdited ? 'explicit' : undefined));
  }
  return {
    stream: emptyBitStream(),
    bytes,
    lines: [],
    name: 'BIG',
    originalSource: '',
    progNumber: 0,
    header: {
      byteIndex: 0,
      fileType:  1,        // machine code
      autorun:   false,
      startAddr: 0,
      endAddr:   dataLen,
    },
  };
}

// ── Regression: large program must not blow the call stack ───────────────────

test('large program + metadata encodes without RangeError (spread fix)', () => {
  // 300k data bytes, all flagged edited — both the block-bytes append
  // (line 146) and the metadata append (line 155) handle arrays far
  // past V8's spread-argument ceiling under the old `push(...)` form.
  const N = 300_000;
  const prog = mkMachineCodeProgram(N, /* markEdited */ true);

  // Throwing here is the regression — the runner reports it as
  // "threw: ...".  We additionally sanity-check the output shape.
  const out = encodeTapFile([{ prog, includeMetadata: true }]);

  if (!(out instanceof Uint8Array)) return `expected Uint8Array, got ${typeof out}`;
  // Block alone is ~ sync(9) + header(9) + name(4) + N data; metadata
  // adds far more (a ~N-entry index array as JSON).  Must exceed N.
  if (out.length <= N) return `output length ${out.length} not > ${N}`;
  // Canonical sync: eight 0x16 then 0x24.
  for (let i = 0; i < 8; i++) if (out[i] !== 0x16) return `sync byte ${i} = ${out[i]}, want 0x16`;
  if (out[8] !== 0x24) return `sync terminator = ${out[8]}, want 0x24`;
  return null;
});

// ── Correctness control: the refactor preserves byte-exact output ────────────

test('minimal machine-code program round-trips byte-exactly', () => {
  const data = [0xA9, 0x01, 0x60, 0x00];   // LDA #1 : RTS : pad
  const prog = mkMachineCodeProgram(data.length, /* markEdited */ false);
  for (let i = 0; i < data.length; i++) prog.bytes[13 + i].v = data[i];

  const out = encodeTapFile([{ prog, includeMetadata: false }]);

  const want: number[] = [
    0x16, 0x16, 0x16, 0x16, 0x16, 0x16, 0x16, 0x16, 0x24, // sync
    0, 0, 0, 0, 0, 0, 0, 0, 0,                              // 9 header bytes
    66, 73, 71, 0,                                          // "BIG" + 0x00
    ...data,                                                // program data
  ];
  if (out.length !== want.length) {
    return `length ${out.length}, want ${want.length}`;
  }
  for (let i = 0; i < want.length; i++) {
    if (out[i] !== want[i]) return `byte ${i} = ${out[i]}, want ${want[i]}`;
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
