#!/usr/bin/env npx tsx
/**
 * Scenario tests for readProgramBytes() — the bit-stream → byte framer, its
 * two-frame lock search, and the backwards walk that recovers leading
 * not-error-free bytes.
 *
 * readProgramBytes reads ONLY the bit-level fields of a BitStream (bitV,
 * bitUnclear, bitCount, format), so we test it by hand-building a stream from a
 * list of byte frames — no encoder / WAV / cycle-detector in the loop.  A
 * bitstream has no intrinsic byte boundaries; they exist only in the decoder's
 * output, so every input frame is laid down in the OUTPUT framing (the byte we
 * expect back, with its stop/parity cells set to the defect under test).
 *
 * The expected result comes ONLY from the forward decoder + the cadence rule -
 * never from the back-walk code, so we catch "not as intended," not just
 * "working as designed".  The intention:
 *
 *   A core byte recovers iff forward-decode from its start would land aligned on
 *   the lock, AND its stop run matches the 3/4 cadence under MAXIMAL matching:
 *   going back, greedily take stop bits up to the cadence cap, stopping at a
 *   clear-0 boundary (a clear-0 parity-adjacent stop, or — at cadence 4 — a
 *   trailing unclear-0 that can't be the 4th stop, dropping the cap to 3).
 *
 * Consequences (all forward/cadence-derived):
 *   - a short all-1 (or unclear-0) run has no boundary → maximal matching runs to
 *     the cap and frames a DIFFERENT byte, so it's an invalid input → excluded;
 *   - a too-few run with a clear-0 boundary IS recoverable;
 *   - the forward decode mis-frames (so the byte can't recover) when the following
 *     byte's start is unclear and the run is < 3 stops — the skip swallows it.
 *
 * Run:  npx tsx tests/readProgramBytesScenarios.ts
 */

import { readProgramBytes, emptyBitStream, type BitStream } from '../src/decoder';

const hex = (n: number) => '0x' + n.toString(16).padStart(2, '0').toUpperCase();

// ── Synthetic BitStream builder ───────────────────────────────────────────────

/** One byte frame: [start 0][8 data, LSB first][parity][stop cells].
 *  `stops`: one char per stop cell — '1' clean-1, '0' clear-0, 'u' unclear-0.
 *  `noStart` emits a `1` where the start bit should be — i.e. a stop run with no
 *  valid start, the "exceed-cadence" halt: maximal-match the stops, step back 10,
 *  find a `1` instead of a `0` start. */
type Frame = { value: number; stops: string; badParity?: boolean; startUnclear?: boolean; noStart?: boolean };

function bitStream(frames: Frame[], format: 'fast' | 'slow' = 'fast'): BitStream {
  const v: number[] = [], u: number[] = [];
  const put = (bit: number, unclear = false) => { v.push(bit); u.push(unclear ? 1 : 0); };
  for (const f of frames) {
    put(f.noStart ? 1 : 0, f.startUnclear);                 // start (or a 1 = no valid start)
    let ones = 0;
    for (let i = 0; i < 8; i++) { const b = (f.value >> i) & 1; put(b); ones += b; }   // data, LSB first
    put(((ones & 1) ^ 1) ^ (f.badParity ? 1 : 0));          // parity, optionally wrong
    for (const c of f.stops) {                               // stop cells
      if      (c === '1') put(1);
      else if (c === '0') put(0);
      else if (c === 'u') put(0, true);
      else throw new Error(`bad stop cell '${c}'`);
    }
  }
  const s = emptyBitStream(format);
  s.bitV = Uint8Array.from(v); s.bitUnclear = Uint8Array.from(u); s.bitCount = v.length;
  return s;
}

const ones = (n: number) => '1'.repeat(n);

const LOCK_A = 0xC1, LOCK_B = 0xD2, TERM = 0xE3;
function lockFrames(c: 3 | 4): Frame[] {
  const flip = c === 3 ? 4 : 3;
  return [
    { value: LOCK_A, stops: ones(flip) },
    { value: LOCK_B, stops: ones(c) },
    { value: TERM,   stops: ones(flip) },   // terminates LOCK_B; itself not emitted
  ];
}

// ── Harness ───────────────────────────────────────────────────────────────────

type Flags = { chkErr?: boolean; unclear?: boolean };
type Test = { name: string; run: () => string | null };
const tests: Test[] = [];
function test(name: string, run: () => string | null) { tests.push({ name, run }); }

function expectBytes(s: BitStream, wantV: number[], wantFlags: Flags[] = []): string | null {
  const got = readProgramBytes(s).bytes;
  if (got.length !== wantV.length || got.some((b, i) => b.v !== wantV[i])) {
    return `values [${got.map(b => hex(b.v)).join(' ')}], want [${wantV.map(hex).join(' ')}]`;
  }
  for (let i = 0; i < got.length; i++) {
    const f = wantFlags[i] ?? {};
    if (got[i].chkErr !== !!f.chkErr)   return `byte ${i} ${hex(got[i].v)}: chkErr=${got[i].chkErr}, want ${!!f.chkErr}`;
    if (got[i].unclear !== !!f.unclear) return `byte ${i} ${hex(got[i].v)}: unclear=${got[i].unclear}, want ${!!f.unclear}`;
  }
  return null;
}

// ── Forward + cadence reference (no back-walk reasoning) ──────────────────────

/** Forward-valid stop regions of a given length: c1 (parity-adjacent) ∈ {1,0,u};
 *  later cells ∈ {1,u}, with unclear-0 only where the forward loop tolerates it
 *  (pos ≤ 3; a clear-0 or pos-4 unclear-0 would terminate the run early). */
