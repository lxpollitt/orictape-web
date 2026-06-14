#!/usr/bin/env npx tsx
/**
 * Bulk bit-stream round-trip regression test for the Oric tape-audio encoder.
 *
 * For every NON-CORRUPT program decoded from every recording in tests/audio:
 * re-encode it to WAV, decode that, and confirm the re-decode's bit stream
 * matches the original recording's bits from the 0x24 through the last program
 * byte (the shared roundTripMismatch comparison — framing, parity AND the 3/4
 * cadence + name->data gap, validated against ground truth across every name
 * length present in the corpus).
 *
 * Programs are identified with the same `<wav-base>_<NAME>_<startSec>s` label
 * the bulk TAP snapshot uses, and byte indices use the UI convention (byte 0 =
 * first header byte, just after the 0x24), so a finding can be located in the
 * app / waveform directly.
 *
 * "Non-corrupt" = decoded cleanly in the compared region: valid header, no
 * parity errors, no dropped stop bits (a leading run < 3 is impossible in a
 * clean save), no structural line errors / early termination, and the 0x24
 * stop-run is the expected 3.  `unclear` bytes ARE allowed: in fast format one
 * cycle is always one bit with a definite value, so a non-parity unclear byte
 * re-encodes to identical bits.  Skipped programs are tallied by reason (with
 * the offending byte where relevant) so coverage is visible — nothing is
 * dropped silently.
 *
 * The originals (tests/audio) are personal recordings, not in the repo, so this
 * is skipped cleanly when the directory is absent.
 *
 * Run:  npx tsx tests/audioBulkRoundtrip.ts [-v] [filename-substring-filter]
 *   e.g. npx tsx tests/audioBulkRoundtrip.ts -v "UF1 B"
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { Program } from '../src/decoder';
import { decodeWav, hex, programLabel, programWindow, roundTripMismatch, stopRun } from './roundtripCompare';

const AUDIO_DIR = 'tests/audio';
const rawArgs = process.argv.slice(2);
const verbose = rawArgs.includes('-v') || rawArgs.includes('--verbose');
const filter  = rawArgs.filter(a => a !== '-v' && a !== '--verbose').join(' ').trim() || null;

const isTTY = process.stdout.isTTY ?? false;
const c = {
  green: (s: string) => isTTY ? `\x1b[32m${s}\x1b[0m` : s,
  red:   (s: string) => isTTY ? `\x1b[31m${s}\x1b[0m` : s,
  dim:   (s: string) => isTTY ? `\x1b[2m${s}\x1b[0m`  : s,
};

interface Skip { reason: string; detail?: string }

/**
 * Qualify a program for round-tripping.  Returns null if it qualifies, else a
 * Skip {reason (tally key), detail (offending UI byte)}.  Header/byte based so
 * it covers machine-code programs too (no-name and no-BASIC-lines programs with
 * a valid header are fine to round-trip).  Checks the compared region only
 * (0x24 .. last program byte) — corruption past it is irrelevant.
 */
function skipReason(prog: Program): Skip | null {
  // Structural usability + extent, derived from the header (any program type).
  const w = programWindow(prog);
  if (typeof w === 'string') return { reason: w };   // no marker / name not terminated / truncated / degenerate length
  const { ai, dataEnd } = w;

  // Cadence anchor: real Oric saves always show 3 stop bits before the 0x24.
  // A different count means a mis-segmented / non-program block.
  if (stopRun(prog.stream, prog.bytes[ai].firstBit) !== 3) return { reason: '0x24 stop-run != 3' };

  // Byte-level damage anywhere in the compared region disqualifies — our clean
  // re-encode of a damaged byte legitimately wouldn't match the bits:
  //   - parity error: the byte's value is suspect;
  //   - a leading stop run < 3: impossible in a clean Oric save (the ROM always
  //     emits >= 3 stop bits), so the recording dropped a stop bit — a local
  //     timing glitch (often at an `unclear`, slightly-stretched cell) that
  //     shifts the framing across adjacent bytes without corrupting their
  //     values, and which our canonical cadence can't and shouldn't reproduce.
  for (let i = ai; i < dataEnd; i++) {
    const b = prog.bytes[i];
    if (!b) continue;
    const ui = i - ai - 1;                            // UI index: 0 = first header byte (just after 0x24)
    if (b.chkErr) return { reason: 'parity error', detail: `byte ${ui} (${hex(b.v)})` };
    const run = stopRun(prog.stream, b.firstBit);
    if (run < 3) return { reason: 'dropped stop bit (recording glitch)', detail: `byte ${ui} (${hex(b.v)}, ${run} stops)` };
  }
  if (prog.earlyTermination) return { reason: 'early termination' };

  // BASIC programs carry extra structural signals (missing/garbled lines) that
  // machine-code programs don't — use them when present.  lenErr in particular
  // usually means bytes went missing.
  for (const ln of prog.lines) {
    if (ln.lenErr || ln.earlyEnd || ln.nonMonotonic) return { reason: 'structural line error' };
  }
  return null;   // qualifies (unclear bytes allowed; no-name and machine-code OK)
}

