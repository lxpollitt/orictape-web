#!/usr/bin/env npx tsx
/**
 * Ad-hoc scenario tests for the Phase 4 6502 assembler.
 *
 * Covers:
 *   - One instruction per mnemonic family (smoke test the opcode table).
 *   - Every supported addressing mode on LDA (widest ALU-op coverage), plus
 *     targeted coverage of ACC (shifts/rotates) and IND (JMP).
 *   - ZP↔ABS resolution, including the explicit 3+hex-digit "force wide" path.
 *   - Numeric literal forms: hex, decimal, binary (%…), ASCII ('c).
 *   - Error paths: unknown mnemonic, bad operand syntax, mode unsupported,
 *     values out of byte / 16-bit range, malformed literals.
 *   - Round-trip vs `disassemble` for every legal non-REL opcode.
 *   - Multi-statement annotations (`:` separator), `;` end-of-annotation
 *     comments, ORG directive and endAddr PC tracking.
 *   - Labels and equates (single-annotation and cross-annotation via
 *     `assembleProgram`), forward and backward branches with REL offset
 *     computation, forward-reference "assume ABS" sizing rule, undefined
 *     symbol and redeclaration errors.
 *
 * Not part of CI — just a quick sanity check during development.
 */

import { assemble, assembleProgram } from '../src/assembler6502';
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
const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');

/** Assemble helper: returns the bytes if there are no errors, else throws
 *  with the first error message.  Makes positive-path tests read cleanly. */
function asm(source: string): number[] {
  const { bytes, errors } = assemble(source, 0x0000);
  if (errors.length > 0) throw new Error(`${source} → ${errors.map(e => e.message).join('; ')}`);
  return bytes;
}

/** Assemble a source that is expected to fail; return the first error
 *  message, or null if it unexpectedly succeeded.  Assumes single-statement:
 *  the failing statement emits no bytes, so bytes.length must be 0. */
function asmErr(source: string): string | null {
  const { bytes, errors } = assemble(source, 0x0000);
  if (errors.length === 0) return null;
  if (bytes.length !== 0) return `expected empty bytes on error, got [${bytes.map(hex2).join(' ')}]`;
  return errors[0].message;
}

/** Like `asmErr`, but doesn't require bytes to be empty — for multi-statement
 *  sources where the failing statement is interleaved with successful ones. */
