#!/usr/bin/env npx tsx
/**
 * Run every self-checking test in tests/ and report a combined pass/fail.
 *
 * Picks up all tests/*.ts except EXCLUDE, so a new *Scenarios test is included
 * automatically; only a destructive or arg-taking script needs adding to EXCLUDE.
 * Each test is a standalone tsx script that exits non-zero on failure — this runs
 * them in child processes (from the repo root, so their relative paths resolve)
 * and aggregates.  A passing test's output is hidden; a failing test's is shown.
 *
 * Run:  npx tsx tests/runAll.ts     (or: npm test)
 */

import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

// NOT auto-run: snapshot rewrites the baselines and compareTaps is a by-hand
// comparison (both effectively destructive); compare / extractNames take args;
// roundtripCompare is a shared helper with no main.  Add any new such script here.
const EXCLUDE = new Set([
  'runAll.ts', 'snapshot.ts', 'compareTaps.ts', 'compare.ts', 'extractNames.ts', 'roundtripCompare.ts',
]);

const testsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testsDir, '..');
const files = readdirSync(testsDir).filter(f => f.endsWith('.ts') && !EXCLUDE.has(f)).sort();

let failed = 0;
for (const f of files) {
  const res = spawnSync('npx', ['tsx', join('tests', f)], { cwd: repoRoot, encoding: 'utf8' });
  const ok = res.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${f}`);
  if (!ok) {
    const out = ((res.stdout ?? '') + (res.stderr ?? '') + (res.error ? `\n[spawn error] ${res.error.message}` : '')).trimEnd();
    console.log(out.split('\n').map(l => '      ' + l).join('\n'));
  }
}

console.log(`\n${files.length - failed}/${files.length} test files passed`);
process.exit(failed ? 1 : 0);
