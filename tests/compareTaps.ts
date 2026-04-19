#!/usr/bin/env npx tsx
/**
 * BASIC-aware TAP file comparison tool with severity classification.
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
 *
 * When TAP files contain ORICTAPE_META metadata (from snapshot.ts), differences
 * are classified by severity:
 *   REGRESSION — was clean, now corrupted or missing
 *   DEGRADED   — was corrupted, now more corrupted
 *   CHANGED    — was clean, still clean, but different content
 *   EQUIVALENT — was corrupted, still corrupted, similar severity
 *   IMPROVED   — was corrupted, now less corrupted or clean
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, basename } from 'path';
import { parseTapFile } from '../src/tapDecoder';
import { alignPrograms, isLineClean, type LineSource } from '../src/merger';
import type { Program, ByteInfo } from '../src/decoder';

// ── ANSI colour helpers (disabled when piped) ────────────────────────────────

const isTTY = process.stdout.isTTY ?? false;
const c = {
  blue:   (s: string) => isTTY ? `\x1b[34m${s}\x1b[0m` : s,
  green:  (s: string) => isTTY ? `\x1b[32m${s}\x1b[0m` : s,
  yellow: (s: string) => isTTY ? `\x1b[33m${s}\x1b[0m` : s,
  red:    (s: string) => isTTY ? `\x1b[31m${s}\x1b[0m` : s,
  dim:    (s: string) => isTTY ? `\x1b[2m${s}\x1b[0m`  : s,
  grey:   (s: string) => isTTY ? `\x1b[90m${s}\x1b[0m` : s,
};

// ── Character sanitisation ───────────────────────────────────────────────────

/** Replace control characters (0x00–0x1F, 0x7F) with a visible placeholder. */
const sanitise = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, '\u25a0');

/** For highlighted (colour-coded) elements: also replace spaces with underscores
 *  so invisible characters become visible when colour-coded. */
const sanitiseHighlighted = (s: string) => sanitise(s).replace(/ /g, '_');

// ── Severity types ───────────────────────────────────────────────────────────

type Severity =
  | 'regression'          // was clean, now corrupted or missing
  | 'degraded'            // significantly worsened: warning→error, or issues increased ≥50%
  | 'changed'             // was clean, still clean, different content
  | 'similar-degraded'    // marginally worsened (below degraded threshold)
  | 'similar-equivalent'  // same level of issues, just different
  | 'similar-improved'    // marginally improved (below improved threshold)
  | 'improved';           // significantly improved: error→warning-only or →clean

/** Map severity to its primary colour (for counts in summaries). */
function severityColour(s: Severity, text: string): string {
  switch (s) {
    case 'regression':        return c.red(text);
    case 'degraded':          return c.red(text);
    case 'changed':           return c.yellow(text);
    case 'similar-degraded':  return c.yellow(text);
    case 'similar-equivalent':return c.yellow(text);
    case 'similar-improved':  return c.yellow(text);
    case 'improved':          return c.green(text);
  }
}

/** Human-readable label: "SIMILAR (marginally improved)" etc. */
function severityLabel(s: Severity): string {
  switch (s) {
    case 'regression':         return c.red('REGRESSION');
    case 'degraded':           return c.red('DEGRADED');
    case 'changed':            return c.yellow('CHANGED');
    case 'similar-degraded':   return c.yellow('SIMILAR') + ' (marginally degraded)';
    case 'similar-equivalent': return c.yellow('SIMILAR') + ' (equivalent)';
    case 'similar-improved':   return c.yellow('SIMILAR') + ' (marginally improved)';
    case 'improved':           return c.green('IMPROVED');
  }
}

/** Short name for summary counts. */
function severityShortName(s: Severity): string {
  switch (s) {
    case 'similar-degraded':   return 'similar';
    case 'similar-equivalent': return 'similar';
    case 'similar-improved':   return 'similar';
    default:                   return s;
  }
}

/** Line health: clean (no issues), warning (unclear only), or error (chkErr or structural). */
type LineHealth = 'clean' | 'warning' | 'error';

interface LineStats {
  health:       LineHealth;
  errorCount:   number;  // chkErr bytes + structural issues
  unclearCount: number;  // unclear-only bytes (not also chkErr)
  totalIssues:  number;  // errorCount + unclearCount
  // Edit-metadata counts — not health-affecting, but tracked so differences
  // between baseline and current can be flagged as 'changed' (useful for
  // detecting drift in edit-provenance tracking through the tapEncoder).
  editedExplicitCount:  number;  // bytes with edited === 'explicit'
  editedAutomaticCount: number;  // bytes with edited === 'automatic'
  deltaCount:           number;  // line.originalBytesDelta?.length ?? 0
}

