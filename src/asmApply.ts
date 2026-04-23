/**
 * Glue layer: re-assemble the 6502 annotations embedded in a BASIC
 * program and patch the affected BASIC lines.  Covers two related jobs
 * driven by a single `applyAssembler` call:
 *
 *   Phase 5 — DATA/REM hosts:
 *     - Host-line eligibility per `oric-asm-syntax.md` — only `REM` and
 *       `DATA` lines contribute annotations to the assembler.
 *     - Detection is by token byte at `firstByte+4` (`TOKEN_REM` /
 *       `TOKEN_DATA`) — per spec, the keyword must appear immediately
 *       after the line number; we don't scan past leading whitespace.
 *     - All eligible annotations are threaded into one `assembleProgram`
 *       call so labels and equates are shared program-wide.
 *     - DATA lines that produce bytes (with no errors) are rewritten via
 *       `applyLineEdit`; new bytes are post-flagged `'automatic'`.
 *
 *   Phase 6 — CALL/POKE/DOKE/PEEK/DEEK back-patch hosts:
 *     - Any line containing one of these token bytes (anywhere outside
 *       strings and outside the `'` annotation) plus an annotation
 *       whose first non-whitespace token is `.` or `-:` is a back-patch
 *       host.
 *     - Each token occurrence on the line is a patch site; the directive
 *       list in the annotation pairs 1:1 with sites in source order.
 *     - `.LABEL` substitutes the resolved symbol value (hex or decimal
 *       per the original literal's format); `-` is a placeholder.
 *     - Lines are rewritten via `applyLineEdit`, bytes flagged
 *       `'automatic'`.
 *
 * Errors are attributed per line (`lineIdx` + BASIC `lineNum`) for
 * presentation in an error modal.
 *
 * Byte-format in the rewritten DATA line is uniform uppercase `#XX` hex
 * for v1 — per-byte format preservation is tracked in `todo.md`.
 * Back-patch literals follow the per-spec format-preservation rule.
 */

import type { Program } from './decoder';
import {
  TOKEN_DATA, TOKEN_REM,
  TOKEN_CALL, TOKEN_POKE, TOKEN_DOKE, TOKEN_PEEK, TOKEN_DEEK,
  TOKEN_FOR,  TOKEN_TO,  TOKEN_EQ,
  KEYWORDS,
} from './decoder';
import { applyLineEdit } from './editor';
import { assembleProgram, type Symbols, type Chunk, type Emission } from './assembler6502';

// ── Public API ─────────────────────────────────────────────────────────────

export interface AsmApplyError {
  /** 0-based index into `prog.lines`. */
  lineIdx: number;
  /** BASIC line number, for display in error UI. */
  lineNum: number;
  /** Error message from the assembler. */
  message: string;
}

export interface AsmApplyResult {
  /** Indices of lines whose bytes were rewritten by this call. */
  linesPatched: number[];
  /** One entry per assembly error, tagged with line info.  Empty on
   *  success. */
  errors: AsmApplyError[];
  /** Resolved symbol table from the assembly pass.  Exposed for the
   *  Phase 6 back-patch directive implementation. */
  symbols: Symbols;
}

/**
 * Re-assemble the inline-assembly annotations in a BASIC program and
 * patch each DATA line's values with the resulting bytes.
 *
 * `startAddr` is optional.  If omitted, the program must declare an
 * `ORG` directive before using any label as an absolute address (the
 * assembler will flag otherwise).  Equates-only and REL-branch-only
 * programs work fine without either.
 */
