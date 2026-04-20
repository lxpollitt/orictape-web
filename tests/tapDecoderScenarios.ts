#!/usr/bin/env npx tsx
/**
 * Ad-hoc scenario tests for tapDecoder.parseTapFile.
 *
 * Focused on the block-boundary / sync-detection behaviour: hand-crafted
 * TAP byte streams exercising mid-body 0x16 runs (the bug that motivated
 * the endAddr-based body-skip fix), malformed sync patterns, and back-to-
 * back programs.  Not part of CI — a quick sanity check when tuning the
 * TAP decoder.
 */

import { parseTapFile } from '../src/tapDecoder';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Encode a minimal BASIC TAP block.  Caller supplies body bytes; we wrap
 *  with sync + header + null-terminated filename.  startAddr is fixed at
 *  0x0501, endAddr is computed as startAddr + body.length (exclusive). */
function buildBasicTapBlock(name: string, body: number[]): number[] {
  const startAddr = 0x0501;
  const endAddr   = startAddr + body.length;
  const bytes: number[] = [];
  // Sync: 8 × 0x16 + 0x24
  for (let i = 0; i < 8; i++) bytes.push(0x16);
  bytes.push(0x24);
  // Header: 00 00 fileType(BASIC=0) autorun(none=0) endHi endLo startHi startLo 00
  bytes.push(0x00, 0x00, 0x00, 0x00);
  bytes.push((endAddr   >> 8) & 0xFF, endAddr   & 0xFF);
  bytes.push((startAddr >> 8) & 0xFF, startAddr & 0xFF);
  bytes.push(0x00);
  // Filename (ASCII) + null terminator.
  for (let i = 0; i < name.length; i++) bytes.push(name.charCodeAt(i));
  bytes.push(0x00);
  // Body.
  for (const b of body) bytes.push(b);
  return bytes;
}

/** Build a minimal one-line BASIC body with a REM whose payload is the
 *  caller-supplied byte sequence.  Ends with the canonical 0x00 0x00
 *  end-of-program marker. */
function buildBasicBodyRemLine(lineNum: number, remPayload: number[]): number[] {
  const startAddr = 0x0501;
  const TOKEN_REM = 0x9E;
  // Line layout: pointer(2) + lineNum(2) + REM + payload + 0x00 terminator
  const lineLen = 2 + 2 + 1 + remPayload.length + 1;
  const nextAddr = startAddr + lineLen;
  const body: number[] = [];
  body.push(nextAddr & 0xFF, (nextAddr >> 8) & 0xFF);  // pointer LE
  body.push(lineNum  & 0xFF, (lineNum  >> 8) & 0xFF);  // line number LE
  body.push(TOKEN_REM);
  body.push(...remPayload);
  body.push(0x00);
  body.push(0x00, 0x00);  // end-of-program marker
  return body;
}

// ── Scenarios ─────────────────────────────────────────────────────────────────

type Scenario = {
  name: string;
  tapBytes: number[];
  expectedPrograms: number;
  /** Optional: expected name of each program, in order. */
  expectedNames?: string[];
  /** Optional: post-parse assertion on returned programs. */
  extraCheck?: (progs: ReturnType<typeof parseTapFile>) => string | null;
};

// Check that the first program has exactly one BASIC line spanning the whole
// body (i.e. the mid-body split didn't happen and truncate the line).
const checkFirstProgHasOneLine: Scenario['extraCheck'] = (progs) => {
  if (progs.length === 0) return 'no programs returned';
  const p = progs[0];
  if (p.lines.length !== 1) return `expected 1 line, got ${p.lines.length}`;
  return null;
};