function getLineStats(prog: Program, lineIdx: number): LineStats {
  const line = prog.lines[lineIdx];
  let errorCount = 0;
  let unclearCount = 0;
  let editedExplicitCount = 0;
  let editedAutomaticCount = 0;

  // Structural issues count as errors.
  if (line.lenErr || line.earlyEnd || line.nonMonotonic) errorCount++;

  // Count unknown keyword elements individually (each is one corrupt byte).
  for (const elem of line.elements) {
    if (elem === '[UNKNOWN_KEYWORD]') errorCount++;
  }

  for (let i = line.firstByte; i <= line.lastByte; i++) {
    const b = prog.bytes[i];
    if (b?.chkErr)                         errorCount++;
    else if (b?.unclear)                   unclearCount++;
    if (b?.edited === 'explicit')          editedExplicitCount++;
    else if (b?.edited === 'automatic')    editedAutomaticCount++;
  }

  const deltaCount = line.originalBytesDelta?.length ?? 0;

  const health: LineHealth = errorCount > 0 ? 'error'
    : unclearCount > 0 ? 'warning'
    : 'clean';

  return {
    health, errorCount, unclearCount, totalIssues: errorCount + unclearCount,
    editedExplicitCount, editedAutomaticCount, deltaCount,
  };
}

/** True if any edit-provenance counts (edit flags or delta count) differ. */
function editMetaDiffers(a: LineStats, b: LineStats): boolean {
  return a.editedExplicitCount  !== b.editedExplicitCount
      || a.editedAutomaticCount !== b.editedAutomaticCount
      || a.deltaCount           !== b.deltaCount;
}

/**
 * Classify a conflict between baseline and current versions of a line.
 *
 * IMPROVED (green):   error → clean, error → warning-only, warning → clean
 * DEGRADED (red):     warning → error, or total issues increased ≥50%
 * CHANGED (yellow):   clean → clean (different content)
 * REGRESSION (red):   clean → non-clean
 * SIMILAR (yellow):   everything else (marginal changes in already-imperfect lines)
 */
function classifyConflict(
  baseProg: Program, baseLineIdx: number,
  currProg: Program, currLineIdx: number,
): Severity {
  const base = getLineStats(baseProg, baseLineIdx);
  const curr = getLineStats(currProg, currLineIdx);

  // Clean → anything different.
  if (base.health === 'clean' && curr.health === 'clean')    return 'changed';
  if (base.health === 'clean')                                return 'regression';

  // Anything → clean.
  if (curr.health === 'clean')                                return 'improved';

  // Warning → ...
  if (base.health === 'warning') {
    if (curr.health === 'error')                              return 'similar-degraded';
    // Both warning — compare counts.
    if (curr.unclearCount < base.unclearCount)                return 'similar-improved';
    if (curr.unclearCount > base.unclearCount)                return 'similar-degraded';
    return 'similar-equivalent';
  }

  // Error → warning-only = significant improvement.
  if (curr.health === 'warning')                              return 'improved';

  // Both error — check for significant change (>50% increase/decrease).
  const baseTotal = base.totalIssues;
  const currTotal = curr.totalIssues;
  const threshold = Math.ceil(baseTotal * 0.5);  // 50% rounded up

  if (currTotal > baseTotal + threshold)                      return 'degraded';
  if (currTotal < baseTotal - threshold)                      return 'improved';

  // Marginal change or equivalent.
  if (currTotal > baseTotal)                                  return 'similar-degraded';
  if (currTotal < baseTotal)                                  return 'similar-improved';
  return 'similar-equivalent';
}

// ── Element-level diff for conflict lines ────────────────────────────────────

// ── Per-element health ───────────────────────────────────────────────────────

type ElemHealth = 'clean' | 'unclear' | 'error';

/** Element-level health: ok or error (unknown keyword, non-monotonic line number). */
type ElemStatus = 'ok' | 'error';

/** Edit-provenance status of the byte(s) backing an element. */
type ElemEditStatus = 'none' | 'explicit' | 'automatic' | 'mixed';

interface ElemInfo {
  elemStatus: ElemStatus;      // element-level: ok or error
  byteHealth: ElemHealth;      // byte-level: clean, unclear, or error
  editStatus: ElemEditStatus;  // byte-level edit provenance
}

/** Determine the element status, byte health, and edit status for a single element. */
function getElemInfo(prog: Program, lineIdx: number, elemIdx: number): ElemInfo {
  const line = prog.lines[lineIdx];
  const elem = line.elements[elemIdx];

  // Element-level status: error if unknown keyword or non-monotonic line number.
  const elemStatus: ElemStatus =
    (elem === '[UNKNOWN_KEYWORD]') ? 'error' :
    (elemIdx === 0 && line.nonMonotonic) ? 'error' :
    'ok';

  // Byte-level health and edit status.  Element 0 spans 2 bytes (line number);
  // the others are single bytes.
  let byteHealth: ElemHealth;
  let editStatus: ElemEditStatus;
  const editOf = (e: ByteInfo['edited']): Exclude<ElemEditStatus, 'mixed'> =>
    e === 'explicit' ? 'explicit' : e === 'automatic' ? 'automatic' : 'none';
  if (elemIdx === 0) {
    const b2 = prog.bytes[line.firstByte + 2];
    const b3 = prog.bytes[line.firstByte + 3];
    byteHealth = (b2?.chkErr || b3?.chkErr) ? 'error'
      : (b2?.unclear || b3?.unclear) ? 'unclear'
      : 'clean';
    const e2 = editOf(b2?.edited);
    const e3 = editOf(b3?.edited);
    editStatus = e2 === e3 ? e2 : 'mixed';
  } else {
    const b = prog.bytes[line.firstByte + 3 + elemIdx];
    byteHealth = b?.chkErr ? 'error' : b?.unclear ? 'unclear' : 'clean';
    editStatus = editOf(b?.edited);
  }

  return { elemStatus, byteHealth, editStatus };
}