if (!existsSync(AUDIO_DIR)) {
  console.log(`SKIP  bulk round-trip: ${AUDIO_DIR} not present (personal recordings, not in repo)`);
  process.exit(0);
}

const files = readdirSync(AUDIO_DIR)
  .filter(f => f.toLowerCase().endsWith('.wav'))
  .filter(f => !filter || f.includes(filter))
  .sort();

if (files.length === 0) {
  console.error(filter ? `No .wav files match filter "${filter}"` : `No .wav files in ${AUDIO_DIR}`);
  process.exit(1);
}

let totalProgs = 0, tested = 0, passed = 0, failed = 0;
const skips     = new Map<string, number>();   // reason -> count
const testedLen = new Map<number, number>();   // name length -> count tested
const failures: string[] = [];

for (let fi = 0; fi < files.length; fi++) {
  const f = files[fi];
  const base = f.replace(/\.wav$/i, '');
  process.stderr.write(isTTY ? `\r\x1b[2K\x1b[90m[${fi + 1}/${files.length}] ${f}\x1b[0m` : '');

  let programs: Program[], sampleRate: number;
  try {
    ({ programs, sampleRate } = decodeWav(readFileSync(join(AUDIO_DIR, f))));
  } catch (e: any) {
    failures.push(`${base}: decode threw: ${e.message}`);
    failed++;
    continue;
  }

  let fileTested = 0, filePassed = 0, fileFailed = 0, fileSkipped = 0;
  for (const prog of programs) {
    totalProgs++;
    const label = programLabel(base, prog, sampleRate);

    const skip = skipReason(prog);
    if (skip) {
      skips.set(skip.reason, (skips.get(skip.reason) ?? 0) + 1);
      fileSkipped++;
      if (verbose) console.log(`  ${c.dim('skip')} ${label}  ${c.dim(skip.reason + (skip.detail ? ` — ${skip.detail}` : ''))}`);
      continue;
    }

    tested++; fileTested++;
    testedLen.set(prog.name.length, (testedLen.get(prog.name.length) ?? 0) + 1);
    const mismatch = roundTripMismatch(prog);
    if (mismatch === null) {
      passed++; filePassed++;
      if (verbose) console.log(`  ${c.green('pass')} ${label}  ${c.dim(`(nameLen ${prog.name.length})`)}`);
    } else {
      failed++; fileFailed++;
      failures.push(`${label}  ${mismatch}`);
      if (verbose) console.log(`  ${c.red('FAIL')} ${label}  ${mismatch}`);
    }
  }

  if (isTTY) process.stderr.write('\r\x1b[2K');
  const tag = fileFailed > 0 ? c.red('FAIL') : c.green('ok  ');
  console.log(`${tag} ${f}  ${c.dim(`(${filePassed}/${fileTested} passed, ${fileSkipped} skipped)`)}`);
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${files.length} file(s), ${totalProgs} program(s): ${c.green(`${passed} passed`)}, ${failed > 0 ? c.red(`${failed} failed`) : '0 failed'}, ${totalProgs - tested} skipped`);

if (skips.size > 0) {
  console.log(`\nSkipped (not non-corrupt in compared region):`);
  for (const [reason, n] of [...skips.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${reason}`);
  }
  if (!verbose) console.log(c.dim(`  (re-run with -v to list each skipped program + offending byte)`));
}

if (tested > 0) {
  const lens = [...testedLen.keys()].sort((a, b) => a - b);
  const span = lens.length ? `${lens[0]}-${lens[lens.length - 1]}` : '-';
  console.log(`\nName-length coverage (tested): ${lens.length} distinct lengths, range ${span}`);
  console.log(`  ${lens.map(l => `${l}:${testedLen.get(l)}`).join('  ')}`);
}

if (failures.length > 0) {
  console.log(`\n${c.red('Failures:')}`);
  for (const s of failures) console.log(`  - ${s}`);
}

console.log('');
console.log(failed > 0 ? c.red('Result: FAILURES DETECTED') : c.green('Result: ALL ROUND-TRIPS MATCH'));
process.exit(failed > 0 ? 1 : 0);