function asmErrMulti(source: string): string | null {
  const { errors } = assemble(source, 0x0000);
  return errors.length === 0 ? null : errors[0].message;
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

// `#abc` parses as `immediate <symbol abc>`; with no `.abc` declared
// anywhere, the undefined-symbol error fires in pass 2.
test('undefined symbol as immediate (LDA #abc)', () => {
  const err = asmErr('LDA #abc');
  if (err === null) return 'expected error, got success';
  if (!/undefined symbol/i.test(err)) return `wrong message: ${err}`;
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

// ── Phase 3: multi-statement (`:` separator) ─────────────────────────────────

test('two statements: STX 1 : STY 2',
  () => compareBytes(asm('STX 1:STY 2'), [0x86, 0x01, 0x84, 0x02]));
test('two statements with spaces around `:`',
  () => compareBytes(asm('STX 1 : STY 2'), [0x86, 0x01, 0x84, 0x02]));
test('three statements',
  () => compareBytes(asm('LDA #$BB : STA $04 : RTS'), [0xA9, 0xBB, 0x85, 0x04, 0x60]));
test('trailing `:` (empty final statement)',
  () => compareBytes(asm('RTS:'), [0x60]));
test('leading `:` (empty first statement)',
  () => compareBytes(asm(':RTS'), [0x60]));
test('repeated `:` (empty middle statements)',
  () => compareBytes(asm('RTS::RTS'), [0x60, 0x60]));
test('whitespace-only statement between `:` ignored',
  () => compareBytes(asm('RTS :   : RTS'), [0x60, 0x60]));

// ── Phase 3: `;` end-of-annotation comments ──────────────────────────────────

test('trailing comment stripped',
  () => compareBytes(asm('LDA #$BB * load BB'), [0xA9, 0xBB]));
test('comment on its own line → no bytes',
  () => compareBytes(asm('* just a comment'), []));
test('comment eats subsequent `:` (no second statement)',
  () => compareBytes(asm('LDA #$01 * STA $04'), [0xA9, 0x01]));
test('comment after multi-statement',
  () => compareBytes(asm('STX 1 : STY 2 * save regs'), [0x86, 0x01, 0x84, 0x02]));
test('empty source',
  () => compareBytes(asm(''), []));
test('whitespace-only source',
  () => compareBytes(asm('   \t  '), []));

// ── Phase 3: ORG directive ───────────────────────────────────────────────────

test('ORG alone emits no bytes, updates endAddr', () => {
  const r = assemble('ORG $9800', 0x0000);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (r.bytes.length !== 0) return `expected no bytes, got [${r.bytes.map(hex2).join(' ')}]`;
  if (r.endAddr !== 0x9800) return `endAddr $${hex4(r.endAddr)} (want $9800)`;
  return null;
});

test('ORG then instruction', () => {
  const r = assemble('ORG $9800 : LDA #$BB', 0x0000);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  const err = compareBytes(r.bytes, [0xA9, 0xBB]);
  if (err) return err;
  if (r.endAddr !== 0x9802) return `endAddr $${hex4(r.endAddr)} (want $9802)`;
  return null;
});

test('instruction then ORG (endAddr reflects post-ORG)', () => {
  const r = assemble('LDA #$BB : ORG $9900', 0x1000);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  const err = compareBytes(r.bytes, [0xA9, 0xBB]);
  if (err) return err;
  if (r.endAddr !== 0x9900) return `endAddr $${hex4(r.endAddr)} (want $9900)`;
  return null;
});

test('multiple ORGs interleaved with instructions', () => {
  const r = assemble('LDA #$01 : ORG $9900 : LDA #$02 : ORG $AA00 : RTS', 0x1000);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  const err = compareBytes(r.bytes, [0xA9, 0x01, 0xA9, 0x02, 0x60]);
  if (err) return err;
  if (r.endAddr !== 0xAA01) return `endAddr $${hex4(r.endAddr)} (want $AA01)`;
  return null;
});

test('ORG decimal literal',
  () => {
    const r = assemble('ORG 39936', 0x0000);
    if (r.endAddr !== 0x9C00) return `endAddr $${hex4(r.endAddr)} (want $9C00)`;
    return null;
  });

test('ORG binary literal',
  () => {
    const r = assemble('ORG %1001100000000000', 0x0000);
    if (r.endAddr !== 0x9800) return `endAddr $${hex4(r.endAddr)} (want $9800)`;
    return null;
  });

test('ORG case-insensitive',
  () => {
    const r = assemble('org $9800', 0x0000);
    if (r.endAddr !== 0x9800) return `endAddr $${hex4(r.endAddr)} (want $9800)`;
    return null;
  });

test('ORG missing address', () => {
  const err = asmErrMulti('ORG');
  if (err === null) return 'expected error, got success';
  if (!/ORG requires an address/i.test(err)) return `wrong message: ${err}`;
  return null;
});

test('ORG out of 16-bit range', () => {
  const err = asmErrMulti('ORG $10000');
  if (err === null) return 'expected error, got success';
  if (!/ORG address out of 16-bit range/i.test(err)) return `wrong message: ${err}`;
  return null;
});

test('bad ORG literal', () => {
  const err = asmErrMulti('ORG $XY');
  if (err === null) return 'expected error, got success';
  if (!/invalid hex literal/i.test(err)) return `wrong message: ${err}`;
  return null;
});

// ── Phase 3: endAddr tracking ────────────────────────────────────────────────

test('endAddr = startAddr + bytes.length (no ORG)', () => {
  const r = assemble('LDA #$BB : STA $1234', 0x1000);
  if (r.endAddr !== 0x1005) return `endAddr $${hex4(r.endAddr)} (want $1005 = start + 5 bytes)`;
  return null;
});

test('endAddr = startAddr when empty source', () => {
  const r = assemble('', 0x1000);
  if (r.endAddr !== 0x1000) return `endAddr $${hex4(r.endAddr)} (want $1000)`;
  return null;
});

test('endAddr wraps at 16 bits', () => {
  // Start near the top of memory; LDA #$BB emits 2 bytes, wrapping past $FFFF.
  const r = assemble('LDA #$BB', 0xFFFF);
  if (r.endAddr !== 0x0001) return `endAddr $${hex4(r.endAddr)} (want $0001 — wrapped)`;
  return null;
});

// ── Phase 3: error collection across statements ──────────────────────────────

test('second statement errors, first still emitted', () => {
  const r = assemble('LDA #$BB : STA #1', 0x0000);
  if (r.errors.length !== 1) return `expected 1 error, got ${r.errors.length}`;
  const err = compareBytes(r.bytes, [0xA9, 0xBB]);
  if (err) return err;
  return null;
});

test('first statement errors, second still emitted', () => {
  const r = assemble('LDA #500 : STA $04', 0x0000);
  if (r.errors.length !== 1) return `expected 1 error, got ${r.errors.length}`;
  const err = compareBytes(r.bytes, [0x85, 0x04]);
  if (err) return err;
  return null;
});

test('multiple errors collected in one pass', () => {
  const r = assemble('LDA #500 : STA #1 : BOGUS', 0x0000);
  if (r.errors.length !== 3) return `expected 3 errors, got ${r.errors.length}: ${r.errors.map(e => e.message).join(' / ')}`;
  if (r.bytes.length !== 0) return `expected no bytes, got [${r.bytes.map(hex2).join(' ')}]`;
  return null;
});

test('ORG error doesn\'t block subsequent instructions', () => {
  const r = assemble('ORG $10000 : LDA #$BB', 0x0000);
  if (r.errors.length !== 1) return `expected 1 error, got ${r.errors.length}`;
  const err = compareBytes(r.bytes, [0xA9, 0xBB]);
  if (err) return err;
  return null;
});

// ── Phase 3: literal-aware splitting / commenting ────────────────────────────

test("`:` inside ASCII literal doesn't split statement",
  () => compareBytes(asm("LDA #':"), [0xA9, 0x3A]));   // ':' = 0x3A

test("`;` inside ASCII literal doesn't start comment",
  () => compareBytes(asm("LDA #';"), [0xA9, 0x3B]));   // ';' = 0x3B

test("ASCII literal then normal `:` after",
  () => compareBytes(asm("LDA #':  : RTS"), [0xA9, 0x3A, 0x60]));

// ── Phase 4: equates (same annotation) ───────────────────────────────────────

test('equate resolves to ZP form when value fits',
  () => compareBytes(asm('.LIVES = $04 : DEC LIVES'), [0xC6, 0x04]));

test('equate resolves to ABS when value ≥ 256',
  () => compareBytes(asm('.SCRN = $BB80 : LDA SCRN'), [0xAD, 0x80, 0xBB]));

test('equate forceWide ($0004) forces ABS even though value fits ZP',
  () => compareBytes(asm('.FOO = $0004 : LDA FOO'), [0xAD, 0x04, 0x00]));

test('equate in immediate (LDA #COLOR)',
  () => compareBytes(asm('.COLOR = 10 : LDA #COLOR'), [0xA9, 0x0A]));

test('equate in indirect indexed (LDA (PTR),Y)',
  () => compareBytes(asm('.PTR = $04 : LDA (PTR),Y'), [0xB1, 0x04]));

test('equate with underscore in name',
  () => compareBytes(asm('.A_B = 5 : LDA #A_B'), [0xA9, 0x05]));

test('equate in indexed X (LDA ARR,X)',
  () => compareBytes(asm('.ARR = $BB80 : LDA ARR,X'), [0xBD, 0x80, 0xBB]));

// Forward reference to an equate: pass 1 doesn't know the value, commits ABS.
// Pass 2 resolves LIVES=$04 but the committed mode is ABS, so we get 3 bytes.
test('forward ref to ZP-valued equate still emits ABS',
  () => compareBytes(asm('DEC LIVES : .LIVES = $04'), [0xCE, 0x04, 0x00]));

// ── Phase 4: labels and branches ─────────────────────────────────────────────

test('backward branch (.LOOP : NOP : BNE LOOP)',
  () => compareBytes(asm('.LOOP : NOP : BNE LOOP'), [0xEA, 0xD0, 0xFD]));

test('forward branch (BEQ SKIP : NOP : .SKIP : RTS)',
  () => compareBytes(asm('BEQ SKIP : NOP : .SKIP : RTS'), [0xF0, 0x01, 0xEA, 0x60]));

test('label via ORG (ORG $9800 : .START : RTS : BNE START)', () => {
  const r = assemble('ORG $9800 : .START : RTS : BNE START', 0x0000);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  return compareBytes(r.bytes, [0x60, 0xD0, 0xFD]);
});

test('branch-self: BPL back to self', () => {
  // BPL at offset 0, target = same instruction → offset = 0 - 2 = -2 = 0xFE.
  const r = assemble('.HERE : BPL HERE', 0x0000);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  return compareBytes(r.bytes, [0x10, 0xFE]);
});

test('branch at maximum positive offset (+127)', () => {
  // BEQ to a label 127+2 bytes ahead.  We construct 127 bytes of fill using
  // an ORG trick: place the label at exactly PC+2+127.
  const r = assemble('BEQ FAR : ORG $0081 : .FAR : RTS', 0x0000);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  // BEQ at $0000, pc+2=$0002, FAR=$0081, offset = 127 = 0x7F.
  return compareBytes(r.bytes.slice(0, 2), [0xF0, 0x7F]);
});

test('branch at maximum negative offset (-128)', () => {
  // Place label, then 126 filler bytes (NOP), then BNE LOOP which is 2 more
  // bytes — branch target is 128 bytes before pc+2.
  const filler = Array.from({ length: 126 }, () => 'NOP').join(':');
  const r = assemble(`.LOOP : ${filler} : BNE LOOP`, 0x0000);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  // BNE opcode+offset is the last 2 bytes: 0xD0, 0x80 (-128).
  return compareBytes(r.bytes.slice(-2), [0xD0, 0x80]);
});

test('branch out of range errors', () => {
  const err = asmErrMulti('.FAR = $1000 : BNE FAR');
  if (err === null) return 'expected error, got success';
  if (!/branch out of range/i.test(err)) return `wrong message: ${err}`;
  return null;
});

// ── Branch direct-offset operands (width-based interpretation) ───────────────
//
// Numeric operands to REL branches are interpreted as EITHER a target
// address (2-byte input: hex 3+ digits, label) OR a direct offset byte
// (1-byte input: hex ≤ 2 digits, decimal in [-128, +127]).  Decimal
// outside [-128, +127] errors to avoid ambiguity.

test('BNE -7 emits D0 F9 (direct signed offset)',
  () => compareBytes(asm('BNE -7'), [0xD0, 0xF9]));

test('BNE +5 emits D0 05 (explicit positive sign)',
  () => compareBytes(asm('BNE +5'), [0xD0, 0x05]));

test('BNE 5 emits D0 05 (bare positive decimal, direct offset)',
  () => compareBytes(asm('BNE 5'), [0xD0, 0x05]));

test('BNE -128 emits D0 80 (max negative)',
  () => compareBytes(asm('BNE -128'), [0xD0, 0x80]));

test('BNE 127 emits D0 7F (max positive signed decimal)',
  () => compareBytes(asm('BNE 127'), [0xD0, 0x7F]));

test('BNE $F9 emits D0 F9 (direct hex byte)',
  () => compareBytes(asm('BNE $F9'), [0xD0, 0xF9]));

test('BNE $FF emits D0 FF (hex byte, -1 signed)',
  () => compareBytes(asm('BNE $FF'), [0xD0, 0xFF]));

test('BNE $05 emits D0 05 (hex byte, forward)',
  () => compareBytes(asm('BNE $05'), [0xD0, 0x05]));

test('BNE direct offset is PC-independent', () => {
  // The same `BNE -7` at different PCs should produce identical bytes,
  // unlike target-address branches which depend on PC.
  const r1 = assemble('BNE -7', 0x0000);
  const r2 = assemble('BNE -7', 0x9800);
  if (r1.errors.length !== 0) return `r1 err: ${r1.errors[0].message}`;
  if (r2.errors.length !== 0) return `r2 err: ${r2.errors[0].message}`;
  return compareBytes(r1.bytes, r2.bytes, 'PC independence');
});

test('BNE 128 errors (decimal out of signed-byte range)', () => {
  const err = asmErrMulti('BNE 128');
  if (err === null) return 'expected error, got success';
  if (!/decimal branch operand 128 out of signed-byte range/i.test(err)) {
    return `wrong message: ${err}`;
  }
  return null;
});

test('BNE 249 errors (decimal out of signed-byte range)', () => {
  const err = asmErrMulti('BNE 249');
  if (err === null) return 'expected error, got success';
  if (!/decimal branch operand 249 out of signed-byte range/i.test(err)) {
    return `wrong message: ${err}`;
  }
  return null;
});

test('BNE 300 errors (decimal, out of signed-byte range)', () => {
  const err = asmErrMulti('BNE 300');
  if (err === null) return 'expected error, got success';
  if (!/decimal branch operand 300 out of signed-byte range/i.test(err)) {
    return `wrong message: ${err}`;
  }
  return null;
});

test('BNE -129 errors (below signed-byte range)', () => {
  const err = asmErrMulti('BNE -129');
  if (err === null) return 'expected error, got success';
  if (!/decimal branch operand -129 out of signed-byte range/i.test(err)) {
    return `wrong message: ${err}`;
  }
  return null;
});

test('BNE $9800 still works as target address (compute offset)', () => {
  // 4-digit hex → 2-byte target.  At PC=$9800: offset = $9800 - $9802 = -2.
  const r = assemble('BNE $9800', 0x9800);
  if (r.errors.length !== 0) return `unexpected error: ${r.errors[0].message}`;
  return compareBytes(r.bytes, [0xD0, 0xFE]);
});

test('BNE $0004 is a 2-byte target address (3+ digits = forceWide)', () => {
  // At PC=0: target $0004, offset = 4 - 2 = 2.
  const r = assemble('BNE $0004', 0x0000);
  if (r.errors.length !== 0) return `unexpected error: ${r.errors[0].message}`;
  return compareBytes(r.bytes, [0xD0, 0x02]);
});

test('equate with negative decimal works as direct offset', () => {
  // `.OFF = -7 : BNE OFF` — equate is decimal-in-range, direct offset.
  const r = assemble('.OFF = -7 : BNE OFF', 0x0000);
  if (r.errors.length !== 0) return `unexpected error: ${r.errors[0].message}`;
  return compareBytes(r.bytes, [0xD0, 0xF9]);
});

test('equate with out-of-range decimal errors', () => {
  const err = asmErrMulti('.VAL = 249 : BNE VAL');
  if (err === null) return 'expected error, got success';
  if (!/decimal branch operand 249 out of signed-byte range/i.test(err)) {
    return `wrong message: ${err}`;
  }
  return null;
});

// ── Phase 4: error paths (symbols) ───────────────────────────────────────────

test('undefined symbol (LDA UNDEFINED)', () => {
  const err = asmErrMulti('LDA UNDEFINED');
  if (err === null) return 'expected error, got success';
  if (!/undefined symbol.*UNDEFINED/i.test(err)) return `wrong message: ${err}`;
  return null;
});

test('redeclaration of equate', () => {
  const err = asmErrMulti('.FOO = 1 : .FOO = 2');
  if (err === null) return 'expected error, got success';
  if (!/already declared.*FOO/i.test(err)) return `wrong message: ${err}`;
  return null;
});

test('redeclaration of label', () => {
  const err = asmErrMulti('.LOOP : NOP : .LOOP : RTS');
  if (err === null) return 'expected error, got success';
  if (!/already declared.*LOOP/i.test(err)) return `wrong message: ${err}`;
  return null;
});

test('redeclaration across equate/label kinds', () => {
  const err = asmErrMulti('.FOO = 1 : .FOO');
  if (err === null) return 'expected error, got success';
  if (!/already declared.*FOO/i.test(err)) return `wrong message: ${err}`;
  return null;
});

test('identifier must start with a letter (.9FOO)', () => {
  const err = asmErrMulti('.9FOO = 1');
  if (err === null) return 'expected error, got success';
  if (!/invalid declaration/i.test(err)) return `wrong message: ${err}`;
  return null;
});

test('equate value must be a literal (.FOO = BAR)', () => {
  const err = asmErrMulti('.FOO = BAR');
  if (err === null) return 'expected error, got success';
  if (!/expected a literal/i.test(err)) return `wrong message: ${err}`;
  return null;
});

test('ORG requires a literal (ORG FOO)', () => {
  const err = asmErrMulti('ORG FOO');
  if (err === null) return 'expected error, got success';
  if (!/expected a literal/i.test(err)) return `wrong message: ${err}`;
  return null;
});

// ── Phase 4: assembleProgram (cross-annotation) ──────────────────────────────

test('equate on line 0, used on line 1', () => {
  const r = assembleProgram(['.LIVES = $04', 'DEC LIVES'], 0x0000);
  if (r.perLine[0].errors.length !== 0) return `line 0 error: ${r.perLine[0].errors[0].message}`;
  if (r.perLine[1].errors.length !== 0) return `line 1 error: ${r.perLine[1].errors[0].message}`;
  if (r.perLine[0].bytes.length !== 0) return `line 0 bytes should be empty`;
  return compareBytes(r.perLine[1].bytes, [0xC6, 0x04]);
});

test('label across lines (.LOOP, NOP, BNE LOOP)', () => {
  const r = assembleProgram(['.LOOP', 'NOP', 'BNE LOOP'], 0x0000);
  for (let i = 0; i < r.perLine.length; i++) {
    if (r.perLine[i].errors.length !== 0) return `line ${i}: ${r.perLine[i].errors[0].message}`;
  }
  if (r.perLine[0].bytes.length !== 0) return 'line 0 should be empty (label only)';
  let err = compareBytes(r.perLine[1].bytes, [0xEA], 'line 1'); if (err) return err;
  err = compareBytes(r.perLine[2].bytes, [0xD0, 0xFD], 'line 2'); if (err) return err;
  return null;
});

test('forward label across lines', () => {
  // Line 0: BEQ SKIP (forward ref to SKIP)
  // Line 1: NOP
  // Line 2: .SKIP
  // Line 3: RTS
  const r = assembleProgram(['BEQ SKIP', 'NOP', '.SKIP', 'RTS'], 0x0000);
  for (let i = 0; i < r.perLine.length; i++) {
    if (r.perLine[i].errors.length !== 0) return `line ${i}: ${r.perLine[i].errors[0].message}`;
  }
  let err = compareBytes(r.perLine[0].bytes, [0xF0, 0x01], 'line 0'); if (err) return err;
  err = compareBytes(r.perLine[1].bytes, [0xEA],       'line 1'); if (err) return err;
  if (r.perLine[2].bytes.length !== 0) return 'line 2 (label) should be empty';
  err = compareBytes(r.perLine[3].bytes, [0x60],       'line 3'); if (err) return err;
  return null;
});

test('error is attached to the originating line', () => {
  // Line 0 is fine; line 1 references an undefined symbol.
  const r = assembleProgram(['.FOO = 1', 'LDA BAR'], 0x0000);
  if (r.perLine[0].errors.length !== 0) return `line 0 unexpected error`;
  if (r.perLine[1].errors.length !== 1) return `line 1 expected 1 error, got ${r.perLine[1].errors.length}`;
  if (!/undefined symbol.*BAR/i.test(r.perLine[1].errors[0].message)) {
    return `wrong message: ${r.perLine[1].errors[0].message}`;
  }
  return null;
});

test('symbol table exposed on the program result', () => {
  const r = assembleProgram(['.LIVES = $04', '.SCRN = $BB80', '.LOOP', 'NOP'], 0x9800);
  if (r.symbols.get('LIVES')?.value !== 0x04) return 'LIVES not in symbol table';
  if (r.symbols.get('SCRN')?.value  !== 0xBB80) return 'SCRN not in symbol table';
  if (r.symbols.get('LOOP')?.value  !== 0x9800) return 'LOOP not at $9800';
  return null;
});

// ── Phase 4: ORG-missing error for ABS label references ─────────────────────
//
// When the caller passes no `startAddr` and the program contains no ORG,
// labels have no anchor to real memory.  Using such a label as an absolute
// address (JMP/JSR LABEL, LDA LABEL in ABS form, etc.) is an error.  REL
// branches, equates, and literals are all still fine.

test('no-ORG program with REL branches only: assembles', () => {
  const r = assembleProgram(['.LOOP : NOP : BNE LOOP']);
  if (r.perLine[0].errors.length !== 0) return `unexpected error: ${r.perLine[0].errors[0].message}`;
  return compareBytes(r.perLine[0].bytes, [0xEA, 0xD0, 0xFD]);
});

test('no-ORG program with equates only: assembles', () => {
  const r = assembleProgram(['.LIVES = $04 : DEC LIVES']);
  if (r.perLine[0].errors.length !== 0) return `unexpected error: ${r.perLine[0].errors[0].message}`;
  return compareBytes(r.perLine[0].bytes, [0xC6, 0x04]);
});

test('no-ORG program with ABS jump to label: errors', () => {
  const r = assembleProgram(['.LOOP : JMP LOOP']);
  if (r.perLine[0].errors.length !== 1) return `expected 1 error, got ${r.perLine[0].errors.length}`;
  const msg = r.perLine[0].errors[0].message;
  if (!/no ORG.*declared/i.test(msg)) return `wrong message: ${msg}`;
  if (!/LOOP/.test(msg)) return `message should mention the label: ${msg}`;
  return null;
});

test('no-ORG program with JSR to label: errors', () => {
  const r = assembleProgram(['.SUB : RTS : JSR SUB']);
  if (r.perLine[0].errors.length !== 1) return `expected 1 error, got ${r.perLine[0].errors.length}`;
  if (!/no ORG.*declared/i.test(r.perLine[0].errors[0].message)) {
    return `wrong message: ${r.perLine[0].errors[0].message}`;
  }
  return null;
});

test('no-ORG program with LDA label in ABS form: errors', () => {
  const r = assembleProgram(['.DATA_AREA : NOP : LDA DATA_AREA']);
  if (r.perLine[0].errors.length !== 1) return `expected 1 error, got ${r.perLine[0].errors.length}`;
  if (!/no ORG.*declared/i.test(r.perLine[0].errors[0].message)) {
    return `wrong message: ${r.perLine[0].errors[0].message}`;
  }
  return null;
});

test('ORG directive unlocks ABS label references', () => {
  const r = assembleProgram(['ORG $9800 : .LOOP : JMP LOOP']);
  if (r.perLine[0].errors.length !== 0) return `unexpected error: ${r.perLine[0].errors[0].message}`;
  // JMP LOOP at $9802, target $9800 → 4C 00 98.
  return compareBytes(r.perLine[0].bytes, [0x4C, 0x00, 0x98]);
});

test('explicit startAddr acts as implicit ORG', () => {
  const r = assembleProgram(['.LOOP : JMP LOOP'], 0x9800);
  if (r.perLine[0].errors.length !== 0) return `unexpected error: ${r.perLine[0].errors[0].message}`;
  return compareBytes(r.perLine[0].bytes, [0x4C, 0x00, 0x98]);
});

test('ORG on one line unlocks labels declared on another (cross-line)', () => {
  const r = assembleProgram([
    'ORG $9800',
    '.LOOP',
    'NOP',
    'JMP LOOP',
  ]);
  for (let i = 0; i < r.perLine.length; i++) {
    if (r.perLine[i].errors.length !== 0) return `line ${i}: ${r.perLine[i].errors[0].message}`;
  }
  // JMP LOOP at $9801, target $9800 → 4C 00 98 on line 3.
  return compareBytes(r.perLine[3].bytes, [0x4C, 0x00, 0x98]);
});

test('label declared before ORG used in ABS: errors (per-label anchoring)', () => {
  // `.PRE` declares at PC=0 (pre-ORG, unanchored).  ORG then jumps PC
  // to $9800.  Under per-label anchoring, PRE remains unanchored even
  // after the subsequent ORG — ORG only anchors labels declared AFTER
  // it, not labels declared before it.  Using PRE in ABS errors.
  const r = assembleProgram(['.PRE : ORG $9800 : LDA PRE']);
  const errs = r.perLine[0].errors;
  if (errs.length !== 1) return `expected 1 error, got ${errs.length}`;
  if (!/absolute addressing.*no ORG/i.test(errs[0].message)) {
    return `wrong error: ${errs[0].message}`;
  }
  return null;
});

// ── Phase 4: worked mini-program (spec-style) ────────────────────────────────
//
// Models the structure of the spec's example: two equates on a REM line,
// ORG on another REM line, then code lines.  We verify the expected bytes
// for each code line.  (Exact branch offset computed from layout.)
test('worked mini-program (structured like spec example)', () => {
  const lines = [
    '.LIVES = $04 : .SCRN = $BB80',
    'ORG $9800',
    'STX 1 : STY 2',             // $9800: 4 bytes
    '.LOOPA : LDY #0',           // $9804: 2 bytes  (LOOPA = $9804)
    'LDA (1),Y',                 // $9806: 2 bytes
    'STA 3',                     // $9808: 2 bytes
    'DEC LIVES',                 // $980A: 2 bytes (DEC ZP, LIVES = $04)
    'BNE LOOPA',                 // $980C: 2 bytes → offset = $9804 - $980E = -10 = 0xF6
    'RTS',                       // $980E: 1 byte
  ];
  const r = assembleProgram(lines, 0x0000);  // startAddr ignored once ORG fires
  for (let i = 0; i < r.perLine.length; i++) {
    if (r.perLine[i].errors.length !== 0) return `line ${i}: ${r.perLine[i].errors[0].message}`;
  }
  const expected: number[][] = [
    [],                              // line 0: equates
    [],                              // line 1: ORG
    [0x86, 0x01, 0x84, 0x02],        // STX 1 : STY 2
    [0xA0, 0x00],                    // LDY #0
    [0xB1, 0x01],                    // LDA (1),Y
    [0x85, 0x03],                    // STA 3
    [0xC6, 0x04],                    // DEC LIVES (ZP)
    [0xD0, 0xF6],                    // BNE LOOPA (offset -10)
    [0x60],                          // RTS
  ];
  for (let i = 0; i < lines.length; i++) {
    const err = compareBytes(r.perLine[i].bytes, expected[i], `line ${i}`);
    if (err) return err;
  }
  if (r.endAddr !== 0x980F) return `endAddr $${hex4(r.endAddr)} (want $980F)`;
  return null;
});

// ── Round-trip: disassemble → assemble → same bytes ──────────────────────────
//
// The disassembler and assembler must be inverses.  For every legal opcode,
// we fabricate plausible operand bytes, disassemble, strip the
// "$ADDR: HH HH HH  " prefix, and re-assemble the mnemonic+operand back to
// the same byte sequence.  Includes REL (branches) — the disassembler
// renders them as absolute targets and the assembler recomputes the offset
// using the startAddr we pass in.

/** Parse one line of the disassembler's output and return just the
 *  mnemonic+operand portion (the bit after the two-space separator). */
function extractAsmPart(line: string): string {
  const i = line.indexOf('  ');  // two-space separator before the mnemonic
  if (i < 0) throw new Error(`unexpected disassembly line format: ${line}`);
  return line.slice(i + 2).trim();
}

test('round-trip: disassemble → assemble for every legal opcode', () => {
  let covered = 0;
  for (let op = 0; op < 256; op++) {
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
  // Sanity: 151 official 6502 opcodes.
  if (covered !== 151) return `expected 151 opcodes covered, got ${covered}`;
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

test('round-trip spot: BNE REL (D0 02) at $1000 → "BNE $1004" → D0 02', () => {
  // Disassembler renders BNE as absolute target $1004.  Re-assembling with
  // startAddr $1000 must recompute offset = 2.
  const r = assemble(extractAsmPart(disassemble([0xD0, 0x02], 0x1000)[0]), 0x1000);
  if (r.errors.length !== 0) return r.errors[0].message;
  return compareBytes(r.bytes, [0xD0, 0x02]);
});

test('round-trip spot: BEQ REL negative (F0 FE) at $1000 → "BEQ $1000" → F0 FE', () => {
  // Branch-to-self: $1000 - ($1000+2) = -2 = 0xFE.
  const r = assemble(extractAsmPart(disassemble([0xF0, 0xFE], 0x1000)[0]), 0x1000);
  if (r.errors.length !== 0) return r.errors[0].message;
  return compareBytes(r.bytes, [0xF0, 0xFE]);
});

// ── DB (data bytes) directive ───────────────────────────────────────────────

test('DB single hex byte', () =>
  compareBytes(asm('DB $42'), [0x42]));

test('DB hex word emits little-endian', () =>
  compareBytes(asm('DB $1234'), [0x34, 0x12]));

test('DB unsigned decimal byte (≤255)', () =>
  compareBytes(asm('DB 120'), [120]));

test('DB unsigned decimal word (>255)', () =>
  compareBytes(asm('DB 256'), [0x00, 0x01]));

test('DB unsigned decimal forces word via leading zero', () =>
  compareBytes(asm('DB 0120'), [120, 0]));

test('DB signed decimal byte (-1 → 0xFF)', () =>
  compareBytes(asm('DB -1'), [0xFF]));

test('DB signed decimal byte (+5)', () =>
  compareBytes(asm('DB +5'), [5]));

test('DB signed +255 forces word (out of signed-byte range)', () =>
  compareBytes(asm('DB +255'), [0xFF, 0x00]));

test('DB signed -129 forces word', () =>
  compareBytes(asm('DB -129'), [0x7F, 0xFF]));

test('DB binary byte', () =>
  compareBytes(asm('DB %10110001'), [0xB1]));

test('DB binary short bit-count OK', () =>
  compareBytes(asm('DB %101'), [0x05]));

test('DB binary >8 bits errors',
  () => /max 8 bits/i.test(asmErr('DB %101101011') ?? '') ? null : 'wrong/no error');

test('DB string of printable ASCII', () =>
  compareBytes(asm('DB "hi"'), [0x68, 0x69]));

test('DB string with embedded comma and colon', () =>
  compareBytes(asm('DB "a,b:c"'), [0x61, 0x2C, 0x62, 0x3A, 0x63]));

test('DB string non-printable errors',
  () => /non-printable/i.test(asmErr('DB "\u0001"') ?? '') ? null : 'wrong/no error');

test('DB mixed types', () =>
  compareBytes(asm('DB 0,0,%101110,%011111,%101110,0,0,0,"hi",0'),
               [0, 0, 0x2E, 0x1F, 0x2E, 0, 0, 0, 0x68, 0x69, 0]));

test('DB identifier resolves to little-endian word', () => {
  const r = assembleProgram(['ORG $9800:.TGT:RTS:DB TGT']);
  if (r.perLine[0].errors.length !== 0) return `unexpected error: ${r.perLine[0].errors[0].message}`;
  // .TGT at $9800; RTS = 60; DB TGT → 00,98 (little-endian).
  return compareBytes(r.perLine[0].bytes, [0x60, 0x00, 0x98]);
});

test('DB identifier without ORG errors', () => {
  const r = assembleProgram(['.TGT:DB TGT']);
  const errs = r.perLine[0].errors;
  if (errs.length !== 1) return `expected 1 error, got ${errs.length}`;
  if (!/no ORG was declared/i.test(errs[0].message)) return `wrong: ${errs[0].message}`;
  return null;
});

test('DB undefined symbol errors',
  () => /undefined symbol.*FOO/i.test(asmErr('DB FOO') ?? '') ? null : 'wrong/no error');

test('DB no values errors',
  () => /at least one value/i.test(asmErr('DB') ?? '') ? null : 'wrong/no error');

test('DB trailing comma errors',
  () => /empty value/i.test(asmErrMulti('DB 1,2,') ?? '') ? null : 'wrong/no error');

test('DB hex word too wide errors',
  () => /too wide/i.test(asmErr('DB $12345') ?? '') ? null : 'wrong/no error');

test('DB unsigned decimal out of range errors',
  () => /out of word range/i.test(asmErr('DB 70000') ?? '') ? null : 'wrong/no error');

test('DB signed decimal out of word range errors',
  () => /out of word range/i.test(asmErr('DB +99999') ?? '') ? null : 'wrong/no error');

test('DB combined with label declaration', () => {
  // The label declaration sits at the start of the data block.
  const r = assembleProgram(['ORG $9800:.TABLE:DB $01,$02,$03,$04']);
  if (r.perLine[0].errors.length !== 0) return `unexpected error: ${r.perLine[0].errors[0].message}`;
  if (r.symbols.get('TABLE')?.value !== 0x9800) return `TABLE addr: ${r.symbols.get('TABLE')?.value?.toString(16)}`;
  return compareBytes(r.perLine[0].bytes, [0x01, 0x02, 0x03, 0x04]);
});

test('DB lowercase keyword case-insensitive', () =>
  compareBytes(asm('db $42'), [0x42]));

test('DB statements separated by colon', () => {
  const r = assembleProgram(['DB $01,$02:DB $03,$04']);
  if (r.perLine[0].errors.length !== 0) return `unexpected error: ${r.perLine[0].errors[0].message}`;
  return compareBytes(r.perLine[0].bytes, [0x01, 0x02, 0x03, 0x04]);
});

test('DB followed by instruction on same line', () => {
  const r = assembleProgram(['DB $42:NOP']);
  if (r.perLine[0].errors.length !== 0) return `unexpected error: ${r.perLine[0].errors[0].message}`;
  return compareBytes(r.perLine[0].bytes, [0x42, 0xEA]);
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