/** Build per-element info arrays for a line. */
function lineElemInfos(prog: Program, lineIdx: number): ElemInfo[] {
  const line = prog.lines[lineIdx];
  return line.elements.map((_, ei) => getElemInfo(prog, lineIdx, ei));
}

/** Format a delta-byte array as ` [0x11 0x32]` in grey, or empty string when empty. */
function formatDelta(delta: ByteInfo[] | undefined): string {
  if (!delta || delta.length === 0) return '';
  const hex = delta.map(b => '0x' + b.v.toString(16).padStart(2, '0')).join(' ');
  return c.grey(` [${hex}]`);
}

/**
 * Format delta suffixes for a paired baseline/current line, aligning the
 * visual representation: if either side has non-empty deltas, both sides
 * show the bracket (empty side shows ` []`).  If both are empty, both
 * sides show nothing.  Matches user's request for visual parity.
 */
function formatDeltaPair(
  aDelta: ByteInfo[] | undefined,
  bDelta: ByteInfo[] | undefined,
): [string, string] {
  const aEmpty = !aDelta || aDelta.length === 0;
  const bEmpty = !bDelta || bDelta.length === 0;
  if (aEmpty && bEmpty) return ['', ''];
  const fmt = (d: ByteInfo[] | undefined, empty: boolean) => {
    if (empty) return c.grey(' []');
    const hex = d!.map(b => '0x' + b.v.toString(16).padStart(2, '0')).join(' ');
    return c.grey(` [${hex}]`);
  };
  return [fmt(aDelta, aEmpty), fmt(bDelta, bEmpty)];
}

// ── Header byte-level comparison ─────────────────────────────────────────────

/** Count edit flags and delta size across the 9 header bytes. */
function headerEditStats(prog: Program): { explicit: number; automatic: number; deltaCount: number } {
  const h = prog.header;
  let explicit = 0, automatic = 0;
  for (let i = 0; i < 9; i++) {
    const b = prog.bytes[h.byteIndex + i];
    if (b?.edited === 'explicit')        explicit++;
    else if (b?.edited === 'automatic')  automatic++;
  }
  return { explicit, automatic, deltaCount: h.originalBytesDelta?.length ?? 0 };
}

/**
 * Format the 9 header bytes as side-by-side hex strings with colouring:
 *   - Blue when the edit-provenance status differs between baseline/current
 *   - Red when the byte values differ (but edit status matches)
 *   - No colour when both value and edit status match
 * Blue wins over red — matches the per-element rule.
 */
function formatHeaderBytes(aProg: Program, bProg: Program): { aStr: string; bStr: string } {
  const BLUE = '\x1b[34m', RED = '\x1b[31m', CLEAR = '\x1b[0m';
  const aHex: string[] = [], bHex: string[] = [];
  for (let i = 0; i < 9; i++) {
    const a = aProg.bytes[aProg.header.byteIndex + i];
    const b = bProg.bytes[bProg.header.byteIndex + i];
    const aEdit = a?.edited ?? 'none';
    const bEdit = b?.edited ?? 'none';
    const col = !isTTY ? ''
      : aEdit !== bEdit ? BLUE
      : a?.v !== b?.v   ? RED
      : '';
    const aByte = (a?.v ?? 0).toString(16).padStart(2, '0');
    const bByte = (b?.v ?? 0).toString(16).padStart(2, '0');
    aHex.push(col ? `${col}${aByte}${CLEAR}` : aByte);
    bHex.push(col ? `${col}${bByte}${CLEAR}` : bByte);
  }
  return { aStr: aHex.join(' '), bStr: bHex.join(' ') };
}

// ── Element-level diff for conflict lines ────────────────────────────────────

/**
 * LCS-based element diff with colour rules:
 *
 *   Blue overrides everything when the element's edit-provenance status
 *   differs between sides (matched pair) or when own side is edited and
 *   unmatched.  Matches app UI convention (hb-edited / hb-auto-edited).
 *
 *   Otherwise, existing health-based rules apply:
 *     - Element error (unknown keyword / non-monotonic) → Red
 *     - Byte-level chkErr → Red
 *     - Byte-level unclear → Yellow
 *     - Clean + severity CHANGED → Yellow
 *     - Clean otherwise → No colour
 */
