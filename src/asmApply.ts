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
import { assembleProgram, type Symbols } from './assembler6502';

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
  const rawAnnotations  = prog.lines.map(l => extractAnnotation(l.v));
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
  const patches: { lineIdx: number; newText: string }[] = [];
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
      patches.push({ lineIdx: i, newText: buildNewDataLineText(prog, i, state.bytes) });
    }
  }

  // 4. Apply Phase 5 patches.  Line indices are stable across `applyLineEdit`
  //    calls (byte offsets shift, but lines don't get renumbered), so
  //    iteration order doesn't matter.
  const linesPatched: number[] = [];
  for (const p of patches) {
    applyLineEdit(prog, p.lineIdx, p.newText);
    markLineEditsAutomatic(prog, p.lineIdx);
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

/** Everything after the first `'` in a line's rendered text.  Empty
 *  string if the line has no annotation.  Note: doesn't track BASIC
 *  string-literal context — fine for REM/DATA lines, which don't
 *  typically contain `"..."`. */
function extractAnnotation(lineText: string): string {
  const i = lineText.indexOf("'");
  return i < 0 ? '' : lineText.slice(i + 1);
}

/** Format a byte array as BASIC DATA values.  V1 uses uniform `#XX`
 *  uppercase hex; per-byte format preservation is tracked in `todo.md`. */
function formatDataValues(bytes: number[]): string {
  return bytes
    .map(b => '#' + b.toString(16).toUpperCase().padStart(2, '0'))
    .join(',');
}

/** Build replacement text for a DATA line whose values will be
 *  overwritten with `newBytes`, preserving any existing annotation
 *  chunk (from the first `'` to end-of-line) exactly. */
function buildNewDataLineText(prog: Program, lineIdx: number, newBytes: number[]): string {
  const line    = prog.lines[lineIdx];
  const lineNum = prog.bytes[line.firstByte + 2].v + prog.bytes[line.firstByte + 3].v * 256;

  const v     = line.v;
  const apost = v.indexOf("'");
  const annot = apost >= 0 ? v.slice(apost) : '';   // includes the ' itself
  const sep   = annot ? ' ' : '';

  return `${lineNum} DATA ${formatDataValues(newBytes)}${sep}${annot}`;
}

/** Downgrade any `edited: 'explicit'` marks within `lineIdx`'s byte
 *  range to `'automatic'`.  Called immediately after `applyLineEdit`
 *  so the new bytes reflect tool origin rather than user input. */
function markLineEditsAutomatic(prog: Program, lineIdx: number): void {
  const line = prog.lines[lineIdx];
  for (let i = line.firstByte; i <= line.lastByte; i++) {
    const bi = prog.bytes[i];
    if (bi.edited === 'explicit') bi.edited = 'automatic';
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
 *  against mismatch here.  Returns the new line text and any per-site
 *  errors (undefined symbol, non-literal argument). */
function rewriteLineForBackPatch(
  prog:       Program,
  lineIdx:    number,
  directives: BackPatchDirective[],
  symbols:    Symbols,
): { newText: string; errors: string[] } {
  const line    = prog.lines[lineIdx];
  const lineNum = prog.bytes[line.firstByte + 2].v + prog.bytes[line.firstByte + 3].v * 256;
  const errors: string[] = [];

  let out          = `${lineNum} `;
  let inString     = false;
  let inAnnotation = false;
  let siteIdx      = 0;
  let i            = line.firstByte + 4;

  while (i <= line.lastByte) {
    const b = prog.bytes[i].v;
    if (b === 0) break;

    // Once the annotation starts, everything else is passthrough — we
    // don't want to "patch" occurrences of verb tokens that the BASIC
    // tokeniser may have stamped inside the annotation's text.
    if (!inAnnotation && !inString && b === 0x27) inAnnotation = true;
    if (inAnnotation) { out += renderByte(b); i++; continue; }

    // String-literal tracking.
    if (inString) {
      out += renderByte(b);
      if (b === 0x22) inString = false;
      i++;
      continue;
    }
    if (b === 0x22) { out += '"'; inString = true; i++; continue; }

    // Patch-site verb token.
    if (isBackPatchToken(b)) {
      out += KEYWORDS[b - 0x80];
      i++;

      // Emit any whitespace and an optional opening paren before the literal.
      while (i <= line.lastByte) {
        const bj = prog.bytes[i].v;
        if (bj === 0) break;
        if (bj === 0x20 || bj === 0x28) { out += String.fromCharCode(bj); i++; continue; }
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
        out += literal;
        continue;
      }

      // directive.kind === 'label'.
      if (literal === '' || literal === '#') {
        errors.push(
          `back-patch at '${KEYWORDS[b - 0x80]}' has no numeric literal argument`,
        );
        out += literal;
        continue;
      }
      const sym = symbols.get(directive.name);
      if (!sym) {
        errors.push(`undefined symbol in back-patch: ${directive.name}`);
        out += literal;
        continue;
      }
      out += formatBackPatchValue(sym.value, literal);
      continue;
    }

    // Default: render and advance.
    out += renderByte(b);
    i++;
  }

  return { newText: out, errors };
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
  const { newText, errors: siteErrors } =
    rewriteLineForBackPatch(prog, lineIdx, parsed.directives, symbols);
  const wrapped: AsmApplyError[] = siteErrors.map(m => ({ lineIdx, lineNum, message: m }));
  if (wrapped.length > 0) return { patched: false, errors: wrapped };

  applyLineEdit(prog, lineIdx, newText);
  markLineEditsAutomatic(prog, lineIdx);
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