export function applyAssembler(
  prog:       Program,
  startAddr?: number,
): AsmApplyResult {
  // 0. Bounded-region pre-filter (Phase 6b).  Walks every annotation in
  //    program order, tracking a single active/inactive state that
  //    `[[` and `]]` markers flip.  The initial state is *inactive* if
  //    any marker appears anywhere in the program, else *active* (the
  //    fully-backward-compatible default).  The result is a per-line
  //    array of filtered annotation strings — markers stripped, inactive
  //    statements dropped — that feeds both Phase 5 and Phase 6.
  //
  //    Annotation extraction is kind-aware: REM lines only yield a
  //    non-empty annotation when the body starts with `'` (so
  //    `REM UDG's` is a plain comment, not a host); DATA/CALL-family
  //    use the first-`'` rule; other lines contribute nothing.
  // First pass: classify every line.  Lines between a type-2 open
  // and its matching close get re-classified as 'type2-body'
  // unconditionally — the user has declared the region is all
  // assembler, so any BASIC (REM/DATA/CALL/etc.) inside is an error
  // surfaced by the validation pass below (and by the assembler
  // rejecting the annotation shape).
  const hostKinds: AnnotationHostKind[] = prog.lines.map((_, i) => annotationHostKind(prog, i));
  {
    let insideType2 = false;
    for (let i = 0; i < hostKinds.length; i++) {
      const k = hostKinds[i];
      if (k === 'type2-open')       { insideType2 = true;  continue; }
      if (k === 'type2-close')      { insideType2 = false; continue; }
      if (insideType2) hostKinds[i] = 'type2-body';
    }
  }
  const rawAnnotations  = prog.lines.map((l, i) => extractAnnotation(l.v, hostKinds[i]));
  const anyMarker       = rawAnnotations.some(a => annotationContainsMarker(a));
  let   activeState     = !anyMarker;
  // Sticky settings from `[[ PARAM ...`.  Default WORDS — unchanged
  // programs that never opt in still get the new representation for
  // 2-byte operands.  `[[ BYTES` opts out.
  let   wordModeState   = true;
  const filteredAnnots: string[] = [];
  /** Per-line render mode — the wordMode prevailing at the start of
   *  this annotation's first active statement.  Used by
   *  `buildNewDataLineText` to decide byte-wise vs word-wise emission. */
  const lineWordModes:  boolean[] = [];
  /** Per-line "is this line sitting in an active region" flag.  True
   *  if active state was on at the start of the line, OR the line
   *  itself opened a region via `[[`.  Used by the strict-mode check
   *  below to distinguish "zero-emit DATA inside a user-declared
   *  assembler region" (error) from "zero-emit DATA outside any
   *  assembler region" (silently skipped). */
  const lineInActiveRegion: boolean[] = [];
  /** Per-line "did this annotation contain a `]]` close marker?"
   *  flag.  Passed to the assembler as `blockEndAfterLine` so any
   *  active named block (`ORG $xxxx .NAME`) closes at the user-
   *  declared region end, setting `NAME_END` to the last byte
   *  assembled before the `]]`. */
  const blockEndAfterLine: boolean[] = [];
  /** Regions opened by `[[ DATA <line>` that need post-assembly
   *  single-DATA output.  Captured during the filter walk: each
   *  entry pairs the line where the `[[ DATA` appeared (inclusive
   *  lower bound of the region) with the line where the matching
   *  `]]` appeared (inclusive upper bound).  If no `]]` is found the
   *  region extends to the end of the program. */
  type DataOutputRegion = {
    openLineIdx:  number;
    closeLineIdx: number;    // inclusive; last index if no explicit close
    targetLine:   number;    // BASIC line number to write DATA into
  };
  const dataOutputRegions: DataOutputRegion[] = [];
  let   activeDataRegion: { openLineIdx: number; targetLine: number } | null = null;
  /** Errors raised while parsing bounded-region params, tagged with
   *  line info at collection time below. */
  const filterErrors: AsmApplyError[] = [];
  for (let i = 0; i < rawAnnotations.length; i++) {
    const line    = prog.lines[i];
    const lineNum = prog.bytes[line.firstByte + 2].v + prog.bytes[line.firstByte + 3].v * 256;
    const beforeActive = activeState;
    const res = filterStatementsByState(rawAnnotations[i], activeState, wordModeState);
    filteredAnnots.push(res.filtered);
    lineWordModes.push(res.lineWordMode);
    // A line is "in an active region" if it started active (carrying
    // state from a prior `[[`).  Lines whose annotation itself flips
    // the active state are edge cases handled by the filter's normal
    // statement-level tracking — the strict-mode gate uses only the
    // coarse "was this line sitting inside an open region?" view.
    lineInActiveRegion.push(beforeActive);
    blockEndAfterLine.push(res.sawCloseMarker);
    activeState   = res.active;
    wordModeState = res.wordMode;
    // Track DATA-output regions.  A `[[ DATA <line>` opens one; the
    // next `]]` closes it.  The open line and close line are both
    // considered part of the region (their emissions, if any, get
    // included in the byte collection).
    if (res.openedOutput && res.openedOutput.kind === 'data') {
      activeDataRegion = { openLineIdx: i, targetLine: res.openedOutput.lineNum };
    }
    if (res.sawCloseMarker && activeDataRegion !== null) {
      dataOutputRegions.push({
        openLineIdx:  activeDataRegion.openLineIdx,
        closeLineIdx: i,
        targetLine:   activeDataRegion.targetLine,
      });
      activeDataRegion = null;
    }
    for (const msg of res.errors) filterErrors.push({ lineIdx: i, lineNum, message: msg });
  }
  // If a `[[ DATA` region was never closed, extend it to the end
  // of the program.
  if (activeDataRegion !== null) {
    dataOutputRegions.push({
      openLineIdx:  activeDataRegion.openLineIdx,
      closeLineIdx: prog.lines.length - 1,
      targetLine:   activeDataRegion.targetLine,
    });
  }

  // 1. Build the Phase-5 annotation list, gated by host-line eligibility
  //    and using the already-filtered annotation text.  Alongside it,
  //    `isDataLine[i]` tells the assembler which source lines are DATA
  //    lines (vs REM or non-host) so it can detect PC-breaks when a
  //    DATA line emits zero instruction-bytes — see the pass 1 docs.
  //    Type-2 open/close/body lines also contribute their filtered
  //    annotation text (marker statements are stripped by the filter;
  //    body statements remain as bare assembler).  For type-2 body
  //    lines, the rendered line text (`line.v`) is used — Oric BASIC
  //    tokenises substrings like `OR` in `ORG` into keyword bytes,
  //    but `buildLineElements` joins keyword text and ASCII without
  //    separators, so rendered `line.v` recovers the original
  //    assembler source exactly.  Invalid BASIC lines inside the
  //    region (e.g. a stray `REM`) fall through to the assembler's
  //    existing "unknown mnemonic" errors.
  const asmAnnotations: string[] = prog.lines.map((_line, i) => {
    const k = hostKinds[i];
    const isAsmHost = k === 'rem' || k === 'data'
                   || k === 'type2-open' || k === 'type2-close' || k === 'type2-body';
    if (!isAsmHost) return '';
    return filteredAnnots[i];
  });
  const isDataLine: boolean[] = prog.lines.map((_line, i) => hostKind(prog, i) === 'data');

  // 2. Assemble them together so symbols are shared program-wide.
  const { perLine, symbols, emissions } = assembleProgram(
    asmAnnotations, startAddr, isDataLine, blockEndAfterLine,
  );

  // 3. Precompute patches (DATA lines with clean output) and errors.
  //    We separate planning from applying so `applyLineEdit`'s byte-stream
  //    side-effects don't disturb later lookups.  Filter-stage errors
  //    (from unknown bounded-region params) are surfaced here too so the
  //    caller sees them alongside assembly errors.
  const patches: { lineIdx: number; newText: string; ownedByteIndices: number[] }[] = [];
  const errors:  AsmApplyError[] = [...filterErrors];

  // Type-2 "Missing ORG statement" check.  Walk each DATA-output
  // region (currently the only flavour of type-2 region with
  // explicit bounds); verify the first line that emitted bytes was
  // preceded by an `ORG` statement within the same region.  We can't
  // do this before assembly because byte emission is what tells us
  // "this was an instruction".
  for (const region of dataOutputRegions) {
    let sawOrg = false;
    for (let i = region.openLineIdx; i <= region.closeLineIdx; i++) {
      if (annotationHasOrg(filteredAnnots[i])) sawOrg = true;
      if (perLine[i].bytes.length > 0 && !sawOrg) {
        const line    = prog.lines[i];
        const lineNum = prog.bytes[line.firstByte + 2].v + prog.bytes[line.firstByte + 3].v * 256;
        errors.push({ lineIdx: i, lineNum, message: 'Missing ORG statement' });
        break;   // one error per region — user fixes and re-runs
      }
    }
  }

  for (let i = 0; i < prog.lines.length; i++) {
    const line    = prog.lines[i];
    const lineNum = prog.bytes[line.firstByte + 2].v + prog.bytes[line.firstByte + 3].v * 256;
    const state   = perLine[i];

    for (const e of state.errors) {
      errors.push({ lineIdx: i, lineNum, message: e.message });
    }

    // Strict mode: when the program contains any `[[` or `]]` marker,
    // the user has explicitly declared one or more assembler regions.
    // A DATA line inside an active region that emits zero assembled
    // bytes is almost certainly a mistake (forgotten annotation,
    // comment-only annotation, or stray non-code DATA inside what was
    // meant to be an all-code region) — surface it as an error so the
    // user is pushed to either annotate it with instructions, wrap it
    // in `]]`/`[[` to skip, or move any ORG-only statement onto a REM
    // line where zero-emit annotations are idiomatic.  In lenient mode
    // (no markers anywhere) the same situation just triggers a silent
    // PC-break; downstream ABS uses of later labels will error if
    // affected.
    // Target DATA lines for type-2 `[[ DATA <line>` output sinks
    // are EXPECTED to be placeholder DATA (often just `DATA 0`)
    // because their contents will be fully replaced by the
    // assembled bytes from the region.  Exclude them from the
    // strict-mode "must contain non-zero bytes" check.
    const isDataOutputTarget = dataOutputRegions.some(
      r => findLineIdxByLineNum(prog, r.targetLine) === i,
    );
    if (anyMarker &&
        isDataLine[i] &&
        state.bytes.length === 0 &&
        lineInActiveRegion[i] &&
        !isDataOutputTarget) {
      errors.push({
        lineIdx: i, lineNum,
        message: `DATA lines inside [[ regions must contain a non-zero number of assembled bytes`,
      });
    }

    const patchable =
      state.errors.length === 0 &&
      state.bytes.length  >  0  &&
      hostKind(prog, i)   === 'data';
    if (patchable) {
      const { newText, ownedByteIndices } =
        buildNewDataLineText(prog, i, state.chunks, lineWordModes[i]);
      patches.push({ lineIdx: i, newText, ownedByteIndices });
    }
  }

  // Type-2 DATA-output patches.  For each `[[ DATA <line>` region
  // that assembled cleanly, collect its bytes and rewrite the target
  // BASIC line as a single `DATA #XX,#XX,…` statement.  Error if the
  // target line doesn't exist, or if the target is inside the region
  // itself (which would overwrite the `[[` marker or region code).
  for (const region of dataOutputRegions) {
    // If any line in the region has assembly errors, skip — we
    // don't want to write partial/wrong bytes.
    let regionHasErrors = false;
    for (let i = region.openLineIdx; i <= region.closeLineIdx; i++) {
      if (perLine[i].errors.length > 0) { regionHasErrors = true; break; }
    }
    if (regionHasErrors) continue;

    // Find the target line.  Attach the error to the open line
    // (that's where the user declared the output sink).
    const targetIdx = findLineIdxByLineNum(prog, region.targetLine);
    if (targetIdx === null) {
      const openLine = prog.lines[region.openLineIdx];
      const openLineNum = prog.bytes[openLine.firstByte + 2].v
                        + prog.bytes[openLine.firstByte + 3].v * 256;
      errors.push({
        lineIdx: region.openLineIdx, lineNum: openLineNum,
        message: `[[ DATA ${region.targetLine}: BASIC line ${region.targetLine} not found`,
      });
      continue;
    }
    if (targetIdx >= region.openLineIdx && targetIdx <= region.closeLineIdx) {
      const openLine = prog.lines[region.openLineIdx];
      const openLineNum = prog.bytes[openLine.firstByte + 2].v
                        + prog.bytes[openLine.firstByte + 3].v * 256;
      errors.push({
        lineIdx: region.openLineIdx, lineNum: openLineNum,
        message: `[[ DATA ${region.targetLine}: target line is inside the [[ ... ]] region`,
      });
      continue;
    }

    const buf = buildRegionByteBuffer(emissions, region.openLineIdx, region.closeLineIdx);
    if (!buf) continue;        // nothing to emit (region had no instructions)
    const { newText, ownedByteIndices } = buildType2DataLineText(prog, targetIdx, buf.bytes);
    patches.push({ lineIdx: targetIdx, newText, ownedByteIndices });
  }

  // 4. Apply Phase 5 patches.  Line indices are stable across `applyLineEdit`
  //    calls (byte offsets shift, but lines don't get renumbered), so
  //    iteration order doesn't matter.  `markAssemblerBytesAutomatic`
  //    precisely flips only the bytes the assembler produced; any user
  //    `'explicit'` edits on other parts of the line (line number,
  //    annotation, etc.) survive unchanged.
  const linesPatched: number[] = [];
  for (const p of patches) {
    applyLineEdit(prog, p.lineIdx, p.newText);
    markAssemblerBytesAutomatic(prog, p.ownedByteIndices);
    linesPatched.push(p.lineIdx);
  }

  // 5. Phase 6: walk every line and apply back-patch directives.  Uses the
  //    filtered annotation so lines outside the active region are ignored
  //    and markers embedded in the annotation are transparent.  Type-2
  //    body / open / close lines are skipped entirely: inside a
  //    `[[ ... ]]` bare-assembler region, the whole line is assembler
  //    source, not BASIC with a back-patch annotation.  The byte-wise
  //    token scan in `countBackPatchTokens` would otherwise get fooled
  //    by BASIC keyword tokens embedded in label names (e.g. `.SFORWT`
  //    stores as [`.`][`S`][FOR-token][`W`][`T`], which would make the
  //    scanner mistake the FOR token for a patch site).
  for (let i = 0; i < prog.lines.length; i++) {
    const k = hostKinds[i];
    if (k === 'type2-open' || k === 'type2-close' || k === 'type2-body') continue;
    const res = applyBackPatchesToLine(prog, i, symbols, filteredAnnots[i]);
    errors.push(...res.errors);
    if (res.patched) linesPatched.push(i);
  }

  return { linesPatched, errors, symbols };
}

