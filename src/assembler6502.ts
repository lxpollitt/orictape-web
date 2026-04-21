/**
 * Naive 6502 assembler — Phase 2.
 *
 * Converts a single 6502 instruction source line into the bytes it
 * assembles to.  Inverse of `disassembler6502.ts`; shares the same
 * mnemonic set and operand syntax (hex `$`, decimal bare, `#` for
 * immediate, `,X` / `,Y` for indexed, `()` for indirect) so that a
 * disassemble→assemble round-trip reproduces the original byte sequence.
 *
 * Scope for Phase 2:
 *   - Mnemonics: full official 6502 instruction set (matches the
 *     disassembler's opcode table 1:1).
 *   - Addressing modes: IMP IMM ZP ZPX ZPY ABS ABX ABY IND IZX IZY ACC.
 *     (REL requires labels — deferred to Phase 4.)
 *   - Numeric literals: `$HH`/`$HHHH` (hex, digit count informs ZP vs
 *     ABS), decimal, `%` binary, `'c` ASCII (single character).
 *   - One statement per call — no `:` separator, no ORG, no labels.
 *
 * ZP-vs-ABS resolution:
 *   - 2-digit hex operand (`$HH`) or decimal / binary / ASCII fitting in
 *     a byte → prefer ZP; fall back to ABS if the mnemonic has no ZP
 *     form.
 *   - 3+ digit hex operand (`$HHH`, `$HHHH`) → force ABS (matches the
 *     spec's "leading zero forces ABS" convention — writing extra digits
 *     is the explicit way to say "I want the 2-byte address form").
 *   - Decimal ≥ 256 → ABS.
 *
 * The `startAddr` parameter is carried through for API-shape parity with
 * the phases to come (label resolution, branch offsets, ORG tracking)
 * but has no effect on the byte output for Phase 2's operand set.
 */

// ── Addressing modes ────────────────────────────────────────────────────────

type Mode =
  | 'IMP'   // implied
  | 'ACC'   // accumulator (deferred to Phase 2)
  | 'IMM'   // immediate #$nn
  | 'ZP'    // zero page $nn
  | 'ZPX'   // zero page,X
  | 'ZPY'   // zero page,Y
  | 'ABS'   // absolute $nnnn
  | 'ABX'   // absolute,X
  | 'ABY'   // absolute,Y
  | 'IND'   // indirect ($nnnn) (deferred to Phase 2)
  | 'IZX'   // (indirect,X)
  | 'IZY'   // (indirect),Y
  | 'REL';  // relative branch (deferred to Phase 4)

/** Operand-byte count for each addressing mode.  Total instruction length
 *  is 1 (opcode) + this. */
function operandBytes(mode: Mode): number {
  switch (mode) {
    case 'IMP': case 'ACC': return 0;
    case 'ABS': case 'ABX': case 'ABY': case 'IND': return 2;
    default: return 1;
  }
}

// ── Opcode table ────────────────────────────────────────────────────────────
// 256 entries indexed by opcode byte.  Layout and rows mirror
// disassembler6502.ts exactly — if the two tables drift apart, round-trip
// tests will fail loudly, which is the point.  Illegal/unofficial opcodes
// stay null and are rejected by the reverse lookup.

interface OpEntry { mnemonic: string; mode: Mode; }
const OP: (OpEntry | null)[] = new Array(256).fill(null);

function set(op: number, mnemonic: string, mode: Mode): void { OP[op] = { mnemonic, mode }; }

// Row 0x0X
set(0x00, 'BRK', 'IMP'); set(0x01, 'ORA', 'IZX');
set(0x05, 'ORA', 'ZP');  set(0x06, 'ASL', 'ZP');
set(0x08, 'PHP', 'IMP'); set(0x09, 'ORA', 'IMM'); set(0x0A, 'ASL', 'ACC');
set(0x0D, 'ORA', 'ABS'); set(0x0E, 'ASL', 'ABS');