function highlightElementDiffs(
  a: string[], aInfos: ElemInfo[],
  b: string[], bInfos: ElemInfo[],
  severity: Severity,
): { aHighlighted: string; bHighlighted: string } {
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

  // Backtrack — track matched pairs for health comparison.
  const aFlags = new Uint8Array(n); // 1 = text differs (LCS)
  const bFlags = new Uint8Array(m);
  const matchedPairs: [number, number][] = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      matchedPairs.push([i - 1, j - 1]);
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      bFlags[--j] = 1;
    } else {
      aFlags[--i] = 1;
    }
  }

  // Per-element colour, computed independently for each side.
  const aColours = new Array<string>(n).fill('');
  const bColours = new Array<string>(m).fill('');

  const BLUE = '\x1b[34m';

  const byteColour = (bh: ElemHealth): string => {
    if (bh === 'error')   return '\x1b[31m';
    if (bh === 'unclear') return '\x1b[33m';
    if (severity === 'changed') return '\x1b[33m';
    return '';
  };

  // Handle text-differing elements (LCS flagged).  Blue wins if own is
  // edited — we have no counterpart to compare against but the edit
  // provenance is itself information worth highlighting.
  for (let k = 0; k < n; k++) {
    if (!aFlags[k]) continue;
    const ai = aInfos[k];
    if (ai.editStatus !== 'none') { aColours[k] = BLUE; continue; }
    if (ai.elemStatus === 'error') { aColours[k] = '\x1b[31m'; continue; }
    aColours[k] = byteColour(ai.byteHealth);
  }
  for (let k = 0; k < m; k++) {
    if (!bFlags[k]) continue;
    const bi = bInfos[k];
    if (bi.editStatus !== 'none') { bColours[k] = BLUE; continue; }
    if (bi.elemStatus === 'error') { bColours[k] = '\x1b[31m'; continue; }
    bColours[k] = byteColour(bi.byteHealth);
  }

  // Handle matched elements (text identical).  Blue wins when edit status
  // differs between sides.  Otherwise compare health/element-status.
  for (const [ai, bi] of matchedPairs) {
    const aInfo = aInfos[ai];
    const bInfo = bInfos[bi];

    // Skip if completely identical across every dimension we care about.
    if (aInfo.elemStatus === bInfo.elemStatus
        && aInfo.byteHealth === bInfo.byteHealth
        && aInfo.editStatus === bInfo.editStatus) continue;

    // Edit status differs — blue overrides everything else.
    if (aInfo.editStatus !== bInfo.editStatus) {
      aColours[ai] = BLUE;
      bColours[bi] = BLUE;
      continue;
    }

    // Element status differs.
    if (aInfo.elemStatus !== bInfo.elemStatus) {
      aColours[ai] = aInfo.elemStatus === 'error' ? '\x1b[31m' : byteColour(aInfo.byteHealth);
      bColours[bi] = bInfo.elemStatus === 'error' ? '\x1b[31m' : byteColour(bInfo.byteHealth);
      continue;
    }

    // Byte health differs — colour by own byte health.
    aColours[ai] = byteColour(aInfo.byteHealth);
    bColours[bi] = byteColour(bInfo.byteHealth);
  }

  // Build highlighted strings.
  const highlight = (elems: string[], colours: string[]): string => {
    let out = '';
    let curColour = '';
    for (let k = 0; k < elems.length; k++) {
      const wantColour = colours[k];
      if (wantColour !== curColour) {
        if (curColour) out += '\x1b[0m';
        out += wantColour;
        curColour = wantColour;
      }
      out += wantColour ? sanitiseHighlighted(elems[k]) : sanitise(elems[k]);
    }
    if (curColour) out += '\x1b[0m';
    return out;
  };

  return {
    aHighlighted: highlight(a, aColours),
    bHighlighted: highlight(b, bColours),
  };
}

// ── Argument parsing ─────────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2);
const verbose = rawArgs.includes('--verbose') || rawArgs.includes('-v');
const args = rawArgs.filter(a => a !== '--verbose' && a !== '-v');

const wantsHelp = rawArgs.includes('--help') || rawArgs.includes('-h');

if (wantsHelp) {
  console.log(`BASIC-aware TAP file comparison with severity classification.

Usage:
  compareTaps [options] <baseline-dir> <current-dir> [filter...]
  compareTaps [options] <baseline.tap> <current.tap>

Filter:
  Numbers       One or more program indexes separated by spaces (shown in output, e.g. 3 7 12)
  String        Substring match against TAP filenames (no need to escape spaces)
  (omit)        Compare all TAP files

Options:
  -v, --verbose Show identical/structural-only files and SIMILAR line details
  -h, --help    Show full help

Severity levels:
  REGRESSION    Was clean, now corrupted or missing (red)
  DEGRADED      Significantly worsened (red)
  CHANGED       Was clean, still clean, different content (yellow)
  SIMILAR       Marginal change in already-imperfect lines (yellow)
  IMPROVED      Significantly improved or newly recovered (green)

Exit code: 1 if regressions/degraded, 0 otherwise.`);
  process.exit(0);
}

