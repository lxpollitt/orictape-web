#!/usr/bin/env npx tsx
/**
 * Ad-hoc scenario tests for computeLcs tie-break behaviour.
 *
 * Runs the three scenarios from the design discussion and prints the
 * resulting alignment in a human-readable form.  Not part of CI — just a
 * quick sanity check when tuning the LCS algorithm.
 */

import { computeLcs } from '../src/editor';

type Scenario = { name: string; oldStr: string; newStr: string; expectedInsertions: string[] };

const scenarios: Scenario[] = [
  {
    name: 'pies',
    oldStr: '5 REM *By A.Pollitt.               *',
    newStr: '5 REM *By A.Pollitt who likes pies!               *',
    // Want: single contiguous insertion " who likes pies!" and deletion "."
    expectedInsertions: [' who likes pies!'],
  },
  {
    name: '100→1000',
    oldStr: '100',
    newStr: '1000',
    // Want: trailing 0 highlighted
    expectedInsertions: ['0'],
  },
  {
    name: '100 PRINT X → 1000 PRINT X',
    oldStr: '100 PRINT X',
    newStr: '1000 PRINT X',
    // Want: insertion at the boundary between "100" and " PRINT X"
    // — the 4th digit, i.e. new[3]='0'.  Checked via a position assertion
    // below as well, not just the insertion text.
    expectedInsertions: ['0'],
  },
  // Edge cases — mostly to catch backtrack bugs at boundaries.
  { name: 'empty-both',  oldStr: '',    newStr: '',     expectedInsertions: [] },
  { name: 'empty-old',   oldStr: '',    newStr: 'HI',   expectedInsertions: ['HI'] },
  { name: 'empty-new',   oldStr: 'HI',  newStr: '',     expectedInsertions: [] },
  { name: 'identical',   oldStr: 'ABC', newStr: 'ABC',  expectedInsertions: [] },
  { name: 'full-replace',oldStr: 'ABC', newStr: 'XYZ',  expectedInsertions: ['XYZ'] },
  { name: 'HI→HII',      oldStr: 'HI',  newStr: 'HII',  expectedInsertions: ['I'] },
];

function toCodes(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
  return out;
}

function analyse(oldStr: string, newStr: string) {
  const oldValues = toCodes(oldStr);
  const newValues = toCodes(newStr);
  const matches = computeLcs(newValues, oldValues);

  // Build sets of matched positions for quick lookup.
  const matchedOld = new Set(matches.map(m => m.oldIdx));
  const matchedNew = new Set(matches.map(m => m.newIdx));

  // Extract contiguous insertions in new and deletions in old.
  const insertions: { start: number; text: string }[] = [];
  for (let i = 0; i < newStr.length; ) {
    if (!matchedNew.has(i)) {
      const start = i;
      let text = '';
      while (i < newStr.length && !matchedNew.has(i)) { text += newStr[i]; i++; }
      insertions.push({ start, text });
    } else i++;
  }
  const deletions: { start: number; text: string }[] = [];
  for (let i = 0; i < oldStr.length; ) {
    if (!matchedOld.has(i)) {
      const start = i;
      let text = '';
      while (i < oldStr.length && !matchedOld.has(i)) { text += oldStr[i]; i++; }
      deletions.push({ start, text });
    } else i++;
  }

  // Count contiguous match runs (in new-index order).
  let runs = 0;
  let prevNew = -2, prevOld = -2;
  for (const m of matches) {
    if (m.newIdx !== prevNew + 1 || m.oldIdx !== prevOld + 1) runs++;
    prevNew = m.newIdx;
    prevOld = m.oldIdx;
  }

  return { matches, insertions, deletions, runs };
}

function formatVisual(newStr: string, matches: { newIdx: number; oldIdx: number }[]): string {
  const matchedNew = new Set(matches.map(m => m.newIdx));
  let out = '';
  for (let i = 0; i < newStr.length; i++) {
    out += matchedNew.has(i) ? newStr[i] : `[${newStr[i]}]`;
  }
  return out;
}

// Position assertions — insertion must land at this start index in new.
// Tests where only the insertion text matters (not position) omit an entry.
const positionChecks: Record<string, number | undefined> = {
  '100 PRINT X → 1000 PRINT X': 3,
  '100→1000':                   3,
  'HI→HII':                     2,
};

let allPass = true;
for (const s of scenarios) {
  const { matches, insertions, deletions, runs } = analyse(s.oldStr, s.newStr);
  const insTexts = insertions.map(i => i.text);
  const textPass = JSON.stringify(insTexts) === JSON.stringify(s.expectedInsertions);
  const expectedPos = positionChecks[s.name];
  const posPass = expectedPos === undefined
    || (insertions.length === 1 && insertions[0].start === expectedPos);
  const pass = textPass && posPass;
  if (!pass) allPass = false;

  console.log(`\n=== ${s.name} ===`);
  console.log(`  old: "${s.oldStr}"`);
  console.log(`  new: "${s.newStr}"`);
  console.log(`  visual: ${formatVisual(s.newStr, matches)}`);
  console.log(`  insertions: ${JSON.stringify(insTexts)} at ${JSON.stringify(insertions.map(i => i.start))}`);
  console.log(`  deletions:  ${JSON.stringify(deletions.map(d => d.text))}`);
  console.log(`  match runs: ${runs}`);
  console.log(`  expected insertions: ${JSON.stringify(s.expectedInsertions)}${expectedPos !== undefined ? ` at [${expectedPos}]` : ''}`);
  console.log(`  ${pass ? 'PASS' : 'FAIL'}`);
}

console.log(`\n${allPass ? 'ALL SCENARIOS PASSED' : 'SOME SCENARIOS FAILED'}`);
process.exit(allPass ? 0 : 1);
