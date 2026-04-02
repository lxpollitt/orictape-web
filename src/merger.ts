import type { Program } from './decoder';

// ── Source references ─────────────────────────────────────────────────────────
// We store indices rather than copies of data. All raw data lives in
// Program/BitStream. These types are thin reference wrappers.

export interface LineSource {
  tapeIdx: number;   // index into the programs[] array passed to alignPrograms
  lineIdx: number;   // index into Program.lines[]
}

export interface ByteSource {
  tapeIdx: number;
  byteIdx: number;   // index into Program.bytes[]
}

// ── Line-level merge types ────────────────────────────────────────────────────

export type LineStatus =
  | 'consensus'   // all tapes agree on content
  | 'conflict'    // all tapes have this line number but content differs
  | 'partial'     // some (but not all) tapes have this line
  | 'single';     // exactly one tape has this line

export interface AlignedLine {
  lineNum:     number;
  status:      LineStatus;
  sources:     LineSource[];
  /** Populated lazily by mergeLineBytes() (Phase 2 — currently always null). */
  mergedBytes: MergedByte[] | null;
}

// ── Byte-level merge types (data structure ready; algorithm is future) ────────

export type ByteStatus = 'consensus' | 'conflict' | 'single' | 'unclear';

export interface MergedByte {
  offset:    number;          // byte offset from the line's firstByte
  status:    ByteStatus;
  sources:   ByteSource[];
  consensus: number | null;   // agreed value, or null if unresolved conflict
}

// ── Merged program ────────────────────────────────────────────────────────────

export interface MergedProgram {
  /** Total number of tape slots (some may be undefined/absent). */
  tapeCount:  number;
  lines:      AlignedLine[];
  // Summary counts for badges / status bar
  total:      number;
  consensus:  number;
  conflicts:  number;
  partial:    number;
  singles:    number;
}

// ── Primary algorithm: line-level alignment ───────────────────────────────────

/**
 * Align multiple tape recordings of the same BASIC program at the line level.
 *
 * `programs` is indexed by tapeIdx; entries may be undefined if a given tape
 * does not contain a program at this ordinal position. This preserves the
 * tapeIdx ↔ array-index correspondence throughout the codebase.
 *
 * Steps:
 *   1. Extract monotonically-increasing line-number sequences per tape,
 *      discarding non-monotonic entries (corrupt pointer/line-number bytes).
 *   2. Union all filtered line numbers into a map keyed by line number.
 *   3. Sort, classify, and return the AlignedLine array.
 *
 * Complexity: O(L log L) where L = total decoded lines across all tapes.
 */
export function alignPrograms(
  programs: ReadonlyArray<Program | undefined>,
): MergedProgram {
  const tapeCount = programs.length;

  // Step 1 — per-tape filtered sequences.
  const filtered = programs.map((prog, tapeIdx) =>
    prog ? extractMonotonicLines(prog, tapeIdx) : [],
  );

  // Step 2 — union into lineNum → LineSource[].
  const lineMap = new Map<number, LineSource[]>();
  for (const tapeLines of filtered) {
    for (const { lineNum, lineIdx, tapeIdx } of tapeLines) {
      if (!lineMap.has(lineNum)) lineMap.set(lineNum, []);
      lineMap.get(lineNum)!.push({ tapeIdx, lineIdx });
    }
  }

  // Step 3 — sort and classify.
  const sortedNums = [...lineMap.keys()].sort((a, b) => a - b);
  const lines: AlignedLine[] = sortedNums.map(lineNum => {
    const sources = lineMap.get(lineNum)!;
    return {
      lineNum,
      status:      classifyLine(sources, programs, tapeCount),
      sources,
      mergedBytes: null,
    };
  });

  const consensus = lines.filter(l => l.status === 'consensus').length;
  const conflicts = lines.filter(l => l.status === 'conflict').length;
  const partial   = lines.filter(l => l.status === 'partial').length;
  const singles   = lines.filter(l => l.status === 'single').length;

  return { tapeCount, lines, total: lines.length, consensus, conflicts, partial, singles };
}

/**
 * Choose the best available source for a line — the one most likely to have
 * the correct byte content. Used by the UI to pick a default rendering.
 *
 * Priority: no lenErr > fewer unclear bytes > earlier tape index.
 */
export function bestSource(
  line:     AlignedLine,
  programs: ReadonlyArray<Program | undefined>,
): LineSource {
  return line.sources.reduce((best, candidate) => {
    const bProg = programs[best.tapeIdx];
    const cProg = programs[candidate.tapeIdx];
    if (!cProg) return best;
    if (!bProg) return candidate;
    const bLine = bProg.lines[best.lineIdx];
    const cLine = cProg.lines[candidate.lineIdx];
    if (!cLine.lenErr && bLine.lenErr)  return candidate;
    if (cLine.lenErr  && !bLine.lenErr) return best;
    const bUnclear = countUnclear(bLine.firstByte, bLine.lastByte, bProg);
    const cUnclear = countUnclear(cLine.firstByte, cLine.lastByte, cProg);
    return cUnclear < bUnclear ? candidate : best;
  });
}