// Row 0x1X
set(0x10, 'BPL', 'REL'); set(0x11, 'ORA', 'IZY');
set(0x15, 'ORA', 'ZPX'); set(0x16, 'ASL', 'ZPX');
set(0x18, 'CLC', 'IMP'); set(0x19, 'ORA', 'ABY');
set(0x1D, 'ORA', 'ABX'); set(0x1E, 'ASL', 'ABX');

// Row 0x2X
set(0x20, 'JSR', 'ABS'); set(0x21, 'AND', 'IZX');
set(0x24, 'BIT', 'ZP');  set(0x25, 'AND', 'ZP');  set(0x26, 'ROL', 'ZP');
set(0x28, 'PLP', 'IMP'); set(0x29, 'AND', 'IMM'); set(0x2A, 'ROL', 'ACC');
set(0x2C, 'BIT', 'ABS'); set(0x2D, 'AND', 'ABS'); set(0x2E, 'ROL', 'ABS');

// Row 0x3X
set(0x30, 'BMI', 'REL'); set(0x31, 'AND', 'IZY');
set(0x35, 'AND', 'ZPX'); set(0x36, 'ROL', 'ZPX');
set(0x38, 'SEC', 'IMP'); set(0x39, 'AND', 'ABY');
set(0x3D, 'AND', 'ABX'); set(0x3E, 'ROL', 'ABX');

// Row 0x4X
set(0x40, 'RTI', 'IMP'); set(0x41, 'EOR', 'IZX');
set(0x45, 'EOR', 'ZP');  set(0x46, 'LSR', 'ZP');
set(0x48, 'PHA', 'IMP'); set(0x49, 'EOR', 'IMM'); set(0x4A, 'LSR', 'ACC');
set(0x4C, 'JMP', 'ABS'); set(0x4D, 'EOR', 'ABS'); set(0x4E, 'LSR', 'ABS');

// Row 0x5X
set(0x50, 'BVC', 'REL'); set(0x51, 'EOR', 'IZY');
set(0x55, 'EOR', 'ZPX'); set(0x56, 'LSR', 'ZPX');
set(0x58, 'CLI', 'IMP'); set(0x59, 'EOR', 'ABY');
set(0x5D, 'EOR', 'ABX'); set(0x5E, 'LSR', 'ABX');

// Row 0x6X
set(0x60, 'RTS', 'IMP'); set(0x61, 'ADC', 'IZX');
set(0x65, 'ADC', 'ZP');  set(0x66, 'ROR', 'ZP');
set(0x68, 'PLA', 'IMP'); set(0x69, 'ADC', 'IMM'); set(0x6A, 'ROR', 'ACC');
set(0x6C, 'JMP', 'IND'); set(0x6D, 'ADC', 'ABS'); set(0x6E, 'ROR', 'ABS');

// Row 0x7X
set(0x70, 'BVS', 'REL'); set(0x71, 'ADC', 'IZY');
set(0x75, 'ADC', 'ZPX'); set(0x76, 'ROR', 'ZPX');
set(0x78, 'SEI', 'IMP'); set(0x79, 'ADC', 'ABY');
set(0x7D, 'ADC', 'ABX'); set(0x7E, 'ROR', 'ABX');

// Row 0x8X
set(0x81, 'STA', 'IZX');
set(0x84, 'STY', 'ZP');  set(0x85, 'STA', 'ZP');  set(0x86, 'STX', 'ZP');
set(0x88, 'DEY', 'IMP');
set(0x8A, 'TXA', 'IMP');
set(0x8C, 'STY', 'ABS'); set(0x8D, 'STA', 'ABS'); set(0x8E, 'STX', 'ABS');

// Row 0x9X
set(0x90, 'BCC', 'REL'); set(0x91, 'STA', 'IZY');
set(0x94, 'STY', 'ZPX'); set(0x95, 'STA', 'ZPX'); set(0x96, 'STX', 'ZPY');
set(0x98, 'TYA', 'IMP'); set(0x99, 'STA', 'ABY');
set(0x9A, 'TXS', 'IMP'); set(0x9D, 'STA', 'ABX');