function regionPatterns(len: number): string[] {
  const opts = (pos: number) => pos === 1 ? ['1', '0', 'u'] : pos <= 3 ? ['1', 'u'] : ['1'];
  let out = [''];
  for (let pos = 1; pos <= len; pos++) out = out.flatMap(s => opts(pos).map(ch => s + ch));
  return out;
}

/** Classify a core byte from forward + maximal-cadence intent (NOT the walk). */
function classify(region: string, cadence: 3 | 4, followingUnclear: boolean): 'recover' | 'halt' | 'exclude' {
  const k = region.length;
  if (k === cadence) return 'recover';                 // full cadence → maximal match lands on the start
  // k < cadence (too few): valid only if the run's start boundary is unambiguous —
  // a clear-0 parity-adjacent stop, or (cadence 4) a trailing unclear-0 that can't
  // be the 4th stop, so the cap drops to 3 and a 3-run becomes a full match.
  const bounded = region[0] === '0' || (cadence === 4 && k === 3 && region[k - 1] === 'u');
  if (!bounded) return 'exclude';                      // all-1 / unclear short run → frames a different byte
  // bounded short run: forward mis-frames if the following start is unclear and the
  // run is < 3 (the stop-skip tolerates it as a stop and swallows it), so no recover.
  if (followingUnclear && k < 3) return 'halt';
  return 'recover';
}

// ── Exhaustive sweep ═════════════════════════════════════════════════════════
// [core under test][following byte, start-clarity we control][clean lock].  The
// following byte always recovers; the core recovers / halts / is-invalid per the
// reference above.  Core sits at bit 0 so an invalid input can't silently misframe
// onto preceding cells.
const CORE = 0xA5, FROM = 0xBB;
let recovered = 0, halted = 0, excluded = 0;
const fails: string[] = [];
for (const c of [3, 4] as const) {
  const flip = c === 3 ? 4 : 3;
  for (let len = 1; len <= c; len++) {            // k > cadence (too many) is out of scope
    for (const region of regionPatterns(len)) {
      const lockRejected = /[0u]/.test(region);   // a 0-value stop cell rejects the lock
      for (const badParity of [false, true]) {
        if (!lockRejected && !badParity) continue;  // clean byte → a lock case, not a walk case
        for (const followingUnclear of [false, true]) {
          const cls = classify(region, c, followingUnclear);
          if (cls === 'exclude') { excluded++; continue; }
          const core: Frame = { value: CORE, stops: region, badParity };
          const from: Frame = { value: FROM, stops: ones(flip), badParity: true, startUnclear: followingUnclear };
          const s = bitStream([core, from, ...lockFrames(flip)]);
          const coreFlags: Flags = { chkErr: badParity, unclear: region.includes('u') || followingUnclear };
          let err: string | null;
          if (cls === 'recover') { recovered++; err = expectBytes(s, [CORE, FROM, LOCK_A, LOCK_B], [coreFlags, { chkErr: true }, {}, {}]); }
          else                   { halted++;    err = expectBytes(s, [FROM, LOCK_A, LOCK_B], [{ chkErr: true }, {}, {}]); }
          if (err) fails.push(`region "${region}" cadence ${c} ${badParity ? 'badP' : 'okP'} nextU=${followingUnclear} (${cls}) — ${err}`);
        }
      }
    }
  }
}

// ── Hand-written sanity cases alongside the sweep ────────────────────────────

test('clean cadence stream decodes to its values; trailing byte without a successor is dropped', () =>
  expectBytes(bitStream([
    { value: 0xA1, stops: '111' }, { value: 0xB2, stops: '1111' }, { value: 0xC3, stops: '111' },
    { value: 0xD4, stops: '1111' }, { value: 0xE5, stops: '111' },
  ]), [0xA1, 0xB2, 0xC3, 0xD4]));

test('walk back through two different defects in sequence', () =>
  expectBytes(bitStream([
    { value: 0xB2, stops: '1u11' }, { value: 0xA1, stops: '111', badParity: true }, ...lockFrames(3),
  ]), [0xB2, 0xA1, LOCK_A, LOCK_B], [{ unclear: true }, { chkErr: true }, {}, {}]));

// Exceed-cadence halt: a stop run with no 0 start bit at the step-back position -
// the walk maximal-matches the stops (up to the cadence cap), finds no 0 start
// where one should be, and halts.  Any stop count 1..cadence: the over-count
// either lands on the 1-where-the-start-should-be (k = cadence) or runs off the
// front (k < cadence).  The bad core is omitted either way.
for (const c of [3, 4] as const) {
  const flip = c === 3 ? 4 : 3;
  for (let k = 1; k <= c; k++) {
    test(`halt: ${k}-stop run with no 0 start bit — cadence ${c}`, () =>
      expectBytes(bitStream([
        { value: CORE, stops: ones(k), noStart: true },
        { value: FROM, stops: ones(flip), badParity: true },
        ...lockFrames(flip),
      ]), [FROM, LOCK_A, LOCK_B], [{ chkErr: true }, {}, {}]));
  }
}

// ── Runner ────────────────────────────────────────────────────────────────────

let allPass = true;
for (const t of tests) {
  const err = t.run();
  if (err) allPass = false;
  console.log(`${err ? 'FAIL' : 'PASS'}  ${t.name}${err ? `\n      ${err}` : ''}`);
}
console.log(`\nSweep: ${recovered + halted - fails.length}/${recovered + halted} passed  (${recovered} recover, ${halted} halt, ${excluded} excluded as invalid inputs)`);
for (const f of fails.slice(0, 20)) console.log(`  FAIL  ${f}`);
if (fails.length > 20) console.log(`  … and ${fails.length - 20} more`);
if (fails.length) allPass = false;

console.log(`\n${allPass ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'}`);
process.exit(allPass ? 0 : 1);