if (args.length < 2) {
  console.error(`Usage:
  compareTaps [options] <baseline-dir> <current-dir> [filter...]
  compareTaps [options] <baseline.tap> <current.tap>

Options:
  -v, --verbose Show identical/structural-only files and SIMILAR line details
  -h, --help    Show full help`);
  process.exit(1);
}

const [arg1, arg2, ...filterParts] = args;

// Filter parsing: if all filter args are pure numbers → program index filter.
// Otherwise → filename substring filter.
const allNumeric = filterParts.length > 0 && filterParts.every(a => /^\d+$/.test(a));
const progIndexFilter = allNumeric ? new Set(filterParts.map(Number)) : null;
const tapFilter = !allNumeric && filterParts.length > 0 ? filterParts.join(' ') : null;

interface TapEntry { name: string; progNum: number; inBaseline: boolean; inCurrent: boolean; baselinePath?: string; currentPath?: string; }
interface TapPair  { name: string; progNum: number; baselinePath: string; currentPath: string; }

const allEntries: TapEntry[] = [];
const pairs: TapPair[] = [];
let newInCurrent = 0;
let missingInCurrent = 0;

// Global severity tallies across all files.
const globalSeverity: Record<Severity, number> = {
  regression: 0, degraded: 0, changed: 0,
  'similar-degraded': 0, 'similar-equivalent': 0, 'similar-improved': 0,
  improved: 0,
};

if (statSync(arg1).isDirectory() && statSync(arg2).isDirectory()) {
  // Directory mode: build full sorted list with program numbers, then filter.
  const baseFiles = new Set(readdirSync(arg1).filter(f => f.endsWith('.tap')));
  const currFiles = new Set(readdirSync(arg2).filter(f => f.endsWith('.tap')));
  const allFiles = [...new Set([...baseFiles, ...currFiles])].sort();

  // Assign program numbers to ALL files (stable regardless of filter).
  for (let i = 0; i < allFiles.length; i++) {
    const f = allFiles[i];
    allEntries.push({
      name: f,
      progNum: i + 1,
      inBaseline: baseFiles.has(f),
      inCurrent:  currFiles.has(f),
      baselinePath: baseFiles.has(f) ? join(arg1, f) : undefined,
      currentPath:  currFiles.has(f) ? join(arg2, f) : undefined,
    });
  }

  // Apply filter.
  const matchesFilter = (e: TapEntry) => {
    if (progIndexFilter) return progIndexFilter.has(e.progNum);
    if (tapFilter)       return e.name.includes(tapFilter);
    return true;
  };

  const filtered = allEntries.filter(matchesFilter);

  if (filterParts.length > 0 && filtered.length === 0) {
    if (progIndexFilter) {
      console.error(`No programs found matching index(es): ${filterParts.join(', ')}`);
    } else {
      console.error(`No filenames found matching filter '${tapFilter}'`);
    }
    process.exit(1);
  }

  for (const e of filtered) {
    pairs.push({
      name: e.name,
      progNum: e.progNum,
      baselinePath: e.baselinePath ?? '',
      currentPath:  e.currentPath ?? '',
    });
  }
} else {
  // Direct file mode
  if (!existsSync(arg1)) { console.error(`File not found: ${arg1}`); process.exit(1); }
  if (!existsSync(arg2)) { console.error(`File not found: ${arg2}`); process.exit(1); }
  pairs.push({ name: basename(arg1), progNum: 1, baselinePath: arg1, currentPath: arg2 });
}

// ── Compare each pair ────────────────────────────────────────────────────────

let totalPairs = 0;
let identicalPairs = 0;
let structuralOnlyPairs = 0;
let changedPairs = 0;
// Track last output type for blank-line separators: 'none' | 'clean' | 'changes'.
// Blank line before changes (unless first output). Blank line before clean if prev was changes.
let lastOutput: 'none' | 'clean' | 'changes' = 'none';

