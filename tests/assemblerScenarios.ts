#!/usr/bin/env npx tsx
/**
 * Ad-hoc scenario tests for the Phase 2 6502 assembler.
 *
 * Covers:
 *   - One instruction per mnemonic family (smoke test the opcode table).
 *   - Every supported addressing mode on LDA (widest ALU-op coverage), plus
 *     targeted coverage of ACC (shifts/rotates) and IND (JMP).
 *   - ZP↔ABS resolution, including the explicit 3+hex-digit "force wide" path.
 *   - Numeric literal forms: hex, decimal, binary (%…), ASCII ('c).
 *   - Error paths: unknown mnemonic, bad operand syntax, mode unsupported,
 *     values out of byte / 16-bit range, malformed literals.
 *   - Round-trip vs `disassemble` for every legal non-REL opcode: bytes →
 *     disassemble → assemble → same bytes.  REL is skipped (needs labels).
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

// ── Phase 2: new mnemonic families (smoke) ───────────────────────────────────

test('BRK → 00',          () => compareBytes(asm('BRK'),      [0x00]));
test('PHP → 08',          () => compareBytes(asm('PHP'),      [0x08]));
test('CLC → 18',          () => compareBytes(asm('CLC'),      [0x18]));
test('SEC → 38',          () => compareBytes(asm('SEC'),      [0x38]));
test('RTI → 40',          () => compareBytes(asm('RTI'),      [0x40]));
test('NOP → EA',          () => compareBytes(asm('NOP'),      [0xEA]));
test('JSR $1234 → 20 34 12',        () => compareBytes(asm('JSR $1234'), [0x20, 0x34, 0x12]));
test('JMP $1234 → 4C 34 12',        () => compareBytes(asm('JMP $1234'), [0x4C, 0x34, 0x12]));
test('ORA #$FF → 09 FF',            () => compareBytes(asm('ORA #$FF'),  [0x09, 0xFF]));
test('AND $04  → 25 04',            () => compareBytes(asm('AND $04'),   [0x25, 0x04]));
test('EOR ($80,X) → 41 80',         () => compareBytes(asm('EOR ($80,X)'), [0x41, 0x80]));
test('ADC ($04),Y → 71 04',         () => compareBytes(asm('ADC ($04),Y'), [0x71, 0x04]));
test('CMP $1234 → CD 34 12',        () => compareBytes(asm('CMP $1234'), [0xCD, 0x34, 0x12]));
test('CPX #$10 → E0 10',            () => compareBytes(asm('CPX #$10'),  [0xE0, 0x10]));
test('CPY #$10 → C0 10',            () => compareBytes(asm('CPY #$10'),  [0xC0, 0x10]));
test('SBC $04 → E5 04',             () => compareBytes(asm('SBC $04'),   [0xE5, 0x04]));
test('BIT $1234 → 2C 34 12',        () => compareBytes(asm('BIT $1234'), [0x2C, 0x34, 0x12]));
test('INC $04 → E6 04',             () => compareBytes(asm('INC $04'),   [0xE6, 0x04]));
test('DEC $04 → C6 04',             () => compareBytes(asm('DEC $04'),   [0xC6, 0x04]));
test('INX → E8',                    () => compareBytes(asm('INX'), [0xE8]));
test('INY → C8',                    () => compareBytes(asm('INY'), [0xC8]));
test('DEX → CA',                    () => compareBytes(asm('DEX'), [0xCA]));
test('DEY → 88',                    () => compareBytes(asm('DEY'), [0x88]));
test('TAX → AA',                    () => compareBytes(asm('TAX'), [0xAA]));
test('TAY → A8',                    () => compareBytes(asm('TAY'), [0xA8]));
test('TXA → 8A',                    () => compareBytes(asm('TXA'), [0x8A]));
test('TYA → 98',                    () => compareBytes(asm('TYA'), [0x98]));
test('TSX → BA',                    () => compareBytes(asm('TSX'), [0xBA]));
test('TXS → 9A',                    () => compareBytes(asm('TXS'), [0x9A]));
test('PHA → 48',                    () => compareBytes(asm('PHA'), [0x48]));
test('PLA → 68',                    () => compareBytes(asm('PLA'), [0x68]));
test('PLP → 28',                    () => compareBytes(asm('PLP'), [0x28]));
test('CLI → 58',                    () => compareBytes(asm('CLI'), [0x58]));
test('CLD → D8',                    () => compareBytes(asm('CLD'), [0xD8]));
test('CLV → B8',                    () => compareBytes(asm('CLV'), [0xB8]));
test('SEI → 78',                    () => compareBytes(asm('SEI'), [0x78]));
test('SED → F8',                    () => compareBytes(asm('SED'), [0xF8]));

// ── Phase 2: ACC (accumulator) mode ──────────────────────────────────────────

test('ASL A → 0A (accumulator)',    () => compareBytes(asm('ASL A'),  [0x0A]));
test('ASL   → 0A (implicit ACC)',   () => compareBytes(asm('ASL'),    [0x0A]));
test('LSR A → 4A',                  () => compareBytes(asm('LSR A'),  [0x4A]));
test('LSR   → 4A',                  () => compareBytes(asm('LSR'),    [0x4A]));
test('ROL A → 2A',                  () => compareBytes(asm('ROL A'),  [0x2A]));
test('ROR A → 6A',                  () => compareBytes(asm('ROR A'),  [0x6A]));
test('ASL $04 → 06 04 (ZP form)',   () => compareBytes(asm('ASL $04'), [0x06, 0x04]));
test('ASL $1234 → 0E 34 12 (ABS)',  () => compareBytes(asm('ASL $1234'), [0x0E, 0x34, 0x12]));

// ── Phase 2: IND mode (JMP only) ─────────────────────────────────────────────

test('JMP ($FFFC) → 6C FC FF',      () => compareBytes(asm('JMP ($FFFC)'), [0x6C, 0xFC, 0xFF]));
test('JMP ($1234) → 6C 34 12',      () => compareBytes(asm('JMP ($1234)'), [0x6C, 0x34, 0x12]));
// IND on a short literal is still legal syntax; value just fits in a byte.
test('JMP ($80) → 6C 80 00',        () => compareBytes(asm('JMP ($80)'),   [0x6C, 0x80, 0x00]));

test('IND out of 16-bit range (JMP ($10000))', () => {
  const err = asmErr('JMP ($10000)');
  if (err === null) return 'expected error, got success';
  if (!/IND address out of 16-bit range/i.test(err)) return `wrong message: ${err}`;
  return null;
});

test('ACC mode rejected when unsupported (LDA A)', () => {
  // LDA has no ACC opcode, so `LDA A` should fail.
  const err = asmErr('LDA A');
  if (err === null) return 'expected error, got success';
  if (!/does not support/i.test(err)) return `wrong message: ${err}`;
  return null;
});

// ── Phase 2: binary and ASCII literals ───────────────────────────────────────

test('binary immediate (LDA #%01111111 → A9 7F)',
  () => compareBytes(asm('LDA #%01111111'), [0xA9, 0x7F]));
test('binary immediate zero-pad (LDA #%00000001 → A9 01)',
  () => compareBytes(asm('LDA #%00000001'), [0xA9, 0x01]));
test('binary operand at ZP (LDA %10000000 → A5 80)',
  () => compareBytes(asm('LDA %10000000'), [0xA5, 0x80]));
test('binary operand ≥256 uses ABS (LDA %100000000 → AD 00 01)',
  () => compareBytes(asm('LDA %100000000'), [0xAD, 0x00, 0x01]));

test("ASCII immediate (LDA #'s → A9 73)",
  () => compareBytes(asm("LDA #'s"), [0xA9, 0x73]));
test("ASCII immediate uppercase (LDA #'A → A9 41)",
  () => compareBytes(asm("LDA #'A"), [0xA9, 0x41]));
test("ASCII ZP operand (LDA 's → A5 73)",
  () => compareBytes(asm("LDA 's"), [0xA5, 0x73]));

test('bad binary literal (LDA #%123)', () => {
  const err = asmErr('LDA #%123');
  if (err === null) return 'expected error, got success';
  if (!/invalid binary literal/i.test(err)) return `wrong message: ${err}`;
  return null;
});

test("bad ASCII literal (LDA #'ab)", () => {
  const err = asmErr("LDA #'ab");
  if (err === null) return 'expected error, got success';
  if (!/invalid ASCII literal/i.test(err)) return `wrong message: ${err}`;
  return null;
});

test("empty ASCII literal (LDA #')", () => {
  const err = asmErr("LDA #'");
  if (err === null) return 'expected error, got success';
  if (!/invalid ASCII literal/i.test(err)) return `wrong message: ${err}`;
  return null;
});

// ── Round-trip: disassemble → assemble → same bytes ──────────────────────────
//
// The disassembler and assembler must be inverses.  For every legal non-REL
// opcode, we fabricate plausible operand bytes, disassemble, strip the
// "$ADDR: HH HH HH  " prefix, and re-assemble the mnemonic+operand back to
// the same byte sequence.  REL (branches) is skipped because operand
// formatting yields a target address whose re-assembly needs labels.

/** Parse one line of the disassembler's output and return just the
 *  mnemonic+operand portion (the bit after the two-space separator). */