// ── Helpers ────────────────────────────────────────────────────────────────
//
// These are file-local but named and commented so tests in the same
// package can import them via a dedicated re-export block at the bottom
// of the file if we ever want tighter unit coverage.  For now the
// end-to-end tests in `asmApplyScenarios.ts` exercise them indirectly.

type HostKind = 'rem' | 'data' | 'other';

/** Classify a line by its first statement's token byte.  Per the host
 *  eligibility spec, the token must appear immediately at `firstByte+4`
 *  (no leading whitespace tolerance). */
function hostKind(prog: Program, lineIdx: number): HostKind {
  const line = prog.lines[lineIdx];
  if (line.firstByte + 4 > line.lastByte) return 'other';
  const b = prog.bytes[line.firstByte + 4].v;
  if (b === TOKEN_REM)  return 'rem';
  if (b === TOKEN_DATA) return 'data';
  return 'other';
}

/** The broader annotation-host classification used for annotation
 *  extraction and bounded-region marker scanning.  `hostKind` handles
 *  Phase 5's REM/DATA gate; for everything else, we still need to know
 *  whether a line is a CALL-family back-patch host (so its annotation
 *  can hold back-patch directives or `[[`/`]]` markers).  Lines with no
 *  annotation-host role are `'other'` and contribute nothing. */
/**
 * Line classification used for annotation extraction.
 *
 * - `rem`, `data` — traditional type-1 hosts: assembler source lives
 *   inside the `'` annotation.
 * - `callfamily` — lines carrying back-patch verbs (CALL/POKE/etc.);
 *   the annotation is the directive list, not assembler source.
 * - `type2-open`  — a line whose content begins with literal `[[` in
 *   ASCII, opening a type-2 region.  Everything up to the matching
 *   `]]` line is bare assembler (no `'` delimiter).
 * - `type2-close` — a line whose content begins with literal `]]`.
 * - `type2-body`  — any line between a type-2 open and its matching
 *   close.  The entire line body (minus the line number) is treated
 *   as the assembler annotation.
 * - `other`       — no annotation-host role; contributes nothing to
 *   the assembler input.
 */
type AnnotationHostKind =
  | 'rem' | 'data' | 'callfamily'
  | 'type2-open' | 'type2-body' | 'type2-close'
  | 'other';

/** Helper: does the line's content (skipping leading spaces) begin
 *  with the given ASCII marker string?  Used to detect `[[` and `]]`
 *  written at the start of a line (outside any REM or DATA host) —
 *  the type-2 form.  BASIC keyword tokens are high-bit bytes so they
 *  never collide with ASCII marker characters. */
