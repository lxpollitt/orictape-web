#!/usr/bin/env npx tsx
/**
 * Ad-hoc scenario tests for the Phase 1 6502 assembler.
 *
 * Covers:
 *   - One instruction per Phase-1 mnemonic (smoke test the opcode table).
 *   - Every supported addressing mode on LDA (widest coverage in Phase 1).
 *   - ZP↔ABS resolution, including the explicit 4-hex-digit "force wide" path.
 *   - Error paths: unknown mnemonic, bad operand syntax, mode unsupported,
 *     values out of byte / 16-bit range.
 *   - Round-trip vs `disassemble` for every legal Phase-1 opcode: bytes →
 *     disassemble → assemble → same bytes.
 *
 * Not part of CI — just a quick sanity check during development.
 */

import { assemble } from '../src/assembler6502';
import { disassemble } from '../src/disassembler6502';

// ── Runner glue ──────────────────────────────────────────────────────────────

type Test = { name: string; run: () => string | null };
const tests: Test[] = [];
function test(name: string, run: () => string | null) { tests.push({ name, run }); }

/** Compare two byte arrays; return null on match, or a mismatch description. */
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

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

/** Assemble helper: returns the bytes if there are no errors, else throws
 *  with the first error message.  Makes positive-path tests read cleanly. */
function asm(source: string): number[] {
  const { bytes, errors } = assemble(source, 0x0000);
  if (errors.length > 0) throw new Error(`${source} → ${errors.map(e => e.message).join('; ')}`);
  return bytes;
}

/** Assemble a source that is expected to fail; return the first error
 *  message, or null if it unexpectedly succeeded. */
function asmErr(source: string): string | null {
  const { bytes, errors } = assemble(source, 0x0000);
  if (errors.length === 0) return null;
  // When there's an error, bytes should be empty.
  if (bytes.length !== 0) return `expected empty bytes on error, got [${bytes.map(hex2).join(' ')}]`;
  return errors[0].message;
}

// ── Per-mnemonic smoke tests ────────────────────────────────────────────────

test('LDA #$BB → A9 BB', () => compareBytes(asm('LDA #$BB'), [0xA9, 0xBB]));
test('LDX #$42 → A2 42', () => compareBytes(asm('LDX #$42'), [0xA2, 0x42]));
test('LDY #$00 → A0 00', () => compareBytes(asm('LDY #$00'), [0xA0, 0x00]));
test('STA $80  → 85 80', () => compareBytes(asm('STA $80'),  [0x85, 0x80]));
test('STX $04  → 86 04', () => compareBytes(asm('STX $04'),  [0x86, 0x04]));
test('STY $05  → 84 05', () => compareBytes(asm('STY $05'),  [0x84, 0x05]));
test('RTS      → 60',    () => compareBytes(asm('RTS'),      [0x60]));

// ── Addressing modes on LDA ──────────────────────────────────────────────────

test('LDA IMM — immediate hex',     () => compareBytes(asm('LDA #$BB'),     [0xA9, 0xBB]));
test('LDA IMM — immediate decimal', () => compareBytes(asm('LDA #40'),      [0xA9, 0x28]));
test('LDA ZP',                      () => compareBytes(asm('LDA $04'),      [0xA5, 0x04]));
test('LDA ZPX',                     () => compareBytes(asm('LDA $04,X'),    [0xB5, 0x04]));
test('LDA ABS',                     () => compareBytes(asm('LDA $1234'),    [0xAD, 0x34, 0x12]));
test('LDA ABX',                     () => compareBytes(asm('LDA $1234,X'),  [0xBD, 0x34, 0x12]));
test('LDA ABY',                     () => compareBytes(asm('LDA $1234,Y'),  [0xB9, 0x34, 0x12]));
test('LDA IZX',                     () => compareBytes(asm('LDA ($80,X)'),  [0xA1, 0x80]));
test('LDA IZY',                     () => compareBytes(asm('LDA ($04),Y'),  [0xB1, 0x04]));

// ── ZP vs ABS resolution ─────────────────────────────────────────────────────

// $HH → 2 hex digits → prefer ZP; LDA supports ZP → opcode A5.
test('LDA $BB    → A5 BB (ZP)',            () => compareBytes(asm('LDA $BB'),   [0xA5, 0xBB]));
// $HHHH → 4 hex digits → force wide → ABS → opcode AD.
test('LDA $00BB  → AD BB 00 (forced ABS)', () => compareBytes(asm('LDA $00BB'), [0xAD, 0xBB, 0x00]));
// $HHH (3 hex digits) → still forceWide in our rule (>=3 digits) → ABS.
test('LDA $0BB   → AD BB 00 (3-digit hex forces ABS)',
  () => compareBytes(asm('LDA $0BB'), [0xAD, 0xBB, 0x00]));
