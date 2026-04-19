import type { Program, ByteInfo, LineInfo } from './decoder';
import { lineHasHardError, lineHealth, lineFirstAddr, lineNextAddr, emptyBitStream, invalidateLineHealth } from './decoder';
import { getFullOriginalBytes, getHeaderOriginalBytes, storeOriginalBytesDelta, storeHeaderOriginalBytesDelta, flagAll } from './editor';

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
  /** When true, this line is displayed but excluded from the merged output.
   *  Used for non-monotonic lines that are superseded by another tape's clean
   *  monotonic coverage of the same region. */
  rejected?:   boolean;
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
  /** Deep-copied snapshot of the source programs taken at merge creation time.
   *  Indexed by slot position — matches LineSource.tapeIdx.  Snapshots are
   *  independent of the original Programs: edits or closures applied to the
   *  originals after merge creation do not affect the snapshot.  BitStream is
   *  shared by reference (large, never mutated).  Undefined slots are preserved
   *  for 1:1 indexing, but in practice are never dereferenced because no lines
   *  reference an absent source. */
  sources:    (Program | undefined)[];
  lines:      AlignedLine[];
  /** Byte-level merged output — a synthesized Program whose bytes are the
   *  concatenation of the best source's bytes for each non-rejected aligned
   *  line, with next-line pointers and header end-address rewritten to match
   *  the merged address space.
   *
   *  Derived once at merge creation from `sources` and `lines`.  Used by
   *  tapEncoder for serialization, and available as a uniform Program view
   *  for anything else that wants to consume the merged result.
   *
   *  Per-byte/per-line edit state from sources is preserved: edit flags and
   *  originalBytesDelta ride along (with originalIndex rewritten into the
   *  merged output's original-byte sequence).  Pointer / endAddr rewrites
   *  use the standard editor paradigm — byte values that already match are
   *  left alone; values that need to change get `edited: 'automatic'` and
   *  displaced originals flow into delta. */
  output:     Program;
  // Summary counts for badges / status bar (based on LineQuality)
  total:        number;
  clean:        number;   // all sources agree and all are byte-perfect
  issues:       number;   // uncertain output — needs human attention
  issuesError:  number;   // subset of issues with hard errors (chkErr, lenErr, etc.)
  issuesUnclear:number;   // subset of issues with only unclear bytes (no hard errors)
  recovered:    number;   // conflicts resolved by preferring a clean source
  unverified:   number;   // single-source or partial lines
}

// ── Source snapshot ──────────────────────────────────────────────────────────

/**
 * Deep-copy a Program for storage on MergedProgram.sources.  All mutable state
 * (bytes, lines, header, and nested originalBytesDelta) is cloned so edits to
 * the original Program do not affect the merged snapshot.  The BitStream is
 * shared by reference — it is large (waveform data) and never mutated after
 * initial decode, so sharing is safe and saves significant memory.
 */
function cloneProgramForSnapshot(prog: Program): Program {
  const { stream, ...rest } = prog;
  const cloned = structuredClone(rest);
  return { ...cloned, stream };
}

// ── Primary algorithm: line-level alignment ───────────────────────────────────