function lineContentStartsWithAscii(prog: Program, lineIdx: number, marker: string): boolean {
  const line = prog.lines[lineIdx];
  let i = line.firstByte + 4;
  // Skip leading spaces.
  while (i <= line.lastByte && prog.bytes[i].v === 0x20) i++;
  for (let k = 0; k < marker.length; k++) {
    if (i + k > line.lastByte) return false;
    if (prog.bytes[i + k].v !== marker.charCodeAt(k)) return false;
  }
  return true;
}

/** Quick check: does a line contain any back-patch verb token in its
 *  BASIC code body (outside strings, stopping at the `'` annotation
 *  marker)?  Used to classify CALL-family hosts without paying the
 *  full `countBackPatchTokens` cost when we only care about presence. */
function hasAnyBackPatchToken(prog: Program, lineIdx: number): boolean {
  const line = prog.lines[lineIdx];
  let inString = false;
  for (let i = line.firstByte + 4; i <= line.lastByte; i++) {
    const b = prog.bytes[i].v;
    if (b === 0) break;
    if (inString) { if (b === 0x22) inString = false; continue; }
    if (b === 0x22) { inString = true; continue; }
    if (b === 0x27) break;
    if (isBackPatchToken(b)) return true;
  }
  return false;
}

function annotationHostKind(prog: Program, lineIdx: number): AnnotationHostKind {
  // Type-2 open/close markers are detected by ASCII prefix on the
  // line content — these sit outside the token-based REM/DATA hosts.
  // Body classification (lines *between* an open and close) requires
  // cross-line state, so it's handled in the caller's walk, not here.
  if (lineContentStartsWithAscii(prog, lineIdx, '[[')) return 'type2-open';
  if (lineContentStartsWithAscii(prog, lineIdx, ']]')) return 'type2-close';
  const hk = hostKind(prog, lineIdx);
  if (hk === 'rem' || hk === 'data') return hk;
  if (hasAnyBackPatchToken(prog, lineIdx)) return 'callfamily';
  return 'other';
}

/** Extract the annotation text from a line's rendered `v` string, with
 *  a rule that depends on the line's host kind:
 *
 *   - **REM** — strict: the body directly after the `REM` keyword must
 *     start with `'` (allowing whitespace between).  REM lines whose
 *     body begins with anything else (including ordinary comments like
 *     `REM UDG's` that happen to contain apostrophes) are *not*
 *     annotation hosts and produce an empty string.
 *   - **DATA** / **CALL-family** — permissive: the annotation begins at
 *     the first `'` in the rendered text.  DATA values and CALL-family
 *     BASIC arguments don't typically contain apostrophes, so the first
 *     `'` is overwhelmingly the annotation marker in practice.
 *   - **other** — no annotation; returns empty string.
 *
 *  Returns the annotation text with the opening `'` stripped, or `""`
 *  if the line is not an annotation host.
 */
function extractAnnotation(lineText: string, kind: AnnotationHostKind): string {
  if (kind === 'other') return '';

  if (kind === 'rem') {
    // buildLineElements renders TOKEN_REM as the literal text "REM", so
    // the first occurrence of "REM" in the line is the keyword.
    const remIdx = lineText.indexOf('REM');
    if (remIdx < 0) return '';
    const afterRem = lineText.slice(remIdx + 3).replace(/^\s+/, '');
    if (!afterRem.startsWith("'")) return '';
    return afterRem.slice(1);
  }

  // Type-2 open/close/body: the entire body (everything after the
  // line number + space) is the annotation — there is no `'`
  // delimiter in this form.  The filter will parse the `[[` and `]]`
  // markers as usual (including any output-sink params).
  if (kind === 'type2-open' || kind === 'type2-close' || kind === 'type2-body') {
    const spaceIdx = lineText.indexOf(' ');
    return spaceIdx < 0 ? '' : lineText.slice(spaceIdx + 1);
  }

  // DATA, CALL-family: first `'` in the line text is the annotation marker.
  const i = lineText.indexOf("'");
  return i < 0 ? '' : lineText.slice(i + 1);
}

/** Format a chunk list as BASIC DATA values.  Each chunk is either a
 *  single byte (opcode, IMM/ZP operand, REL offset) or a 2-byte operand
 *  that can render either as a single word (WORDS mode) or as two
 *  separate bytes (BYTES mode).
 *
 *  Byte rendering honours the chunk's paired `format` (hex → `#XX`,
 *  decimal → `NN`) with `minDigits` setting a minimum width (zero-
 *  padded) — so `LDY #00` round-trips through DATA as `00`, not `0`.
 *  Word rendering (WORDS mode, 2-byte chunk) uses the chunk's first
 *  format entry; minDigits default is 4 for hex and 1 for decimal.
 *  The minimum is never *truncating*; oversized values just print
 *  their natural width. */
function formatDataValues(chunks: Chunk[], wordMode: boolean): string {
  const parts: string[] = [];
  for (const ch of chunks) {
    if (ch.bytes.length === 2 && wordMode) {
      const value = ch.bytes[0] | (ch.bytes[1] << 8);
      const fmt   = ch.formats[0]   ?? 'hex';
      const min   = Math.max(ch.minDigits[0] ?? 0, fmt === 'hex' ? 4 : 1);
      if (fmt === 'hex') parts.push('#' + value.toString(16).toUpperCase().padStart(min, '0'));
      else               parts.push(value.toString(10).padStart(min, '0'));
      continue;
    }
    // Byte-wise: render each byte in the chunk separately.
    for (let i = 0; i < ch.bytes.length; i++) {
      const b   = ch.bytes[i];
      const fmt = ch.formats[i]   ?? 'hex';
      const min = ch.minDigits[i] ?? (fmt === 'hex' ? 2 : 1);
      if (fmt === 'hex') parts.push('#' + b.toString(16).toUpperCase().padStart(min, '0'));
      else               parts.push(b.toString(10).padStart(min, '0'));
    }
  }
  return parts.join(',');
}

/** Build replacement text for a DATA line whose values will be
 *  overwritten with the bytes described by `chunks`, preserving any
 *  existing annotation (from the first `'` to end-of-line) exactly.
 *  `wordMode` picks whether 2-byte operand chunks render as one word
 *  or as two bytes — driven by the per-line mode state tracked by
 *  `filterStatementsByState` (see `[[ WORDS` / `[[ BYTES` directives).
 *
 *  Also returns `ownedByteIndices` — the absolute indices in
 *  `prog.bytes` where the new DATA values will land after
 *  `applyLineEdit` re-tokenises the text.  Used for precise attribution
 *  of the new bytes as `edited: 'automatic'` without touching user
 *  edits elsewhere on the line.
 *
 *  Index math: after parseLine, the line-number text becomes 2 bytes
 *  in the header slot (not content) and the content begins at
 *  `firstByte + 4`.  Our rebuild puts `"DATA "` at content bytes 0–1
 *  (TOKEN_DATA + space) and the values at content bytes 2 onward, each
 *  value character tokenising to one ASCII byte in the DATA literal
 *  section. */
