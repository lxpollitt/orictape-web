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

/**
 * Quality of the merged output line — independent of structural status.
 *
 *  clean      — all sources agree and every source is byte-perfect
 *  issue      — merged output is uncertain: either sources disagree (with no
 *               clear winner), all copies are corrupt, or they agree on data
 *               that contains errors / unclear bytes
 *  recovered  — a conflict existed but a clean source beat a corrupt one;
 *               the chosen output is byte-perfect
 *  unverified — only one tape (or a subset) has this line; cannot cross-check
 */
export type LineQuality = 'clean' | 'issue' | 'recovered' | 'unverified';

export interface AlignedLine {
  lineNum:     number;
  status:      LineStatus;
  quality:     LineQuality;
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
  // Summary counts for badges / status bar (based on LineQuality)
  total:      number;
  clean:      number;   // all sources agree and all are byte-perfect
  issues:     number;   // uncertain output — needs human attention
  recovered:  number;   // conflicts resolved by preferring a clean source
  unverified: number;   // single-source or partial lines
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

  // Step 1 — per-tape partition into monotonic and non-monotonic lines.
  const extracted = programs.map((prog, tapeIdx) =>
    prog ? extractLines(prog, tapeIdx) : { monotonic: [], nonMonotonic: [] },
  );

  // Step 2 — union monotonic lines into lineNum → LineSource[].
  const lineMap = new Map<number, LineSource[]>();
  for (const { monotonic } of extracted) {
    for (const { lineNum, lineIdx, tapeIdx } of monotonic) {
      if (!lineMap.has(lineNum)) lineMap.set(lineNum, []);
      lineMap.get(lineNum)!.push({ tapeIdx, lineIdx });
    }
  }

  // Step 3 — sort, classify, and assess quality for monotonic lines.
  const sortedNums = [...lineMap.keys()].sort((a, b) => a - b);
  const lines: AlignedLine[] = sortedNums.map(lineNum => {
    const sources = lineMap.get(lineNum)!;
    const status  = classifyLine(sources, programs, tapeCount);
    return {
      lineNum,
      status,
      quality:     computeLineQuality(status, sources, programs),
      sources,
      mergedBytes: null,
    };
  });

  // Step 4 — insert non-monotonic lines at their correct positions.
  // Non-monotonic lines can't be matched by line number (it's corrupt), so we
  // match them by position: the (preceding, following) monotonic line number pair.
  // Lines from different tapes that share the same slot are grouped as one
  // AlignedLine with multiple sources, just like normal line-number matches.

  // 4a: For each tape, annotate non-monotonic lines with their slot key.
  interface SlottedNM {
    tapeIdx: number;
    lineIdx: number;
    lineNum: number;
    key:     string;   // "preceding:following" monotonic line numbers
    ordinal: number;   // position within this slot (for multi-NM slots)
  }

  const allNM: SlottedNM[] = [];

  for (const { monotonic, nonMonotonic } of extracted) {
    if (nonMonotonic.length === 0) continue;

    const monoByIdx = new Map(monotonic.map(m => [m.lineIdx, m.lineNum]));

    // Track ordinals per slot key within this tape.
    const slotOrdinals = new Map<string, number>();

    for (const nm of nonMonotonic) {
      // Find preceding monotonic line number.
      let preceding = -1;
      for (let li = nm.lineIdx - 1; li >= 0; li--) {
        if (monoByIdx.has(li)) { preceding = monoByIdx.get(li)!; break; }
      }
      // Find following monotonic line number.
      let following = -1;
      for (let li = nm.lineIdx + 1; li < (programs[nm.tapeIdx]?.lines.length ?? 0); li++) {
        if (monoByIdx.has(li)) { following = monoByIdx.get(li)!; break; }
      }

      const key = `${preceding}:${following}`;
      const ordinal = slotOrdinals.get(key) ?? 0;
      slotOrdinals.set(key, ordinal + 1);
      allNM.push({ tapeIdx: nm.tapeIdx, lineIdx: nm.lineIdx, lineNum: nm.lineNum, key, ordinal });
    }
  }

  // 4b: Group by (key, ordinal) to pair lines from different tapes.
  const nmGroups = new Map<string, SlottedNM[]>();
  for (const nm of allNM) {
    const groupKey = `${nm.key}#${nm.ordinal}`;
    if (!nmGroups.has(groupKey)) nmGroups.set(groupKey, []);
    nmGroups.get(groupKey)!.push(nm);
  }

  // 4c: Build AlignedLine entries and insert at the correct positions.
  // Sort groups by preceding line number so we insert in order.
  const sortedGroups = [...nmGroups.values()].sort((a, b) => {
    const aPrec = parseInt(a[0].key.split(':')[0], 10);
    const bPrec = parseInt(b[0].key.split(':')[0], 10);
    if (aPrec !== bPrec) return aPrec - bPrec;
    return a[0].ordinal - b[0].ordinal;
  });

