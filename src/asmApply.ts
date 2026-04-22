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
  KEYWORDS,
} from './decoder';
import { applyLineEdit } from './editor';
import { assembleProgram, type Symbols, type DataFormat } from './assembler6502';

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
  const hostKinds       = prog.lines.map((_, i) => annotationHostKind(prog, i));
  const rawAnnotations  = prog.lines.map((l, i) => extractAnnotation(l.v, hostKinds[i]));
  const anyMarker       = rawAnnotations.some(a => annotationContainsMarker(a));
  let   activeState     = !anyMarker;
  const filteredAnnots: string[] = [];
  for (const a of rawAnnotations) {
    const { filtered, active } = filterStatementsByState(a, activeState);
    filteredAnnots.push(filtered);
    activeState = active;
  }

  // 1. Build the Phase-5 annotation list, gated by host-line eligibility
  //    and using the already-filtered annotation text.
  const asmAnnotations: string[] = prog.lines.map((_line, i) => {
    const kind = hostKind(prog, i);
    return (kind === 'rem' || kind === 'data') ? filteredAnnots[i] : '';
  });

  // 2. Assemble them together so symbols are shared program-wide.
  const { perLine, symbols } = assembleProgram(asmAnnotations, startAddr);

  // 3. Precompute patches (DATA lines with clean output) and errors.
  //    We separate planning from applying so `applyLineEdit`'s byte-stream
  //    side-effects don't disturb later lookups.
  const patches: { lineIdx: number; newText: string; ownedByteIndices: number[] }[] = [];
  const errors:  AsmApplyError[] = [];

  for (let i = 0; i < prog.lines.length; i++) {
    const line    = prog.lines[i];
    const lineNum = prog.bytes[line.firstByte + 2].v + prog.bytes[line.firstByte + 3].v * 256;
    const state   = perLine[i];

    for (const e of state.errors) {
      errors.push({ lineIdx: i, lineNum, message: e.message });
    }

    const patchable =
      state.errors.length === 0 &&
      state.bytes.length  >  0  &&
      hostKind(prog, i)   === 'data';
    if (patchable) {
      const { newText, ownedByteIndices } =
        buildNewDataLineText(prog, i, state.bytes, state.formats, state.minDigits);
      patches.push({ lineIdx: i, newText, ownedByteIndices });
    }
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
  //    and markers embedded in the annotation are transparent.
  for (let i = 0; i < prog.lines.length; i++) {
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
type AnnotationHostKind = 'rem' | 'data' | 'callfamily' | 'other';

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

  // DATA, CALL-family: first `'` in the line text is the annotation marker.
  const i = lineText.indexOf("'");
  return i < 0 ? '' : lineText.slice(i + 1);
}

/** Format a byte array as BASIC DATA values.  Each byte is rendered per
 *  its paired `format` (hex → `#XX`, decimal → `NN`) with `minDigits`
 *  setting a minimum width (zero-padded) — so `LDY #00` round-trips
 *  through DATA as `00`, not `0`.  The minimum is never *truncating*;
 *  oversized values just print their natural width.
 *
 *  `formats` / `minDigits` must be the same length as `bytes` (pass-2
 *  always builds them that way), but we defensively fall back to
 *  format defaults if an entry is missing, so an upstream bug degrades
 *  to the old behaviour rather than producing garbage. */
function formatDataValues(
  bytes:     number[],
  formats:   DataFormat[],
  minDigits: number[],
): string {
  return bytes.map((b, i) => {
    const fmt = formats[i]   ?? 'hex';
    const min = minDigits[i] ?? (fmt === 'hex' ? 2 : 1);
    if (fmt === 'hex') return '#' + b.toString(16).toUpperCase().padStart(min, '0');
    return b.toString(10).padStart(min, '0');
  }).join(',');
}

/** Build replacement text for a DATA line whose values will be
 *  overwritten with `newBytes`, preserving any existing annotation
 *  chunk (from the first `'` to end-of-line) exactly.  The parallel
 *  `formats` / `minDigits` arrays come from pass 2 and record the
 *  hex-vs-decimal choice and min emit width per byte.
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
  newBytes:  number[],
  formats:   DataFormat[],
  minDigits: number[],
): { newText: string; ownedByteIndices: number[] } {
  const line    = prog.lines[lineIdx];
  const lineNum = prog.bytes[line.firstByte + 2].v + prog.bytes[line.firstByte + 3].v * 256;

  const v     = line.v;
  const apost = v.indexOf("'");
  const annot = apost >= 0 ? v.slice(apost) : '';   // includes the ' itself
  const sep   = annot ? ' ' : '';

  const values = formatDataValues(newBytes, formats, minDigits);
  const newText = `${lineNum} DATA ${values}${sep}${annot}`;

  const valuesStartByte = line.firstByte + 4 + 2;  // content starts at +4; values at content offset 2
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

/** True when `b` is one of the back-patch verb token bytes. */
function isBackPatchToken(b: number): boolean {
  return b === TOKEN_CALL || b === TOKEN_POKE || b === TOKEN_DOKE
      || b === TOKEN_PEEK || b === TOKEN_DEEK;
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

/** Strip a trailing `;` comment from a back-patch annotation.  Mirrors
 *  the assembler's `stripComment` — the back-patch directive syntax
 *  doesn't use `'c` literals, so tracking char-literal context is
 *  unnecessary here, but we keep the logic aligned for consistency. */
function stripBackPatchComment(s: string): string {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ';') return s.slice(0, i);
  }
  return s;
}