function buildNewDataLineText(
  prog:      Program,
  lineIdx:   number,
  chunks:    Chunk[],
  wordMode:  boolean,
): { newText: string; ownedByteIndices: number[] } {
  const line    = prog.lines[lineIdx];
  const lineNum = prog.bytes[line.firstByte + 2].v + prog.bytes[line.firstByte + 3].v * 256;

  const v     = line.v;
  const apost = v.indexOf("'");
  const annot = apost >= 0 ? v.slice(apost) : '';   // includes the ' itself
  const sep   = annot ? ' ' : '';

  const values = formatDataValues(chunks, wordMode);
  const newText = `${lineNum} DATA ${values}${sep}${annot}`;

  const valuesStartByte = line.firstByte + 4 + 2;  // content starts at +4; values at content offset 2
  const ownedByteIndices: number[] = [];
  for (let k = 0; k < values.length; k++) ownedByteIndices.push(valuesStartByte + k);

  return { newText, ownedByteIndices };
}

/** Locate a BASIC line by its user-visible line number.  Returns the
 *  program-line index, or null if no line in the program carries
 *  that number.  Used by type-2 DATA output to find the target line
 *  the user named in `[[ DATA <line>`.  O(n) in program length;
 *  fine for the handful of DATA-sink regions a typical program has. */
function findLineIdxByLineNum(prog: Program, targetLineNum: number): number | null {
  for (let i = 0; i < prog.lines.length; i++) {
    const line = prog.lines[i];
    const lNum = prog.bytes[line.firstByte + 2].v + prog.bytes[line.firstByte + 3].v * 256;
    if (lNum === targetLineNum) return i;
  }
  return null;
}

/** Collect the bytes of a type-2 DATA-output region into a single
 *  contiguous buffer, indexed by PC.  Pulls every emission whose
 *  `lineIdx` falls inside the region's open/close range, computes
 *  the min and max PCs covered, and zero-fills any gaps between
 *  emissions (e.g. when the user uses multiple `ORG`s for alignment
 *  without filling the space with NOPs).  Returns null when the
 *  region produced no emissions at all — callers treat that as "no
 *  output to write". */
function buildRegionByteBuffer(
  emissions:    Emission[],
  openLineIdx:  number,
  closeLineIdx: number,
): { bytes: number[]; startPc: number } | null {
  let startPc        = Infinity;
  let endPcInclusive = -Infinity;
  let any            = false;
  for (const e of emissions) {
    if (e.lineIdx < openLineIdx || e.lineIdx > closeLineIdx) continue;
    any = true;
    if (e.pc < startPc) startPc = e.pc;
    const last = e.pc + e.bytes.length - 1;
    if (last > endPcInclusive) endPcInclusive = last;
  }
  if (!any) return null;
  const size = endPcInclusive - startPc + 1;
  const buffer = new Array<number>(size).fill(0);
  for (const e of emissions) {
    if (e.lineIdx < openLineIdx || e.lineIdx > closeLineIdx) continue;
    for (let k = 0; k < e.bytes.length; k++) {
      buffer[e.pc - startPc + k] = e.bytes[k];
    }
  }
  return { bytes: buffer, startPc };
}

/** Build replacement text for a target DATA line that receives a
 *  type-2 region's assembled bytes in a single flat DATA statement.
 *  Format is forced to byte-per-value hex (`#XX,#XX,…`) regardless
 *  of the region's WORDS/BYTES setting — type-2 DATA is a large
 *  opaque blob loaded by a POKE loop; WORDS chunking would break
 *  the one-POKE-per-value contract the BASIC loop relies on.
 *
 *  Any pre-existing annotation on the target line (`'` and
 *  everything after) is preserved verbatim so the user's hand
 *  comments survive.  Returns `ownedByteIndices` identifying which
 *  `prog.bytes` positions the assembler produced, for precise
 *  `'automatic'` tagging later. */
function buildType2DataLineText(
  prog:     Program,
  lineIdx:  number,
  bytes:    number[],
): { newText: string; ownedByteIndices: number[] } {
  const line    = prog.lines[lineIdx];
  const lineNum = prog.bytes[line.firstByte + 2].v + prog.bytes[line.firstByte + 3].v * 256;

  const v     = line.v;
  const apost = v.indexOf("'");
  const annot = apost >= 0 ? v.slice(apost) : '';
  const sep   = annot ? ' ' : '';

  const values = bytes
    .map(b => '#' + b.toString(16).toUpperCase().padStart(2, '0'))
    .join(',');
  const newText = `${lineNum} DATA ${values}${sep}${annot}`;

  const valuesStartByte = line.firstByte + 4 + 2;  // content +2 past "DATA "
  const ownedByteIndices: number[] = [];
  for (let k = 0; k < values.length; k++) ownedByteIndices.push(valuesStartByte + k);

  return { newText, ownedByteIndices };
}

/** Downgrade `edited: 'explicit'` to `'automatic'` for exactly the
 *  `prog.bytes` indices the assembler produced on this re-assembly run.
 *  The index list comes from `buildNewDataLineText` /
 *  `rewriteLineForBackPatch`, both of which track which of their
 *  emitted bytes came from the assembler's output (as opposed to
 *  being copied verbatim from the input line).  Byte positions
 *  elsewhere on the line — line number, keyword, annotation, commas,
 *  unpatched placeholder literals, etc. — are untouched, preserving
 *  any user `'explicit'` edits they carry. */
function markAssemblerBytesAutomatic(prog: Program, indices: number[]): void {
  for (const idx of indices) {
    const bi = prog.bytes[idx];
    if (bi !== undefined && bi.edited === 'explicit') bi.edited = 'automatic';
  }
}

// ── Phase 6: back-patch directives ──────────────────────────────────────────

type BackPatchDirective =
  | { kind: 'label'; name: string }
  | { kind: 'skip' };

/** True when `b` is one of the back-patch verb token bytes.  A
 *  `FOR` / `TO` pair on one line contributes two patch sites (start
 *  address, end address); each token is counted separately. */
function isBackPatchToken(b: number): boolean {
  return b === TOKEN_CALL || b === TOKEN_POKE || b === TOKEN_DOKE
      || b === TOKEN_PEEK || b === TOKEN_DEEK
      || b === TOKEN_FOR  || b === TOKEN_TO;
}

/** Test whether an annotation's prefix marks it as back-patch directives —
 *  i.e. first non-whitespace token is `.` (label) or `-:` (placeholder
 *  followed by colon).  Whitespace between `-` and `:` is permitted. */
function isBackPatchAnnotation(annotation: string): boolean {
  const t = annotation.trimStart();
  if (t.startsWith('.')) return true;
  if (t.startsWith('-')) {
    const after = t.slice(1).trimStart();
    if (after.startsWith(':')) return true;
  }
  return false;
}