// Decimal < 256 → no forceWide → prefer ZP.
test('LDA 40     → A5 28 (ZP from decimal)',
  () => compareBytes(asm('LDA 40'), [0xA5, 0x28]));
// Decimal >= 256 → value doesn't fit in byte → ABS.
test('LDA 300    → AD … (ABS from decimal)',
  () => compareBytes(asm('LDA 300'), [0xAD, 0x2C, 0x01]));

// Indexed variants pick ZPX over ABX when value fits and not forced.
test('LDA $04,X   → B5 04 (ZPX preferred)',   () => compareBytes(asm('LDA $04,X'),   [0xB5, 0x04]));
test('LDA $0004,X → BD 04 00 (forced ABX)',   () => compareBytes(asm('LDA $0004,X'), [0xBD, 0x04, 0x00]));
test('LDA $04,Y   → B9 04 00 (no ZPY on LDA → falls back to ABY)',
  () => compareBytes(asm('LDA $04,Y'), [0xB9, 0x04, 0x00]));

// LDX ZPY exists and should be preferred for $04,Y.
test('LDX $04,Y   → B6 04 (LDX ZPY preferred)', () => compareBytes(asm('LDX $04,Y'), [0xB6, 0x04]));
test('LDX $1234,Y → BE 34 12 (LDX ABY)',        () => compareBytes(asm('LDX $1234,Y'), [0xBE, 0x34, 0x12]));

// STA ZPX exists; STA ABY exists; STA has no ZPY (so STA $04,Y → ABY).
test('STA $04,X   → 95 04 (STA ZPX)',       () => compareBytes(asm('STA $04,X'),   [0x95, 0x04]));
test('STA $04,Y   → 99 04 00 (STA ABY)',    () => compareBytes(asm('STA $04,Y'),   [0x99, 0x04, 0x00]));

// ── Whitespace / casing ─────────────────────────────────────────────────────

test('leading/trailing whitespace ignored',
  () => compareBytes(asm('   LDA #$BB   '), [0xA9, 0xBB]));
test('lowercase mnemonic accepted',
  () => compareBytes(asm('lda #$bb'), [0xA9, 0xBB]));
test('mixed case accepted',
  () => compareBytes(asm('Lda #$Bb'), [0xA9, 0xBB]));
test('extra spaces between mnemonic and operand',
  () => compareBytes(asm('LDA     #$BB'), [0xA9, 0xBB]));

// ── Error paths ──────────────────────────────────────────────────────────────

test('unknown mnemonic', () => {
  const err = asmErr('FOO #$BB');
  if (err === null) return 'expected error, got success';
  if (!/unknown mnemonic/i.test(err)) return `wrong message: ${err}`;
  return null;
});

test('mnemonic does not support IMM (STA #$BB)', () => {
  const err = asmErr('STA #$BB');
  if (err === null) return 'expected error, got success';
  if (!/does not support/i.test(err)) return `wrong message: ${err}`;
  return null;
});

test('mnemonic does not support IMP (LDA alone)', () => {
  const err = asmErr('LDA');
  if (err === null) return 'expected error, got success';
  if (!/does not support/i.test(err)) return `wrong message: ${err}`;
  return null;
});

test('RTS does not accept operand (RTS $04)', () => {
  // RTS only has IMP; $04 parses as {ZP, ABS} candidates — neither matches.
  const err = asmErr('RTS $04');
  if (err === null) return 'expected error, got success';
  if (!/does not support/i.test(err)) return `wrong message: ${err}`;
  return null;
});

test('immediate out of byte range (LDA #300)', () => {
  const err = asmErr('LDA #300');
  if (err === null) return 'expected error, got success';
  if (!/out of byte range/i.test(err)) return `wrong message: ${err}`;
  return null;
});

test('address out of 16-bit range (LDA 70000)', () => {
  const err = asmErr('LDA 70000');
  if (err === null) return 'expected error, got success';
  if (!/out of 16-bit range/i.test(err)) return `wrong message: ${err}`;
  return null;
});

test('bad hex literal (LDA #$XY)', () => {
  const err = asmErr('LDA #$XY');
  if (err === null) return 'expected error, got success';
  if (!/invalid hex literal/i.test(err)) return `wrong message: ${err}`;
  return null;
});

test('unrecognised literal (LDA #abc)', () => {
  const err = asmErr('LDA #abc');
  if (err === null) return 'expected error, got success';
  if (!/unrecognised numeric literal/i.test(err)) return `wrong message: ${err}`;
  return null;
});

test('garbled syntax (just punctuation)', () => {
  const err = asmErr('!!');
  if (err === null) return 'expected error, got success';
  if (!/invalid instruction syntax/i.test(err)) return `wrong message: ${err}`;
  return null;
});

