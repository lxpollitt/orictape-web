#!/usr/bin/env npx tsx
/**
 * Scenario tests for `applyAssembler` — the Phase 5 glue that feeds
 * BASIC-hosted assembly annotations through the 6502 assembler and
 * patches each DATA line's values with the resulting bytes.
 *
 * Covers:
 *   - Line-level host gating: only `REM` and `DATA` lines contribute
 *     annotations to the assembler; `PRINT`, `LET`, and friends are
 *     ignored regardless of their annotation content.
 *   - Cross-line symbol sharing: equates declared on a REM line are
 *     visible to DATA-line instructions, and vice versa.
 *   - Assembly error attribution to the originating BASIC line.
 *   - DATA patching: post-call, the patched line's bytes match the
 *     assembler's output, and the new bytes are flagged `'automatic'`.
 *   - Annotation preservation across the rewrite.
 *   - REM-line annotations (declarations, no bytes) are NOT rewritten.
 *
 * Uses a minimal in-memory `Program` builder so we can construct
 * synthetic programs from BASIC text without loading a TAP.  That keeps
 * the tests fast and hermetic; deeper end-to-end coverage will arrive
 * via a TAP-based snapshot test once the UI wiring lands.
 *
 * Not part of CI — just a quick sanity check during development.
 */

import type { ByteInfo, LineInfo, Program } from '../src/decoder';
import { emptyBitStream, buildLineElements } from '../src/decoder';
import { parseLine } from '../src/editor';
import { applyAssembler } from '../src/asmApply';

// ── Runner glue ──────────────────────────────────────────────────────────────

type Test = { name: string; run: () => string | null };
const tests: Test[] = [];
function test(name: string, run: () => string | null) { tests.push({ name, run }); }

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

/** Compare two byte arrays (numbers or ByteInfo.v) and return null on
 *  match, or a descriptive mismatch string. */
function compareBytes(got: number[], want: number[], label = ''): string | null {
  if (got.length !== want.length) {
    return `${label}: length ${got.length} (want ${want.length}); got=[${got.map(hex2).join(' ')}]`;
  }
  for (let i = 0; i < got.length; i++) {
    if (got[i] !== want[i]) {
      return `${label}: byte ${i} = $${hex2(got[i])} (want $${hex2(want[i])}); got=[${got.map(hex2).join(' ')}]`;
    }
  }
  return null;
}

// ── Minimal Program builder ──────────────────────────────────────────────────
//
// Constructs a Program from a list of BASIC source lines.  Each line is
// tokenised via `parseLine`, then wrapped in the 4-byte header (next-line
// pointer + line number), terminated by 0x00, and stitched into a single
// byte stream with the standard Oric BASIC program-start address ($0501).
// The final pair of 0x00 bytes serves as the end-of-program marker.
//
// After construction each line's `LineInfo.v` / `.elements` are populated
// via `buildLineElements` so `applyAssembler`'s annotation extraction
// sees the real rendered text.

function mkByte(v: number): ByteInfo {
  return { v, firstBit: 0, lastBit: 0, unclear: false, chkErr: false };
}

function mkProgram(lineTexts: string[]): Program {
  const START_ADDR = 0x0501;
  const bytes: ByteInfo[] = [];
  const lines: LineInfo[] = [];

  let nextMemAddr = START_ADDR;

  for (const text of lineTexts) {
    const parsed = parseLine(text);
    if (!parsed) throw new Error(`mkProgram: parseLine failed on: ${text}`);
    // parsed.bytes = [lineNum_lo, lineNum_hi, ...content, 0x00]

    const lineMemLen = 2 + parsed.bytes.length;  // +2 for the pointer bytes
    const nextMemAddr2 = nextMemAddr + lineMemLen;

    const firstByte = bytes.length;

    // Pointer (little-endian) to the next line's address.
    bytes.push(mkByte(nextMemAddr2 & 0xFF));
    bytes.push(mkByte((nextMemAddr2 >> 8) & 0xFF));
    for (const v of parsed.bytes) bytes.push(mkByte(v));

    const lastByte = bytes.length - 1;
    const info: LineInfo = { v: '', elements: [], firstByte, lastByte, lenErr: false };
    buildLineElements(info, bytes);
    lines.push(info);

    nextMemAddr = nextMemAddr2;
  }

  // End-of-program marker: two null bytes.
  bytes.push(mkByte(0x00));
  bytes.push(mkByte(0x00));

  return {
    stream: emptyBitStream(),
    bytes,
    lines,
    name: 'test',
    originalSource: 'test',
    progNumber: 0,
    header: {
      byteIndex: 0,
      fileType:  0,
      autorun:   false,
      startAddr: START_ADDR,
      endAddr:   nextMemAddr,
    },
  };
}