/** Strip a trailing `*` comment from a back-patch annotation.  Mirrors
 *  the assembler's `stripComment` — the back-patch directive syntax
 *  doesn't use `'c` literals, so tracking char-literal context is
 *  unnecessary here, but we keep the logic aligned for consistency. */
function stripBackPatchComment(s: string): string {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '*') return s.slice(0, i);
  }
  return s;
}

/** Parse a back-patch annotation into a list of directives.  Slots may
 *  be separated by `:` or `;` (both accepted interchangeably — see the
 *  assembler's `splitStatements`).  Empty slots are tolerated and
 *  skipped; each non-empty slot must be either `-` or `.IDENT`.  Returns
 *  the directive list, or an `{error}` describing the first invalid
 *  slot. */
function parseBackPatchDirectives(
  annotation: string,
): { directives: BackPatchDirective[] } | { error: string } {
  const stripped = stripBackPatchComment(annotation);
  const parts = stripped.split(/[:;]/);
  const directives: BackPatchDirective[] = [];
  for (const raw of parts) {
    const t = raw.trim();
    if (t === '') continue;
    if (t === '-') { directives.push({ kind: 'skip' }); continue; }
    const m = t.match(/^\.([A-Za-z][A-Za-z0-9_]*)$/);
    if (m) { directives.push({ kind: 'label', name: m[1] }); continue; }
    return { error: `invalid back-patch directive: ${t}` };
  }
  return { directives };
}

/** Count back-patch verb tokens on a line, respecting string-literal
 *  context and stopping at the first `'` annotation marker. */
function countBackPatchTokens(prog: Program, lineIdx: number): number {
  const line = prog.lines[lineIdx];
  let count = 0;
  let inString = false;
  for (let i = line.firstByte + 4; i <= line.lastByte; i++) {
    const b = prog.bytes[i].v;
    if (b === 0) break;              // line terminator
    if (inString) { if (b === 0x22) inString = false; continue; }
    if (b === 0x22) { inString = true; continue; }
    if (b === 0x27) break;            // annotation starts — stop scanning
    if (isBackPatchToken(b)) count++;
  }
  return count;
}

/** Render a single byte as its text form — printable ASCII as itself,
 *  keyword bytes as their `KEYWORDS[]` entry, anything else as `«0xXX»`
 *  (which `parseLine` will flag on re-tokenisation, though back-patch
 *  lines typically don't contain error bytes). */
function renderByte(b: number): string {
  if (b >= 0x20 && b <= 0x7E) return String.fromCharCode(b);
  if (b >= 0x80 && (b - 0x80) < KEYWORDS.length) return KEYWORDS[b - 0x80];
  return `«0x${b.toString(16).toUpperCase().padStart(2, '0')}»`;
}

/** Format a resolved symbol value as a back-patch literal, matching the
 *  original literal's format.  Hex → `#XXXX` uppercase 4 digits; decimal
 *  → base-10 no leading zeros. */
