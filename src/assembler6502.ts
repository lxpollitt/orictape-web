/**
 * Naive 6502 assembler — Phase 4.
 *
 * Converts 6502 annotations (each a `:`-separated sequence of statements)
 * into the bytes they assemble to.  Inverse of `disassembler6502.ts`; shares
 * the same mnemonic set and operand syntax so that disassemble→assemble
 * round-trips reproduce the original bytes.
 *
 * Scope:
 *   - Full official 6502 instruction set, every addressing mode including
 *     REL (branches).
 *   - Numeric literals: `$HH`/`$HHHH` hex, decimal, `%` binary, `'c` ASCII.
 *   - `:` separates statements within one annotation.
 *   - `;` starts an end-of-annotation comment.
 *   - `ORG $xxxx` directive: sets PC; may appear multiple times.
 *   - `.LABEL` statement: declares a code label at the current PC.
 *   - `.LABEL = <literal>` statement: declares a numeric equate.
 *   - Bare identifier in operand position: reference to label or equate.
 *
 * Identifiers match `[A-Za-z][A-Za-z0-9_]*`.  Label/equate namespace is
 * shared and redeclaration is an error.
 *
 * Two-pass resolution:
 *   - Pass 1 walks every statement in input order across all annotations,
 *     declaring labels at the current PC and collecting equates.  For each
 *     instruction it parses the operand, picks a concrete addressing mode,
 *     and advances PC by the chosen encoding's size.  Forward-referenced
 *     symbols are unknown here → mode falls back to ABS (or REL for
 *     branches), which is always 2–3 bytes and is committed.  This means
 *     forward references to *equates* always emit the ABS form even if the
 *     value would fit in ZP — declare equates before use if you want ZP.
 *   - Pass 2 walks the processed statements, resolves all remaining symbol
 *     references, and emits bytes using the mode selected in pass 1.  REL
 *     offsets are computed here (`target - (pc + 2)`) with a signed-byte
 *     range check.
 *
 * The public API has two entry points:
 *   - `assemble(source, startAddr)` — one annotation, thin wrapper around
 *     `assembleProgram`.  Preserved for tests and ad-hoc callers.
 *   - `assembleProgram(annotations[], startAddr)` — multi-annotation, with
 *     symbols shared across all of them.  Returns per-line bytes plus the
 *     resolved symbol table (exposed for Phase 5's back-patch directives).
 *
 * ZP-vs-ABS resolution (for resolved literals/equates):
 *   - 2-digit hex, or decimal/binary/ASCII fitting in a byte → prefer ZP,
 *     fall back to ABS if the mnemonic has no ZP form.
 *   - 3+ digit hex → force ABS.
 *   - Value ≥ 256 → ABS.
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

// ── Expressions (literals and symbol references) ───────────────────────────

/** Format a DATA value should be emitted in when propagated from an
 *  assembler operand literal back into a BASIC DATA statement.  `'hex'`
 *  means `#XX` output, `'decimal'` means bare `<num>`.  Binary (`%…`)
 *  maps to hex; ASCII char (`'c`) maps to decimal (per design note in
 *  `oric-asm-syntax.md` / project decisions).  Opcodes and REL offsets
 *  are always hex and don't consult this. */
export type DataFormat = 'hex' | 'decimal';

/** An expression is either a literal value or a reference to a named
 *  symbol (label or equate).  `forceWide` carries the "3+ hex digits"
 *  signal for literals; for symbols, size is determined at resolution
 *  time from the resolved symbol's `forceWide`.  `dataFormat` records
 *  which way a literal's bytes should be rendered back into DATA
 *  statements (see {@link DataFormat}).  `digitCount` is the number of
 *  digits the user wrote (not counting the `$`/`%`/`'` prefix) — used
 *  as the minimum emit width when the byte propagates into a DATA
 *  value, so `LDY #00` round-trips through DATA as `00`.  Undefined
 *  for binary (`%…`) and ASCII (`'c`) literals since those don't
 *  correspond to hex/decimal digit widths. */
type Expr =
  | { kind: 'lit'; value: number; forceWide: boolean; dataFormat: DataFormat; digitCount?: number }
  | { kind: 'sym'; name: string };

/** A resolved value — either what a literal Expr already carries, or the
 *  result of looking up a symbol in the symbol table.  `isLabel` is set
 *  for symbols declared via `.LABEL` (value = PC at declaration); equates
 *  and inline literals leave it undefined.  `dataFormat` is the DATA
 *  rendering preference: inherited from the literal form for equates,
 *  defaulting to `'hex'` for code labels (since labels are addresses
 *  and hex reads more naturally).  `digitCount` is the user-typed digit
 *  width (for byte-operand DATA emission minimum-width preservation);
 *  inherited from a declaring literal for equates, undefined for code
 *  labels and for binary/char-derived equates.  `anchored` and
 *  `regionId` apply to labels only — `anchored` is true when an `ORG`
 *  anchored PC before this label was declared (either via a prior
 *  `ORG` directive, an explicit `startAddr`, or the current region had
 *  `ORG` applied before the label); `regionId` identifies the
 *  contiguous PC-consistent region the label lives in (bumped by each
 *  `ORG` and by each PC-break from a zero-emit DATA line).  Pass 2
 *  uses `anchored` to gate ABS label references and `regionId` to
 *  gate cross-region REL branches.  Equates leave both undefined
 *  (their values are PC-independent). */