/** Shortcut: read a line's content bytes (skipping next-line-pointer and
 *  line-number, excluding the trailing 0x00 terminator). */
function contentBytes(prog: Program, lineIdx: number): number[] {
  const line = prog.lines[lineIdx];
  const out: number[] = [];
  for (let i = line.firstByte + 4; i <= line.lastByte; i++) {
    const b = prog.bytes[i].v;
    if (b === 0) break;
    out.push(b);
  }
  return out;
}

// ── Sanity: the builder itself ───────────────────────────────────────────────

test('mkProgram: round-trips a simple one-line program', () => {
  const p = mkProgram(["10 PRINT \"HI\""]);
  if (p.lines.length !== 1) return `expected 1 line, got ${p.lines.length}`;
  if (!p.lines[0].v.startsWith('10 ')) return `unexpected v: ${p.lines[0].v}`;
  return null;
});

test('mkProgram: three-line program, line indices and line numbers', () => {
  const p = mkProgram(['10 REM hi', '20 PRINT "x"', '30 END']);
  if (p.lines.length !== 3) return `expected 3 lines, got ${p.lines.length}`;
  // Line numbers are at firstByte+2 / +3.
  const num = (i: number) =>
    p.bytes[p.lines[i].firstByte + 2].v + p.bytes[p.lines[i].firstByte + 3].v * 256;
  if (num(0) !== 10) return `line 0 num=${num(0)} (want 10)`;
  if (num(1) !== 20) return `line 1 num=${num(1)} (want 20)`;
  if (num(2) !== 30) return `line 2 num=${num(2)} (want 30)`;
  return null;
});

// ── Line-level host gating ───────────────────────────────────────────────────