/**
 * Align multiple tape recordings of the same BASIC program at the line level.
 *
 * `programs` is indexed by tapeIdx; entries may be undefined if a given tape
 * does not contain a program at this ordinal position. This preserves the
 * tapeIdx ↔ array-index correspondence throughout the codebase.
 *
 * A deep-copied snapshot of the input programs is stored on the returned
 * MergedProgram.sources, so later edits or closures of the original Programs
 * do not affect this merge.  All references to sources from the merge result
 * (LineSource.tapeIdx) index into merged.sources, not into the original array.
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
  programsIn: ReadonlyArray<Program | undefined>,
): MergedProgram {
  const tapeCount = programsIn.length;

  // Snapshot the source programs up-front so all downstream logic reads from
  // the merge's own copy.  The snapshot is write-once — never updated after
  // creation — making the merge a self-contained artifact.
  const programs: (Program | undefined)[] = programsIn.map(p =>
    p ? cloneProgramForSnapshot(p) : undefined,
  );

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

  // 4c: Build per-tape monotonic line number sets for coverage checks.
  const monoLineNums: Set<number>[] = extracted.map(({ monotonic }) =>
    new Set(monotonic.map(m => m.lineNum)),
  );

  // 4d: Build AlignedLine entries and insert at the correct positions.
  // Skip groups where another tape's monotonic lines cover the slot — i.e. the
  // other tape has both the preceding and following line numbers in its monotonic
  // sequence, confirming it has authoritative data for the entire region.
  const sortedGroups = [...nmGroups.values()].sort((a, b) => {
    const aPrec = parseInt(a[0].key.split(':')[0], 10);
    const bPrec = parseInt(b[0].key.split(':')[0], 10);
    if (aPrec !== bPrec) return aPrec - bPrec;
    return a[0].ordinal - b[0].ordinal;
  });

  for (const group of sortedGroups) {
    const key = group[0].key;
    const preceding = parseInt(key.split(':')[0], 10);
    const following = parseInt(key.split(':')[1], 10);

    // Check if any tape that does NOT contribute to this group covers the slot.
    const contributingTapes = new Set(group.map(nm => nm.tapeIdx));
    const coveredByOther = monoLineNums.some((lineNums, tapeIdx) => {
      if (contributingTapes.has(tapeIdx) || programs[tapeIdx] === undefined) return false;
      const hasB1 = preceding === -1 || lineNums.has(preceding);
      const hasB2 = following === -1 || lineNums.has(following);
      return hasB1 && hasB2;
    });
    const sources: LineSource[] = group.map(nm => ({ tapeIdx: nm.tapeIdx, lineIdx: nm.lineIdx }));
    const lineNum = group[0].lineNum;  // use first tape's (corrupt) line number
    const status  = classifyLine(sources, programs, tapeCount);

    const entry: AlignedLine = {
      lineNum,
      status,
      quality:     'issue',  // non-monotonic line numbers are always an issue
      sources,
      mergedBytes: null,
      rejected:    coveredByOther || undefined,
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

  const active     = lines.filter(l => !l.rejected);
  const clean      = active.filter(l => l.quality === 'clean').length;
  const issueLines = active.filter(l => l.quality === 'issue');
  const issues     = issueLines.length;
  const recovered  = active.filter(l => l.quality === 'recovered').length;
  const unverified = active.filter(l => l.quality === 'unverified').length;

  // Classify issue lines: hard errors vs unclear-only.
  let issuesError = 0;
  for (const line of issueLines) {
    const src  = pickBestSource(line, programs);
    const prog = programs[src.tapeIdx];
    if (prog && lineHasHardError(prog, src.lineIdx)) issuesError++;
  }
  const issuesUnclear = issues - issuesError;

  // Synthesize the byte-level output Program from the aligned lines + source
  // snapshots.  Done as a final step after all per-line decisions are made.
  const output = buildMergedOutput(programs, lines);

  return { tapeCount, sources: programs, lines, output, total: active.length, clean, issues, issuesError, issuesUnclear, recovered, unverified };
}

/**
 * Choose the best available source for a line — the one most likely to have
 * the correct byte content. Used by the UI to pick a default rendering.
 * Reads from merged.sources, the merge's own snapshot.
 *
 * Priority: no lenErr > fewer unclear bytes > earlier tape index.
 */
export function bestSource(
  merged: MergedProgram,
  line:   AlignedLine,
): LineSource {
  return pickBestSource(line, merged.sources);
}

/**
 * Internal helper that takes the sources array directly, so alignPrograms can
 * use it before the MergedProgram result object is constructed.
 */