/** Parse a back-patch annotation into a list of directives.  Empty
 *  slots (between `:`s) are tolerated and skipped; each non-empty slot
 *  must be either `-` or `.IDENT`.  Returns the directive list, or an
 *  `{error}` describing the first invalid slot. */
function parseBackPatchDirectives(
  annotation: string,
): { directives: BackPatchDirective[] } | { error: string } {
  const stripped = stripBackPatchComment(annotation);
  const parts = stripped.split(':');
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
      emitByte(KEYWORDS[b - 0x80]);
      i++;

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

/** Check whether an annotation contains `[[` or `]]` as a top-level
 *  statement.  Walks chars directly so we correctly respect `'c` ASCII
 *  char literals (skip the next char after an unescaped `'`) and truncate
 *  at the first `;` end-of-annotation comment. */
function annotationContainsMarker(annotation: string): boolean {
  let start = 0;
  let end   = annotation.length;
  const isMarker = (part: string): boolean => {
    const t = part.trim();
    return t === '[[' || t === ']]';
  };
  for (let i = 0; i < annotation.length; i++) {
    if (annotation[i] === "'") { i++; continue; }
    if (annotation[i] === ';') { end = i; break; }
    if (annotation[i] === ':') {
      if (isMarker(annotation.slice(start, i))) return true;
      start = i + 1;
    }
  }
  return isMarker(annotation.slice(start, end));
}

/** Walk an annotation's `:`-separated statements and filter by the
 *  bounded-region active state.  `[[` sets active = true, `]]` sets
 *  active = false (both idempotent if the state is already that way).
 *  Inactive and marker statements are dropped; active non-marker
 *  statements are kept in their original textual form.  Returns the
 *  filtered annotation (markers stripped, may be empty) and the
 *  post-walk active state for the next annotation to pick up.
 *
 *  Trailing `;` comments are dropped along the way — they're informative
 *  only and the assembler strips them too. */
function filterStatementsByState(
  annotation:    string,
  initialActive: boolean,
): { filtered: string; active: boolean } {
  // Split into statements, `'c`-literal aware, stopping at `;`.
  const statements: string[] = [];
  let start = 0;
  let end   = annotation.length;
  for (let i = 0; i < annotation.length; i++) {
    if (annotation[i] === "'") { i++; continue; }
    if (annotation[i] === ';') { end = i; break; }
    if (annotation[i] === ':') {
      statements.push(annotation.slice(start, i));
      start = i + 1;
    }
  }
  statements.push(annotation.slice(start, end));

  // Walk, flip state on markers, keep the active non-marker statements.
  let active = initialActive;
  const kept: string[] = [];
  for (const raw of statements) {
    const t = raw.trim();
    if (t === '[[') { active = true;  continue; }
    if (t === ']]') { active = false; continue; }
    if (active) kept.push(raw);
  }

  return { filtered: kept.join(':'), active };
}