test('IZX pointer out of ZP range (LDA ($1234,X))', () => {
  const err = asmErr('LDA ($1234,X)');
  if (err === null) return 'expected error, got success';
  if (!/IZX pointer out of ZP range/i.test(err)) return `wrong message: ${err}`;
  return null;
});

test('empty source yields no bytes and no errors', () => {
  const { bytes, errors } = assemble('', 0x0000);
  if (bytes.length !== 0) return `expected empty bytes, got [${bytes.map(hex2).join(' ')}]`;
  if (errors.length !== 0) return `expected no errors, got ${errors[0].message}`;
  return null;
});

// ── Round-trip: disassemble → assemble → same bytes ──────────────────────────
//
// The disassembler and assembler must be inverses.  For every legal Phase-1
// opcode, we fabricate plausible operand bytes, disassemble, strip the
// "$ADDR: HH HH HH  " prefix, and re-assemble the mnemonic+operand back to
// the same byte sequence.

/** Parse one line of the disassembler's output and return just the
 *  mnemonic+operand portion (the bit after the two-space separator). */
function extractAsmPart(line: string): string {
  const i = line.indexOf('  ');  // two-space separator before the mnemonic
  if (i < 0) throw new Error(`unexpected disassembly line format: ${line}`);
  return line.slice(i + 2).trim();
}

/** The Phase-1 opcodes we assemble: must match the set() calls in
 *  assembler6502.ts.  Listed explicitly so tests catch accidental drift. */
const PHASE1_OPCODES = [
  0xA9, 0xA5, 0xB5, 0xAD, 0xBD, 0xB9, 0xA1, 0xB1,  // LDA
  0xA2, 0xA6, 0xB6, 0xAE, 0xBE,                    // LDX
  0xA0, 0xA4, 0xB4, 0xAC, 0xBC,                    // LDY
  0x85, 0x95, 0x8D, 0x9D, 0x99, 0x81, 0x91,        // STA
  0x86, 0x96, 0x8E,                                // STX
  0x84, 0x94, 0x8C,                                // STY
  0x60,                                            // RTS
];

test('round-trip: disassemble → assemble for every Phase-1 opcode', () => {
  for (const op of PHASE1_OPCODES) {
    // Use distinct, non-zero operand bytes so ZP/ABS distinction is exercised.
    // For 1-byte-operand instructions only the first is consumed; for 2-byte
    // instructions both are.
    const bytes = [op, 0xBB, 0x12];
    const lines = disassemble(bytes, 0x1000);
    if (lines.length === 0) return `opcode $${hex2(op)}: no disassembly`;
    const asmPart = extractAsmPart(lines[0]);
    const { bytes: out, errors } = assemble(asmPart, 0x1000);
    if (errors.length > 0) return `opcode $${hex2(op)} (${asmPart}): ${errors[0].message}`;
    // Consume only as many input bytes as this instruction uses.
    const want = bytes.slice(0, out.length);
    const err = compareBytes(out, want, `opcode $${hex2(op)} (${asmPart})`);
    if (err) return err;
  }
  return null;
});

// A few pointed round-trip spot-checks to catch subtle formatting drift.
test('round-trip spot: LDA ZP  (A5 BB) → "LDA $BB" → A5 BB',
  () => compareBytes(asm(extractAsmPart(disassemble([0xA5, 0xBB], 0)[0])), [0xA5, 0xBB]));
test('round-trip spot: LDA ABS (AD BB 12) → "LDA $12BB" → AD BB 12',
  () => compareBytes(asm(extractAsmPart(disassemble([0xAD, 0xBB, 0x12], 0)[0])), [0xAD, 0xBB, 0x12]));
test('round-trip spot: LDA IZX (A1 80) → "LDA ($80,X)" → A1 80',
  () => compareBytes(asm(extractAsmPart(disassemble([0xA1, 0x80], 0)[0])), [0xA1, 0x80]));
test('round-trip spot: LDA IZY (B1 04) → "LDA ($04),Y" → B1 04',
  () => compareBytes(asm(extractAsmPart(disassemble([0xB1, 0x04], 0)[0])), [0xB1, 0x04]));
test('round-trip spot: STA ABY (99 34 12) → "STA $1234,Y" → 99 34 12',
  () => compareBytes(asm(extractAsmPart(disassemble([0x99, 0x34, 0x12], 0)[0])), [0x99, 0x34, 0x12]));
test('round-trip spot: LDX ZPY (B6 04) → "LDX $04,Y" → B6 04',
  () => compareBytes(asm(extractAsmPart(disassemble([0xB6, 0x04], 0)[0])), [0xB6, 0x04]));
test('round-trip spot: RTS (60) → "RTS" → 60',
  () => compareBytes(asm(extractAsmPart(disassemble([0x60], 0)[0])), [0x60]));

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
