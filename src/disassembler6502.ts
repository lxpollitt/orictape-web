/**
 * Naive 6502 disassembler.
 *
 * Walks a byte sequence linearly, decoding each byte as an opcode and
 * consuming operand bytes based on the addressing mode. Produces one
 * formatted line per instruction.
 *
 * Limitations of this naive approach:
 *   - Can't distinguish code from data. Data interleaved with code will be
 *     decoded as nonsense instructions.
 *   - Illegal/unofficial opcodes are marked as "???".
 *   - Doesn't follow jumps/branches — just linear decode.
 */

// ── Addressing modes ────────────────────────────────────────────────────────
// Operand byte counts shown in comments.
type Mode =
  | 'IMP' // implied               (0)
  | 'ACC' // accumulator           (0)
  | 'IMM' // immediate #$nn        (1)
  | 'ZP'  // zero page $nn         (1)
  | 'ZPX' // zero page,X           (1)
  | 'ZPY' // zero page,Y           (1)
  | 'ABS' // absolute $nnnn        (2)
  | 'ABX' // absolute,X            (2)
  | 'ABY' // absolute,Y            (2)
  | 'IND' // indirect ($nnnn)      (2)
  | 'IZX' // (indirect,X)          (1)
  | 'IZY' // (indirect),Y          (1)
  | 'REL' // relative branch       (1, signed)
  ;

function operandBytes(mode: Mode): number {
  switch (mode) {
    case 'IMP': case 'ACC': return 0;
    case 'ABS': case 'ABX': case 'ABY': case 'IND': return 2;
    default: return 1;
  }
}

// ── Opcode table ────────────────────────────────────────────────────────────
// 256 entries indexed by opcode byte. null entries are illegal opcodes.
interface OpEntry { mnemonic: string; mode: Mode; }
const OP: (OpEntry | null)[] = new Array(256).fill(null);

function set(op: number, mnemonic: string, mode: Mode): void {
  OP[op] = { mnemonic, mode };
}

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

// ── Formatting helpers ──────────────────────────────────────────────────────

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');

function formatOperand(mode: Mode, operands: number[], pc: number): string {
  switch (mode) {
    case 'IMP': return '';
    case 'ACC': return 'A';
    case 'IMM': return `#$${hex2(operands[0])}`;
    case 'ZP':  return `$${hex2(operands[0])}`;
    case 'ZPX': return `$${hex2(operands[0])},X`;
    case 'ZPY': return `$${hex2(operands[0])},Y`;
    case 'ABS': return `$${hex4(operands[0] | (operands[1] << 8))}`;
    case 'ABX': return `$${hex4(operands[0] | (operands[1] << 8))},X`;
    case 'ABY': return `$${hex4(operands[0] | (operands[1] << 8))},Y`;
    case 'IND': return `($${hex4(operands[0] | (operands[1] << 8))})`;
    case 'IZX': return `($${hex2(operands[0])},X)`;
    case 'IZY': return `($${hex2(operands[0])}),Y`;
    case 'REL': {
      // Relative is signed 8-bit offset from the byte after the instruction.
      const offset = operands[0] < 0x80 ? operands[0] : operands[0] - 0x100;
      const target = (pc + 2 + offset) & 0xFFFF;
      return `$${hex4(target)}`;
    }
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Disassemble a byte array as 6502 machine code, starting at memory address startAddr.
 * Returns an array of formatted lines, one per instruction.
 *
 * Line format:  "$ADDR: HH HH HH  MNEM OPERAND"
 *   - ADDR:    4-digit hex memory address
 *   - HH HH HH: 1, 2, or 3 hex bytes for the instruction
 *   - MNEM:    3-letter mnemonic
 *   - OPERAND: addressing-mode-dependent operand string
 */
export function disassemble(bytes: number[], startAddr: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    const op = bytes[i];
    const entry = OP[op];
    const pc = (startAddr + i) & 0xFFFF;

    if (!entry) {
      // Illegal/unknown opcode.
      out.push(`$${hex4(pc)}: ${hex2(op)}         ???`);
      i++;
      continue;
    }

    const n = operandBytes(entry.mode);
    // Collect operand bytes (truncate cleanly if we run out).
    const operands: number[] = [];
    for (let j = 0; j < n; j++) {
      if (i + 1 + j < bytes.length) operands.push(bytes[i + 1 + j]);
      else operands.push(0);  // pad — should arguably flag this
    }

    const hexBytes = [op, ...operands].map(hex2).join(' ');
    const operandStr = formatOperand(entry.mode, operands, pc);
    const instr = operandStr ? `${entry.mnemonic} ${operandStr}` : entry.mnemonic;
    out.push(`$${hex4(pc)}: ${hexBytes.padEnd(8)}  ${instr}`);

    i += 1 + n;
  }
  return out;
}