for (const pair of pairs) {
  totalPairs++;

  // Handle new/missing files (no baseline or no current path).
  if (!pair.baselinePath) {
    if (lastOutput !== 'none') console.log('');
    console.log(`${pair.progNum} ${c.blue(pair.name)}:`);
    console.log(`  ${c.green('New in current (no baseline)')}`);
    lastOutput = 'changes';
    newInCurrent++;
    globalSeverity.improved++;
    continue;
  }
  if (!pair.currentPath) {
    if (lastOutput !== 'none') console.log('');
    console.log(`${pair.progNum} ${c.blue(pair.name)}:`);
    console.log(`  ${c.red('Missing in current')}`);
    lastOutput = 'changes';
    missingInCurrent++;
    globalSeverity.regression++;
    continue;
  }

  const baseBuf  = readFileSync(pair.baselinePath);
  const currBuf  = readFileSync(pair.currentPath);

  // Quick check: if files are byte-identical, skip the detailed comparison.
  if (Buffer.compare(baseBuf, currBuf) === 0) {
    if (verbose) {
      if (lastOutput === 'changes') console.log('');
      console.log(`${pair.progNum} ${c.blue(pair.name)}: ${c.dim('identical')}`);
      lastOutput = 'clean';
    }
    identicalPairs++;
    continue;
  }

  const baseProgs = parseTapFile(baseBuf.buffer.slice(baseBuf.byteOffset, baseBuf.byteOffset + baseBuf.byteLength));
  const currProgs = parseTapFile(currBuf.buffer.slice(currBuf.byteOffset, currBuf.byteOffset + currBuf.byteLength));

  if (baseProgs.length === 0 && currProgs.length === 0) {
    if (verbose) {
      if (lastOutput === 'changes') console.log('');
      console.log(`${pair.progNum} ${c.blue(pair.name)}: ${c.dim('identical')}`);
      lastOutput = 'clean';
    }
    identicalPairs++;
    continue;
  }

  // Compare the first program from each TAP (TAP files from snapshot.ts contain one program each).
  const baseProg = baseProgs[0];
  const currProg = currProgs[0];

  if (!baseProg || !currProg) {
    changedPairs++;
    globalSeverity.regression++;
    console.log(`${pair.progNum} ${c.blue(pair.name)}: ${c.red(`parse failure (baseline: ${baseProgs.length} progs, current: ${currProgs.length} progs)`)}`);
    continue;
  }

  // ── Header comparison ──────────────────────────────────────────────────────
  const bh = baseProg.header;
  const ch = currProg.header;

  interface HeaderDiff { field: string; baseVal: string; currVal: string; }
  const headerDiffs: HeaderDiff[] = [];

  if (baseProg.name !== currProg.name)
    headerDiffs.push({ field: 'Program name', baseVal: `"${baseProg.name}"`, currVal: `"${currProg.name}"` });
  if (bh.fileType !== ch.fileType)
    headerDiffs.push({ field: 'File type', baseVal: `0x${bh.fileType.toString(16).padStart(2, '0')}`, currVal: `0x${ch.fileType.toString(16).padStart(2, '0')}` });
  if (bh.autorun !== ch.autorun)
    headerDiffs.push({ field: 'Autorun', baseVal: String(bh.autorun), currVal: String(ch.autorun) });
  if (bh.startAddr !== ch.startAddr)
    headerDiffs.push({ field: 'Start address', baseVal: `0x${bh.startAddr.toString(16).padStart(4, '0')}`, currVal: `0x${ch.startAddr.toString(16).padStart(4, '0')}` });

  // End address validity: check it points to 0x00 0x00 (encoder correctness check).
  function hasValidEndAddr(prog: Program): boolean {
    const h = prog.header;
    let nameEnd = h.byteIndex + 9;
    while (nameEnd < prog.bytes.length && prog.bytes[nameEnd].v !== 0) nameEnd++;
    nameEnd++;
    const endOffset = nameEnd + (h.endAddr - h.startAddr);
    const b0 = prog.bytes[endOffset - 2]?.v;
    const b1 = prog.bytes[endOffset - 1]?.v;
    return b0 === 0x00 && b1 === 0x00;
  }

  function endAddrDetail(prog: Program): string {
    const h = prog.header;
    let nameEnd = h.byteIndex + 9;
    while (nameEnd < prog.bytes.length && prog.bytes[nameEnd].v !== 0) nameEnd++;
    nameEnd++;
    const endOffset = nameEnd + (h.endAddr - h.startAddr);
    const b0 = prog.bytes[endOffset - 2]?.v ?? 0;
    const b1 = prog.bytes[endOffset - 1]?.v ?? 0;
    return `0x${h.endAddr.toString(16).padStart(4, '0')} → 0x${b0.toString(16).padStart(2, '0')} 0x${b1.toString(16).padStart(2, '0')}`;
  }

  const baseEndOk = hasValidEndAddr(baseProg);
  const currEndOk = hasValidEndAddr(currProg);
  const headerWarnings: string[] = [];

  if (!baseEndOk && !currEndOk) {
    headerWarnings.push(`End address invalid in both (baseline: ${endAddrDetail(baseProg)}, current: ${endAddrDetail(currProg)})`);
  } else if (!baseEndOk) {
    headerWarnings.push(`End address invalid in baseline: ${endAddrDetail(baseProg)}`);
    globalSeverity.improved++;
  } else if (!currEndOk) {
    headerWarnings.push(`End address invalid in current: ${endAddrDetail(currProg)}`);
    globalSeverity.regression++;
  }

  // Header edit-meta diff — edit flags on the 9 header bytes and the
  // header's originalBytesDelta.  Treated as a 'changed' severity like line
  // edit-meta drift: surfaces provenance drift without escalating to a
  // regression.
  const baseHdrStats = headerEditStats(baseProg);
  const currHdrStats = headerEditStats(currProg);
  const headerEditMetaDiffers =
    baseHdrStats.explicit  !== currHdrStats.explicit  ||
    baseHdrStats.automatic !== currHdrStats.automatic ||
    baseHdrStats.deltaCount !== currHdrStats.deltaCount;
  if (headerEditMetaDiffers) globalSeverity.changed++;

  // Use the merger to do line-level alignment.
  const merged = alignPrograms([baseProg, currProg]);

  // Analyse the merge results with severity classification.
  // The merger now includes non-monotonic lines in their correct positions,
  // so we just iterate through merged.lines in order.
  let consensusCount = 0;
  interface ClassifiedLine {
    lineNum:  number;
    severity: Severity;
    kind:     'conflict' | 'baseline-only' | 'current-only';
    baseSrc?: LineSource;
    currSrc?: LineSource;
  }
  const classifiedLines: ClassifiedLine[] = [];

  for (const line of merged.lines) {
    if (line.rejected) continue;  // rejected lines are displayed but not compared
    const baseSrc = line.sources.find(s => s.tapeIdx === 0);
    const currSrc = line.sources.find(s => s.tapeIdx === 1);

    if (baseSrc && currSrc) {
      if (line.status === 'consensus') {
        // Consensus on BASIC text — but still check for edit-metadata drift
        // (edit flags, originalBytesDelta).  These don't affect the decoded
        // program's semantics but indicate provenance changes worth surfacing
        // (e.g. when validating that the tapEncoder / merger preserve edit
        // tracking faithfully).  Report as 'changed', not a regression.
        const baseStats = getLineStats(baseProg, baseSrc.lineIdx);
        const currStats = getLineStats(currProg, currSrc.lineIdx);
        if (editMetaDiffers(baseStats, currStats)) {
          classifiedLines.push({ lineNum: line.lineNum, severity: 'changed', kind: 'conflict', baseSrc, currSrc });
          globalSeverity.changed++;
        } else {
          consensusCount++;
        }
      } else {
        const severity = classifyConflict(baseProg, baseSrc.lineIdx, currProg, currSrc.lineIdx);
        classifiedLines.push({ lineNum: line.lineNum, severity, kind: 'conflict', baseSrc, currSrc });
        globalSeverity[severity]++;
      }
    } else if (baseSrc) {
      classifiedLines.push({ lineNum: line.lineNum, severity: 'regression', kind: 'baseline-only', baseSrc });
      globalSeverity.regression++;
    } else if (currSrc) {
      classifiedLines.push({ lineNum: line.lineNum, severity: 'improved', kind: 'current-only', currSrc });
      globalSeverity.improved++;
    }
  }

  if (classifiedLines.length === 0 && headerDiffs.length === 0 && headerWarnings.length === 0 && !headerEditMetaDiffers) {
    // Lines and headers all match — programs are identical.
    if (verbose) {
      if (lastOutput === 'changes') console.log('');
      console.log(`${pair.progNum} ${c.blue(pair.name)}: ${c.green(`identical program (${consensusCount} lines)`)}`);
      lastOutput = 'clean';
    }
    structuralOnlyPairs++;
    continue;
  }

  changedPairs++;

  // Build summary line with severity-coloured counts.
  const sevCounts: Partial<Record<Severity, number>> = {};
  for (const cl of classifiedLines) {
    sevCounts[cl.severity] = (sevCounts[cl.severity] ?? 0) + 1;
  }

  const simD = sevCounts['similar-degraded'] ?? 0;
  const simE = sevCounts['similar-equivalent'] ?? 0;
  const simI = sevCounts['similar-improved'] ?? 0;
  const simTotal = simD + simE + simI;

  const parts: string[] = [];
  parts.push(c.green(`${consensusCount} matching`));
  if (sevCounts['regression'])  parts.push(c.red(`${sevCounts['regression']} regression`));
  if (sevCounts['degraded'])    parts.push(c.red(`${sevCounts['degraded']} degraded`));
  if (sevCounts['changed'])     parts.push(c.yellow(`${sevCounts['changed']} changed`));
  if (simTotal > 0) {
    parts.push(c.yellow(`${simTotal} similar`) + ` (${c.red(String(simD))}+${c.yellow(String(simE))}+${c.green(String(simI))})`);
  }
  if (sevCounts['improved'])    parts.push(c.green(`${sevCounts['improved']} improved`));
  if (lastOutput !== 'none') console.log('');
  console.log(`${pair.progNum} ${c.blue(pair.name)}:`);
  console.log(`  ${parts.join(', ')}`);
  lastOutput = 'changes';

  // Show header differences (if any) before line-level details.  Mirrors the
  // per-line output style: a "Header: CHANGED" label followed by baseline
  // and current hex bytes with colouring (blue where edit status differs,
  // red where byte values differ) and a delta-bytes suffix.  Field-level
  // summaries (name, fileType, etc.) are appended below for context.
  if (headerDiffs.length > 0 || headerEditMetaDiffers) {
    const { aStr, bStr } = formatHeaderBytes(baseProg, currProg);
    const [aDelta, bDelta] = formatDeltaPair(baseProg.header.originalBytesDelta, currProg.header.originalBytesDelta);
    console.log(`  Header: ${severityLabel('changed')}`);
    console.log(`    baseline: ${aStr}${aDelta}`);
    console.log(`    current:  ${bStr}${bDelta}`);
    for (const hd of headerDiffs) {
      console.log(`    - ${hd.field}: ${hd.baseVal} → ${hd.currVal}`);
    }
  }

  // Show end-address validity warnings (kept separate — semantic warnings,
  // not byte-level diffs).
  for (const w of headerWarnings) {
    console.log(`  ${c.red(w)}`);
  }

  // Show detail for each classified line.
  const isSimilar = (s: Severity) => s === 'similar-degraded' || s === 'similar-equivalent' || s === 'similar-improved';

  for (const cl of classifiedLines) {
    // In non-verbose mode, skip SIMILAR lines entirely — the per-file summary has the counts.
    if (!verbose && isSimilar(cl.severity)) continue;

    if (cl.kind === 'conflict') {
      const baseLine = baseProg.lines[cl.baseSrc!.lineIdx];
      const currLine = currProg.lines[cl.currSrc!.lineIdx];
      const baseInfos = lineElemInfos(baseProg, cl.baseSrc!.lineIdx);
      const currInfos = lineElemInfos(currProg, cl.currSrc!.lineIdx);
      const { aHighlighted, bHighlighted } = highlightElementDiffs(
        baseLine.elements, baseInfos, currLine.elements, currInfos, cl.severity,
      );
      const [aDelta, bDelta] = formatDeltaPair(baseLine.originalBytesDelta, currLine.originalBytesDelta);
      console.log(`  Line ${cl.lineNum}: ${severityLabel(cl.severity)}`);
      console.log(`    baseline: ${aHighlighted}${aDelta}`);
      console.log(`    current:  ${bHighlighted}${bDelta}`);
    } else if (cl.kind === 'baseline-only') {
      const line = baseProg.lines[cl.baseSrc!.lineIdx];
      console.log(`  Line ${cl.lineNum}: ${severityLabel(cl.severity)} (baseline only)`);
      console.log(`    baseline: ${sanitise(line.elements.join(''))}${formatDelta(line.originalBytesDelta)}`);
    } else {
      const line = currProg.lines[cl.currSrc!.lineIdx];
      console.log(`  Line ${cl.lineNum}: ${severityLabel(cl.severity)} (current only)`);
      console.log(`    current:  ${sanitise(line.elements.join(''))}${formatDelta(line.originalBytesDelta)}`);
    }
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log('');
const totalFiles = totalPairs + newInCurrent + missingInCurrent;
const fileParts = [`${identicalPairs} identical`];
if (structuralOnlyPairs > 0) fileParts.push(`${structuralOnlyPairs} identical programs`);
if (changedPairs > 0) fileParts.push(`${changedPairs} changed`);
if (newInCurrent > 0) fileParts.push(`${newInCurrent} new`);
if (missingInCurrent > 0) fileParts.push(`${missingInCurrent} missing`);
console.log(`${totalFiles} TAP files: ${fileParts.join(', ')}`);

// Show severity summary if there are any differences (group similar subtypes).
const totalDiffs = Object.values(globalSeverity).reduce((a, b) => a + b, 0);
if (totalDiffs > 0) {
  const globalGrouped = new Map<string, number>();
  for (const [sev, count] of Object.entries(globalSeverity)) {
    if (count === 0) continue;
    const name = severityShortName(sev as Severity);
    globalGrouped.set(name, (globalGrouped.get(name) ?? 0) + count);
  }
  const sevParts: string[] = [];
  for (const [name, sev] of [['regression', 'regression'], ['degraded', 'degraded'], ['changed', 'changed'], ['similar', 'similar-equivalent'], ['improved', 'improved']] as [string, Severity][]) {
    const count = globalGrouped.get(name);
    if (count && count > 0) sevParts.push(severityColour(sev, `${count} ${name}`));
  }
  console.log(`Line differences: ${sevParts.join(', ')}`);
}

const hasRegressions = globalSeverity.regression > 0 || globalSeverity.degraded > 0;
const hasChanges     = globalSeverity.changed > 0;
console.log('');
if (hasRegressions) {
  console.log(c.red('Result: REGRESSIONS DETECTED'));
} else if (hasChanges) {
  console.log(c.yellow('Result: CHANGES DETECTED (no regressions)'));
} else if (totalDiffs > 0) {
  console.log(c.green('Result: NO REGRESSIONS (similar and/or improvements only)'));
} else if (structuralOnlyPairs > 0) {
  console.log(c.green('Result: ALL PROGRAMS IDENTICAL'));
} else {
  console.log(c.green('Result: ALL IDENTICAL'));
}

if (!verbose && totalDiffs > 0) {
  console.log(c.dim('For full details, re-run with --verbose or -v'));
}

process.exit(hasRegressions ? 1 : 0);