// Row 0xAX
set(0xA0, 'LDY', 'IMM'); set(0xA1, 'LDA', 'IZX'); set(0xA2, 'LDX', 'IMM');
set(0xA4, 'LDY', 'ZP');  set(0xA5, 'LDA', 'ZP');  set(0xA6, 'LDX', 'ZP');
set(0xA8, 'TAY', 'IMP'); set(0xA9, 'LDA', 'IMM'); set(0xAA, 'TAX', 'IMP');
set(0xAC, 'LDY', 'ABS'); set(0xAD, 'LDA', 'ABS'); set(0xAE, 'LDX', 'ABS');

// Row 0xBX
set(0xB0, 'BCS', 'REL'); set(0xB1, 'LDA', 'IZY');
set(0xB4, 'LDY', 'ZPX'); set(0xB5, 'LDA', 'ZPX'); set(0xB6, 'LDX', 'ZPY');
set(0xB8, 'CLV', 'IMP'); set(0xB9, 'LDA', 'ABY'); set(0xBA, 'TSX', 'IMP');
set(0xBC, 'LDY', 'ABX'); set(0xBD, 'LDA', 'ABX'); set(0xBE, 'LDX', 'ABY');

// Row 0xCX
set(0xC0, 'CPY', 'IMM'); set(0xC1, 'CMP', 'IZX');
set(0xC4, 'CPY', 'ZP');  set(0xC5, 'CMP', 'ZP');  set(0xC6, 'DEC', 'ZP');
set(0xC8, 'INY', 'IMP'); set(0xC9, 'CMP', 'IMM'); set(0xCA, 'DEX', 'IMP');
set(0xCC, 'CPY', 'ABS'); set(0xCD, 'CMP', 'ABS'); set(0xCE, 'DEC', 'ABS');

// Row 0xDX
set(0xD0, 'BNE', 'REL'); set(0xD1, 'CMP', 'IZY');
set(0xD5, 'CMP', 'ZPX'); set(0xD6, 'DEC', 'ZPX');
set(0xD8, 'CLD', 'IMP'); set(0xD9, 'CMP', 'ABY');
set(0xDD, 'CMP', 'ABX'); set(0xDE, 'DEC', 'ABX');

// Row 0xEX
set(0xE0, 'CPX', 'IMM'); set(0xE1, 'SBC', 'IZX');
set(0xE4, 'CPX', 'ZP');  set(0xE5, 'SBC', 'ZP');  set(0xE6, 'INC', 'ZP');
set(0xE8, 'INX', 'IMP'); set(0xE9, 'SBC', 'IMM'); set(0xEA, 'NOP', 'IMP');
set(0xEC, 'CPX', 'ABS'); set(0xED, 'SBC', 'ABS'); set(0xEE, 'INC', 'ABS');

// Row 0xFX
set(0xF0, 'BEQ', 'REL'); set(0xF1, 'SBC', 'IZY');
set(0xF5, 'SBC', 'ZPX'); set(0xF6, 'INC', 'ZPX');
set(0xF8, 'SED', 'IMP'); set(0xF9, 'SBC', 'ABY');
set(0xFD, 'SBC', 'ABX'); set(0xFE, 'INC', 'ABX');

// ── Reverse lookup: (mnemonic, mode) → opcode ──────────────────────────────

const OPCODES: Map<string, Map<Mode, number>> = new Map();
for (let op = 0; op < 256; op++) {
  const entry = OP[op];
  if (!entry) continue;
  let modeMap = OPCODES.get(entry.mnemonic);
  if (!modeMap) { modeMap = new Map(); OPCODES.set(entry.mnemonic, modeMap); }
  modeMap.set(entry.mode, op);
}

// ── Operand parsing ────────────────────────────────────────────────────────

/** A parsed operand: the addressing-mode candidates (ordered by caller
 *  preference, e.g. ZP before ABS) and the numeric value.  The assembler
 *  picks the first candidate the mnemonic actually supports. */
interface ParsedOperand {
  candidates: Mode[];
  value: number;
}