export interface ResolvedSymbol {
  value:       number;
  forceWide:   boolean;
  isLabel?:    boolean;
  dataFormat:  DataFormat;
  digitCount?: number;
  anchored?:   boolean;
  regionId?:   number;
}
// Short in-module alias to keep existing code tidy.
type Resolved = ResolvedSymbol;

/** The symbol table: shared across all annotations in one program. */
export type Symbols = Map<string, ResolvedSymbol>;

const IDENT_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Parse a numeric literal — `$HH[HH]` hex, `%…` binary, `'c` ASCII, or
 *  decimal — OR a bare identifier naming a label/equate.  Literals carry
 *  `forceWide` to distinguish `$04` (ZP-preferred) from `$0004` (ABS),
 *  plus a `dataFormat` that records how re-emitting the literal into a
 *  DATA statement should look (hex → `#XX`, decimal → bare digits; `%`
 *  binary maps to hex, `'c` char maps to decimal).  Identifiers are
 *  resolved later against the symbol table. */
function parseExpr(text: string): Expr | { error: string } {
  const t = text.trim();
  if (t.length === 0) return { error: 'missing operand' };
  if (t.startsWith('$')) {
    const hex = t.slice(1);
    if (!/^[0-9A-Fa-f]+$/.test(hex)) return { error: `invalid hex literal: ${t}` };
    return {
      kind: 'lit', value: parseInt(hex, 16),
      forceWide: hex.length >= 3,
      dataFormat: 'hex',
      digitCount: hex.length,
    };
  }
  if (t.startsWith('%')) {
    // Binary maps to hex on DATA output, but the user didn't write hex
    // digits — so we have no digitCount to preserve.
    const bin = t.slice(1);
    if (!/^[01]+$/.test(bin)) return { error: `invalid binary literal: ${t}` };
    return { kind: 'lit', value: parseInt(bin, 2), forceWide: false, dataFormat: 'hex' };
  }
  if (t.startsWith("'")) {
    // ASCII maps to decimal on DATA output.  The char literal is one
    // character; no user-chosen digit width to carry.
    const rest = t.slice(1);
    if (rest.length !== 1) return { error: `invalid ASCII literal: ${t}` };
    return { kind: 'lit', value: rest.charCodeAt(0), forceWide: false, dataFormat: 'decimal' };
  }
  if (/^[+-]?\d+$/.test(t)) {
    // Decimal digit width is preserved too — `LDY #00` → DATA `00`,
    // `LDY #0` → DATA `0`.  Leading sign (`+` or `-`) is not counted
    // as a digit.  An explicit `+` is accepted so that branch operands
    // can be written as `BNE +5` for a forward-branch offset in parallel
    // with `BNE -7` for a backward one.
    const digits = /^[+-]/.test(t) ? t.slice(1) : t;
    return {
      kind: 'lit', value: parseInt(t, 10),
      forceWide: false,
      dataFormat: 'decimal',
      digitCount: digits.length,
    };
  }
  if (IDENT_RE.test(t)) {
    return { kind: 'sym', name: t };
  }
  return { error: `unrecognised operand: ${t}` };
}

/** Parse an Expr and require it to be a literal.  Used for ORG and equate
 *  declarations — per spec, those take a literal, not a symbol. */
function parseLiteralOnly(text: string): Resolved | { error: string } {
  const e = parseExpr(text);
  if ('error' in e) return e;
  if (e.kind !== 'lit') return { error: `expected a literal, got identifier: ${e.name}` };
  return {
    value:      e.value,
    forceWide:  e.forceWide,
    dataFormat: e.dataFormat,
    digitCount: e.digitCount,
  };
}

/** Look up an expression's value in the symbol table.  Returns the
 *  resolved value, `null` if the symbol is unresolved, or an error for
 *  structural issues (should not happen for well-formed Exprs). */
function resolveExpr(expr: Expr, symbols: Symbols): Resolved | null {
  if (expr.kind === 'lit') {
    return {
      value:      expr.value,
      forceWide:  expr.forceWide,
      dataFormat: expr.dataFormat,
      digitCount: expr.digitCount,
    };
  }
  const sym = symbols.get(expr.name);
  return sym ?? null;
}

// ── Operand forms ──────────────────────────────────────────────────────────

/** Syntactic form of an operand, before mode selection.  The mnemonic's
 *  supported modes combined with the operand value pick the concrete
 *  addressing mode from each form's candidate set. */
type OperandForm =
  | 'IMP_OR_ACC'  // empty operand — either implied or accumulator
  | 'ACC'         // explicit `A`
  | 'IMM'         // `#<expr>`
  | 'DIR'         // `<expr>`        — ZP/ABS/REL
  | 'DIRX'        // `<expr>,X`      — ZPX/ABX
  | 'DIRY'        // `<expr>,Y`      — ZPY/ABY
  | 'IZX'         // `(<expr>,X)`
  | 'IZY'         // `(<expr>),Y`
  | 'IND';        // `(<expr>)`

