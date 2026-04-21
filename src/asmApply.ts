/**
 * Glue layer: re-assemble the 6502 annotations embedded in a BASIC
 * program and patch the affected DATA lines.
 *
 * Scope (Phase 5):
 *   - Host-line eligibility per `oric-asm-syntax.md` — only `REM` and
 *     `DATA` lines contribute annotations to the assembler in this phase.
 *     CALL/POKE/etc. back-patch directives come in Phase 6.  Any other
 *     line kind (PRINT, LET, …) is ignored.
 *   - Detection is by token byte at `firstByte+4` (`TOKEN_REM` /
 *     `TOKEN_DATA`) — robust against ASCII-text collisions.  Per spec,
 *     the keyword must appear immediately after the line number; we
 *     don't scan past leading whitespace.
 *   - All eligible annotations are threaded into one `assembleProgram`
 *     call so labels and equates are shared program-wide.
 *   - DATA lines that produce bytes (with no errors) are rewritten via
 *     `applyLineEdit`; the new bytes are post-flagged `'automatic'` so
 *     the UI can distinguish tool-driven edits from user-typed ones.
 *   - Errors are attributed per line (`lineIdx` + BASIC `lineNum`) for
 *     presentation in an error modal.
 *
 * Byte-format in the rewritten DATA line is uniform uppercase `#XX` hex
 * for v1 — per-byte format preservation is tracked in `todo.md`.
 */

import type { Program } from './decoder';
import { TOKEN_DATA, TOKEN_REM } from './decoder';
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
  // 1. Build the annotation list, gated by host-line eligibility.
  const annotations: string[] = prog.lines.map((line, i) => {
    const kind = hostKind(prog, i);
    return (kind === 'rem' || kind === 'data') ? extractAnnotation(line.v) : '';
  });

  // 2. Assemble them together so symbols are shared program-wide.
  const { perLine, symbols } = assembleProgram(annotations, startAddr);

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

  // 4. Apply patches.  Line indices are stable across `applyLineEdit`
  //    calls (byte offsets shift, but lines don't get renumbered), so
  //    iteration order doesn't matter.
  const linesPatched: number[] = [];
  for (const p of patches) {
    applyLineEdit(prog, p.lineIdx, p.newText);
    markLineEditsAutomatic(prog, p.lineIdx);
    linesPatched.push(p.lineIdx);
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
