#!/usr/bin/env npx tsx
/**
 * BASIC-aware TAP file comparison tool.
 *
 * Usage: npx tsx tests/compareTaps.ts <baseline.tap> <current.tap>
 *    or: npx tsx tests/compareTaps.ts <baseline-dir> <current-dir> [filter...]
 *
 * When given two .tap files directly, compares them at the BASIC line level.
 * When given two directories, finds matching TAP files (optionally filtered)
 * and compares each pair.
 *
 * Uses the main program's TAP parser and merge infrastructure for line-level
 * alignment, giving the same comparison the UI's merge view would show.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, basename } from 'path';
import { parseTapFile } from '../src/tapfile';
import { alignPrograms } from '../src/merger';
import type { Program } from '../src/decoder';

// ── ANSI colour helpers (disabled when piped) ────────────────────────────────

const isTTY = process.stdout.isTTY ?? false;
const c = {
  blue:  (s: string) => isTTY ? `\x1b[34m${s}\x1b[0m` : s,
  green: (s: string) => isTTY ? `\x1b[32m${s}\x1b[0m` : s,
  red:   (s: string) => isTTY ? `\x1b[31m${s}\x1b[0m` : s,
  dim:   (s: string) => isTTY ? `\x1b[2m${s}\x1b[0m`  : s,
};

// ── Element-level diff for conflict lines ────────────────────────────────────

/**
 * LCS-based element diff. Each BASIC keyword/token is an atomic unit.
 * Returns the lines with differing elements wrapped in red ANSI escapes.
 */
function highlightElementDiffs(a: string[], b: string[]): { aHighlighted: string; bHighlighted: string } {
  const aText = a.join(''), bText = b.join('');
  if (!isTTY) return { aHighlighted: aText, bHighlighted: bText };

  // Build LCS table on elements.
  const n = a.length, m = b.length;
  const dp: Uint16Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint16Array(m + 1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to classify each element as match or diff.
  const aFlags = new Uint8Array(n); // 1 = different
  const bFlags = new Uint8Array(m);
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      bFlags[--j] = 1;
    } else {
      aFlags[--i] = 1;
    }
  }

  // Replace control characters (0x00–0x1F, 0x7F) with a visible placeholder.
  const sanitise = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, '\u25a0');

  // Build highlighted strings, colouring entire elements.
  const highlight = (elems: string[], flags: Uint8Array): string => {
    let out = '';
    let inRed = false;
    for (let k = 0; k < elems.length; k++) {
      if (flags[k] && !inRed) { out += '\x1b[31m'; inRed = true; }
      if (!flags[k] && inRed) { out += '\x1b[0m';  inRed = false; }
      out += sanitise(elems[k]);
    }
    if (inRed) out += '\x1b[0m';
    return out;
  };

  return { aHighlighted: highlight(a, aFlags), bHighlighted: highlight(b, bFlags) };
}

// ── Argument parsing ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: npx tsx tests/compareTaps.ts <baseline.tap> <current.tap>');
  console.error('   or: npx tsx tests/compareTaps.ts <baseline-dir> <current-dir> [filter...]');
  process.exit(1);
}

const [arg1, arg2, ...filterParts] = args;
const tapFilter = filterParts.length > 0 ? filterParts.join(' ') : null;

interface TapPair { name: string; baselinePath: string; currentPath: string; }

const pairs: TapPair[] = [];
let newInCurrent = 0;
let missingInCurrent = 0;

if (statSync(arg1).isDirectory() && statSync(arg2).isDirectory()) {
  // Directory mode: find matching TAP files
  const matchesFilter = (f: string) => !tapFilter || f.includes(tapFilter);
  const baseFiles = new Set(readdirSync(arg1).filter(f => f.endsWith('.tap') && matchesFilter(f)));
  const currFiles = new Set(readdirSync(arg2).filter(f => f.endsWith('.tap') && matchesFilter(f)));

  const allFiles = new Set([...baseFiles, ...currFiles]);
  for (const f of [...allFiles].sort()) {
    if (!baseFiles.has(f)) { console.log(`${c.blue(f)}: ${c.green('new in current (no baseline)')}`); newInCurrent++; continue; }
    if (!currFiles.has(f)) { console.log(`${c.blue(f)}: ${c.red('missing in current')}`); missingInCurrent++; continue; }
    pairs.push({ name: f, baselinePath: join(arg1, f), currentPath: join(arg2, f) });
  }
} else {
  // Direct file mode
  if (!existsSync(arg1)) { console.error(`File not found: ${arg1}`); process.exit(1); }
  if (!existsSync(arg2)) { console.error(`File not found: ${arg2}`); process.exit(1); }
  pairs.push({ name: basename(arg1), baselinePath: arg1, currentPath: arg2 });
}