const scenarios: Scenario[] = [
  {
    // Bug reproducer: REM payload contains 0x16 0x16 0x16 0x16 0x24 mid-body.
    // Pre-fix, parseTapFile splits this into two blocks and the first block's
    // body is truncated before the line terminator, so line parsing fails.
    name: 'mid-body trap pattern (0x16^4 + 0x24) in REM payload',
    tapBytes: buildBasicTapBlock(
      'TRAP',
      buildBasicBodyRemLine(10, [0x16, 0x16, 0x16, 0x16, 0x24, 0x41, 0x42]),
    ),
    expectedPrograms: 1,
    expectedNames:  ['TRAP'],
    extraCheck:     checkFirstProgHasOneLine,
  },
  {
    // Same trap pattern, but with a second legitimate program after it.
    // The fix must not lose the second program either.
    name: 'trap pattern followed by second program',
    tapBytes: [
      ...buildBasicTapBlock(
        'TRAP',
        buildBasicBodyRemLine(10, [0x16, 0x16, 0x16, 0x16, 0x24, 0x41, 0x42]),
      ),
      ...buildBasicTapBlock(
        'PROG2',
        buildBasicBodyRemLine(20, [0x48, 0x49]),
      ),
    ],
    expectedPrograms: 2,
    expectedNames:  ['TRAP', 'PROG2'],
    extraCheck:     checkFirstProgHasOneLine,
  },
  {
    // Long 0x16 run (16 of them) mid-body — more than we'd emit as sync.
    name: 'long 0x16 run mid-body',
    tapBytes: buildBasicTapBlock(
      'LONGRUN',
      buildBasicBodyRemLine(10, [
        0x16, 0x16, 0x16, 0x16, 0x16, 0x16, 0x16, 0x16,
        0x16, 0x16, 0x16, 0x16, 0x16, 0x16, 0x16, 0x16,
        0x24, 0x44, 0x45, 0x46,
      ]),
    ),
    expectedPrograms: 1,
    expectedNames:  ['LONGRUN'],
    extraCheck:     checkFirstProgHasOneLine,
  },
  {
    // Sanity: a normal program without any trap pattern still decodes.
    name: 'normal program',
    tapBytes: buildBasicTapBlock(
      'HELLO',
      buildBasicBodyRemLine(10, [0x48, 0x49]),
    ),
    expectedPrograms: 1,
    expectedNames: ['HELLO'],
  },
  {
    // A run of 0x16s NOT followed by 0x24 should not be treated as sync.
    // We place a 5 × 0x16 + non-0x24 run before the real program.
    name: '0x16 run without 0x24 is not sync',
    tapBytes: [
      0x16, 0x16, 0x16, 0x16, 0x16, 0x41,  // spurious run
      ...buildBasicTapBlock('AFTER', buildBasicBodyRemLine(10, [0x42])),
    ],
    expectedPrograms: 1,
    expectedNames: ['AFTER'],
  },
];

// ── Runner ────────────────────────────────────────────────────────────────────

let allPass = true;
for (const s of scenarios) {
  const buffer = new Uint8Array(s.tapBytes).buffer;
  let progs: ReturnType<typeof parseTapFile>;
  let err = '';
  try {
    progs = parseTapFile(buffer);
  } catch (e: any) {
    progs = [];
    err   = `threw: ${e.message}`;
  }
  const countOk = progs.length === s.expectedPrograms;
  let namesOk  = true;
  if (s.expectedNames) {
    namesOk = progs.length === s.expectedNames.length
      && progs.every((p, i) => p.name === s.expectedNames![i]);
  }
  const extraErr = !err && s.extraCheck ? s.extraCheck(progs) : null;
  const pass = !err && countOk && namesOk && !extraErr;
  if (!pass) allPass = false;

  console.log(`\n=== ${s.name} ===`);
  console.log(`  TAP bytes: ${s.tapBytes.length}`);
  console.log(`  programs returned: ${progs.length} (expected ${s.expectedPrograms})`);
  if (s.expectedNames) {
    console.log(`  names: ${JSON.stringify(progs.map(p => p.name))} `
              + `(expected ${JSON.stringify(s.expectedNames)})`);
  }
  if (err)      console.log(`  ERROR: ${err}`);
  if (extraErr) console.log(`  CHECK FAILED: ${extraErr}`);
  console.log(`  ${pass ? 'PASS' : 'FAIL'}`);
}

console.log(`\n${allPass ? 'ALL SCENARIOS PASSED' : 'SOME SCENARIOS FAILED'}`);
process.exit(allPass ? 0 : 1);
