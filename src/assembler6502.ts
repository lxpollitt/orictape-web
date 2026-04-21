/**
 * Naive 6502 assembler — Phase 1.
 *
 * Converts a single 6502 instruction source line into the bytes it
 * assembles to.  Inverse of `disassembler6502.ts`; shares the same
 * mnemonic set and operand syntax (hex `$`, decimal bare, `#` for
 * immediate, `,X` / `,Y` for indexed, `()` for indirect) so that a
 * disassemble→assemble round-trip reproduces the original byte sequence.
 *
 * Scope for Phase 1 (kept deliberately small to nail the infrastructure
 * before scaling out):
 *   - Mnemonics: LDA LDX LDY STA STX STY RTS.
 *   - Addressing modes: IMP IMM ZP ZPX ZPY ABS ABX ABY IZX IZY.
 *     (Deferred: IND — JMP only — and ACC — shifts/rotates — Phase 2;
 *     REL requires labels — Phase 4.)
 *   - Numeric literals: `$HH` / `$HHHH` (hex, digit count informs ZP vs
 *     ABS), decimal.  (Deferred: `%` binary, `'c` ASCII — Phase 2.)
 *   - One statement per call — no `:` separator, no ORG, no labels.
 *
 * ZP-vs-ABS resolution:
 *   - 2-digit hex operand (`$HH`) or decimal < 256 → prefer ZP; fall
 *     back to ABS if the mnemonic has no ZP form.
 *   - 4-digit hex operand (`$HHHH`) → force ABS (matches the spec's
 *     "leading zero forces ABS" convention — writing four digits is the
 *     explicit way to say "I want the 2-byte address form").
 *   - Decimal ≥ 256 → ABS.
 *
 * The `startAddr` parameter is carried through for API-shape parity with
 * the phases to come (label resolution, branch offsets, ORG tracking)
 * but has no effect on the byte output for Phase 1's operand set.
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
// Entries kept in 1:1 register-mirror layout to match disassembler6502.ts.
// Only Phase 1 mnemonics are populated here — the rest stay null.  We'll
// fill them in during Phase 2 when the full instruction set lands.

interface OpEntry { mnemonic: string; mode: Mode; }
const OP: (OpEntry | null)[] = new Array(256).fill(null);

function set(op: number, mnemonic: string, mode: Mode): void { OP[op] = { mnemonic, mode }; }

// Load A
set(0xA9, 'LDA', 'IMM'); set(0xA5, 'LDA', 'ZP');  set(0xB5, 'LDA', 'ZPX');
set(0xAD, 'LDA', 'ABS'); set(0xBD, 'LDA', 'ABX'); set(0xB9, 'LDA', 'ABY');
set(0xA1, 'LDA', 'IZX'); set(0xB1, 'LDA', 'IZY');
// Load X
set(0xA2, 'LDX', 'IMM'); set(0xA6, 'LDX', 'ZP');  set(0xB6, 'LDX', 'ZPY');
set(0xAE, 'LDX', 'ABS'); set(0xBE, 'LDX', 'ABY');
// Load Y
set(0xA0, 'LDY', 'IMM'); set(0xA4, 'LDY', 'ZP');  set(0xB4, 'LDY', 'ZPX');
set(0xAC, 'LDY', 'ABS'); set(0xBC, 'LDY', 'ABX');
// Store A
set(0x85, 'STA', 'ZP');  set(0x95, 'STA', 'ZPX');
set(0x8D, 'STA', 'ABS'); set(0x9D, 'STA', 'ABX'); set(0x99, 'STA', 'ABY');
set(0x81, 'STA', 'IZX'); set(0x91, 'STA', 'IZY');
// Store X
set(0x86, 'STX', 'ZP');  set(0x96, 'STX', 'ZPY'); set(0x8E, 'STX', 'ABS');
// Store Y
set(0x84, 'STY', 'ZP');  set(0x94, 'STY', 'ZPX'); set(0x8C, 'STY', 'ABS');
// Return from subroutine
set(0x60, 'RTS', 'IMP');

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

/** Parse a numeric literal — `$HH[HH]` or decimal — returning the
 *  numeric value and whether the literal format forces a 2-byte
 *  (absolute) operand. */
function parseLiteral(text: string): { value: number; forceWide: boolean } | { error: string } {
  const t = text.trim();
  if (t.length === 0) return { error: 'missing numeric operand' };
  if (t.startsWith('$')) {
    const hex = t.slice(1);
    if (!/^[0-9A-Fa-f]+$/.test(hex)) return { error: `invalid hex literal: ${t}` };
    const value = parseInt(hex, 16);
    // Three or more hex digits (`$XXX`, `$XXXX`, …) signals "wide" —
    // the user has explicitly written a 2-byte address and expects the
    // ABS/ABX/ABY form even if the value happens to fit in a byte.
    const forceWide = hex.length >= 3;
    return { value, forceWide };
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
    // `(<value>)` — pure indirect (JMP only in 6502, deferred to Phase 2).
    m = t.match(/^\(\s*([^)]+?)\s*\)$/);
    if (m) {
      const lit = parseLiteral(m[1]);
      if ('error' in lit) return { error: lit.error };
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