// ── Compare each pair ────────────────────────────────────────────────────────

let totalPairs = 0;
let identicalPairs = 0;
let structuralOnlyPairs = 0;
let changedPairs = 0;

for (const pair of pairs) {
  totalPairs++;

  const baseBuf  = readFileSync(pair.baselinePath);
  const currBuf  = readFileSync(pair.currentPath);

  // Quick check: if files are byte-identical, skip the detailed comparison.
  if (Buffer.compare(baseBuf, currBuf) === 0) {
    identicalPairs++;
    continue;
  }

  const baseProgs = parseTapFile(baseBuf.buffer.slice(baseBuf.byteOffset, baseBuf.byteOffset + baseBuf.byteLength));
  const currProgs = parseTapFile(currBuf.buffer.slice(currBuf.byteOffset, currBuf.byteOffset + currBuf.byteLength));

  if (baseProgs.length === 0 && currProgs.length === 0) {
    identicalPairs++;
    continue;
  }

  // Compare the first program from each TAP (TAP files from snapshot.ts contain one program each).
  const baseProg = baseProgs[0];
  const currProg = currProgs[0];

  if (!baseProg || !currProg) {
    changedPairs++;
    console.log(`${c.blue(pair.name)}: ${c.red(`parse failure (baseline: ${baseProgs.length} progs, current: ${currProgs.length} progs)}`)}`);

    continue;
  }

  // Use the merger to do line-level alignment.
  const merged = alignPrograms([baseProg, currProg]);

  // Analyse the merge results.
  const consensusLines: number[] = [];
  const conflictLines:  number[] = [];
  const baseOnlyLines:  number[] = [];
  const currOnlyLines:  number[] = [];

  for (const line of merged.lines) {
    const hasBase = line.sources.some(s => s.tapeIdx === 0);
    const hasCurr = line.sources.some(s => s.tapeIdx === 1);

    if (hasBase && hasCurr) {
      if (line.status === 'consensus') {
        consensusLines.push(line.lineNum);
      } else {
        conflictLines.push(line.lineNum);
      }
    } else if (hasBase) {
      baseOnlyLines.push(line.lineNum);
    } else {
      currOnlyLines.push(line.lineNum);
    }
  }

  if (conflictLines.length === 0 && baseOnlyLines.length === 0 && currOnlyLines.length === 0) {
    // Lines all match — the byte-level difference must be in headers/pointers only.
    console.log(`${c.blue(pair.name)}: ${c.green(`BASIC identical (${consensusLines.length} lines)`)} — byte difference is structural only`);
    structuralOnlyPairs++;
    continue;
  }

  changedPairs++;
  const parts: string[] = [];
  parts.push(c.green(`${consensusLines.length} matching`));
  if (conflictLines.length > 0)  parts.push(c.red(`${conflictLines.length} conflicting`));
  if (baseOnlyLines.length > 0)  parts.push(c.red(`${baseOnlyLines.length} baseline-only`));
  if (currOnlyLines.length > 0)  parts.push(c.red(`${currOnlyLines.length} current-only`));

  console.log(`${c.blue(pair.name)}: ${parts.join(', ')}`);

  // Show detail for conflicts and missing lines.
  for (const lineNum of conflictLines) {
    const line = merged.lines.find(l => l.lineNum === lineNum)!;
    const baseSrc = line.sources.find(s => s.tapeIdx === 0)!;
    const currSrc = line.sources.find(s => s.tapeIdx === 1)!;
    const baseElems = baseProg.lines[baseSrc.lineIdx].elements;
    const currElems = currProg.lines[currSrc.lineIdx].elements;
    const { aHighlighted, bHighlighted } = highlightElementDiffs(baseElems, currElems);
    console.log(`  Line ${lineNum}: CONFLICT`);
    console.log(`    baseline: ${aHighlighted}`);
    console.log(`    current:  ${bHighlighted}`);
  }
  for (const lineNum of baseOnlyLines) {
    console.log(`  Line ${lineNum}: baseline only`);
  }
  for (const lineNum of currOnlyLines) {
    console.log(`  Line ${lineNum}: current only`);
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log('');
const totalFiles = totalPairs + newInCurrent + missingInCurrent;
const summaryParts = [`${identicalPairs} identical`];
if (structuralOnlyPairs > 0) summaryParts.push(`${structuralOnlyPairs} structural only`);
if (changedPairs > 0) summaryParts.push(`${changedPairs} changed`);
if (newInCurrent > 0) summaryParts.push(`${newInCurrent} new`);
if (missingInCurrent > 0) summaryParts.push(`${missingInCurrent} missing`);
console.log(`${totalFiles} TAP files: ${summaryParts.join(', ')}`);

if (changedPairs > 0) process.exit(1);
