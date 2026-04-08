#!/usr/bin/env npx tsx
/**
 * Compare tool: diff two snapshot output directories.
 *
 * Usage: npx tsx tests/compare.ts <baseline-dir> <current-dir>
 *
 * Compares summary.txt files and TAP files between two snapshot runs.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

function usage(): never {
  console.error('Usage: npx tsx tests/compare.ts <baseline-dir> <current-dir> [filter...]');
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length < 2) usage();

const [baselineDir, currentDir, ...filterParts] = args;
const tapFilter = filterParts.length > 0 ? filterParts.join(' ') : null;

if (!existsSync(baselineDir)) { console.error(`Baseline dir not found: ${baselineDir}`); process.exit(1); }
if (!existsSync(currentDir))  { console.error(`Current dir not found: ${currentDir}`);  process.exit(1); }

// ── Summary diff (skip when filtering to specific TAP files) ─────────────────

if (!tapFilter) {
  const baselineSummary = existsSync(join(baselineDir, 'summary.txt'))
    ? readFileSync(join(baselineDir, 'summary.txt'), 'utf-8')
    : '';
  const currentSummary = existsSync(join(currentDir, 'summary.txt'))
    ? readFileSync(join(currentDir, 'summary.txt'), 'utf-8')
    : '';

  if (baselineSummary === currentSummary) {
    console.log('summary.txt: identical');
  } else {
    const baseLines = baselineSummary.split('\n');
    const currLines = currentSummary.split('\n');
    let changed = 0;
    const maxLen = Math.max(baseLines.length, currLines.length);
    for (let i = 0; i < maxLen; i++) {
      if (baseLines[i] !== currLines[i]) changed++;
    }
    console.log(`summary.txt: ${changed} line(s) differ`);

    // Show the actual diffs
    for (let i = 0; i < maxLen; i++) {
      if (baseLines[i] !== currLines[i]) {
        if (baseLines[i] !== undefined) console.log(`  - ${baseLines[i]}`);
        if (currLines[i] !== undefined) console.log(`  + ${currLines[i]}`);
      }
    }
  }
}

// ── Byte-level diff (Myers-style, bounded) ───────────────────────────────

interface DiffResult { changed: number; inserted: number; deleted: number; }

/**
 * Compare two byte buffers using a bounded LCS approach.
 * For files up to a few KB (typical TAP size) this is fast.
 * Returns counts of changed, inserted, and deleted bytes.
 */
function diffBytes(a: Buffer, b: Buffer): DiffResult {
  const n = a.length;
  const m = b.length;

  // Build LCS length table using two rows (space-optimised).
  let prev = new Uint16Array(m + 1);
  let curr = new Uint16Array(m + 1);
  for (let i = 1; i <= n; i++) {
    [prev, curr] = [curr, prev];
    curr.fill(0);
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = prev[j] > curr[j - 1] ? prev[j] : curr[j - 1];
      }
    }
  }
  const lcsLen = curr[m];

  // Backtrack to recover the actual LCS and classify differences.
  // Rebuild the full DP table for backtracking (only needed for small files).
  const dp: Uint16Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint16Array(m + 1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = dp[i - 1][j] > dp[i][j - 1] ? dp[i - 1][j] : dp[i][j - 1];
      }
    }
  }

  // Walk back through the DP table to count insertions, deletions, and changes.
  let i = n, j = m;
  let deleted = 0, inserted = 0;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      i--; j--; // match
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      inserted++; j--;
    } else {
      deleted++; i--;
    }
  }

  // Pair up deletions and insertions as "changes" where possible.
  const paired  = Math.min(deleted, inserted);
  return {
    changed:  paired,
    inserted: inserted - paired,
    deleted:  deleted - paired,
  };
}

// ── TAP file comparison ───────────────────────────────────────────────────────

const matchesFilter = (f: string) => !tapFilter || f.includes(tapFilter);

const baselineTaps = new Set(
  readdirSync(baselineDir).filter(f => f.endsWith('.tap') && matchesFilter(f)).sort()
);
const currentTaps = new Set(
  readdirSync(currentDir).filter(f => f.endsWith('.tap') && matchesFilter(f)).sort()
);

const allTaps = new Set([...baselineTaps, ...currentTaps]);

let identical = 0;
let changed   = 0;
let missingInCurrent: string[]  = [];
let missingInBaseline: string[] = [];
const changedFiles: { name: string; detail: string }[] = [];

for (const tap of [...allTaps].sort()) {
  const inBaseline = baselineTaps.has(tap);
  const inCurrent  = currentTaps.has(tap);

  if (inBaseline && !inCurrent) {
    missingInCurrent.push(tap);
    continue;
  }
  if (!inBaseline && inCurrent) {
    missingInBaseline.push(tap);
    continue;
  }

  // Both exist — compare contents
  const baseBytes = readFileSync(join(baselineDir, tap));
  const currBytes = readFileSync(join(currentDir, tap));

  if (Buffer.compare(baseBytes, currBytes) === 0) {
    identical++;
  } else {
    changed++;
    const diff = diffBytes(baseBytes, currBytes);
    const sizePart = baseBytes.length !== currBytes.length
      ? ` (${baseBytes.length} → ${currBytes.length} bytes)`
      : ` (${baseBytes.length} bytes)`;
    const parts: string[] = [];
    if (diff.changed > 0)  parts.push(`${diff.changed} changed`);
    if (diff.inserted > 0) parts.push(`${diff.inserted} inserted`);
    if (diff.deleted > 0)  parts.push(`${diff.deleted} deleted`);
    changedFiles.push({ name: tap, detail: `${parts.join(', ')}${sizePart}` });
  }
}

console.log('');
console.log(`TAP files: ${identical} identical, ${changed} changed, ${missingInCurrent.length} missing in current, ${missingInBaseline.length} missing in baseline`);

for (const f of changedFiles) {
  console.log(`  ${f.name}: ${f.detail}`);
}
for (const f of missingInCurrent) {
  console.log(`  ${f}: missing in current`);
}
for (const f of missingInBaseline) {
  console.log(`  ${f}: new in current`);
}

// ── Overall verdict ───────────────────────────────────────────────────────────

const hasChanges = changed > 0
  || missingInCurrent.length > 0
  || missingInBaseline.length > 0;

console.log('');
if (hasChanges) {
  console.log('Result: CHANGES DETECTED');
  process.exit(1);
} else {
  console.log('Result: ALL IDENTICAL');
  process.exit(0);
}