function extractAsmPart(line: string): string {
  const i = line.indexOf('  ');  // two-space separator before the mnemonic
  if (i < 0) throw new Error(`unexpected disassembly line format: ${line}`);
  return line.slice(i + 2).trim();
}

/** REL-mode opcodes (branch instructions).  Skipped by the round-trip
 *  test — Phase 2 can't assemble branches, only Phase 4 with labels. */
const REL_OPCODES = new Set<number>([
  0x10, // BPL
  0x30, // BMI
  0x50, // BVC
  0x70, // BVS
  0x90, // BCC
  0xB0, // BCS
  0xD0, // BNE
  0xF0, // BEQ
]);

test('round-trip: disassemble → assemble for every legal non-REL opcode', () => {
  let covered = 0;
  for (let op = 0; op < 256; op++) {
    if (REL_OPCODES.has(op)) continue;
    // Use distinct, non-zero operand bytes so ZP/ABS distinction is exercised.
    const bytes = [op, 0xBB, 0x12];
    const lines = disassemble(bytes, 0x1000);
    if (lines.length === 0) return `opcode $${hex2(op)}: no disassembly`;
    const asmPart = extractAsmPart(lines[0]);
    // Illegal/unknown opcodes disassemble as "???" — skip them.
    if (asmPart === '???') continue;
    const { bytes: out, errors } = assemble(asmPart, 0x1000);
    if (errors.length > 0) return `opcode $${hex2(op)} (${asmPart}): ${errors[0].message}`;
    // Consume only as many input bytes as this instruction uses.
    const want = bytes.slice(0, out.length);
    const err = compareBytes(out, want, `opcode $${hex2(op)} (${asmPart})`);
    if (err) return err;
    covered++;
  }
  // Sanity: 151 official opcodes - 8 REL = 143 expected.
  if (covered !== 143) return `expected 143 opcodes covered, got ${covered}`;
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
test('round-trip spot: ASL ACC (0A) → "ASL A" → 0A',
  () => compareBytes(asm(extractAsmPart(disassemble([0x0A], 0)[0])), [0x0A]));
test('round-trip spot: JMP IND (6C FC FF) → "JMP ($FFFC)" → 6C FC FF',
  () => compareBytes(asm(extractAsmPart(disassemble([0x6C, 0xFC, 0xFF], 0)[0])), [0x6C, 0xFC, 0xFF]));
test('round-trip spot: JSR ABS (20 34 12) → "JSR $1234" → 20 34 12',
  () => compareBytes(asm(extractAsmPart(disassemble([0x20, 0x34, 0x12], 0)[0])), [0x20, 0x34, 0x12]));

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