/** A parsed operand — syntactic form plus (for non-implied forms) the
 *  expression carrying the value.  Symbol refs in the expression are
 *  resolved at assembly time. */
interface ParsedOperand {
  form: OperandForm;
  expr: Expr | null;
}

/** Parse the operand portion of an instruction (the text after the
 *  mnemonic). */
function parseOperand(text: string): ParsedOperand | { error: string } {
  const t = text.trim();

  if (t.length === 0)          return { form: 'IMP_OR_ACC', expr: null };
  if (t.toUpperCase() === 'A') return { form: 'ACC',        expr: null };

  if (t.startsWith('#')) {
    const e = parseExpr(t.slice(1));
    if ('error' in e) return { error: e.error };
    return { form: 'IMM', expr: e };
  }

  if (t.startsWith('(')) {
    // `(<value>,X)` — indexed indirect.
    let m = t.match(/^\(\s*([^),]+?)\s*,\s*[Xx]\s*\)$/);
    if (m) {
      const e = parseExpr(m[1]);
      if ('error' in e) return { error: e.error };
      return { form: 'IZX', expr: e };
    }
    // `(<value>),Y` — indirect indexed.
    m = t.match(/^\(\s*([^)]+?)\s*\)\s*,\s*[Yy]$/);
    if (m) {
      const e = parseExpr(m[1]);
      if ('error' in e) return { error: e.error };
      return { form: 'IZY', expr: e };
    }
    // `(<value>)` — pure indirect (JMP only).
    m = t.match(/^\(\s*([^)]+?)\s*\)$/);
    if (m) {
      const e = parseExpr(m[1]);
      if ('error' in e) return { error: e.error };
      return { form: 'IND', expr: e };
    }
    return { error: `unrecognised indirect operand syntax: ${t}` };
  }

  // Indexed: `<value>,X` or `<value>,Y`.
  const mX = t.match(/^(.+?)\s*,\s*[Xx]$/);
  if (mX) {
    const e = parseExpr(mX[1]);
    if ('error' in e) return { error: e.error };
    return { form: 'DIRX', expr: e };
  }
  const mY = t.match(/^(.+?)\s*,\s*[Yy]$/);
  if (mY) {
    const e = parseExpr(mY[1]);
    if ('error' in e) return { error: e.error };
    return { form: 'DIRY', expr: e };
  }

  // Plain direct operand.
  const e = parseExpr(t);
  if ('error' in e) return { error: e.error };
  return { form: 'DIR', expr: e };
}

// ── Mode selection ─────────────────────────────────────────────────────────

/** Addressing-mode candidates for a given operand form and resolved value
 *  (or null if unresolved).  The caller's mnemonic lookup picks the first
 *  candidate the mnemonic actually supports. */
function candidateModes(form: OperandForm, resolved: Resolved | null): Mode[] {
  const zpEligible =
    resolved !== null &&
    !resolved.forceWide &&
    resolved.value >= 0 &&
    resolved.value <= 0xFF;

  switch (form) {
    case 'IMP_OR_ACC': return ['IMP', 'ACC'];
    case 'ACC':        return ['ACC'];
    case 'IMM':        return ['IMM'];
    case 'IZX':        return ['IZX'];
    case 'IZY':        return ['IZY'];
    case 'IND':        return ['IND'];
    case 'DIR':        return zpEligible ? ['ZP', 'ABS', 'REL'] : ['ABS', 'REL'];
    case 'DIRX':       return zpEligible ? ['ZPX', 'ABX']       : ['ABX'];
    case 'DIRY':       return zpEligible ? ['ZPY', 'ABY']       : ['ABY'];
  }
}

/** Given a mnemonic and operand form + optional resolved value, pick the
 *  opcode + addressing mode.  Returns null if the mnemonic doesn't
 *  support any candidate mode for this form. */
function selectMode(
  mnemonic: string,
  form:     OperandForm,
  resolved: Resolved | null,
): { mode: Mode; opcode: number } | null {
  const modeMap = OPCODES.get(mnemonic);
  if (!modeMap) return null;
  const candidates = candidateModes(form, resolved);
  for (const mode of candidates) {
    const op = modeMap.get(mode);
    if (op !== undefined) return { mode, opcode: op };
  }
  return null;
}

// ── Annotation pre-processing ──────────────────────────────────────────────

/** Strip an end-of-annotation `*` comment.  Skips over `'c` ASCII literals
 *  so `LDA #'*` (were it ever to appear) doesn't mis-terminate. */
function stripComment(s: string): string {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") { i++; continue; }
    if (c === '*') return s.slice(0, i);
  }
  return s;
}

/** Split an annotation into statements on `:` or `;` (both accepted
 *  interchangeably — `;` is the common convention in existing hand-
 *  assembled Oric programs, while `:` mirrors Oric BASIC's own
 *  statement separator).  Skips over `'c` ASCII literals. */
