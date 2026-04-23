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
import { parseLine, applyLineEdit } from '../src/editor';
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

  // Nine-byte placeholder TAP header at the front of prog.bytes.
  // `applyLineEdit` triggers `adjustHeaderEndAddr`, which writes to
  // `prog.bytes[header.byteIndex + 4]` and `[+5]` — so we need real
  // byte slots there or those writes clobber line content.  Values
  // don't matter for the tests.
  for (let i = 0; i < 9; i++) bytes.push(mkByte(0));

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

// ── User-edit preservation across re-assembly ────────────────────────────────
//
// Pre-existing `'explicit'` edits from the user — anywhere on a line
// except the specific bytes the assembler is rewriting — must survive
// a re-assembly run.  The assembler tracks its own emitted byte
// indices and only flips those to `'automatic'`.

test("user's annotation edit stays 'explicit' after re-assembly", () => {
  const p = mkProgram(["10 DATA 0,0 ' LDA #$00"]);
  // Simulate the user editing the annotation from `LDA #$00` to `LDA #$BB`.
  // The two `B` chars replace the two `0` chars in the annotation and are
  // marked `'explicit'` by applyLineEdit's normal LCS path.
  applyLineEdit(p, 0, "10 DATA 0,0 ' LDA #$BB");

  // Run the re-assembler.  DATA gets rewritten to match `LDA #$BB`.
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;

  const line = p.lines[0];
  // Find the annotation's last two bytes (the user's `BB`).  They sit
  // just before the 0x00 terminator (or at the end of the line's byte
  // range if the terminator isn't in range).
  // Find the content terminator (0x00) searching from firstByte+4 —
  // skipping the 4-byte line header whose line_num_hi can legitimately
  // be 0x00 for small line numbers.
  let end = line.lastByte;
  for (let i = line.firstByte + 4; i <= line.lastByte; i++) {
    if (p.bytes[i].v === 0) { end = i - 1; break; }
  }
  const b1 = p.bytes[end - 1];
  const b0 = p.bytes[end];
  if (b1.v !== 0x42 || b0.v !== 0x42) {
    return `expected last two bytes to be 'B' 'B', got ${b1.v.toString(16)},${b0.v.toString(16)}`;
  }
  if (b0.edited !== 'explicit') return `last B: expected 'explicit', got ${b0.edited}`;
  if (b1.edited !== 'explicit') return `penultimate B: expected 'explicit', got ${b1.edited}`;

  // And the DATA-values region (assembler-owned) should be 'automatic'.
  // Values start at firstByte+6 (after pointer+lineNum+TOKEN_DATA+space).
  // Walk until we hit the space before the `'` annotation marker.
  let apostIdx = -1;
  for (let i = line.firstByte + 4; i <= line.lastByte; i++) {
    if (p.bytes[i].v === 0x27) { apostIdx = i; break; }
  }
  if (apostIdx < 0) return 'no annotation marker post-run';
  // DATA value bytes are firstByte+6 to apostIdx-2 (skipping the space
  // before the apostrophe at apostIdx-1).  They should either be
  // 'automatic' (the assembler wrote them) or undefined (bytes that
  // LCS matched back to the original — e.g. the comma that happens to
  // be at the same position in both old and new).  Crucially, none
  // should still be 'explicit'.
  let sawAutomatic = false;
  for (let i = line.firstByte + 6; i < apostIdx - 1; i++) {
    const b = p.bytes[i];
    if (b.edited === 'explicit') {
      return `DATA byte at ${i} ('${String.fromCharCode(b.v)}'): unexpected 'explicit'`;
    }
    if (b.edited === 'automatic') sawAutomatic = true;
  }
  if (!sawAutomatic) return 'expected at least one DATA byte marked automatic';
  return null;
});

test("user's line-number edit stays 'explicit' after re-assembly", () => {
  const p = mkProgram(["10 DATA 0 ' RTS"]);
  // Simulate the user changing the line number from 10 to 20.
  applyLineEdit(p, 0, "20 DATA 0 ' RTS");

  const line = p.lines[0];
  // Line-number low byte is at firstByte+2; user's 20 = 0x14.
  if (p.bytes[line.firstByte + 2].v !== 0x14) {
    return `line-number byte: expected 0x14, got 0x${p.bytes[line.firstByte + 2].v.toString(16)}`;
  }
  if (p.bytes[line.firstByte + 2].edited !== 'explicit') {
    return `pre-run: line-number byte should be 'explicit', got ${p.bytes[line.firstByte + 2].edited}`;
  }

  // Run the re-assembler.  RTS → byte 0x60 replaces the DATA value.
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;

  // Line-number edit must survive.
  if (p.bytes[line.firstByte + 2].edited !== 'explicit') {
    return `after re-run: line-number byte should remain 'explicit', got ${p.bytes[line.firstByte + 2].edited}`;
  }
  // Assembler output (the DATA value byte at firstByte+6) should be 'automatic'.
  if (p.bytes[line.firstByte + 6].edited !== 'automatic') {
    return `DATA value byte should be 'automatic', got ${p.bytes[line.firstByte + 6].edited}`;
  }
  return null;
});