/** Parse a numeric literal — `$HH[HH]` hex, `%…` binary, `'c` ASCII, or
 *  decimal — returning the numeric value and whether the literal format
 *  forces a 2-byte (absolute) operand.
 *
 *  `forceWide` is set when the user writes 3+ hex digits (`$0BB`,
 *  `$00BB`), signalling explicit intent for the ABS form even if the
 *  value happens to fit in a byte.  Decimal, binary, and ASCII literals
 *  never force the wide form — they're chosen on value alone. */
function parseLiteral(text: string): { value: number; forceWide: boolean } | { error: string } {
  const t = text.trim();
  if (t.length === 0) return { error: 'missing numeric operand' };
  if (t.startsWith('$')) {
    const hex = t.slice(1);
    if (!/^[0-9A-Fa-f]+$/.test(hex)) return { error: `invalid hex literal: ${t}` };
    const value = parseInt(hex, 16);
    const forceWide = hex.length >= 3;
    return { value, forceWide };
  }
  if (t.startsWith('%')) {
    const bin = t.slice(1);
    if (!/^[01]+$/.test(bin)) return { error: `invalid binary literal: ${t}` };
    return { value: parseInt(bin, 2), forceWide: false };
  }
  if (t.startsWith("'")) {
    // ASCII char literal — exactly one character after the apostrophe.
    const rest = t.slice(1);
    if (rest.length !== 1) return { error: `invalid ASCII literal: ${t}` };
    return { value: rest.charCodeAt(0), forceWide: false };
  }
  if (/^-?\d+$/.test(t)) {
    const value = parseInt(t, 10);
    return { value, forceWide: false };
  }
  return { error: `unrecognised numeric literal: ${t}` };
}

/** Parse the operand portion of an instruction (the text after the
 *  mnemonic).  Returns the addressing-mode candidates ordered by
 *  preference and the numeric value. */
