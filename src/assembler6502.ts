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

/** An expression is either a literal value or a reference to a named
 *  symbol (label or equate).  `forceWide` carries the "3+ hex digits"
 *  signal for literals; for symbols, size is determined at resolution
 *  time from the resolved symbol's `forceWide`. */
type Expr =
  | { kind: 'lit'; value: number; forceWide: boolean }
  | { kind: 'sym'; name: string };

/** A resolved value — either what a literal Expr already carries, or the
 *  result of looking up a symbol in the symbol table. */
interface Resolved { value: number; forceWide: boolean }

/** The symbol table: shared across all annotations in one program. */
type Symbols = Map<string, Resolved>;

const IDENT_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Parse a numeric literal — `$HH[HH]` hex, `%…` binary, `'c` ASCII, or
 *  decimal — OR a bare identifier naming a label/equate.  Literals carry
 *  `forceWide` to distinguish `$04` (ZP-preferred) from `$0004` (ABS).
 *  Identifiers are resolved later against the symbol table. */
function parseExpr(text: string): Expr | { error: string } {
  const t = text.trim();
  if (t.length === 0) return { error: 'missing operand' };
  if (t.startsWith('$')) {
    const hex = t.slice(1);
    if (!/^[0-9A-Fa-f]+$/.test(hex)) return { error: `invalid hex literal: ${t}` };
    return { kind: 'lit', value: parseInt(hex, 16), forceWide: hex.length >= 3 };
  }
  if (t.startsWith('%')) {
    const bin = t.slice(1);
    if (!/^[01]+$/.test(bin)) return { error: `invalid binary literal: ${t}` };
    return { kind: 'lit', value: parseInt(bin, 2), forceWide: false };
  }
  if (t.startsWith("'")) {
    const rest = t.slice(1);
    if (rest.length !== 1) return { error: `invalid ASCII literal: ${t}` };
    return { kind: 'lit', value: rest.charCodeAt(0), forceWide: false };
  }
  if (/^-?\d+$/.test(t)) {
    return { kind: 'lit', value: parseInt(t, 10), forceWide: false };
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
  return { value: e.value, forceWide: e.forceWide };
}

/** Look up an expression's value in the symbol table.  Returns the
 *  resolved value, `null` if the symbol is unresolved, or an error for
 *  structural issues (should not happen for well-formed Exprs). */
function resolveExpr(expr: Expr, symbols: Symbols): Resolved | null {
  if (expr.kind === 'lit') return { value: expr.value, forceWide: expr.forceWide };
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

/** Strip an end-of-annotation `;` comment.  Skips over `'c` ASCII literals
 *  so `LDA #';` (were it ever to appear) doesn't mis-terminate. */
function stripComment(s: string): string {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") { i++; continue; }
    if (c === ';') return s.slice(0, i);
  }
  return s;
}

/** Split an annotation into statements on `:`, skipping over `'c` literals. */
function splitStatements(s: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") { i++; continue; }
    if (c === ':') { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out;
}

// ── Statement parsing ──────────────────────────────────────────────────────

type Statement =
  | { kind: 'empty' }
  | { kind: 'label';  name: string }
  | { kind: 'equate'; name: string; value: Resolved }
  | { kind: 'org';    address: number }
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

  // `ORG <literal>` — case-insensitive.
  const orgM = t.match(/^[Oo][Rr][Gg](?:\s+(.*))?$/);
  if (orgM) {
    const operand = (orgM[1] ?? '').trim();
    if (operand.length === 0) return { kind: 'error', message: 'ORG requires an address' };
    const lit = parseLiteralOnly(operand);
    if ('error' in lit) return { kind: 'error', message: lit.error };
    if (lit.value < 0 || lit.value > 0xFFFF) {
      return { kind: 'error', message: `ORG address out of 16-bit range: ${lit.value}` };
    }
    return { kind: 'org', address: lit.value };
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

/** A per-instruction record produced by pass 1 and consumed by pass 2. */
interface Prepared {
  mnemonic: string;
  op:       ParsedOperand;
  pc:       number;   // address of this instruction
  mode:     Mode;     // mode chosen at pass 1 — committed
  opcode:   number;
  size:     number;
  lineIdx:  number;   // which annotation this came from
}

/** Per-line working state returned by pass 1 and pass 2. */
interface LineState { bytes: number[]; errors: AsmError[] }

/** Emit the operand bytes for a concrete (mode, value) pair.  For REL
 *  also does the signed-offset computation and range check. */
function emitOperand(
  mode:  Mode,
  value: number,
  pc:    number,
): { bytes: number[] } | { error: string } {
  const n = operandBytes(mode);
  if (mode === 'REL') {
    // REL is 1 operand byte, signed offset from the byte after this instruction.
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
 */
function pass1(
  annotations: string[],
  startAddr:   number,
): {
  prepared:   Prepared[];
  symbols:    Symbols;
  lineStates: LineState[];
  endAddr:    number;
} {
  const symbols: Symbols = new Map();
  const lineStates: LineState[] = annotations.map(() => ({ bytes: [], errors: [] }));
  const prepared: Prepared[] = [];
  let pc = startAddr & 0xFFFF;

  const declare = (lineIdx: number, name: string, value: Resolved): string | null => {
    if (symbols.has(name)) return `symbol already declared: ${name}`;
    symbols.set(name, value);
    void lineIdx;
    return null;
  };

  for (let lineIdx = 0; lineIdx < annotations.length; lineIdx++) {
    const stripped = stripComment(annotations[lineIdx]);
    const rawStatements = splitStatements(stripped);
    const stateErrs = lineStates[lineIdx].errors;

    for (const raw of rawStatements) {
      const stmt = parseStatement(raw);
      switch (stmt.kind) {
        case 'empty': break;

        case 'error':
          stateErrs.push({ message: stmt.message });
          break;

        case 'label': {
          const err = declare(lineIdx, stmt.name, { value: pc, forceWide: true });
          if (err) stateErrs.push({ message: err });
          break;
        }

        case 'equate': {
          const err = declare(lineIdx, stmt.name, stmt.value);
          if (err) stateErrs.push({ message: err });
          break;
        }

        case 'org':
          pc = stmt.address & 0xFFFF;
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
          });
          pc = (pc + size) & 0xFFFF;
          break;
        }
      }
    }
  }

  return { prepared, symbols, lineStates, endAddr: pc };
}

/**
 * Pass 2: walk the prepared instructions, resolving any remaining symbol
 * references and emitting bytes.  Each instruction's bytes are appended
 * to its source annotation's LineState.  For REL the signed offset is
 * computed here; undefined symbols and out-of-range branches become
 * errors attached to the originating line.
 */
function pass2(prepared: Prepared[], symbols: Symbols, lineStates: LineState[]): void {
  for (const p of prepared) {
    const lineState = lineStates[p.lineIdx];

    // IMP/ACC have no expression; emit just the opcode.
    if (p.op.expr === null) {
      lineState.bytes.push(p.opcode);
      continue;
    }

    const resolved = resolveExpr(p.op.expr, symbols);
    if (resolved === null) {
      const name = (p.op.expr.kind === 'sym') ? p.op.expr.name : '?';
      lineState.errors.push({ message: `undefined symbol: ${name}` });
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
    if ((p.op.form === 'DIR' || p.op.form === 'DIRX' || p.op.form === 'DIRY') &&
        (resolved.value < 0 || resolved.value > 0xFFFF)) {
      lineState.errors.push({ message: `address out of 16-bit range: ${resolved.value}` });
      continue;
    }

    const emit = emitOperand(p.mode, resolved.value, p.pc);
    if ('error' in emit) { lineState.errors.push({ message: emit.error }); continue; }
    lineState.bytes.push(p.opcode, ...emit.bytes);
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
 */
export function assembleProgram(
  annotations: string[],
  startAddr:   number,
): AssembledProgram {
  const { prepared, symbols, lineStates, endAddr } = pass1(annotations, startAddr);
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