test('applyAssembler ignores annotations on PRINT lines', () => {
  // PRINT with annotation that would otherwise parse as assembly — but the
  // line-level gate skips it entirely, so no errors, no patches.
  const p = mkProgram([
    '10 PRINT "HELLO" \' LDA #$BB',
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (r.linesPatched.length !== 0) return `unexpectedly patched: ${JSON.stringify(r.linesPatched)}`;
  return null;
});

test('applyAssembler ignores annotations on LET lines', () => {
  const p = mkProgram(['10 LET A=5 \' LDA #$BB']);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (r.linesPatched.length !== 0) return `unexpectedly patched: ${JSON.stringify(r.linesPatched)}`;
  return null;
});

test('applyAssembler processes REM-line annotations', () => {
  // REM line with ORG + equate — contributes to symbol table; no bytes
  // emitted, so no patching.  But the symbol table should expose LIVES.
  const p = mkProgram(["10 REM ' ORG $9800:.LIVES = $04"]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (r.linesPatched.length !== 0) return `REM shouldn't be patched`;
  if (r.symbols.get('LIVES')?.value !== 0x04) return 'LIVES not in symbol table';
  return null;
});

test('applyAssembler processes DATA-line annotations', () => {
  // Simplest end-to-end: one DATA line with an instruction annotation.
  // The existing DATA values get replaced with the assembled bytes.
  const p = mkProgram(['10 DATA 0,0 \' LDA #$BB']);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (r.linesPatched.length !== 1 || r.linesPatched[0] !== 0) {
    return `expected to patch line 0, got ${JSON.stringify(r.linesPatched)}`;
  }
  return null;
});

// ── Cross-line symbol sharing ────────────────────────────────────────────────

test('equate on REM line is visible to DATA-line instruction', () => {
  const p = mkProgram([
    "10 REM ' .LIVES = $04",
    '20 DATA 0,0 \' DEC LIVES',
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!r.linesPatched.includes(1)) return `line 1 not patched`;
  // After patching, line 1's content should be: DATA byte + ' + annotation bytes.
  // Easier to check: DEC $04 assembles to 0xC6 0x04.  The patched line's
  // content bytes start with the DATA token, a space, then the new byte
  // literals as ASCII text.  Instead of parsing back, just verify the
  // first few bytes look like "DATA #C6,#04 ...".
  const text = p.lines[1].v;
  if (!/^20 DATA #C6,#04/.test(text)) return `line 1 text: ${text}`;
  return null;
});

test('forward-declared label on REM line is visible to DATA-line branch', () => {
  const p = mkProgram([
    "10 REM ' ORG $9800",
    '20 DATA 0,0 \' BNE END',
    '30 DATA 0 \' NOP',
    "40 REM ' .END",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  // Line 20: BNE END from pc=$9800, END=$9803, offset = 3-2 = 1 → D0 01.
  if (!/^20 DATA #D0,#01/.test(p.lines[1].v)) return `line 1 text: ${p.lines[1].v}`;
  // Line 30: NOP → EA.
  if (!/^30 DATA #EA/.test(p.lines[2].v)) return `line 2 text: ${p.lines[2].v}`;
  return null;
});

// ── Error attribution ────────────────────────────────────────────────────────

test('error on a DATA line is attributed to that line', () => {
  const p = mkProgram([
    '10 DATA 0 \' LDA #$BB',        // fine
    '20 DATA 0 \' LDA UNDEFINED',   // error: undefined symbol
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 1) return `expected 1 error, got ${r.errors.length}`;
  if (r.errors[0].lineIdx !== 1) return `error attributed to line ${r.errors[0].lineIdx} (want 1)`;
  if (r.errors[0].lineNum !== 20) return `error lineNum ${r.errors[0].lineNum} (want 20)`;
  if (!/undefined symbol.*UNDEFINED/i.test(r.errors[0].message)) {
    return `wrong message: ${r.errors[0].message}`;
  }
  // Line 10 should still have been patched successfully.
  if (!r.linesPatched.includes(0)) return `line 0 should have been patched despite line 1 error`;
  return null;
});

test('no-ORG + JMP to label errors at the referencing line', () => {
  const p = mkProgram([
    "10 REM ' .LOOP",
    '20 DATA 0,0,0 \' JMP LOOP',
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 1) return `expected 1 error, got ${r.errors.length}`;
  if (r.errors[0].lineIdx !== 1) return `error attributed to line ${r.errors[0].lineIdx}`;
  if (!/no ORG.*declared/i.test(r.errors[0].message)) return `wrong message: ${r.errors[0].message}`;
  return null;
});

// ── Automatic edit marking ───────────────────────────────────────────────────

test('patched bytes are marked edited: "automatic", not "explicit"', () => {
  const p = mkProgram(['10 DATA 0,0 \' LDA #$BB']);
  applyAssembler(p);
  const line = p.lines[0];
  let sawAutomatic = false;
  let sawExplicit  = false;
  for (let i = line.firstByte; i <= line.lastByte; i++) {
    const e = p.bytes[i].edited;
    if (e === 'automatic') sawAutomatic = true;
    if (e === 'explicit')  sawExplicit  = true;
  }
  if (sawExplicit)    return `at least one byte is still marked "explicit"`;
  if (!sawAutomatic)  return `no bytes marked "automatic" (expected some after re-writing)`;
  return null;
});

// ── Annotation preservation ──────────────────────────────────────────────────

test('annotation text is preserved across a DATA rewrite', () => {
  const p = mkProgram(['10 DATA 0 \' LDA #$BB  ; save A']);
  applyAssembler(p);
  // The rewritten line's rendered text must still contain the annotation.
  const text = p.lines[0].v;
  if (!text.includes("' LDA #$BB")) return `annotation dropped: ${text}`;
  if (!text.includes('; save A'))   return `trailing ; comment dropped: ${text}`;
  return null;
});

// ── Idempotence ──────────────────────────────────────────────────────────────

test('running applyAssembler twice gives identical bytes', () => {
  const p = mkProgram([
    "10 REM ' ORG $9800:.LIVES = $04",
    '20 DATA 0,0 \' DEC LIVES',
    '30 DATA 0,0 \' BNE FWD',
    "40 REM ' .FWD",
  ]);
  applyAssembler(p);
  const first = contentBytes(p, 1).slice();
  applyAssembler(p);
  const second = contentBytes(p, 1);
  return compareBytes(second, first, 'second run vs first');
});

// ── REM lines with instructions: bytes-go-nowhere ────────────────────────────

test('instruction on a REM line does not error, bytes discarded', () => {
  // Per the spec, REM annotations should be declarations only, but if
  // someone writes an instruction on a REM line, PC advances but there's
  // no DATA to patch.  Phase 5's stance is "drop silently" — no error,
  // no patches for that line.
  const p = mkProgram([
    "10 REM ' LDA #$BB",
    '20 DATA 0 \' RTS',
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  // Line 0 (REM) is not patched.  Line 1 (DATA) is patched to RTS.
  if (r.linesPatched.includes(0)) return `REM line shouldn't be patched`;
  if (!r.linesPatched.includes(1)) return `DATA line should be patched`;
  return null;
});

// ── Phase 6: back-patch directives ───────────────────────────────────────────

test('CALL back-patch with hex literal preserves hex format', () => {
  const p = mkProgram([
    "10 REM ' ORG $9800:.LOOPA",
    "20 DATA 0 ' RTS",
    "30 CALL #0000 ' .LOOPA",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!r.linesPatched.includes(2)) return `line 2 should be patched`;
  // LOOPA declared at PC=$9800 (ORG sets it, and .LOOPA follows).
  if (!/^30 CALL #9800/.test(p.lines[2].v)) return `line 2 text: ${p.lines[2].v}`;
  return null;
});

test('POKE back-patch with decimal literal preserves decimal format', () => {
  const p = mkProgram([
    "10 REM ' .LIVES = $04",
    "20 POKE 0,3 ' .LIVES",   // original literal "0" is decimal → emit decimal
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!r.linesPatched.includes(1)) return `line 1 should be patched`;
  if (!/^20 POKE 4,/.test(p.lines[1].v)) return `line 1 text: ${p.lines[1].v}`;
  return null;
});

test('POKE back-patch leaves value arg untouched', () => {
  const p = mkProgram([
    "10 REM ' .LIVES = $04",
    "20 POKE #0000,3 ' .LIVES",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!/^20 POKE #0004,3/.test(p.lines[1].v)) return `line 1 text: ${p.lines[1].v}`;
  return null;
});

test('multiple patch sites paired 1:1 with directives', () => {
  const p = mkProgram([
    "10 REM ' ORG $9800:.LOOPA",
    "20 DATA 0 ' RTS",
    "30 CALL #0000:CALL #F421 ' .LOOPA:-",  // patch first, skip second
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!/^30 CALL #9800:CALL #F421/.test(p.lines[2].v)) return `line 2 text: ${p.lines[2].v}`;
  return null;
});

test("'-' placeholder alone (-:.FOO) skips first site", () => {
  const p = mkProgram([
    "10 REM ' .FOO = $1234",
    "20 CALL #9800:CALL #0000 ' -:.FOO",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!/^20 CALL #9800:CALL #1234/.test(p.lines[1].v)) return `line 1 text: ${p.lines[1].v}`;
  return null;
});

test('PEEK inside an expression is a patch site', () => {
  const p = mkProgram([
    "10 REM ' .ADDR = $BB80",
    "20 LET X = PEEK(#0000) ' .ADDR",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!/PEEK\(#BB80\)/.test(p.lines[1].v)) return `line 1 text: ${p.lines[1].v}`;
  return null;
});

test('DEEK inside an expression is a patch site', () => {
  const p = mkProgram([
    "10 REM ' .ADDR = $BB80",
    "20 LET Y = DEEK(#0000) + 1 ' .ADDR",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!/DEEK\(#BB80\)/.test(p.lines[1].v)) return `line 1 text: ${p.lines[1].v}`;
  return null;
});

test('expression after literal is left untouched', () => {
  // CALL #9800 + OFFSET ' .BASE — patches just the literal, `+ OFFSET` unchanged.
  const p = mkProgram([
    "10 REM ' .BASE = $A000",
    "20 CALL #0000+OFFSET ' .BASE",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!/^20 CALL #A000\+OFFSET/.test(p.lines[1].v)) return `line 1 text: ${p.lines[1].v}`;
  return null;
});

// ── Phase 6: line-level eligibility gate ─────────────────────────────────────

test('line with CALL but non-backpatch annotation is ignored', () => {
  // The annotation starts with "PRINT", not `.` or `-:`, so the line is
  // not a back-patch host.  The CALL's literal should be left intact.
  const p = mkProgram([
    "10 CALL #9800 ' PRINT something",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (r.linesPatched.length !== 0) return `unexpectedly patched: ${JSON.stringify(r.linesPatched)}`;
  return null;
});

test('line without any back-patch token is ignored even with back-patch annotation', () => {
  // PRINT line with a dot-prefixed annotation — no patch-site tokens,
  // so the line contributes nothing and no errors fire.
  const p = mkProgram([
    "10 PRINT \"HI\" ' .FOO",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (r.linesPatched.length !== 0) return `unexpectedly patched`;
  return null;
});

// ── Phase 6: error paths ─────────────────────────────────────────────────────

test('count mismatch produces an error', () => {
  // Two CALLs, one directive → error.
  const p = mkProgram([
    "10 REM ' .FOO = $1234",
    "20 CALL #0000:CALL #1111 ' .FOO",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 1) return `expected 1 error, got ${r.errors.length}`;
  if (!/doesn't match/i.test(r.errors[0].message)) return `wrong message: ${r.errors[0].message}`;
  return null;
});

test('undefined back-patch label errors', () => {
  const p = mkProgram([
    "10 CALL #0000 ' .UNKNOWN",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 1) return `expected 1 error, got ${r.errors.length}`;
  if (!/undefined symbol.*UNKNOWN/i.test(r.errors[0].message)) {
    return `wrong message: ${r.errors[0].message}`;
  }
  return null;
});

test('non-literal argument with .LABEL directive errors', () => {
  // CALL X — variable arg, no literal to patch.  Directive is `.BASE`.
  const p = mkProgram([
    "10 REM ' .BASE = $9800",
    "20 CALL X ' .BASE",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 1) return `expected 1 error, got ${r.errors.length}`;
  if (!/has no numeric literal argument/i.test(r.errors[0].message)) {
    return `wrong message: ${r.errors[0].message}`;
  }
  return null;
});

test('non-literal argument with "-" placeholder is fine', () => {
  // CALL X — no literal, but directive is `-`.  No error, no change.
  const p = mkProgram([
    "10 REM ' .BASE = $9800",
    "20 CALL X:CALL #0000 ' -:.BASE",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!/^20 CALL X:CALL #9800/.test(p.lines[1].v)) return `line 1 text: ${p.lines[1].v}`;
  return null;
});

test('invalid directive syntax errors', () => {
  const p = mkProgram([
    "10 CALL #0000 ' .123FOO",  // identifier can't start with digit
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 1) return `expected 1 error, got ${r.errors.length}`;
  if (!/invalid back-patch directive/i.test(r.errors[0].message)) {
    return `wrong message: ${r.errors[0].message}`;
  }
  return null;
});

// ── Phase 6: automatic-marking and annotation preservation ───────────────────

test('back-patched bytes are marked edited: "automatic"', () => {
  const p = mkProgram([
    "10 REM ' .FOO = $9800",
    "20 CALL #0000 ' .FOO",
  ]);
  applyAssembler(p);
  const line = p.lines[1];
  let sawAutomatic = false;
  let sawExplicit  = false;
  for (let i = line.firstByte; i <= line.lastByte; i++) {
    if (p.bytes[i].edited === 'automatic') sawAutomatic = true;
    if (p.bytes[i].edited === 'explicit')  sawExplicit  = true;
  }
  if (sawExplicit)   return `some byte still marked "explicit"`;
  if (!sawAutomatic) return `expected some "automatic" bytes after back-patch`;
  return null;
});

test('annotation is preserved across a back-patch rewrite', () => {
  const p = mkProgram([
    "10 REM ' .FOO = $9800",
    "20 CALL #0000 ' .FOO  ; jump to setup",
  ]);
  applyAssembler(p);
  const v = p.lines[1].v;
  if (!v.includes("' .FOO")) return `directive text lost: ${v}`;
  if (!v.includes('; jump to setup')) return `trailing comment lost: ${v}`;
  return null;
});

// ── Phase 6: cross-phase interaction ─────────────────────────────────────────

test('Phase 5 and Phase 6 symbols are shared through one call', () => {
  // LIVES is an equate on a REM line (Phase 5 declaration).
  // Line 2 is a DATA-line instruction using LIVES (Phase 5 patches it).
  // Line 3 is a POKE using LIVES as back-patch target (Phase 6 patches it).
  const p = mkProgram([
    "10 REM ' .LIVES = $04",
    "20 DATA 0,0 ' DEC LIVES",           // Phase 5: emits C6 04
    "30 POKE #0000,3 ' .LIVES",          // Phase 6: patches #0000 → #0004
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!r.linesPatched.includes(1)) return `line 1 (Phase 5) not patched`;
  if (!r.linesPatched.includes(2)) return `line 2 (Phase 6) not patched`;
  if (!/^20 DATA #C6,#04/.test(p.lines[1].v)) return `line 1 text: ${p.lines[1].v}`;
  if (!/^30 POKE #0004,3/.test(p.lines[2].v)) return `line 2 text: ${p.lines[2].v}`;
  return null;
});

test('back-patching a label works', () => {
  const p = mkProgram([
    "10 REM ' ORG $9800",
    "20 DATA 0 ' .START:RTS",           // .START declares at $9800
    "30 CALL #0000 ' .START",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!/^30 CALL #9800/.test(p.lines[2].v)) return `line 2 text: ${p.lines[2].v}`;
  return null;
});

// ── Phase 6: idempotence ─────────────────────────────────────────────────────

test('running applyAssembler twice yields identical back-patched line', () => {
  const p = mkProgram([
    "10 REM ' ORG $9800:.LOOPA",
    "20 DATA 0 ' RTS",
    "30 CALL #0000 ' .LOOPA",
  ]);
  applyAssembler(p);
  const first = p.lines[2].v;
  applyAssembler(p);
  const second = p.lines[2].v;
  if (first !== second) return `line 2 changed between runs:\n  first:  ${first}\n  second: ${second}`;
  return null;
});

// ── Runner ───────────────────────────────────────────────────────────────────

let allPass = true;
for (const t of tests) {
  let err: string | null;
  try { err = t.run(); }
  catch (e) { err = `threw: ${(e as Error).message}`; }
  const pass = err === null;
  if (!pass) allPass = false;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${t.name}${err ? `\n      ${err}` : ''}`);
}
console.log(`\n${allPass ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'}`);
process.exit(allPass ? 0 : 1);