  for (const group of sortedGroups) {
    const sources: LineSource[] = group.map(nm => ({ tapeIdx: nm.tapeIdx, lineIdx: nm.lineIdx }));
    const lineNum = group[0].lineNum;  // use first tape's (corrupt) line number
    const status  = classifyLine(sources, programs, tapeCount);

    const entry: AlignedLine = {
      lineNum,
      status,
      quality:     'issue',  // non-monotonic line numbers are always an issue
      sources,
      mergedBytes: null,
    };

    // Insert after the preceding monotonic line in the merged output.
    const precedingLineNum = parseInt(group[0].key.split(':')[0], 10);
    if (precedingLineNum < 0) {
      lines.splice(0, 0, entry);
    } else {
      // Find the last line in the output with this line number (in case
      // previous NM insertions shifted things).
      let insertIdx = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].lineNum === precedingLineNum) { insertIdx = i; break; }
      }
      // Insert after the preceding line, plus any previously inserted NM lines.
      if (insertIdx >= 0) {
        // Skip past any already-inserted entries after the preceding line.
        while (insertIdx + 1 < lines.length && lines[insertIdx + 1].quality === 'issue') {
          insertIdx++;
        }
        lines.splice(insertIdx + 1, 0, entry);
      } else {
        lines.push(entry);
      }
    }
  }

  const clean      = lines.filter(l => l.quality === 'clean').length;
  const issues     = lines.filter(l => l.quality === 'issue').length;
  const recovered  = lines.filter(l => l.quality === 'recovered').length;
  const unverified = lines.filter(l => l.quality === 'unverified').length;

  return { tapeCount, lines, total: lines.length, clean, issues, recovered, unverified };
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

/**
 * Returns true only if every byte in the line is free of checksum errors,
 * unclear bits, and length mismatches.  Both errors AND warnings count as
 * not-clean so that "agree on corrupt data" is correctly flagged as an issue.
 */
export function isLineClean(prog: Program, lineIdx: number): boolean {
  const line = prog.lines[lineIdx];
  if (line.lenErr) return false;
  for (let i = line.firstByte; i <= line.lastByte; i++) {
    const b = prog.bytes[i];
    if (b?.chkErr || b?.unclear) return false;
  }
  return true;
}

/**
 * Derive a LineQuality value from the structural status and the byte-level
 * health of each source.
 *
 * consensus + all clean      → clean
 * consensus + any not-clean  → issue  (agreed-on errors may still be wrong)
 * conflict  + all clean      → issue  (genuinely ambiguous; 50/50 chance wrong)
 * conflict  + all corrupt    → issue  (best of bad options)
 * conflict  + mixed          → recovered  (clean source chosen over corrupt)
 * partial / single           → unverified
 */
function computeLineQuality(
  status:   LineStatus,
  sources:  LineSource[],
  programs: ReadonlyArray<Program | undefined>,
): LineQuality {
  if (status === 'single' || status === 'partial') {
    const allClean = sources.every(s => {
      const prog = programs[s.tapeIdx];
      return prog ? isLineClean(prog, s.lineIdx) : false;
    });
    if (!allClean) return 'issue';
    // With only one tape loaded there is nothing to recover from — genuinely unverified.
    // With multiple tapes the line was absent from some recordings (dropout/corruption)
    // and has been salvaged from the tapes that do have it — treat as recovered.
    const presentTapes = programs.filter(p => p !== undefined).length;
    return presentTapes > 1 ? 'recovered' : 'unverified';
  }

  const cleanCount = sources.filter(s => {
    const prog = programs[s.tapeIdx];
    return prog ? isLineClean(prog, s.lineIdx) : false;
  }).length;

  if (status === 'consensus') {
    if (cleanCount === sources.length) return 'clean';     // all agree, all byte-perfect
    if (cleanCount > 0)               return 'recovered';  // clean copy confirms agreed content
    return 'issue';                                        // all copies corrupt, no confirmation
  }

  // conflict
  if (cleanCount === 0 || cleanCount === sources.length) return 'issue';
  return 'recovered'; // some clean, some corrupt — merger can pick the clean one
}

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
interface ExtractResult {
  monotonic:    FilteredLine[];  // lines in the LIS (reliable line numbers)
  nonMonotonic: FilteredLine[];  // lines excluded from the LIS (corrupt line numbers)
}

/**
 * Partition a program's lines into monotonic (in the Longest Increasing
 * Subsequence of line numbers) and non-monotonic (excluded from the LIS).
 *
 * Uses O(n log n) patience sort with parent-pointer reconstruction.
 */
function extractLines(prog: Program, tapeIdx: number): ExtractResult {
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
  if (candidates.length === 0) return { monotonic: [], nonMonotonic: [] };

  const n        = candidates.length;
  const parent   = new Int32Array(n).fill(-1);
  const tailNums: number[] = [];
  const tailPos:  number[] = [];

  for (let i = 0; i < n; i++) {
    const v = candidates[i].lineNum;
    let lo = 0, hi = tailNums.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tailNums[mid] < v) lo = mid + 1; else hi = mid;
    }
    tailNums[lo] = v;
    tailPos[lo]  = i;
    parent[i]    = lo > 0 ? tailPos[lo - 1] : -1;
  }

  // Reconstruct LIS indices.
  const inLIS = new Uint8Array(n);
  const lisLen = tailNums.length;
  let idx = tailPos[lisLen - 1];
  while (idx >= 0) {
    inLIS[idx] = 1;
    idx = parent[idx];
  }

  const monotonic:    FilteredLine[] = [];
  const nonMonotonic: FilteredLine[] = [];
  for (let i = 0; i < n; i++) {
    (inLIS[i] ? monotonic : nonMonotonic).push(candidates[i]);
  }
  return { monotonic, nonMonotonic };
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