function formatBackPatchValue(value: number, originalLiteral: string): string {
  const isHex = originalLiteral.startsWith('#');
  if (isHex) return '#' + (value & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
  return (value & 0xFFFF).toString(10);
}

/** Reconstruct the line's BASIC text with back-patch substitutions
 *  applied at each patch site.  Called after the directive count has
 *  been verified to match the patch-site count — we don't defend
 *  against mismatch here.
 *
 *  Returns the new line text, any per-site errors (undefined symbol,
 *  non-literal argument), and `ownedByteIndices` — the absolute
 *  `prog.bytes` indices of just the bytes the assembler generated
 *  (substituted-literal bytes).  Used for precise `'automatic'`
 *  attribution that leaves user edits elsewhere on the line untouched.
 *
 *  Index math: content bytes begin at `firstByte + 4`.  We advance a
 *  `contentByteOffset` counter by 1 per output byte as we emit — one
 *  emit-unit tokenises to one byte (a keyword text like `"CALL"` →
 *  `TOKEN_CALL`, a single ASCII char → itself, etc.).  Substituted
 *  literals are runs of pure ASCII (`#`, hex/dec digits), so each char
 *  is its own output byte. */
function rewriteLineForBackPatch(
  prog:       Program,
  lineIdx:    number,
  directives: BackPatchDirective[],
  symbols:    Symbols,
): { newText: string; errors: string[]; ownedByteIndices: number[] } {
  const line    = prog.lines[lineIdx];
  const lineNum = prog.bytes[line.firstByte + 2].v + prog.bytes[line.firstByte + 3].v * 256;
  const errors: string[] = [];
  const ownedByteIndices: number[] = [];

  let out               = `${lineNum} `;
  let inString          = false;
  let inAnnotation      = false;
  let siteIdx           = 0;
  let i                 = line.firstByte + 4;
  let contentByteOffset = 0;                       // relative to firstByte + 4

  // Emit exactly one content byte's worth of text (keyword, ASCII, hex
  // escape — anything that tokenises back to one byte).
  const emitByte = (s: string): void => {
    out += s;
    contentByteOffset++;
  };
  // Emit an ASCII run where each char is its own content byte,
  // optionally flagging those bytes as assembler-owned.
  const emitAsciiRun = (s: string, owned: boolean): void => {
    for (let k = 0; k < s.length; k++) {
      if (owned) ownedByteIndices.push(line.firstByte + 4 + contentByteOffset);
      contentByteOffset++;
    }
    out += s;
  };

  while (i <= line.lastByte) {
    const b = prog.bytes[i].v;
    if (b === 0) break;

    // Once the annotation starts, everything else is passthrough — we
    // don't want to "patch" occurrences of verb tokens that the BASIC
    // tokeniser may have stamped inside the annotation's text.
    if (!inAnnotation && !inString && b === 0x27) inAnnotation = true;
    if (inAnnotation) { emitByte(renderByte(b)); i++; continue; }

    // String-literal tracking.
    if (inString) {
      emitByte(renderByte(b));
      if (b === 0x22) inString = false;
      i++;
      continue;
    }
    if (b === 0x22) { emitByte('"'); inString = true; i++; continue; }

    // Patch-site verb token.
    if (isBackPatchToken(b)) {
      const verbToken = b;
      emitByte(KEYWORDS[b - 0x80]);
      i++;

      // For `FOR var=<literal>` we need to pass through the variable
      // name and `=` sign before we reach the literal.  Walk chars
      // up to and including the first `=` (emitting each as-is).
      // Oric BASIC tokenises `=` into `TOKEN_EQ`, so we break on
      // that; a raw `0x3D` is also accepted in case some source form
      // ever leaves it untokenised.  Bail out early on annotation
      // markers or end-of-content to stay safe on malformed input.
      if (verbToken === TOKEN_FOR) {
        while (i <= line.lastByte) {
          const bj = prog.bytes[i].v;
          if (bj === 0) break;
          if (bj === 0x27) break;                        // annotation marker
          emitByte(renderByte(bj));
          i++;
          if (bj === 0x3D || bj === TOKEN_EQ) break;     // `=` (raw or tokenised)
        }
      }

      // Emit any whitespace and an optional opening paren before the literal.
      while (i <= line.lastByte) {
        const bj = prog.bytes[i].v;
        if (bj === 0) break;
        if (bj === 0x20 || bj === 0x28) { emitByte(String.fromCharCode(bj)); i++; continue; }
        break;
      }

      // Collect the literal's raw ASCII text, if present.  A literal is
      // `#` followed by hex chars, or a run of decimal digits.
      let literal = '';
      while (i <= line.lastByte) {
        const bk = prog.bytes[i].v;
        if (bk === 0) break;
        const cont =
          (bk === 0x23 && literal.length === 0)           // leading #
          || (bk >= 0x30 && bk <= 0x39)                   // 0-9
          || (bk >= 0x41 && bk <= 0x46)                   // A-F
          || (bk >= 0x61 && bk <= 0x66);                  // a-f
        if (!cont) break;
        literal += String.fromCharCode(bk);
        i++;
      }

      // Apply the paired directive.
      const directive = directives[siteIdx];
      siteIdx++;

      if (!directive || directive.kind === 'skip') {
        emitAsciiRun(literal, false);    // echoing original literal; not owned
        continue;
      }

      // directive.kind === 'label'.
      if (literal === '' || literal === '#') {
        errors.push(
          `back-patch at '${KEYWORDS[b - 0x80]}' has no numeric literal argument`,
        );
        emitAsciiRun(literal, false);    // emit original on error; not owned
        continue;
      }
      const sym = symbols.get(directive.name);
      if (!sym) {
        errors.push(`undefined symbol in back-patch: ${directive.name}`);
        emitAsciiRun(literal, false);
        continue;
      }
      // Back-patch substitution writes an absolute 16-bit address into
      // BASIC code, so it has the same "must be anchored" requirement
      // as an assembler ABS reference: a label declared while PC was
      // unanchored (no ORG in effect, or a zero-emit DATA line broke
      // PC between the last ORG and the label) has a value that isn't
      // tied to real memory, so patching it in would silently write
      // garbage.  Equates skip this check because their values come
      // from a literal and are PC-independent.
      if (sym.isLabel && sym.anchored === false) {
        errors.push(
          `back-patch label ${directive.name} is missing ORG declaration for target assembler block`,
        );
        emitAsciiRun(literal, false);
        continue;
      }
      emitAsciiRun(formatBackPatchValue(sym.value, literal), true);
      continue;
    }

    // Default: render and advance.
    emitByte(renderByte(b));
    i++;
  }

  return { newText: out, errors, ownedByteIndices };
}

/** Orchestrate back-patching for one line: eligibility check, directive
 *  parsing, count check, rewrite, apply.  Takes the pre-filtered
 *  annotation text (bounded-region markers stripped, inactive statements
 *  already removed) so out-of-region lines never reach the directive
 *  parser.  Returns whether the line was patched and any errors to
 *  surface. */
function applyBackPatchesToLine(
  prog:       Program,
  lineIdx:    number,
  symbols:    Symbols,
  annotation: string,
): { patched: boolean; errors: AsmApplyError[] } {
  const line    = prog.lines[lineIdx];
  const lineNum = prog.bytes[line.firstByte + 2].v + prog.bytes[line.firstByte + 3].v * 256;

  // Gate: annotation must carry a back-patch-shaped prefix (`.` or `-:`)
  // after filtering, and the line must contain at least one back-patch
  // token in its BASIC statements.
  if (!isBackPatchAnnotation(annotation)) return { patched: false, errors: [] };
  const siteCount = countBackPatchTokens(prog, lineIdx);
  if (siteCount === 0) return { patched: false, errors: [] };

  // Parse the directive list.
  const parsed = parseBackPatchDirectives(annotation);
  if ('error' in parsed) {
    return { patched: false, errors: [{ lineIdx, lineNum, message: parsed.error }] };
  }

  // Enforce 1:1 pairing with patch sites.
  if (parsed.directives.length !== siteCount) {
    return {
      patched: false,
      errors: [{
        lineIdx, lineNum,
        message:
          `back-patch directive count ${parsed.directives.length} ` +
          `doesn't match ${siteCount} patch site${siteCount === 1 ? '' : 's'} on the line`,
      }],
    };
  }

  // Rewrite the line.
  const { newText, errors: siteErrors, ownedByteIndices } =
    rewriteLineForBackPatch(prog, lineIdx, parsed.directives, symbols);
  const wrapped: AsmApplyError[] = siteErrors.map(m => ({ lineIdx, lineNum, message: m }));
  if (wrapped.length > 0) return { patched: false, errors: wrapped };

  applyLineEdit(prog, lineIdx, newText);
  markAssemblerBytesAutomatic(prog, ownedByteIndices);
  return { patched: true, errors: [] };
}

// ── Phase 6b: bounded-region pre-filter ─────────────────────────────────────

/** Classify a trimmed statement as an open/close bounded-region marker,
 *  a plain (non-marker) statement, or an error.  `[[` optionally takes
 *  whitespace-separated parameter tokens controlling mode (see
 *  {@link parseMarkerParams}).  `]]` takes no parameters.  Case-
 *  insensitive for the marker itself and for any params.
 *
 *  Why dedicated parsing:  `[[` acts like a sticky settings directive
 *  (the settings it installs persist past the matching `]]`), so we
 *  need to distinguish structural markers from noise statements before
 *  the assembler sees them, while also surfacing typos like
 *  `[[ WROD` as errors rather than silently ignoring. */
type ParsedMarker =
  | { kind: 'open';  params: MarkerParams }
  | { kind: 'close' }
  | { kind: 'plain' }
  | { kind: 'error'; message: string };

/** Output-sink spec attached to a `[[` marker.  `kind: 'data'` routes
 *  the region's assembled bytes into a single BASIC DATA statement on
 *  an existing line (`lineNum`); intended for type-2 style sources
 *  where assembler lives bare between `[[` and `]]` and the program's
 *  POKE loop reads back the bytes.  Future: `kind: 'tap'` for TAP
 *  output.  `undefined` means "no output sink declared" — type-1
 *  per-line DATA behaviour applies. */
type OutputSink =
  | { kind: 'data'; lineNum: number };

interface MarkerParams {
  /** undefined → preserve the prevailing mode. */
  wordMode: boolean | undefined;
  /** undefined → no output sink declared on this `[[`. */
  output?:  OutputSink;
}

/** Parse a `[[`-open statement's parameter list.  Params are
 *  whitespace-separated tokens after the `[[` marker, case-insensitive
 *  where the user's preferences admit it (mnemonic/ORG-style).  Order
 *  within the list doesn't matter.  Currently recognised:
 *
 *    - `WORDS` / `BYTES` — per-line DATA render mode (sticky setting).
 *    - `DATA <line>`     — type-2 output sink: emit the region's
 *      bytes into a single DATA statement on the given BASIC line
 *      number.  The `<line>` token must immediately follow `DATA`.
 *
 *  Unknown tokens (or `DATA` without a numeric operand) are errors.
 *  No params → `{wordMode: undefined}` (preserve prevailing). */
function parseMarkerParams(rest: string): { params: MarkerParams } | { error: string } {
  const toks = rest.trim().split(/\s+/).filter(t => t.length > 0);
  let wordMode: boolean | undefined = undefined;
  let output:   OutputSink | undefined = undefined;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const u = t.toUpperCase();
    if (u === 'WORDS')      { wordMode = true;  continue; }
    if (u === 'BYTES')      { wordMode = false; continue; }
    if (u === 'DATA') {
      // Consume the next token as the target line number.
      const arg = toks[i + 1];
      if (arg === undefined || !/^\d+$/.test(arg)) {
        return { error: `DATA requires a BASIC line number: [[ DATA <line>` };
      }
      const lineNum = parseInt(arg, 10);
      if (lineNum < 0 || lineNum > 0xFFFF) {
        return { error: `DATA target line number out of range: ${arg}` };
      }
      output = { kind: 'data', lineNum };
      i++;                 // skip the consumed argument
      continue;
    }
    return { error: `unknown bounded-region parameter: ${t}` };
  }
  return { params: { wordMode, output } };
}