test("user's annotation edit stays 'explicit' after back-patch", () => {
  const p = mkProgram([
    "10 REM ' .LOOP = $9800",
    "20 CALL #0000 ' .LOOP",
  ]);
  // Simulate the user appending a ` * note` comment to the back-patch
  // directive's annotation.  The ` * note` chars are new bytes and will
  // be marked `'explicit'` by applyLineEdit.
  applyLineEdit(p, 1, "20 CALL #0000 ' .LOOP * note");

  const line = p.lines[1];
  // Walk to the last non-terminator byte; it should be the final 'e'
  // of "note", marked 'explicit'.
  // Find the content terminator (0x00) searching from firstByte+4 —
  // skipping the 4-byte line header whose line_num_hi can legitimately
  // be 0x00 for small line numbers.
  let end = line.lastByte;
  for (let i = line.firstByte + 4; i <= line.lastByte; i++) {
    if (p.bytes[i].v === 0) { end = i - 1; break; }
  }
  if (p.bytes[end].v !== 0x65) {  // 'e' = 0x65
    return `pre-run: last byte expected 'e', got 0x${p.bytes[end].v.toString(16)}`;
  }
  if (p.bytes[end].edited !== 'explicit') {
    return `pre-run: last byte should be 'explicit', got ${p.bytes[end].edited}`;
  }

  // Run the re-assembler.  The #0000 literal gets back-patched to #9800.
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;

  // Find the new end (skip past the 4-byte line header).
  end = line.lastByte;
  for (let i = line.firstByte + 4; i <= line.lastByte; i++) {
    if (p.bytes[i].v === 0) { end = i - 1; break; }
  }
  // The user's trailing ` ; note` chars should all still be 'explicit'.
  // Scan backward from end, checking the last 5 chars are 'note' (or 'note').
  // Simpler: check the last byte ('e') is 'explicit'.
  if (p.bytes[end].edited !== 'explicit') {
    return `after re-run: last byte should remain 'explicit', got ${p.bytes[end].edited}`;
  }

  // The patched literal `#9800` should have at least one byte marked
  // 'automatic' (bytes that differ from original `#0000`) and no bytes
  // marked 'explicit' (the patch region is assembler-owned).  Bytes
  // that coincidentally match the original via LCS stay undefined,
  // which is fine.
  let apostIdx = -1;
  for (let i = line.firstByte + 4; i <= line.lastByte; i++) {
    if (p.bytes[i].v === 0x27) { apostIdx = i; break; }
  }
  if (apostIdx < 0) return 'no annotation marker post-run';
  let sawAutomaticDigit = false;
  let litDigits = 0;
  for (let i = line.firstByte + 4; i < apostIdx; i++) {
    const b = p.bytes[i];
    if (b.v >= 0x30 && b.v <= 0x39) {
      litDigits++;
      if (b.edited === 'explicit') {
        return `literal digit byte at ${i}: unexpected 'explicit'`;
      }
      if (b.edited === 'automatic') sawAutomaticDigit = true;
    }
  }
  if (litDigits !== 4)     return `expected 4 hex digits in literal, found ${litDigits}`;
  if (!sawAutomaticDigit)  return 'expected at least one literal digit byte marked automatic';
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

// ── Phase 6b: bounded regions ────────────────────────────────────────────────

test('no markers → process everything (backward compatible)', () => {
  const p = mkProgram([
    "10 DATA 0 ' LDA #$BB",
    "20 DATA 0 ' RTS",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (r.linesPatched.length !== 2) return `expected both lines patched, got ${JSON.stringify(r.linesPatched)}`;
  return null;
});

test('[[ alone: lines before skipped, lines from [[ onward processed', () => {
  const p = mkProgram([
    "10 DATA 0 ' LDA #$AA",              // before [[, not processed
    "20 REM ' [[",
    "30 DATA 0 ' LDA #$BB",              // inside region
    "40 DATA 0 ' RTS",                    // inside region
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (r.linesPatched.includes(0)) return `line 0 (before [[) should not be patched`;
  if (!r.linesPatched.includes(2)) return `line 2 should be patched`;
  if (!r.linesPatched.includes(3)) return `line 3 should be patched`;
  // Line 0's DATA body should still read "0" (original), not #AA.
  if (!/^10 DATA 0 /.test(p.lines[0].v)) return `line 0 was modified: ${p.lines[0].v}`;
  return null;
});

test('[[ and ]] bracket a region', () => {
  const p = mkProgram([
    "10 DATA 0 ' LDA #$AA",              // before [[: not processed
    "20 REM ' [[",
    "30 DATA 0 ' LDA #$BB",              // inside: processed
    "40 REM ' ]]",
    "50 DATA 0 ' LDA #$CC",              // after ]]: not processed
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (r.linesPatched.includes(0)) return `line 0 before [[ should not be patched`;
  if (!r.linesPatched.includes(2)) return `line 2 inside region should be patched`;
  if (r.linesPatched.includes(4)) return `line 4 after ]] should not be patched`;
  if (!/^30 DATA #A9,#BB/.test(p.lines[2].v)) return `line 2 text: ${p.lines[2].v}`;
  return null;
});

test('[[ combined with instruction on same line', () => {
  const p = mkProgram([
    "10 DATA 0 ' LDA #$AA",              // before [[: not processed
    "20 DATA 0 ' [[:LDA #$BB",           // [[ activates mid-annotation, LDA is in-region
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (r.linesPatched.includes(0)) return `line 0 should not be patched`;
  if (!r.linesPatched.includes(1)) return `line 1 should be patched`;
  if (!/^20 DATA #A9,#BB/.test(p.lines[1].v)) return `line 1 text: ${p.lines[1].v}`;
  return null;
});

test('marker mid-line: drops only statements after ]]', () => {
  const p = mkProgram([
    "10 DATA 0 ' [[",
    "20 DATA 0 ' LDA #$BB:]]:LDA #$CC",  // LDA #$BB active, then ]] deactivates, LDA #$CC dropped
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  // Line 1 patched with LDA #$BB (2 bytes), the LDA #$CC is dropped.
  if (!/^20 DATA #A9,#BB/.test(p.lines[1].v)) return `line 1 text: ${p.lines[1].v}`;
  // Should NOT contain more than just the LDA #$BB bytes.
  if (/#A9,#BB,#A9,#CC/.test(p.lines[1].v)) return `LDA #$CC after ]] wasn't dropped: ${p.lines[1].v}`;
  return null;
});

test('multiple non-contiguous regions', () => {
  const p = mkProgram([
    "10 REM ' [[",
    "20 DATA 0 ' LDA #$11",              // region 1: processed
    "30 REM ' ]]",
    "40 DATA 0 ' LDA #$22",              // gap: not processed
    "50 REM ' [[",
    "60 DATA 0 ' LDA #$33",              // region 2: processed
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!r.linesPatched.includes(1)) return `line 1 should be patched`;
  if (r.linesPatched.includes(3))  return `line 3 in gap should not be patched`;
  if (!r.linesPatched.includes(5)) return `line 5 should be patched`;
  if (!/^20 DATA #A9,#11/.test(p.lines[1].v)) return `line 1: ${p.lines[1].v}`;
  if (!/^40 DATA 0/.test(p.lines[3].v))       return `line 3 was modified: ${p.lines[3].v}`;
  if (!/^60 DATA #A9,#33/.test(p.lines[5].v)) return `line 5: ${p.lines[5].v}`;
  return null;
});

test('solo ]] at top disables everything (kill switch)', () => {
  // Presence of ]] anywhere forces initial state = inactive.  With no [[
  // to re-activate, nothing gets processed.
  const p = mkProgram([
    "10 REM ' ]]",
    "20 DATA 0 ' LDA #$BB",
    "30 DATA 0 ' RTS",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (r.linesPatched.length !== 0) return `nothing should be patched, got ${JSON.stringify(r.linesPatched)}`;
  return null;
});

test('markers interact with back-patch directives', () => {
  // [[ on a CALL line, followed by the back-patch directive — the marker
  // is stripped by the filter, leaving ".LOOPA" which is a valid
  // back-patch annotation.
  const p = mkProgram([
    "10 REM ' [[:ORG $9800:.LOOPA",
    "20 DATA 0 ' RTS",
    "30 CALL #0000 ' [[:.LOOPA",         // [[ (no-op — already active), then .LOOPA
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!/^30 CALL #9800/.test(p.lines[2].v)) return `line 2: ${p.lines[2].v}`;
  return null;
});

test(']] before any [[ in a program: nothing processed', () => {
  // Since ANY marker triggers initial-inactive, an early ]] doesn't do
  // anything (state already off) and without a later [[ to open, nothing
  // is processed.
  const p = mkProgram([
    "10 DATA 0 ' LDA #$BB",
    "20 REM ' ]]",
    "30 DATA 0 ' RTS",
  ]);
  const r = applyAssembler(p);
  if (r.linesPatched.length !== 0) return `nothing should be patched`;
  return null;
});

test('repeated markers are idempotent', () => {
  // [[ [[ is equivalent to just [[; ]] ]] is equivalent to just ]].
  const p = mkProgram([
    "10 REM ' [[:[[",
    "20 DATA 0 ' LDA #$BB",              // active from first [[
    "30 REM ' ]]:]]",
    "40 DATA 0 ' LDA #$CC",              // inactive from first ]]
  ]);
  const r = applyAssembler(p);
  if (!r.linesPatched.includes(1)) return `line 1 should be patched`;
  if (r.linesPatched.includes(3))  return `line 3 should not be patched`;
  return null;
});

// ── REM strict-host-shape rule: apostrophe-in-comment regressions ──────────
//
// REM is an assembler host only when the body directly after `REM`
// starts with `'`.  Ordinary BASIC comments whose body contains an
// apostrophe for unrelated reasons (possessives, contractions, quoted
// strings) must NOT be interpreted as annotations.

test("REM UDG's is a plain comment, not an assembler host", () => {
  // Embedded apostrophe inside a word — the `'` at position 11 is
  // literal text, not the annotation marker, because the body after
  // REM starts with 'U', not '.
  const p = mkProgram(["9700 REM UDG's"]);
  const r = applyAssembler(p);
  if (r.errors.length  !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (r.linesPatched.length !== 0) return `unexpectedly patched: ${JSON.stringify(r.linesPatched)}`;
  return null;
});

test("REM UDG's DATA is a plain comment (both issues combined)", () => {
  const p = mkProgram(["20000 REM UDG's DATA"]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (r.linesPatched.length !== 0) return `unexpectedly patched`;
  return null;
});

test("REM don't touch this — contraction apostrophe is not an annotation", () => {
  const p = mkProgram(["100 REM don't touch this"]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (r.linesPatched.length !== 0) return `unexpectedly patched`;
  return null;
});

test("REM with in-word apostrophe followed by real-looking text still ignored", () => {
  // Even though this text after the `'` might look like valid assembly,
  // the REM rule requires the `'` to be the body's first non-whitespace
  // char — and it isn't, so this whole line is a plain comment.
  const p = mkProgram(["100 REM note's LDA #$BB here"]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (r.linesPatched.length !== 0) return `unexpectedly patched`;
  return null;
});

test("REM ' ... still works (annotation host, strict rule satisfied)", () => {
  // Sanity: the allowed shape hasn't regressed.
  const p = mkProgram([
    "10 REM ' ORG $9800:.LIVES = $04",
    "20 DATA 0,0 ' DEC LIVES",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!r.linesPatched.includes(1)) return `line 1 should be patched`;
  if (!/^20 DATA #C6,#04/.test(p.lines[1].v)) return `line 1 text: ${p.lines[1].v}`;
  return null;
});

test("REM with leading whitespace before ' is still a host", () => {
  // Multiple spaces between REM and the annotation opener — still the
  // allowed shape.
  const p = mkProgram(["10 REM    ' ORG $9800:.FOO = $1234"]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (r.symbols.get('FOO')?.value !== 0x1234) return 'FOO not declared';
  return null;
});

test('markers strip cleanly from annotations before assembler sees them', () => {
  // REM annotation "[[:ORG $9800:.LIVES = $04" should reach the assembler
  // as "ORG $9800:.LIVES = $04" — the [[ must not produce an assembler
  // error ("unknown mnemonic" etc.).
  const p = mkProgram([
    "10 REM ' [[:ORG $9800:.LIVES = $04",
    "20 DATA 0 ' DEC LIVES",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!/^20 DATA #C6,#04/.test(p.lines[1].v)) return `line 1: ${p.lines[1].v}`;
  return null;
});

// ── DATA byte format preservation: hex/decimal per literal form ──────────────

test('hex literal operand → DATA emitted as hex byte', () => {
  const p = mkProgram(["10 DATA 0,0 ' LDA #$BB"]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  // Opcode always hex (#A9); operand from $BB → hex (#BB).
  if (!/^10 DATA #A9,#BB/.test(p.lines[0].v)) return `line 0: ${p.lines[0].v}`;
  return null;
});

test('decimal literal operand → DATA emitted as decimal byte', () => {
  const p = mkProgram(["10 DATA 0,0 ' LDA #249"]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  // Opcode still hex (#A9); operand from decimal 249 → decimal (249).
  if (!/^10 DATA #A9,249/.test(p.lines[0].v)) return `line 0: ${p.lines[0].v}`;
  return null;
});

test('binary literal operand → DATA emitted as hex byte (binary → hex)', () => {
  const p = mkProgram(["10 DATA 0,0 ' LDA #%01111111"]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  // Binary %01111111 = 0x7F → emitted as #7F.
  if (!/^10 DATA #A9,#7F/.test(p.lines[0].v)) return `line 0: ${p.lines[0].v}`;
  return null;
});

test('ASCII char literal → DATA emitted as decimal byte (char → decimal)', () => {
  const p = mkProgram(["10 DATA 0,0 ' LDA #'A"]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  // 'A = 65 → decimal.
  if (!/^10 DATA #A9,65/.test(p.lines[0].v)) return `line 0: ${p.lines[0].v}`;
  return null;
});

test('2-byte hex operand (ABS) → emitted as one word (default WORDS)', () => {
  const p = mkProgram([
    "10 REM ' ORG $1000",
    "20 DATA 0,0,0 ' LDA $9800",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  // LDA $9800 → AD 00 98.  WORDS mode (default): operand one word #9800.
  if (!/^20 DATA #AD,#9800/.test(p.lines[1].v)) return `line 1: ${p.lines[1].v}`;
  return null;
});

test('2-byte decimal operand (ABS) → emitted as one decimal word (default WORDS)', () => {
  const p = mkProgram([
    "10 REM ' ORG 4096",
    "20 DATA 0,0,0 ' LDA 38912",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  // LDA 38912 → AD 00 98.  WORDS mode: operand one decimal word 38912.
  if (!/^20 DATA #AD,38912/.test(p.lines[1].v)) return `line 1: ${p.lines[1].v}`;
  return null;
});

test('code label reference → DATA emitted as one hex word (default WORDS)', () => {
  const p = mkProgram([
    "10 REM ' ORG $9800",
    "20 DATA 0,0,0 ' JMP TARGET",
    "30 DATA 0 ' RTS",
    "40 REM ' .TARGET",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  // TARGET resolves at $9804 (after JMP's 3 bytes + RTS's 1 byte).
  // JMP ABS → 4C 04 98.  WORDS mode: operand one word #9804 (label default).
  if (!/^20 DATA #4C,#9804/.test(p.lines[1].v)) return `line 1: ${p.lines[1].v}`;
  return null;
});

test('[[ BYTES opts out of default WORDS → operand split into two bytes', () => {
  const p = mkProgram([
    "10 REM ' [[ BYTES:ORG $1000",
    "20 DATA 0,0,0 ' LDA $9800",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!/^20 DATA #AD,#00,#98/.test(p.lines[1].v)) return `line 1: ${p.lines[1].v}`;
  return null;
});

test('[[ BYTES sticky across lines (no re-assertion needed)', () => {
  const p = mkProgram([
    "10 REM ' [[ BYTES:ORG $1000",
    "20 DATA 0,0,0 ' LDA $9800",
    "30 DATA 0,0,0 ' JMP $4242",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!/^20 DATA #AD,#00,#98/.test(p.lines[1].v)) return `line 1: ${p.lines[1].v}`;
  if (!/^30 DATA #4C,#42,#42/.test(p.lines[2].v)) return `line 2: ${p.lines[2].v}`;
  return null;
});

test('[[ WORDS after [[ BYTES switches back', () => {
  const p = mkProgram([
    "10 REM ' [[ BYTES:ORG $1000",
    "20 DATA 0,0,0 ' LDA $9800",
    "30 REM ' [[ WORDS",
    "40 DATA 0,0,0 ' LDA $9800",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!/^20 DATA #AD,#00,#98/.test(p.lines[1].v)) return `line 1: ${p.lines[1].v}`;
  if (!/^40 DATA #AD,#9800/.test(p.lines[3].v))   return `line 3: ${p.lines[3].v}`;
  return null;
});

test('bare [[ preserves prevailing mode', () => {
  const p = mkProgram([
    "10 REM ' [[ BYTES:ORG $1000",
    "20 DATA 0,0,0 ' LDA $9800",
    "30 REM ' ]]",
    "40 REM ' [[",
    "50 DATA 0,0,0 ' LDA $9800",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  // Mode stayed BYTES across `]]` … `[[` (no param on re-open).
  if (!/^20 DATA #AD,#00,#98/.test(p.lines[1].v)) return `line 1: ${p.lines[1].v}`;
  if (!/^50 DATA #AD,#00,#98/.test(p.lines[4].v)) return `line 4: ${p.lines[4].v}`;
  return null;
});

test('[[ params case-insensitive', () => {
  const p = mkProgram([
    "10 REM ' [[ bytes:ORG $1000",
    "20 DATA 0,0,0 ' LDA $9800",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!/^20 DATA #AD,#00,#98/.test(p.lines[1].v)) return `line 1: ${p.lines[1].v}`;
  return null;
});

test('unknown [[ param surfaces as error', () => {
  const p = mkProgram([
    "10 REM ' [[ WORSD:ORG $1000",
    "20 DATA 0,0,0 ' LDA $9800",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length === 0) return 'expected an error for [[ WORSD';
  if (!/unknown bounded-region parameter/i.test(r.errors[0].message)) {
    return `wrong error: ${r.errors[0].message}`;
  }
  return null;
});

test('[[ BYTES mid-annotation takes effect at next line (per-line granularity)', () => {
  // `[[ BYTES` on line 20 changes the mode AFTER line 20's output is
  // rendered — line 20 uses the incoming mode (WORDS, established by
  // line 10's `[[ WORDS`), line 30 picks up BYTES.  This matches the
  // per-line wordMode semantics documented in filterStatementsByState.
  const p = mkProgram([
    "10 REM ' [[ WORDS:ORG $1000",
    "20 DATA 0,0,0 ' LDA $9800:[[ BYTES",
    "30 DATA 0,0,0 ' LDA $9800",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  // Line 20 started in WORDS; emits word.
  if (!/^20 DATA #AD,#9800/.test(p.lines[1].v))   return `line 1: ${p.lines[1].v}`;
  // Line 30 starts in BYTES (set by line 20's trailing `[[ BYTES`).
  if (!/^30 DATA #AD,#00,#98/.test(p.lines[2].v)) return `line 2: ${p.lines[2].v}`;
  return null;
});

test('equate declared in hex → reference emits hex', () => {
  const p = mkProgram([
    "10 REM ' .LIVES = $04",
    "20 DATA 0,0 ' DEC LIVES",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!/^20 DATA #C6,#04/.test(p.lines[1].v)) return `line 1: ${p.lines[1].v}`;
  return null;
});

test('equate declared in decimal → reference emits decimal', () => {
  const p = mkProgram([
    "10 REM ' .COUNT = 50",
    "20 DATA 0,0 ' DEC COUNT",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  // DEC ZP = C6; operand inherits decimal from equate → 50.
  if (!/^20 DATA #C6,50/.test(p.lines[1].v)) return `line 1: ${p.lines[1].v}`;
  return null;
});

test('REL branch offset always emitted as hex (computed, no source literal)', () => {
  const p = mkProgram([
    "10 REM ' ORG $9800",
    "20 DATA 0,0 ' .LOOP:NOP",
    "30 DATA 0,0 ' BNE LOOP",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  // BNE LOOP → D0 <offset>.  Offset is a computed value, rendered hex.
  if (!/^30 DATA #D0,#F[CED]/.test(p.lines[2].v)) return `line 2: ${p.lines[2].v}`;
  return null;
});

test('mixed: hex immediate + decimal-operand instruction', () => {
  const p = mkProgram([
    "10 DATA 0,0,0,0 ' LDA #$BB:STA 100",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  // LDA #$BB → A9 BB (opcode hex, operand hex from $).
  // STA 100 → 85 64 (opcode hex; operand from decimal 100 → decimal).
  if (!/^10 DATA #A9,#BB,#85,100/.test(p.lines[0].v)) return `line 0: ${p.lines[0].v}`;
  return null;
});

// ── Digit-count preservation (byte operands) ─────────────────────────────────

test('LDY #00 round-trips as DATA 00 (decimal 2-digit preserved)', () => {
  const p = mkProgram(["10 DATA 0,0 ' LDY #00"]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  // Opcode A0, operand 0 emitted decimal with min width 2 → "00".
  if (!/^10 DATA #A0,00/.test(p.lines[0].v)) return `line 0: ${p.lines[0].v}`;
  return null;
});

test('LDY #0 round-trips as DATA 0 (no padding)', () => {
  const p = mkProgram(["10 DATA 0,0 ' LDY #0"]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!/^10 DATA #A0,0$/.test(p.lines[0].v) && !/^10 DATA #A0,0 /.test(p.lines[0].v)) {
    return `line 0: ${p.lines[0].v}`;
  }
  return null;
});

test('LDA #$09 emits #09 (2-digit hex preserved)', () => {
  const p = mkProgram(["10 DATA 0,0 ' LDA #$09"]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!/^10 DATA #A9,#09/.test(p.lines[0].v)) return `line 0: ${p.lines[0].v}`;
  return null;
});

test('LDA #$9 emits #9 (1-digit hex preserved)', () => {
  const p = mkProgram(["10 DATA 0,0 ' LDA #$9"]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  // Literal written as 1 hex digit → emit 1 hex digit.
  if (!/^10 DATA #A9,#9$/.test(p.lines[0].v) && !/^10 DATA #A9,#9 /.test(p.lines[0].v)) {
    return `line 0: ${p.lines[0].v}`;
  }
  return null;
});

test('LDA #001 emits 001 (3-digit decimal preserved)', () => {
  const p = mkProgram(["10 DATA 0,0 ' LDA #001"]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!/^10 DATA #A9,001/.test(p.lines[0].v)) return `line 0: ${p.lines[0].v}`;
  return null;
});

test('Equate digit count propagates to references (hex)', () => {
  const p = mkProgram([
    "10 REM ' .LIVES = $04",
    "20 DATA 0,0 ' DEC LIVES",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  // LIVES declared as $04 (2 hex digits) → reference emits #04.
  if (!/^20 DATA #C6,#04/.test(p.lines[1].v)) return `line 1: ${p.lines[1].v}`;
  return null;
});

test('Equate digit count propagates to references (decimal)', () => {
  const p = mkProgram([
    "10 REM ' .COUNT = 05",
    "20 DATA 0,0 ' DEC COUNT",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  // COUNT declared as 05 (2 decimal digits) → reference emits 05.
  if (!/^20 DATA #C6,05/.test(p.lines[1].v)) return `line 1: ${p.lines[1].v}`;
  return null;
});

test('Equate with 1-digit decimal → 1-digit emission', () => {
  const p = mkProgram([
    "10 REM ' .COUNT = 5",
    "20 DATA 0,0 ' DEC COUNT",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  // COUNT declared as 5 (1 digit) → emit 5, no padding.
  if (!/^20 DATA #C6,5$/.test(p.lines[1].v) && !/^20 DATA #C6,5 /.test(p.lines[1].v)) {
    return `line 1: ${p.lines[1].v}`;
  }
  return null;
});

test('Word operand in WORDS mode → #XXXX (4 hex digits)', () => {
  const p = mkProgram([
    "10 REM ' ORG $1000",
    "20 DATA 0,0,0 ' LDA $9800",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  // WORDS mode (default): operand rendered as one 4-digit hex word.
  if (!/^20 DATA #AD,#9800/.test(p.lines[1].v)) return `line 1: ${p.lines[1].v}`;
  return null;
});

test('Word operand in BYTES mode → two #XX (2 hex digits each)', () => {
  const p = mkProgram([
    "10 REM ' [[ BYTES:ORG $1000",
    "20 DATA 0,0,0 ' LDA $9800",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!/^20 DATA #AD,#00,#98/.test(p.lines[1].v)) return `line 1: ${p.lines[1].v}`;
  return null;
});

test('REL offsets always hex 2-digit regardless of label width', () => {
  const p = mkProgram([
    "10 REM ' ORG $9800",
    "20 DATA 0,0 ' .LOOP:NOP",
    "30 DATA 0,0 ' BNE LOOP",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  // REL offset emitted as 2-digit hex.
  if (!/^30 DATA #D0,#F[CED]/.test(p.lines[2].v)) return `line 2: ${p.lines[2].v}`;
  return null;
});

test('BNE -7 in annotation → DATA #D0,249 (young-Alex style)', () => {
  // The classic: user writes a backward-branch offset in signed decimal;
  // the DATA renders the byte unsigned in decimal with min-width 1
  // (which is 3 naturally, since 249 has 3 digits).
  const p = mkProgram(["10 DATA 0,0 ' BNE -7"]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!/^10 DATA #D0,249/.test(p.lines[0].v)) return `line 0: ${p.lines[0].v}`;
  return null;
});

test('BNE $F9 in annotation → DATA #D0,#F9 (hex direct offset)', () => {
  const p = mkProgram(["10 DATA 0,0 ' BNE $F9"]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!/^10 DATA #D0,#F9/.test(p.lines[0].v)) return `line 0: ${p.lines[0].v}`;
  return null;
});

test('LDY #00:LDA #$BB preserves both widths independently (1983 style)', () => {
  // The "young Alex" example: decimal zeros padded to 2 digits to match
  // the column width of the hex values next to them.
  const p = mkProgram(["10 DATA 0,0,0,0 ' LDY #00:LDA #$BB"]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!/^10 DATA #A0,00,#A9,#BB/.test(p.lines[0].v)) return `line 0: ${p.lines[0].v}`;
  return null;
});

test('round-trip: re-assembling the output leaves it unchanged', () => {
  // After the first apply we have bytes + a DATA-styled annotation that
  // reflects the source literal formats.  A second apply should observe
  // the annotation, re-assemble the same bytes, and emit the DATA the
  // same way — the rendered line should be byte-identical.
  const p = mkProgram([
    "10 REM ' ORG $9800",
    "20 DATA 0,0 ' LDA #$BB",
    "30 DATA 0,0 ' LDA #249",
    "40 DATA 0,0,0 ' LDA $1234",
    "50 DATA 0 ' RTS",
  ]);
  applyAssembler(p);
  const after1 = p.lines.map(l => l.v);
  applyAssembler(p);
  const after2 = p.lines.map(l => l.v);
  for (let i = 0; i < after1.length; i++) {
    if (after1[i] !== after2[i]) {
      return `line ${i} differs between runs:\n  run1: ${after1[i]}\n  run2: ${after2[i]}`;
    }
  }
  return null;
});

// ── PC-break detection & strict/lenient mode ───────────────────────────────

test('lenient: zero-emit DATA line triggers silent PC-break (no error if unused)', () => {
  // No markers → lenient mode.  Line 20 is a DATA with comment-only
  // annotation (no instructions).  It breaks PC, but nobody uses
  // .LATER in ABS, so no error surfaces.
  const p = mkProgram([
    "10 REM ' [[ BYTES:ORG $9800",  // `[[ BYTES` makes this a marker program — switch to no markers below
  ]);
  // Rewrite to actually be marker-free.  Use the original-style input.
  const p2 = mkProgram([
    "10 REM ' ORG $9800",
    "20 DATA #EA ' *just a comment",
    "30 DATA #EA ' NOP",
    "40 DATA #EA ' .LATER:NOP",
  ]);
  const r = applyAssembler(p2);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  void p;
  return null;
});

test('lenient: ABS use of unanchored-label-after-break errors', () => {
  const p = mkProgram([
    "10 REM ' ORG $9800",
    "20 DATA #EA ' *comment",          // PC-break
    "30 DATA #EA ' .TGT:NOP",          // TGT declared after break → unanchored
    "40 DATA #4C,0,0 ' JMP TGT",       // ABS use → error
  ]);
  const r = applyAssembler(p);
  if (r.errors.length === 0) return 'expected an error';
  if (!/absolute addressing.*no ORG/i.test(r.errors[0].message)) {
    return `wrong message: ${r.errors[0].message}`;
  }
  return null;
});

test('lenient: ORG after PC-break re-anchors subsequent labels', () => {
  const p = mkProgram([
    "10 REM ' ORG $9800",
    "20 DATA #EA ' *comment",          // PC-break
    "30 REM ' ORG $9820",              // re-anchor
    "40 DATA #EA ' .TGT:NOP",          // anchored again
    "50 DATA #4C,0,0 ' JMP TGT",       // ABS use → OK
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!/^50 DATA #4C,#9820/.test(p.lines[4].v)) return `line 4: ${p.lines[4].v}`;
  return null;
});

test('lenient: REL within same unanchored region works', () => {
  // No ORG anywhere → whole program is unanchored but in one region.
  // REL branches within the region still work.
  const p = mkProgram([
    "10 DATA #A0,00 ' LDY #0",
    "20 DATA #C8 ' .LOOP:INY",
    "30 DATA #D0,#FD ' BNE LOOP",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!/^30 DATA #D0,#FD/.test(p.lines[2].v)) return `line 2: ${p.lines[2].v}`;
  return null;
});

test('lenient: REL across PC-break errors', () => {
  const p = mkProgram([
    "10 REM ' ORG $9800",
    "20 DATA #C8 ' .TGT:INY",
    "30 DATA #EA ' *break",            // PC-break, new region starts
    "40 DATA #D0,#FD ' BNE TGT",       // REL across regions → error
  ]);
  const r = applyAssembler(p);
  if (r.errors.length === 0) return 'expected an error';
  if (!/between different blocks of assembler/i.test(r.errors[0].message)) {
    return `wrong message: ${r.errors[0].message}`;
  }
  return null;
});

test('lenient: labels declared after a PC-break + ORG live in fresh anchored region', () => {
  // User's real program shape: code block 1, gap of un-annotated DATA,
  // ORG to re-anchor, code block 2.  Labels in block 2 should work in
  // ABS because the ORG re-anchored.
  const p = mkProgram([
    "10 REM ' ORG $9800",
    "20 DATA #60 ' .A:RTS",
    "30 DATA #EA,#EA,#EA,#EA ' *raw 4 bytes",   // PC-break
    "40 DATA #EA,#EA,#EA ' *raw 3 bytes",       // still unanchored
    "50 REM ' ORG $9868",                       // re-anchor
    "60 DATA #60 ' .B:RTS",
    "70 DATA #20,0,0 ' JSR B",                  // ABS use of B → OK
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!/^70 DATA #20,#9868/.test(p.lines[6].v)) return `line 6: ${p.lines[6].v}`;
  return null;
});

test('strict ([[): zero-emit DATA line is a hard error', () => {
  const p = mkProgram([
    "10 REM ' [[:ORG $9800",
    "20 DATA #EA ' *comment only",     // zero-emit DATA inside active region
    "30 DATA #60 ' RTS",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length === 0) return 'expected a strict-mode error';
  if (!/DATA lines inside \[\[ regions must contain a non-zero number/i.test(r.errors[0].message)) {
    return `wrong message: ${r.errors[0].message}`;
  }
  return null;
});

test('strict ([[): zero-emit DATA in inactive region is NOT an error', () => {
  const p = mkProgram([
    "10 REM ' [[:ORG $9800",
    "20 DATA #60 ' RTS",
    "30 REM ' ]]",
    "40 DATA #EA ' *no-op docs — in inactive region",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  return null;
});

test('strict ([[): wrapping un-annotated DATA with ]]/[[ avoids error', () => {
  const p = mkProgram([
    "10 REM ' [[:ORG $9800",
    "20 DATA #60 ' .A:RTS",
    "30 REM ' ]]",
    "40 DATA #EA,#EA,#EA ' *raw 3 bytes",   // skipped by brackets
    "50 REM ' [[:ORG $9820",                // re-anchor and re-activate
    "60 DATA #60 ' .B:RTS",
    "70 DATA #20,0,0 ' JSR B",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!/^70 DATA #20,#9820/.test(p.lines[6].v)) return `line 6: ${p.lines[6].v}`;
  return null;
});

test('back-patch with unanchored label errors', () => {
  const p = mkProgram([
    "10 REM ' .TGT = $0",                // declares an equate (not a label) — different case
    "20 DATA #EA ' *break",              // PC-break (lenient mode: no markers in this program)
    "30 DATA #60 ' .LATE:RTS",           // LATE: unanchored
    "40 CALL 0 ' .LATE",                 // back-patch to unanchored label → error
  ]);
  const r = applyAssembler(p);
  if (r.errors.length === 0) return 'expected an error';
  if (!/back-patch label LATE is missing ORG declaration/i.test(r.errors[0].message)) {
    return `wrong message: ${r.errors[0].message}`;
  }
  return null;
});

test('back-patch to anchored label works after PC-break+ORG', () => {
  const p = mkProgram([
    "10 REM ' ORG $9800",
    "20 DATA #EA ' *break",              // PC-break
    "30 REM ' ORG $9820",                // re-anchor
    "40 DATA #60 ' .HERE:RTS",           // anchored
    "50 CALL #0 ' .HERE",                // hex literal → patched as #XXXX
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!/^50 CALL #9820/.test(p.lines[4].v)) return `line 4: ${p.lines[4].v}`;
  return null;
});

// ── Named assembler blocks (`ORG $xxxx .NAME`) ────────────────────────────

test('named ORG declares NAME = start and NAME_END = last byte', () => {
  const p = mkProgram([
    "10 REM ' ORG $9800 .BLOCKA",
    "20 DATA #EA ' NOP",                 // $9800 (1 byte)
    "30 DATA #EA,#EA ' NOP:NOP",         // $9801-$9802 (2 bytes)
    "40 DATA #60 ' RTS",                 // $9803
    "50 CALL #0:CALL #0 ' .BLOCKA:.BLOCKA_END",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!/^50 CALL #9800:CALL #9803/.test(p.lines[4].v)) return `line 4: ${p.lines[4].v}`;
  return null;
});

test('named block ends at next ORG', () => {
  const p = mkProgram([
    "10 REM ' ORG $9800 .BLOCKA",
    "20 DATA #EA ' NOP",                 // $9800, block ends here (next ORG on line 30)
    "30 REM ' ORG $9900 .BLOCKB",
    "40 DATA #EA ' NOP",                 // $9900
    "50 CALL #0:CALL #0 ' .BLOCKA:.BLOCKA_END",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!/^50 CALL #9800:CALL #9800/.test(p.lines[4].v)) return `line 4: ${p.lines[4].v}`;  // 1 byte block
  return null;
});

test('named block ends at zero-output DATA line (lenient)', () => {
  const p = mkProgram([
    "10 REM ' ORG $9800 .BLOCKA",
    "20 DATA #EA ' NOP",                  // $9800
    "30 DATA #EA ' *not code — PC-break", // ends BLOCKA, unanchors
    "40 REM ' ORG $9900 .BLOCKB",
    "50 DATA #60 ' RTS",
    "60 CALL #0 ' .BLOCKA_END",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!/^60 CALL #9800/.test(p.lines[5].v)) return `line 5: ${p.lines[5].v}`;
  return null;
});

test('named block ends at `]]` close marker', () => {
  const p = mkProgram([
    "10 REM ' [[:ORG $9800 .BLOCKA",
    "20 DATA #EA ' NOP",                  // $9800
    "30 DATA #EA ' NOP",                  // $9801
    "40 REM ' ]]",                        // closes BLOCKA at $9801
    "50 REM ' [[",                        // re-activate for the back-patch line
    "60 CALL #0:CALL #0 ' .BLOCKA:.BLOCKA_END",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!/^60 CALL #9800:CALL #9801/.test(p.lines[5].v)) return `line 5: ${p.lines[5].v}`;
  return null;
});

test('named block ends at end of program', () => {
  const p = mkProgram([
    "10 REM ' ORG $9800 .BLOCKA",
    "20 DATA #EA ' NOP",                  // $9800
    "30 DATA #60 ' RTS",                  // $9801; end of program closes BLOCKA
    "40 CALL #0 ' .BLOCKA_END",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!/^40 CALL #9801/.test(p.lines[3].v)) return `line 3: ${p.lines[3].v}`;
  return null;
});

test('empty named block errors', () => {
  const p = mkProgram([
    "10 REM ' ORG $9800 .BLOCKA",
    "20 REM ' ORG $9900 .BLOCKB",        // closes BLOCKA with zero bytes
    "30 DATA #60 ' RTS",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length === 0) return 'expected error for empty named block';
  if (!/named block BLOCKA has no assembled bytes/i.test(r.errors[0].message)) {
    return `wrong message: ${r.errors[0].message}`;
  }
  return null;
});

test('multiple named blocks, cross-referenced', () => {
  const p = mkProgram([
    "10 REM ' ORG $9800 .BLOCKA",
    "20 DATA #60 ' RTS",                  // $9800
    "30 REM ' ORG $9900 .BLOCKB",
    "40 DATA #60 ' RTS",                  // $9900
    "50 CALL #0:CALL #0 ' .BLOCKA_END:.BLOCKB_END",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!/^50 CALL #9800:CALL #9900/.test(p.lines[4].v)) return `line 4: ${p.lines[4].v}`;
  return null;
});

// ── FOR back-patching ─────────────────────────────────────────────────────

test('FOR/TO two-site back-patch with named block', () => {
  const p = mkProgram([
    "10 REM ' ORG $9800 .BLOCKA",
    "20 DATA #EA ' NOP",
    "30 DATA #EA ' NOP",
    "40 DATA #60 ' RTS",                   // $9800-$9802 assembled
    "50 FOR I=#0 TO #0:READ X:POKE I,X:NEXT ' .BLOCKA:.BLOCKA_END:-",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!/^50 FOR I=#9800 TO #9802/.test(p.lines[4].v)) return `line 4: ${p.lines[4].v}`;
  return null;
});

test('FOR/TO directive count mismatch errors', () => {
  const p = mkProgram([
    "10 REM ' ORG $9800 .BLOCKA",
    "20 DATA #60 ' RTS",
    "30 FOR I=#0 TO #0:NEXT ' .BLOCKA",    // only 1 directive, need 2 for FOR+TO
  ]);
  const r = applyAssembler(p);
  if (r.errors.length === 0) return 'expected directive count mismatch';
  if (!/doesn't match 2 patch sites/i.test(r.errors[0].message)) {
    return `wrong message: ${r.errors[0].message}`;
  }
  return null;
});

test('FOR/TO decimal literal preserves decimal format', () => {
  const p = mkProgram([
    "10 REM ' ORG $9800 .BLOCKA",
    "20 DATA #60 ' RTS",                   // $9800
    "30 FOR I=0 TO 0:NEXT ' .BLOCKA:.BLOCKA_END",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  // Decimal patch: $9800 = 38912, block is 1 byte so _END = $9800 = 38912.
  if (!/^30 FOR I=38912 TO 38912/.test(p.lines[2].v)) return `line 2: ${p.lines[2].v}`;
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