/**
 * Stub for Phase 2: byte-level comparison within an aligned line.
 * Returns null until implemented.
 */
export function mergeLineBytes(
  _line:     AlignedLine,
  _programs: ReadonlyArray<Program | undefined>,
): MergedByte[] | null {
  return null;
}

// ── Private helpers ───────────────────────────────────────────────────────────

interface FilteredLine {
  tapeIdx: number;
  lineIdx: number;
  lineNum: number;
}

/**
 * Return lines from a program in the Longest Increasing Subsequence of their
 * line numbers, using O(n log n) patience sort with parent-pointer reconstruction.
 *
 * A greedy prefix scan (keep if > previous) is wrong when a single corrupt
 * line number (e.g. 50608 in the middle of a 1130…1210 sequence) would
 * otherwise block every subsequent valid line from being included.
 *
 * Patience sort places each line number on the leftmost pile whose current
 * tail is ≥ the value; extending a new pile when none qualifies. Replacing a
 * tail never changes the parent pointer of elements already placed — so the
 * reconstruction walk is always valid.
 *
 * Example: {1130, 1131, 50608, 1210}
 *   pile 0: [1130]           parent[0] = -1
 *   pile 1: [1131]           parent[1] = 0   (tail of pile 0 = 1130)
 *   pile 2: [50608]          parent[2] = 1
 *   1210 replaces 50608 in pile 2 → tails=[1130,1131,1210], parent[3] = 1
 *   Reconstruct: 1210→1131→1130  ✓  (50608 excluded)
 */
function extractMonotonicLines(prog: Program, tapeIdx: number): FilteredLine[] {
  // Collect candidates with valid parsed line numbers.
  const candidates: FilteredLine[] = [];
  for (let lineIdx = 0; lineIdx < prog.lines.length; lineIdx++) {
    const line    = prog.lines[lineIdx];
    // elements[0] is the BASIC line number string, e.g. "100 "
    const lineNum = parseInt(line.elements[0] ?? '', 10);
    if (!isNaN(lineNum) && lineNum >= 0 && lineNum <= 65535) {
      candidates.push({ tapeIdx, lineIdx, lineNum });
    }
  }
  if (candidates.length === 0) return [];

  const n        = candidates.length;
  const parent   = new Int32Array(n).fill(-1);
  const tailNums: number[] = [];   // tailNums[i] = smallest tail ending an IS of length i+1
  const tailPos:  number[] = [];   // tailPos[i]  = candidates[] index of that tail

  for (let i = 0; i < n; i++) {
    const v = candidates[i].lineNum;
    // Binary search: first pile whose tail >= v (strict increase).
    let lo = 0, hi = tailNums.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tailNums[mid] < v) lo = mid + 1; else hi = mid;
    }
    tailNums[lo] = v;
    tailPos[lo]  = i;
    parent[i]    = lo > 0 ? tailPos[lo - 1] : -1;
  }

  // Reconstruct LIS from the tail of the longest pile.
  const lisLen = tailNums.length;
  const result = new Array<FilteredLine>(lisLen);
  let   idx    = tailPos[lisLen - 1];
  for (let pos = lisLen - 1; pos >= 0; pos--) {
    result[pos] = candidates[idx];
    idx         = parent[idx];
  }
  return result;
}

/**
 * Classify a line's agreement status across all tapes.
 * Content comparison uses the joined element strings (human-readable BASIC
 * text), deliberately ignoring the raw pointer bytes which can legitimately
 * differ across load addresses.
 */
function classifyLine(
  sources:   LineSource[],
  programs:  ReadonlyArray<Program | undefined>,
  _tapeCount: number,
): LineStatus {
  // Count how many tapes actually have a program here.
  const presentTapes = programs.filter(p => p !== undefined).length;

  if (sources.length === 1)                    return 'single';
  if (sources.length < presentTapes)           return 'partial';

  // All present tapes have this line — check whether content matches.
  const first = joinElements(programs[sources[0].tapeIdx]!, sources[0].lineIdx);
  const allMatch = sources.every(s =>
    joinElements(programs[s.tapeIdx]!, s.lineIdx) === first,
  );
  return allMatch ? 'consensus' : 'conflict';
}

function joinElements(prog: Program, lineIdx: number): string {
  return prog.lines[lineIdx].elements.join('');
}

function countUnclear(firstByte: number, lastByte: number, prog: Program): number {
  let n = 0;
  for (let i = firstByte; i <= lastByte; i++) {
    if (prog.bytes[i]?.unclear) n++;
  }
  return n;
}