function pickBestSource(
  line:    AlignedLine,
  sources: ReadonlyArray<Program | undefined>,
): LineSource {
  return line.sources.reduce((best, candidate) => {
    const bProg = sources[best.tapeIdx];
    const cProg = sources[candidate.tapeIdx];
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
  _merged: MergedProgram,
  _line:   AlignedLine,
): MergedByte[] | null {
  return null;
}

// ── Byte-stream output synthesis ──────────────────────────────────────────────

/**
 * Clone a ByteInfo, optionally offsetting its originalIndex.  Used when
 * copying bytes from a source program into the merged output — non-edit
 * bytes' originalIndex values must be re-anchored into the merged output's
 * original-byte sequence.  Edit bytes keep originalIndex=undefined.
 */
function cloneByteWithOffset(b: ByteInfo, offset: number): ByteInfo {
  const c: ByteInfo = { ...b };
  if (c.originalIndex !== undefined) c.originalIndex += offset;
  return c;
}

/**
 * Build the byte-level merged output Program for a MergedProgram.
 *
 * Per-line algorithm (matching the two-phase "copy verbatim, then apply edit
 * via standard editor paradigm" approach):
 *
 *   1. Copy source line verbatim: bytes + originalBytesDelta, with
 *      originalIndex rewritten into the merged output's sequential
 *      original-byte space.
 *   2. If the source line's next-line pointer value (which came along in the
 *      verbatim copy) disagrees with the value the merged address space
 *      requires, apply a targeted edit to the two pointer bytes — using the
 *      same pattern as editor.ts fixLinePointers: match-against-original
 *      first (so a coincidental match keeps the original ByteInfo), then
 *      edited='automatic' otherwise, and storeOriginalBytesDelta to record
 *      any displaced original.
 *
 * Sync bytes, header bytes (including originalBytesDelta), name bytes and
 * the end-of-program marker get analogous treatment:
 *   - Sync / name / end-marker: copied verbatim (sync+name from header
 *     source; end-marker freshly synthesized with sequential originalIndex).
 *   - Header endAddr bytes: copied verbatim first, then if the merged
 *     endAddr differs from source's, apply the edit via
 *     storeHeaderOriginalBytesDelta.
 *
 * Result: merged.output is a self-consistent Program.  A merge of two
 * identical clean sources produces output bytes bit-for-bit identical to
 * either source (no spurious 'automatic' flags).  Divergent content produces
 * automatic-edit flags only where byte values genuinely had to change.
 *
 * The output's progNumber is left at 0 — merges don't participate in the
 * progNumber identity scheme (they are labelled by their sources' numbers).
 */
function buildMergedOutput(
  sources: ReadonlyArray<Program | undefined>,
  lines:   ReadonlyArray<AlignedLine>,
): Program {
  // Pick a header source.  For MVP: first non-undefined source.  This suffices
  // because all sources in a merge are takes of the same program, so their
  // header metadata (startAddr, fileType, name) should agree.  Differences in
  // endAddr are fixed up below.
  const headerSource = sources.find(p => p !== undefined);

  const out: Program = {
    stream:     emptyBitStream(),
    bytes:      [],
    lines:      [],
    name:       headerSource?.name ?? '',
    progNumber: 0,
    header: {
      byteIndex: 0,
      fileType:  headerSource?.header.fileType ?? 0,
      startAddr: headerSource?.header.startAddr ?? 0x0501,
      endAddr:   0,                                             // patched below
      autorun:   headerSource?.header.autorun ?? false,
    },
  };

  if (!headerSource || headerSource.lines.length === 0) {
    return out;  // empty merge — nothing to synthesize
  }

  // ── Copy sync + header + name section from the header source ────────────
  // Source layout: [0..byteIndex-1] sync, [byteIndex..byteIndex+8] header,
  // [byteIndex+9..firstLineByte-1] name + null terminator.
  //
  // Sync and name bytes are assumed unedited (standard for any decoded
  // program that hasn't been bulk-edited in those regions); we copy them
  // with offset=0 so their originalIndex values carry through unchanged.
  //
  // Header bytes may be edited (e.g. fixPointersAndTerminators has run on
  // source and changed endAddr) — we copy the current bytes AND clone
  // header.originalBytesDelta so the "full original" reconstruction still
  // works in the merged output.
  const srcFirstLineByte = headerSource.lines[0].firstByte;
  for (let i = 0; i < srcFirstLineByte; i++) {
    out.bytes.push(cloneByteWithOffset(headerSource.bytes[i], 0));
  }
  out.header.byteIndex = headerSource.header.byteIndex;
  if (headerSource.header.originalBytesDelta) {
    out.header.originalBytesDelta = headerSource.header.originalBytesDelta.map(
      b => cloneByteWithOffset(b, 0),
    );
  }

  // nextOriginalIdx tracks the position in the merged output's original-byte
  // sequence — advances by the full-original size (current bytes + delta) of
  // each section we add, so that line and delta bytes slot in at the right
  // positions regardless of source edit history.
  //
  // For the header section we just added, the original size equals
  // srcFirstLineByte (header delta slots are accounted for by the 9 header
  // bytes; sync and name bytes are unedited so their position == their
  // originalIndex).
  let nextOriginalIdx = srcFirstLineByte;

  // ── Per-line copy ───────────────────────────────────────────────────────
  for (const alignedLine of lines) {
    if (alignedLine.rejected) continue;
    const src = pickBestSource(alignedLine, sources);
    const sourceProg = sources[src.tapeIdx];
    if (!sourceProg) continue;
    const sourceLine = sourceProg.lines[src.lineIdx];

    // ── Phase 1: verbatim copy ────────────────────────────────────────────
    // Offset = merged_first_original - source_first_original.  Both refer to
    // the position of the first original byte of the line's full-original
    // sequence in their respective original-byte streams.
    const sourceFullOriginal = getFullOriginalBytes(sourceProg, sourceLine);
    if (sourceFullOriginal.length === 0) continue;  // all edited? should not happen
    const sourceFirstOriginalIdx = sourceFullOriginal[0].originalIndex ?? 0;
    const offset = nextOriginalIdx - sourceFirstOriginalIdx;

    const mergedLineFirstByte = out.bytes.length;

    // Copy current bytes from source line into merged output.
    for (let i = sourceLine.firstByte; i <= sourceLine.lastByte; i++) {
      out.bytes.push(cloneByteWithOffset(sourceProg.bytes[i], offset));
    }

    // Clone LineInfo carrying all per-line metadata (elements, v, syntax
    // counters, ignoreErrors, etc.); relocate firstByte/lastByte and
    // offset the delta's originalIndex values.
    const mergedLine: LineInfo = structuredClone(sourceLine);
    mergedLine.firstByte = mergedLineFirstByte;
    mergedLine.lastByte  = out.bytes.length - 1;
    if (mergedLine.originalBytesDelta) {
      mergedLine.originalBytesDelta = mergedLine.originalBytesDelta.map(
        b => cloneByteWithOffset(b, offset),
      );
    }
    // Position-dependent / cached fields will be recomputed by flagAll.
    mergedLine.lenErr       = false;
    mergedLine.earlyEnd     = undefined;
    mergedLine.nonMonotonic = undefined;
    invalidateLineHealth(mergedLine);

    out.lines.push(mergedLine);

    // ── Phase 2: apply pointer edit if required ───────────────────────────
    // Desired pointer = merged_lineFirstAddr + source_declaredSize.
    // Preserves source's lenErr character: if source was clean, desired
    // matches the actual bytes at merged_lineLast+1; if source had lenErr,
    // the mismatch carries through.
    const mergedLineIdx      = out.lines.length - 1;
    const mergedLineFirstAddr = lineFirstAddr(out, mergedLineIdx);
    const sourceDeclaredSize  = lineNextAddr(sourceProg, src.lineIdx)
                              - lineFirstAddr(sourceProg, src.lineIdx);
    const desiredPtrValue = (mergedLineFirstAddr + sourceDeclaredSize) & 0xFFFF;
    const currentPtrValue = out.bytes[mergedLine.firstByte].v
                          | (out.bytes[mergedLine.firstByte + 1].v << 8);
    if (currentPtrValue !== desiredPtrValue) {
      const desiredLo = desiredPtrValue & 0xFF;
      const desiredHi = (desiredPtrValue >> 8) & 0xFF;
      const fullOriginal = getFullOriginalBytes(out, mergedLine);
      out.bytes[mergedLine.firstByte] = fullOriginal.length > 0 && desiredLo === fullOriginal[0].v
        ? fullOriginal[0]
        : { v: desiredLo, firstBit: 0, lastBit: 0, unclear: false, chkErr: false, edited: 'automatic' };
      out.bytes[mergedLine.firstByte + 1] = fullOriginal.length > 1 && desiredHi === fullOriginal[1].v
        ? fullOriginal[1]
        : { v: desiredHi, firstBit: 0, lastBit: 0, unclear: false, chkErr: false, edited: 'automatic' };
      storeOriginalBytesDelta(out, mergedLine, fullOriginal);
    }

    // Advance original-index cursor by this line's full-original size.
    nextOriginalIdx += sourceFullOriginal.length;
  }

  // ── End-of-program marker ────────────────────────────────────────────────
  // Freshly synthesized (2 × 0x00) — no source to inherit from.  These are
  // considered "original" to the merged output, with sequential originalIndex.
  out.bytes.push({ v: 0x00, firstBit: 0, lastBit: 0, unclear: false, chkErr: false, originalIndex: nextOriginalIdx++ });
  out.bytes.push({ v: 0x00, firstBit: 0, lastBit: 0, unclear: false, chkErr: false, originalIndex: nextOriginalIdx++ });

  // ── Patch header endAddr ────────────────────────────────────────────────
  // endAddr (exclusive) = startAddr + (bytes from first line to past end marker).
  // Out.bytes.length is the position one past the second end-marker byte,
  // which is exactly where endAddr should resolve to.
  if (out.lines.length > 0) {
    const firstLineOffset = out.lines[0].firstByte;
    const newEndAddr = out.header.startAddr + (out.bytes.length - firstLineOffset);
    if (out.header.endAddr !== newEndAddr) {
      const newEndHi = (newEndAddr >> 8) & 0xFF;
      const newEndLo = newEndAddr & 0xFF;
      const hiIdx = out.header.byteIndex + 4;
      const loIdx = out.header.byteIndex + 5;
      const fullOriginal = getHeaderOriginalBytes(out);
      out.bytes[hiIdx] = fullOriginal.length > 4 && newEndHi === fullOriginal[4].v
        ? fullOriginal[4]
        : { v: newEndHi, firstBit: 0, lastBit: 0, unclear: false, chkErr: false, edited: 'automatic' };
      out.bytes[loIdx] = fullOriginal.length > 5 && newEndLo === fullOriginal[5].v
        ? fullOriginal[5]
        : { v: newEndLo, firstBit: 0, lastBit: 0, unclear: false, chkErr: false, edited: 'automatic' };
      storeHeaderOriginalBytesDelta(out, fullOriginal);
      out.header.endAddr = newEndAddr;
    }
  }

  flagAll(out);
  return out;
}

// ── Private helpers ───────────────────────────────────────────────────────────



/**
 * Returns true only if the line is completely clean (no errors, no unclear bytes).
 * Delegates to lineHealth from decoder.ts.
 */
export function isLineClean(prog: Program, lineIdx: number): boolean {
  return lineHealth(prog, lineIdx) === 'clean';
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