function classifyStatement(raw: string): ParsedMarker {
  const t = raw.trim();
  if (t === ']]') return { kind: 'close' };
  // `]]` takes no params.  Anything after the `]]` (on the same
  // statement) makes this not a close marker — fall through to `plain`
  // so the assembler parses it and surfaces an error if it's garbage.
  if (t.startsWith('[[')) {
    // `[[`, `[[ WORDS`, `[[WORDS`, `[[  WORDS BYTES` — all parse as
    // open markers with optional whitespace-separated params.  Any
    // unrecognised param name surfaces as an error (not silently
    // swallowed) so typos are caught.
    const parsed = parseMarkerParams(t.slice(2));
    if ('error' in parsed) return { kind: 'error', message: parsed.error };
    return { kind: 'open', params: parsed.params };
  }
  return { kind: 'plain' };
}

/** Helper: does a filtered annotation contain at least one `ORG`
 *  statement?  Used by the type-2 validation pass to flag regions
 *  that emit bytes without having declared an origin.  Statement-
 *  aware (so `ORG` inside a string literal or after `*` comment
 *  won't false-match) — reuses `splitAnnotationStatements` and
 *  matches case-insensitively on the leading token of each
 *  statement. */
function annotationHasOrg(annotation: string): boolean {
  for (const raw of splitAnnotationStatements(annotation)) {
    if (/^\s*[Oo][Rr][Gg]\b/.test(raw)) return true;
  }
  return false;
}

/** Split an annotation into raw statement texts, `'c`-literal aware,
 *  stopping at the first `*` end-of-annotation comment.  Shared between
 *  {@link annotationContainsMarker} and {@link filterStatementsByState}. */
function splitAnnotationStatements(annotation: string): string[] {
  const out: string[] = [];
  let start = 0;
  let end   = annotation.length;
  for (let i = 0; i < annotation.length; i++) {
    if (annotation[i] === "'") { i++; continue; }
    if (annotation[i] === '*') { end = i; break; }
    if (annotation[i] === ':' || annotation[i] === ';') {
      out.push(annotation.slice(start, i));
      start = i + 1;
    }
  }
  out.push(annotation.slice(start, end));
  return out;
}

/** Check whether an annotation contains a bounded-region marker (`[[`
 *  with or without params, or `]]`) as a top-level statement.  Used to
 *  decide the initial active state for the program walk — if any
 *  marker exists anywhere, the program starts inactive; otherwise
 *  fully-backward-compatible active.  Invalid `[[ PARAM` uses count as
 *  markers here (so the program still starts inactive); the actual
 *  parse error surfaces during the walk. */
function annotationContainsMarker(annotation: string): boolean {
  for (const raw of splitAnnotationStatements(annotation)) {
    const c = classifyStatement(raw);
    if (c.kind === 'open' || c.kind === 'close' || c.kind === 'error') return true;
  }
  return false;
}

/** Walk an annotation's statements (separated by `:` or `;`) and filter
 *  by the bounded-region state.  Tracks two pieces of state:
 *
 *   - **active**: `[[` activates, `]]` deactivates.  Inactive and marker
 *     statements are dropped; active non-marker statements are kept.
 *   - **wordMode**: sticky — `[[ WORDS` / `[[ BYTES` set it; bare `[[`
 *     or `]]` leave it alone.  Persists across annotations and past
 *     `]]` closes.  Used by the DATA-line renderer, not by the
 *     assembler's byte emission.
 *
 *  Returns the filtered annotation (markers stripped, may be empty),
 *  the post-walk active and wordMode states for the next annotation,
 *  any param-parse errors, and the wordMode **at the start of the
 *  annotation** (for rendering bytes produced by this annotation's
 *  statements).  Trailing `*` comments are dropped along the way. */
function filterStatementsByState(
  annotation:       string,
  initialActive:    boolean,
  initialWordMode:  boolean,
): {
  filtered:        string;
  active:          boolean;
  wordMode:        boolean;
  lineWordMode:    boolean;
  sawCloseMarker:  boolean;
  openedOutput:    OutputSink | undefined;
  errors:          string[];
} {
  const statements = splitAnnotationStatements(annotation);

  let active   = initialActive;
  let wordMode = initialWordMode;
  // The per-line render mode is the prevailing wordMode at the point
  // the first active non-marker statement begins.  If the annotation
  // has no such statement the value doesn't matter — use the incoming
  // mode as the obvious default.
  let lineWordMode         = initialWordMode;
  let lineWordModeCaptured = false;
  // `sawCloseMarker` lets the caller know a `]]` appeared on this
  // line.  asmApply uses it to close any active named assembler block
  // (the user has explicitly said "this region ends here"), even
  // though `]]` itself emits no bytes and is stripped before the
  // assembler sees the annotation.
  let sawCloseMarker = false;
  // Output sink declared on this line's `[[` marker, if any.  Scoped
  // per-marker (not sticky across lines) so the caller can identify
  // the specific region opened by this `[[`.  If multiple `[[` on
  // the same line declare sinks, the last one wins (caller can warn
  // if desired).
  let openedOutput: OutputSink | undefined = undefined;

  const kept: string[] = [];
  const errors: string[] = [];
  for (const raw of statements) {
    const c = classifyStatement(raw);
    if (c.kind === 'open') {
      active = true;
      if (c.params.wordMode !== undefined) wordMode = c.params.wordMode;
      if (c.params.output   !== undefined) openedOutput = c.params.output;
      continue;
    }
    if (c.kind === 'close') { active = false; sawCloseMarker = true; continue; }
    if (c.kind === 'error') { errors.push(c.message); continue; }
    // plain statement
    if (active) {
      if (!lineWordModeCaptured) {
        lineWordMode = wordMode;
        lineWordModeCaptured = true;
      }
      kept.push(raw);
    }
  }

  return {
    filtered: kept.join(':'),
    active, wordMode, lineWordMode, sawCloseMarker, openedOutput, errors,
  };
}