function splitStatements(s: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") { i++; continue; }
    if (c === ':' || c === ';') { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out;
}

// ── Statement parsing ──────────────────────────────────────────────────────

type Statement =
  | { kind: 'empty' }
  | { kind: 'label';  name: string }
  | { kind: 'equate'; name: string; value: Resolved }
  | { kind: 'org';    address: number; blockName?: string }
  | { kind: 'instr';  mnemonic: string; op: ParsedOperand }
  | { kind: 'error';  message: string };

/** Parse a single trimmed statement into its Statement form.  Doesn't
 *  touch the symbol table — that's the job of the passes below. */
function parseStatement(raw: string): Statement {
  const t = raw.trim();
  if (t.length === 0) return { kind: 'empty' };

  // `.LABEL` or `.LABEL = <literal>` — declaration.
  if (t.startsWith('.')) {
    // Equate form first: `.IDENT = <literal>`.
    const eqM = t.match(/^\.([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    if (eqM) {
      const name = eqM[1];
      const lit = parseLiteralOnly(eqM[2]);
      if ('error' in lit) return { kind: 'error', message: `equate ${name}: ${lit.error}` };
      return { kind: 'equate', name, value: lit };
    }
    // Bare label: `.IDENT`.
    const lblM = t.match(/^\.([A-Za-z][A-Za-z0-9_]*)\s*$/);
    if (lblM) return { kind: 'label', name: lblM[1] };
    return { kind: 'error', message: `invalid declaration: ${t}` };
  }

  // `ORG <literal> [.BLOCKNAME]` — case-insensitive.  The optional
  // trailing `.NAME` names the assembler block that begins at this
  // ORG: the tool declares `NAME` = start address and `NAME_END` =
  // inclusive last byte of the block (populated when the block ends,
  // which happens at the next ORG, a zero-output DATA line, a `]]`
  // close marker, or end of program).
  const orgM = t.match(/^[Oo][Rr][Gg](?:\s+(.*))?$/);
  if (orgM) {
    const rest = (orgM[1] ?? '').trim();
    if (rest.length === 0) return { kind: 'error', message: 'ORG requires an address' };
    // Split off optional trailing `.BLOCKNAME`.
    let operand   = rest;
    let blockName: string | undefined = undefined;
    const nameM = rest.match(/^(.+?)\s+\.([A-Za-z][A-Za-z0-9_]*)\s*$/);
    if (nameM) {
      operand   = nameM[1].trim();
      blockName = nameM[2];
    }
    const lit = parseLiteralOnly(operand);
    if ('error' in lit) return { kind: 'error', message: lit.error };
    if (lit.value < 0 || lit.value > 0xFFFF) {
      return { kind: 'error', message: `ORG address out of 16-bit range: ${lit.value}` };
    }
    return { kind: 'org', address: lit.value, blockName };
  }

  // Instruction: `MNEM [operand]`.
  const instrM = t.match(/^([A-Za-z]{3})(?:\s+(.*))?$/);
  if (!instrM) return { kind: 'error', message: `invalid instruction syntax: ${t}` };
  const mnemonic = instrM[1].toUpperCase();
  const operandRaw = (instrM[2] ?? '').trim();
  if (!OPCODES.has(mnemonic)) return { kind: 'error', message: `unknown mnemonic: ${mnemonic}` };
  const op = parseOperand(operandRaw);
  if ('error' in op) return { kind: 'error', message: op.error };
  return { kind: 'instr', mnemonic, op };
}

// ── Two-pass assembly ──────────────────────────────────────────────────────

/** A per-instruction record produced by pass 1 and consumed by pass 2.
 *  `regionId` is the PC-consistent region this instruction lives in —
 *  REL branches require their target label's `regionId` to match, or
 *  the computed offset spans a PC-break and is meaningless. */
interface Prepared {
  mnemonic: string;
  op:       ParsedOperand;
  pc:       number;   // address of this instruction
  mode:     Mode;     // mode chosen at pass 1 — committed
  opcode:   number;
  size:     number;
  lineIdx:  number;   // which annotation this came from
  regionId: number;
}

/** One emit unit from the assembler — either an opcode byte, or an
 *  operand of 1 or 2 bytes.  `chunks` lets the DATA-line renderer
 *  choose byte-wise or word-wise emission for 2-byte operands without
 *  re-deriving the grouping from the flat byte stream.  Within a chunk,
 *  `bytes`, `formats`, and `minDigits` are parallel arrays of the same
 *  length; for 2-byte operands the low byte is at index 0 (little-endian
 *  memory order, which matches the 6502's operand byte order).  Both
 *  bytes of a 2-byte operand share the same `formats` entry and the
 *  same `minDigits` entry in practice (they came from one source
 *  literal). */
export interface Chunk {
  bytes:     number[];
  formats:   DataFormat[];
  minDigits: number[];
}

/** Per-line working state returned by pass 1 and pass 2.  `chunks` is
 *  the primary emission record — one entry per opcode or operand.
 *  `formats` and `minDigits` are flat views parallel to `bytes` (one
 *  entry per emitted byte) controlling how each byte is rendered in
 *  byte-wise DATA output: `formats` picks hex vs decimal (see
 *  {@link DataFormat}), `minDigits` is the minimum emit width (padded
 *  with leading zeros if the value is narrower).  Opcode bytes and
 *  REL-offset bytes are always `'hex'` with minDigits = 2.  Byte-op
 *  operand bytes inherit minDigits from the operand expression's
 *  `digitCount` (literal) or the resolved symbol's (identifier), so
 *  `LDY #00` round-trips as DATA `00`.  Word-op operand bytes use the
 *  format default (hex: 2, decimal: 1) per byte.  The flat arrays
 *  remain in sync with `chunks` at all times. */
interface LineState {
  bytes:     number[];
  formats:   DataFormat[];
  minDigits: number[];
  chunks:    Chunk[];
  errors:    AsmError[];
}

/** Emit the operand bytes for a concrete (mode, value) pair.  For REL
 *  also does the signed-offset computation and range check. */
function emitOperand(
  mode:  Mode,
  value: number,
  pc:             number,
  isDirectOffset: boolean = false,
): { bytes: number[] } | { error: string } {
  const n = operandBytes(mode);
  if (mode === 'REL') {
    if (isDirectOffset) {
      // User supplied a 1-byte input (hex `$XX` with ≤ 2 digits, or a
      // signed decimal in [-128, 127]) — emit as the offset byte
      // directly.  Callers have already range-checked; mask for safety.
      return { bytes: [value & 0xFF] };
    }
    // Target-address interpretation: compute offset from this
    // instruction's PC+2 to the target, validate ±127 range.
    const offset = value - ((pc + 2) & 0xFFFF);
    if (offset < -128 || offset > 127) {
      return { error: `branch out of range: offset ${offset} to $${value.toString(16).toUpperCase().padStart(4, '0')}` };
    }
    return { bytes: [offset & 0xFF] };
  }
  if (n === 0) return { bytes: [] };
  if (n === 1) {
    if (value < 0 || value > 0xFF) return { error: `operand out of byte range: ${value}` };
    return { bytes: [value & 0xFF] };
  }
  return { bytes: [value & 0xFF, (value >> 8) & 0xFF] };
}

/**
 * Pass 1: walk every statement in input order across all annotations.
 * Declares labels at the current PC, records equates, processes ORG.
 * For each instruction, picks a mode (using whatever symbol knowledge is
 * available so far), commits its size, and advances PC.  The returned
 * `prepared` list feeds pass 2.
 *
 * `startAddr` may be undefined, in which case the initial PC is 0 but
 * `anchored` starts false — meaning labels declared before any ORG
 * directive have values that are only safe to use in relative-addressing
 * contexts.  Pass 2 flags any attempt to emit such a label as an
 * absolute address.
 *
 * `isDataLine[i]` tells pass 1 which source lines are DATA lines (as
 * opposed to REM lines or non-host-line empty strings).  When a DATA
 * line's annotation emits zero instruction-bytes AND doesn't process
 * an `ORG`, its raw DATA values are "unassembled" — we don't know where
 * they sit in memory relative to `pc`, so we un-anchor PC from that
 * point onward (bumping `regionId`).  Subsequent labels declared before
 * the next `ORG` are flagged unanchored, and pass 2 errors on any ABS
 * use of them (same mechanism as the no-ORG-at-all case).
 *
 * `regionId` increments on every ORG and on every PC-break.  Labels
 * and instructions stamp the current `regionId`; pass 2 REL checks
 * require branch and target to share a region (the computed offset
 * only makes sense within a single PC-consistent stretch).
 */
function pass1(
  annotations:          string[],
  startAddr:            number | undefined,
  isDataLine:           boolean[],
  blockEndAfterLine:    boolean[],
): {
  prepared:   Prepared[];
  symbols:    Symbols;
  lineStates: LineState[];
  endAddr:    number;
} {
  const symbols: Symbols = new Map();
  const lineStates: LineState[] = annotations.map(() => ({
    bytes: [], formats: [], minDigits: [], chunks: [], errors: [],
  }));
  const prepared: Prepared[] = [];
  let pc        = (startAddr ?? 0) & 0xFFFF;
  let anchored  = startAddr !== undefined;
  let regionId  = 0;

  const declare = (lineIdx: number, name: string, value: Resolved): string | null => {
    if (symbols.has(name)) return `symbol already declared: ${name}`;
    symbols.set(name, value);
    void lineIdx;
    return null;
  };

  // Named-block state.  An `ORG $xxxx .NAME` opens a block; its end
  // label (`NAME_END`) is declared when the block closes at the next
  // ORG, PC-break, `]]` close marker, or end of program.  `lastByte`
  // is the inclusive address of the most recent emitted instruction
  // byte within this block — that's what `NAME_END` resolves to.
  // If no instructions have been emitted yet, `lastByte` stays at
  // `startPc - 1` and the closing declares an "empty block" error
  // (users naming a block imply they'll reference its size).
  type NamedBlock = { name: string; startPc: number; lastByte: number; lineIdx: number };
  let activeBlock: NamedBlock | null = null;

  const closeNamedBlock = (stateErrs: AsmError[] | null): void => {
    if (!activeBlock) return;
    const b = activeBlock;
    activeBlock = null;
    if (b.lastByte < b.startPc) {
      // Empty block — no instructions emitted since the ORG.  Attach
      // the error to the line that opened the block.
      lineStates[b.lineIdx].errors.push({
        message: `named block ${b.name} has no assembled bytes`,
      });
      void stateErrs;
      return;
    }
    const err = declare(b.lineIdx, `${b.name}_END`, {
      value:      b.lastByte,
      forceWide:  true,
      isLabel:    true,
      dataFormat: 'hex',
      anchored:   true,      // always anchored — block had an ORG
      regionId,               // current region
    });
    if (err && stateErrs) stateErrs.push({ message: err });
  };

  for (let lineIdx = 0; lineIdx < annotations.length; lineIdx++) {
    const stripped = stripComment(annotations[lineIdx]);
    const rawStatements = splitStatements(stripped);
    const stateErrs = lineStates[lineIdx].errors;

    const preparedBefore = prepared.length;
    let sawOrgThisLine   = false;

    for (const raw of rawStatements) {
      const stmt = parseStatement(raw);
      switch (stmt.kind) {
        case 'empty': break;

        case 'error':
          stateErrs.push({ message: stmt.message });
          break;

        case 'label': {
          const err = declare(lineIdx, stmt.name, {
            value: pc, forceWide: true, isLabel: true, dataFormat: 'hex',
            anchored, regionId,
          });
          if (err) stateErrs.push({ message: err });
          break;
        }

        case 'equate': {
          const err = declare(lineIdx, stmt.name, stmt.value);
          if (err) stateErrs.push({ message: err });
          break;
        }

        case 'org':
          // Any ORG closes the active named block before repositioning
          // PC.  If the new ORG itself is named, a fresh block opens
          // after PC is set.
          closeNamedBlock(stateErrs);
          // ORG re-anchors PC.  It starts a new region only when it
          // changes the anchored state (unanchored → anchored) — PC
          // arithmetic is then discontinuous across the boundary so
          // cross-region REL must be blocked.  An ORG that just
          // repositions PC within an already-anchored stretch keeps
          // the same region (consecutive ORGs for non-contiguous
          // anchored code still give well-defined real-memory
          // offsets on either side).
          if (!anchored) regionId = regionId + 1;
          pc       = stmt.address & 0xFFFF;
          anchored = true;
          sawOrgThisLine = true;
          if (stmt.blockName !== undefined) {
            // Declare the start-of-block label (same as a plain
            // `.NAME` at post-ORG PC) and open a new named block.
            const err = declare(lineIdx, stmt.blockName, {
              value: pc, forceWide: true, isLabel: true, dataFormat: 'hex',
              anchored: true, regionId,
            });
            if (err) stateErrs.push({ message: err });
            activeBlock = {
              name:     stmt.blockName,
              startPc:  pc,
              lastByte: pc - 1,   // sentinel for "no bytes yet"
              lineIdx,
            };
          }
          break;

        case 'instr': {
          // Try to resolve the operand now so size picks ZP when possible.
          const resolved = stmt.op.expr === null ? null : resolveExpr(stmt.op.expr, symbols);
          const sel = selectMode(stmt.mnemonic, stmt.op.form, resolved);
          if (!sel) {
            const candidates = candidateModes(stmt.op.form, resolved);
            stateErrs.push({ message: `${stmt.mnemonic} does not support ${candidates.join('/')} mode` });
            break;
          }
          const size = 1 + operandBytes(sel.mode);
          prepared.push({
            mnemonic: stmt.mnemonic,
            op:       stmt.op,
            pc,
            mode:     sel.mode,
            opcode:   sel.opcode,
            size,
            lineIdx,
            regionId,
          });
          pc = (pc + size) & 0xFFFF;
          // Extend the active named block's span to include this
          // instruction's bytes.  `pc` is now one past the last
          // emitted byte; `pc - 1` is the inclusive last byte.
          if (activeBlock) activeBlock.lastByte = (pc - 1) & 0xFFFF;
          break;
        }
      }
    }

    // PC-break detection: a DATA line whose annotation neither emits
    // instructions nor processes an ORG leaves the original DATA
    // values unassembled at an unknown memory address.  Unanchor so
    // subsequent absolute label uses are flagged.  An ORG on the
    // line's own annotation suppresses the break (the user told us
    // where PC is).
    const emittedInstructions = prepared.length > preparedBefore;
    if (isDataLine[lineIdx] && !emittedInstructions && !sawOrgThisLine) {
      // A zero-output DATA line also ends any active named block —
      // the block's bytes have stopped accumulating and the following
      // data is at an unknown address.
      closeNamedBlock(stateErrs);
      regionId = regionId + 1;
      anchored = false;
    }

    // `]]` close marker on this line also ends the active named
    // block (signalled from the filter via `blockEndAfterLine`).  The
    // user has explicitly said "this assembler region stops here".
    if (blockEndAfterLine[lineIdx]) {
      closeNamedBlock(stateErrs);
    }
  }

  // End of program: close any still-active named block.
  closeNamedBlock(null);

  return { prepared, symbols, lineStates, endAddr: pc };
}

/**
 * Pass 2: walk the prepared instructions, resolving any remaining symbol
 * references and emitting bytes.  Each instruction's bytes are appended
 * to its source annotation's LineState.  For REL the signed offset is
 * computed here; undefined symbols and out-of-range branches become
 * errors attached to the originating line.
 *
 * Two PC-consistency gates run here:
 *
 *  - **ABS/absolute label use** requires the label to be `anchored`.
 *    Equivalent to "an `ORG` directive (or explicit `startAddr`) was
 *    in effect when the label was declared, with no intervening
 *    PC-break from a zero-emit DATA line".  Equates and literals are
 *    always fine (they're PC-independent).
 *  - **REL branch to a label** requires the branch's `regionId` to
 *    match the target label's `regionId`.  Within one PC-consistent
 *    region the offset is valid whether or not either end is anchored;
 *    across a PC-break, the offset is meaningless (PC arithmetic got
 *    interrupted) so we error.  Offsets computed from non-label
 *    targets (literal address, direct offset) bypass this check.
 */
function pass2(
  prepared:   Prepared[],
  symbols:    Symbols,
  lineStates: LineState[],
): void {
  for (const p of prepared) {
    const lineState = lineStates[p.lineIdx];

    // IMP/ACC have no expression; emit just the opcode.
    if (p.op.expr === null) {
      lineState.bytes.push(p.opcode);
      lineState.formats.push('hex');
      lineState.minDigits.push(2);
      lineState.chunks.push({ bytes: [p.opcode], formats: ['hex'], minDigits: [2] });
      continue;
    }

    const resolved = resolveExpr(p.op.expr, symbols);
    if (resolved === null) {
      const name = (p.op.expr.kind === 'sym') ? p.op.expr.name : '?';
      lineState.errors.push({ message: `undefined symbol: ${name}` });
      continue;
    }

    // A label used as an absolute address requires a known program
    // origin (either an `ORG` or an explicit `startAddr`) with no
    // intervening PC-break from a zero-emit DATA line.  REL-mode is
    // gated separately (see below) — offsets are base-independent
    // within a region but are meaningless across a PC-break.
    if (resolved.isLabel && p.mode !== 'REL' && !resolved.anchored) {
      const name = (p.op.expr.kind === 'sym') ? p.op.expr.name : '?';
      lineState.errors.push({
        message: `label ${name} used in absolute addressing but no ORG was declared ` +
                 `for this block of assembler`,
      });
      continue;
    }

    // REL branch to a label across a PC-break: the branch's PC and the
    // label's PC come from different regions, so the computed offset
    // is meaningless.  Within one region (anchored or not), REL is
    // fine: PC arithmetic is internally consistent.
    if (resolved.isLabel && p.mode === 'REL' && resolved.regionId !== p.regionId) {
      const name = (p.op.expr.kind === 'sym') ? p.op.expr.name : '?';
      lineState.errors.push({
        message: `branch to label ${name} is between different blocks of assembler ` +
                 `and requires ORG declarations for both blocks`,
      });
      continue;
    }

    // Range checks for forms that imply a byte-sized operand pointer.
    if (p.op.form === 'IMM' && (resolved.value < 0 || resolved.value > 0xFF)) {
      lineState.errors.push({ message: `immediate value out of byte range: ${resolved.value}` });
      continue;
    }
    if (p.op.form === 'IZX' && (resolved.value < 0 || resolved.value > 0xFF)) {
      lineState.errors.push({ message: `IZX pointer out of ZP range: ${resolved.value}` });
      continue;
    }
    if (p.op.form === 'IZY' && (resolved.value < 0 || resolved.value > 0xFF)) {
      lineState.errors.push({ message: `IZY pointer out of ZP range: ${resolved.value}` });
      continue;
    }
    if (p.op.form === 'IND' && (resolved.value < 0 || resolved.value > 0xFFFF)) {
      lineState.errors.push({ message: `IND address out of 16-bit range: ${resolved.value}` });
      continue;
    }

    // For REL (branches), the operand is either a **direct offset**
    // (1-byte input: hex with ≤ 2 digits, or a decimal in
    // [-128, +127]) emitted as-is, or a **target address** (2-byte
    // input: label, hex with 3+ digits) from which we compute an
    // offset.  Decimal out of signed-byte range is an error — avoids
    // the "did the user mean 249 as an address or as -7 as an offset?"
    // ambiguity.
    const isDirectOffset =
      p.mode === 'REL' && !resolved.isLabel && !resolved.forceWide;
    if (p.mode === 'REL' && isDirectOffset && resolved.dataFormat === 'decimal' &&
        (resolved.value < -128 || resolved.value > 127)) {
      lineState.errors.push({
        message: `decimal branch operand ${resolved.value} out of signed-byte range ` +
                 `[-128, +127]; use a signed value, a hex literal, or a label`,
      });
      continue;
    }
    // Range check for the remaining non-REL direct-memory forms.  REL
    // is handled above (direct offset lets negatives through).
    if ((p.op.form === 'DIR' || p.op.form === 'DIRX' || p.op.form === 'DIRY') &&
        p.mode !== 'REL' &&
        (resolved.value < 0 || resolved.value > 0xFFFF)) {
      lineState.errors.push({ message: `address out of 16-bit range: ${resolved.value}` });
      continue;
    }

    const emit = emitOperand(p.mode, resolved.value, p.pc, isDirectOffset);
    if ('error' in emit) { lineState.errors.push({ message: emit.error }); continue; }
    // Operand format: REL target-branches (label or word-sized input)
    // produce a computed offset byte — no source literal to inherit
    // from, so default to hex.  Direct-offset REL branches and all
    // other operand forms inherit from the resolved value (literal
    // directly, or symbol's declared format).  Both bytes of a 2-byte
    // operand get the same format — the low/high bytes come from one
    // source literal, so splitting their rendering would look odd.
    const operandFormat: DataFormat = (p.mode === 'REL' && !isDirectOffset)
      ? 'hex'
      : resolved.dataFormat;

    // Operand min-digit width: byte operands preserve the source
    // literal's digit count (so `LDY #00` → DATA `00`); word operands
    // and REL target-branches use the format default (hex: 2,
    // decimal: 1) per byte.  Direct-offset REL branches count as byte
    // operands here, so `BNE -7` → `DATA … 249` with the `-7` digit
    // count of 1 propagating.
    const formatDefault = (operandFormat === 'hex') ? 2 : 1;
    const isByteOperand = (emit.bytes.length === 1) && (p.mode !== 'REL' || isDirectOffset);
    const operandMinDigits = isByteOperand
      ? (resolved.digitCount ?? formatDefault)
      : formatDefault;

    lineState.bytes.push(p.opcode, ...emit.bytes);
    lineState.formats.push('hex', ...emit.bytes.map(() => operandFormat));
    lineState.minDigits.push(2, ...emit.bytes.map(() => operandMinDigits));
    // Chunks: the opcode is always its own 1-byte chunk; the operand
    // (if any) is one chunk of 1 or 2 bytes.  This grouping lets the
    // DATA-line renderer emit 2-byte operands as a single word value
    // (#XXXX) when WORDS mode is in effect.
    lineState.chunks.push({ bytes: [p.opcode], formats: ['hex'], minDigits: [2] });
    if (emit.bytes.length > 0) {
      lineState.chunks.push({
        bytes:     [...emit.bytes],
        formats:   emit.bytes.map(() => operandFormat),
        minDigits: emit.bytes.map(() => operandMinDigits),
      });
    }
    // Sanity: what we emit must match the size we committed in pass 1.
    if (1 + emit.bytes.length !== p.size) {
      lineState.errors.push({ message: `internal: size mismatch at $${p.pc.toString(16)}` });
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface AsmError {
  message: string;
}

export interface AssembledProgram {
  /** Per-annotation result.  `perLine[i]` corresponds to `annotations[i]`. */
  perLine: LineState[];
  /** Final PC after all annotations have been assembled. */
  endAddr: number;
  /** Resolved symbol table — exposed so Phase 5's back-patch directives
   *  can look labels up. */
  symbols: Symbols;
}

/**
 * Assemble a multi-annotation program with shared symbol table.  Each
 * annotation is processed with the syntax described at the top of the
 * file; symbols declared in earlier annotations are visible in later
 * ones, and forward references (to later-declared labels) resolve as
 * long as the symbol appears anywhere in the program.
 *
 * `startAddr` is optional.  If provided, it's the initial PC and labels
 * resolve to real absolute addresses.  If omitted, the initial PC is 0
 * *but* label values are only safe for relative-addressing uses until
 * an `ORG` directive anchors the program; the assembler will flag any
 * attempt to use a pre-ORG label as an absolute address.
 *
 * `isDataLine[i]` marks which source annotations came from BASIC DATA
 * lines (as opposed to REM lines, non-host lines, or ad-hoc single-
 * annotation callers).  When a DATA line's annotation emits no
 * instructions and carries no `ORG`, its raw DATA values aren't being
 * assembled — so PC arithmetic through that line is broken and
 * subsequent absolute label references are errors (same mechanism as
 * the program-wide no-ORG case).  Callers that don't care about this
 * (e.g. the single-annotation `assemble` wrapper and most tests) can
 * omit the parameter — the default is "nothing is a DATA line", which
 * disables PC-break detection and preserves the legacy behaviour.
 */
export function assembleProgram(
  annotations:        string[],
  startAddr?:         number,
  isDataLine?:        boolean[],
  blockEndAfterLine?: boolean[],
): AssembledProgram {
  const dataFlags  = isDataLine        ?? annotations.map(() => false);
  const blockEnds  = blockEndAfterLine ?? annotations.map(() => false);
  const { prepared, symbols, lineStates, endAddr } = pass1(annotations, startAddr, dataFlags, blockEnds);
  pass2(prepared, symbols, lineStates);
  return { perLine: lineStates, endAddr, symbols };
}

/**
 * Assemble a single 6502 annotation — thin wrapper on `assembleProgram`
 * for callers that work line-at-a-time.  Labels/equates declared in
 * `source` are visible to its own statements (forward branches work)
 * but obviously not to anyone else.
 */
export function assemble(
  source:    string,
  startAddr: number,
): { bytes: number[]; errors: AsmError[]; endAddr: number } {
  const { perLine, endAddr } = assembleProgram([source], startAddr);
  return { bytes: perLine[0].bytes, errors: perLine[0].errors, endAddr };
}