function parseOperand(text: string): ParsedOperand | { error: string } {
  const t = text.trim();

  // Implied / accumulator — no operand text, or just `A`.
  if (t.length === 0)        return { candidates: ['IMP', 'ACC'], value: 0 };
  if (t.toUpperCase() === 'A') return { candidates: ['ACC'],       value: 0 };

  // Immediate: `#<value>`.
  if (t.startsWith('#')) {
    const lit = parseLiteral(t.slice(1));
    if ('error' in lit) return { error: lit.error };
    if (lit.value < 0 || lit.value > 0xFF) {
      return { error: `immediate value out of byte range: ${lit.value}` };
    }
    return { candidates: ['IMM'], value: lit.value };
  }

  // Indexed indirect or plain indirect: `(<value>,X)` or `(<value>),Y` or `(<value>)`.
  if (t.startsWith('(')) {
    // `(<value>,X)` — closing paren at the end, `,X` just before.
    let m = t.match(/^\(\s*([^),]+?)\s*,\s*[Xx]\s*\)$/);
    if (m) {
      const lit = parseLiteral(m[1]);
      if ('error' in lit) return { error: lit.error };
      if (lit.value < 0 || lit.value > 0xFF) return { error: `IZX pointer out of ZP range: ${lit.value}` };
      return { candidates: ['IZX'], value: lit.value };
    }
    // `(<value>),Y` — closing paren before the `,Y`.
    m = t.match(/^\(\s*([^)]+?)\s*\)\s*,\s*[Yy]$/);
    if (m) {
      const lit = parseLiteral(m[1]);
      if ('error' in lit) return { error: lit.error };
      if (lit.value < 0 || lit.value > 0xFF) return { error: `IZY pointer out of ZP range: ${lit.value}` };
      return { candidates: ['IZY'], value: lit.value };
    }
    // `(<value>)` — pure indirect (JMP only in 6502).
    m = t.match(/^\(\s*([^)]+?)\s*\)$/);
    if (m) {
      const lit = parseLiteral(m[1]);
      if ('error' in lit) return { error: lit.error };
      if (lit.value < 0 || lit.value > 0xFFFF) return { error: `IND address out of 16-bit range: ${lit.value}` };
      return { candidates: ['IND'], value: lit.value };
    }
    return { error: `unrecognised indirect operand syntax: ${t}` };
  }

  // Indexed: `<value>,X` or `<value>,Y`.
  const mX = t.match(/^(.+?)\s*,\s*[Xx]$/);
  if (mX) {
    const lit = parseLiteral(mX[1]);
    if ('error' in lit) return { error: lit.error };
    if (lit.value < 0 || lit.value > 0xFFFF) return { error: `address out of 16-bit range: ${lit.value}` };
    // Prefer ZPX if the value fits in a byte AND the user didn't force
    // the wide form.  Otherwise ABX.
    return {
      candidates: (!lit.forceWide && lit.value <= 0xFF) ? ['ZPX', 'ABX'] : ['ABX'],
      value: lit.value,
    };
  }
  const mY = t.match(/^(.+?)\s*,\s*[Yy]$/);
  if (mY) {
    const lit = parseLiteral(mY[1]);
    if ('error' in lit) return { error: lit.error };
    if (lit.value < 0 || lit.value > 0xFFFF) return { error: `address out of 16-bit range: ${lit.value}` };
    // ZPY is much rarer (only LDX/STX support it) than ABY, but the
    // preference order still puts it first — the mnemonic lookup picks
    // whichever is actually supported.
    return {
      candidates: (!lit.forceWide && lit.value <= 0xFF) ? ['ZPY', 'ABY'] : ['ABY'],
      value: lit.value,
    };
  }

  // Plain numeric operand — ZP or ABS.
  const lit = parseLiteral(t);
  if ('error' in lit) return { error: lit.error };
  if (lit.value < 0 || lit.value > 0xFFFF) return { error: `address out of 16-bit range: ${lit.value}` };
  return {
    candidates: (!lit.forceWide && lit.value <= 0xFF) ? ['ZP', 'ABS'] : ['ABS'],
    value: lit.value,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface AsmError {
  message: string;
}

/**
 * Assemble a single 6502 instruction.  Returns the emitted bytes (opcode
 * followed by 0/1/2 operand bytes) and any errors encountered.  On error
 * the `bytes` array is empty.
 *
 * `startAddr` is accepted for API parity with future phases (label
 * resolution, branch offsets) but has no effect on the Phase 1 output.
 */
export function assemble(
  source:     string,
  _startAddr: number,
): { bytes: number[]; errors: AsmError[] } {
  const trimmed = source.trim();
  if (trimmed.length === 0) return { bytes: [], errors: [] };

  // Split mnemonic (3 letters) from operand.  Allow any internal
  // whitespace between; the operand parser handles its own whitespace.
  const m = trimmed.match(/^([A-Za-z]{3})(?:\s+(.*))?$/);
  if (!m) return { bytes: [], errors: [{ message: `invalid instruction syntax: ${trimmed}` }] };
  const mnemonic = m[1].toUpperCase();
  const operand  = (m[2] ?? '').trim();

  const modeMap = OPCODES.get(mnemonic);
  if (!modeMap) return { bytes: [], errors: [{ message: `unknown mnemonic: ${mnemonic}` }] };

  const parsed = parseOperand(operand);
  if ('error' in parsed) return { bytes: [], errors: [{ message: parsed.error }] };

  // Walk candidates in order, use the first one the mnemonic supports.
  let opcode: number | undefined;
  let chosenMode: Mode | undefined;
  for (const mode of parsed.candidates) {
    const byte = modeMap.get(mode);
    if (byte !== undefined) { opcode = byte; chosenMode = mode; break; }
  }
  if (opcode === undefined || chosenMode === undefined) {
    return {
      bytes: [],
      errors: [{ message: `${mnemonic} does not support ${parsed.candidates.join('/')} mode` }],
    };
  }

  const n = operandBytes(chosenMode);
  const out = [opcode];
  if (n === 1) {
    out.push(parsed.value & 0xFF);
  } else if (n === 2) {
    out.push(parsed.value & 0xFF, (parsed.value >> 8) & 0xFF);
  }
  return { bytes: out, errors: [] };
}
