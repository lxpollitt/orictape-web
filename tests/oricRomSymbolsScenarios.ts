#!/usr/bin/env npx tsx
/**
 * Scenario tests for built-in `SYS.` ROM symbols (oricRomSymbols.ts)
 * and their integration into the assembler operand / DB / back-patch
 * resolution paths.
 *
 * Covers: lookupSysSymbol rule logic (invariant / variant / single-ROM
 * / suffix-on-invariant / unknown / malformed); address spot-checks
 * against the curated reference; assembler integration (JSR operand,
 * byte-extract, DB word, back-patch directive); and the reserved-name
 * rejection.
 *
 * Not part of CI — run: npx tsx tests/oricRomSymbolsScenarios.ts
 */

import { lookupSysSymbol, isReservedSysName } from '../src/oricRomSymbols';
import { assemble, assembleProgram } from '../src/assembler6502';
import type { ByteInfo, LineInfo, Program } from '../src/decoder';
import { emptyBitStream, buildLineElements } from '../src/decoder';
import { parseLine } from '../src/editor';
import { applyAssembler } from '../src/asmApply';

type Test = { name: string; run: () => string | null };
const tests: Test[] = [];
function test(name: string, run: () => string | null) { tests.push({ name, run }); }

function asmBytes(src: string): number[] {
  const { bytes, errors } = assemble(src, 0x0000);
  if (errors.length > 0) throw new Error(`${src} → ${errors.map(e => e.message).join('; ')}`);
  return bytes;
}
function asmErr(src: string): string | null {
  const { errors } = assemble(src, 0x0000);
  return errors.length === 0 ? null : errors[0].message;
}

// ── lookupSysSymbol: rule logic ─────────────────────────────────────────────

test('invariant symbol resolves bare', () => {
  const r = lookupSysSymbol('SYS.PARAMS');
  return r.kind === 'ok' && r.value === 0x02E0 ? null : `got ${JSON.stringify(r)}`;
});

test('invariant symbol with suffix is an error', () => {
  const r = lookupSysSymbol('SYS.PARAMS.V11');
  return r.kind === 'error' && /same on both ROMs/.test(r.message)
    ? null : `got ${JSON.stringify(r)}`;
});

test('variant symbol bare is an error naming both forms', () => {
  const r = lookupSysSymbol('SYS.MUSIC');
  if (r.kind !== 'error') return `got ${JSON.stringify(r)}`;
  return /differs between/.test(r.message) && /SYS\.MUSIC\.V10/.test(r.message)
    && /SYS\.MUSIC\.V11/.test(r.message) ? null : `wrong message: ${r.message}`;
});

test('variant symbol .V10 / .V11 resolve to reference addresses', () => {
  const v10 = lookupSysSymbol('SYS.MUSIC.V10');
  const v11 = lookupSysSymbol('SYS.MUSIC.V11');
  if (v10.kind !== 'ok' || v10.value !== 0xFBFE) return `V10: ${JSON.stringify(v10)}`;
  if (v11.kind !== 'ok' || v11.value !== 0xFC18) return `V11: ${JSON.stringify(v11)}`;
  return null;
});

test('spot-check several variant addresses vs reference', () => {
  const cases: [string, number][] = [
    ['SYS.SOUND.V10', 0xFB26], ['SYS.SOUND.V11', 0xFB40],
    ['SYS.INT2FAC.V10', 0xD8D5], ['SYS.INT2FAC.V11', 0xD499],
    ['SYS.FAC2INT.V10', 0xD867], ['SYS.FAC2INT.V11', 0xD922],
    ['SYS.GTVALS.V10', 0xD996], ['SYS.GTVALS.V11', 0xDA22],
  ];
  for (const [n, want] of cases) {
    const r = lookupSysSymbol(n);
    if (r.kind !== 'ok' || r.value !== want) return `${n} → ${JSON.stringify(r)}, want $${want.toString(16)}`;
  }
  return null;
});

test('§5.9 CPU vectors invariant; RESET is variant', () => {
  const rv = lookupSysSymbol('SYS.RESETVEC');
  if (rv.kind !== 'ok' || rv.value !== 0xFFFC) return `RESETVEC: ${JSON.stringify(rv)}`;
  const nv = lookupSysSymbol('SYS.NMIVEC');
  if (nv.kind !== 'ok' || nv.value !== 0xFFFA) return `NMIVEC: ${JSON.stringify(nv)}`;
  const iv = lookupSysSymbol('SYS.IRQVEC');
  if (iv.kind !== 'ok' || iv.value !== 0xFFFE) return `IRQVEC: ${JSON.stringify(iv)}`;
  const r10 = lookupSysSymbol('SYS.RESET.V10');
  if (r10.kind !== 'ok' || r10.value !== 0xF42D) return `RESET.V10: ${JSON.stringify(r10)}`;
  const r11 = lookupSysSymbol('SYS.RESET.V11');
  if (r11.kind !== 'ok' || r11.value !== 0xF88F) return `RESET.V11: ${JSON.stringify(r11)}`;
  const bare = lookupSysSymbol('SYS.RESET');
  if (bare.kind !== 'error' || !/differs between/.test(bare.message)) return `bare RESET: ${JSON.stringify(bare)}`;
  const sfx = lookupSysSymbol('SYS.RESETVEC.V11');
  if (sfx.kind !== 'error' || !/same on both ROMs/.test(sfx.message)) return `RESETVEC.V11: ${JSON.stringify(sfx)}`;
  return null;
});

test('single-ROM symbol: .V11 resolves, .V10 errors, bare errors', () => {
  const v11 = lookupSysSymbol('SYS.CHECKKBD.V11');
  if (v11.kind !== 'ok' || v11.value !== 0xEB78) return `V11: ${JSON.stringify(v11)}`;
  const v10 = lookupSysSymbol('SYS.CHECKKBD.V10');
  if (v10.kind !== 'error' || !/not available on BASIC V1\.0/.test(v10.message)) {
    return `V10: ${JSON.stringify(v10)}`;
  }
  const bare = lookupSysSymbol('SYS.CHECKKBD');
  if (bare.kind !== 'error' || !/differs between/.test(bare.message)) {
    return `bare: ${JSON.stringify(bare)}`;
  }
  return null;
});

test('CHARSET / KEYCODETAB are ROM-variant (validated different per ROM)', () => {
  const c10 = lookupSysSymbol('SYS.CHARSET.V10');
  if (c10.kind !== 'ok' || c10.value !== 0xFC70) return `CHARSET.V10: ${JSON.stringify(c10)}`;
  const c11 = lookupSysSymbol('SYS.CHARSET.V11');
  if (c11.kind !== 'ok' || c11.value !== 0xFC78) return `CHARSET.V11: ${JSON.stringify(c11)}`;
  const k10 = lookupSysSymbol('SYS.KEYCODETAB.V10');
  if (k10.kind !== 'ok' || k10.value !== 0xFF70) return `KEYCODETAB.V10: ${JSON.stringify(k10)}`;
  const k11 = lookupSysSymbol('SYS.KEYCODETAB.V11');
  if (k11.kind !== 'ok' || k11.value !== 0xFF78) return `KEYCODETAB.V11: ${JSON.stringify(k11)}`;
  const bare = lookupSysSymbol('SYS.CHARSET');
  if (bare.kind !== 'error' || !/differs between/.test(bare.message)) return `bare CHARSET: ${JSON.stringify(bare)}`;
  return null;
});

test('video-mode-variant: SCREEN/STDCHARSET/ALTCHARSET resolve per mode', () => {
  const cases: [string, number][] = [
    ['SYS.SCREEN.TEXTMODE', 0xBB80], ['SYS.SCREEN.HIRESMODE', 0xA000],
    ['SYS.STDCHARSET.TEXTMODE', 0xB400], ['SYS.STDCHARSET.HIRESMODE', 0x9C00],
    ['SYS.ALTCHARSET.TEXTMODE', 0xB800], ['SYS.ALTCHARSET.HIRESMODE', 0x9800],
  ];
  for (const [n, want] of cases) {
    const r = lookupSysSymbol(n);
    if (r.kind !== 'ok' || r.value !== want) return `${n} → ${JSON.stringify(r)}, want $${want.toString(16)}`;
  }
  return null;
});

test('mode-variant bare reference errors (mode required)', () => {
  const r = lookupSysSymbol('SYS.SCREEN');
  return r.kind === 'error' && /depends on the video mode/.test(r.message)
    && /TEXTMODE/.test(r.message) && /HIRESMODE/.test(r.message)
    ? null : `got ${JSON.stringify(r)}`;
});

test('wrong-axis suffixes error helpfully', () => {
  // ROM suffix on a mode-variant symbol.
  const a = lookupSysSymbol('SYS.SCREEN.V11');
  if (a.kind !== 'error' || !/varies by video mode, not ROM/.test(a.message)) {
    return `SCREEN.V11: ${JSON.stringify(a)}`;
  }
  // Mode suffix on a ROM-variant symbol.
  const b = lookupSysSymbol('SYS.MUSIC.HIRESMODE');
  if (b.kind !== 'error' || !/varies by ROM, not video mode/.test(b.message)) {
    return `MUSIC.HIRESMODE: ${JSON.stringify(b)}`;
  }
  // Mode suffix on an invariant symbol.
  const c = lookupSysSymbol('SYS.PARAMS.TEXTMODE');
  if (c.kind !== 'error' || !/same on both ROMs and video modes/.test(c.message)) {
    return `PARAMS.TEXTMODE: ${JSON.stringify(c)}`;
  }
  return null;
});

test('mode-variant assembles in operand position', () => {
  const b = asmBytes('LDA SYS.SCREEN.HIRESMODE');   // AD 00 A0 (ABS)
  return (b.length === 3 && b[0] === 0xAD && b[1] === 0x00 && b[2] === 0xA0)
    ? null : `got [${b.map(x => x.toString(16)).join(' ')}]`;
});

test('unknown SYS name is an error', () => {
  const r = lookupSysSymbol('SYS.NOSUCHTHING');
  return r.kind === 'error' && /unknown built-in symbol/.test(r.message)
    ? null : `got ${JSON.stringify(r)}`;
});

test('bad version suffix is an error', () => {
  const r = lookupSysSymbol('SYS.MUSIC.V12');
  return r.kind === 'error' && /unknown suffix/.test(r.message)
    && /\.TEXTMODE or \.HIRESMODE/.test(r.message)
    ? null : `got ${JSON.stringify(r)}`;
});

test('non-SYS name passes through (notSys)', () => {
  const r = lookupSysSymbol('MYLABEL');
  return r.kind === 'notSys' ? null : `got ${JSON.stringify(r)}`;
});

test('case-insensitive matching', () => {
  const r = lookupSysSymbol('sys.params');
  return r.kind === 'ok' && r.value === 0x02E0 ? null : `got ${JSON.stringify(r)}`;
});

test('isReservedSysName', () => {
  if (!isReservedSysName('SYS')) return 'SYS should be reserved';
  if (!isReservedSysName('sys')) return 'sys should be reserved (case-insensitive)';
  if (isReservedSysName('SYSTEM')) return 'SYSTEM should NOT be reserved';
  return null;
});

// ── Assembler integration ───────────────────────────────────────────────────

test('JSR SYS.MUSIC.V11 → 20 18 FC', () => {
  const b = asmBytes('JSR SYS.MUSIC.V11');
  return (b.length === 3 && b[0] === 0x20 && b[1] === 0x18 && b[2] === 0xFC)
    ? null : `got [${b.map(x => x.toString(16)).join(' ')}]`;
});

test('STA SYS.PARAMS → ABS (8D E0 02)', () => {
  const b = asmBytes('STA SYS.PARAMS');
  return (b.length === 3 && b[0] === 0x8D && b[1] === 0xE0 && b[2] === 0x02)
    ? null : `got [${b.map(x => x.toString(16)).join(' ')}]`;
});

test('LDA #<SYS.MUSIC.V11 / #>SYS.MUSIC.V11 (byte-extract)', () => {
  const lo = asmBytes('LDA #<SYS.MUSIC.V11');   // A9 18
  const hi = asmBytes('LDA #>SYS.MUSIC.V11');   // A9 FC
  if (!(lo[0] === 0xA9 && lo[1] === 0x18)) return `lo: [${lo.map(x => x.toString(16)).join(' ')}]`;
  if (!(hi[0] === 0xA9 && hi[1] === 0xFC)) return `hi: [${hi.map(x => x.toString(16)).join(' ')}]`;
  return null;
});

test('DB SYS.PARAMS → E0 02 (16-bit word, little-endian)', () => {
  const b = asmBytes('DB SYS.PARAMS');
  return (b.length === 2 && b[0] === 0xE0 && b[1] === 0x02)
    ? null : `got [${b.map(x => x.toString(16)).join(' ')}]`;
});

test('JSR SYS.MUSIC (bare variant) → assembler error', () => {
  const e = asmErr('JSR SYS.MUSIC');
  return e !== null && /differs between/.test(e) ? null : `got ${e}`;
});

test('JSR SYS.NOPE → unknown built-in error', () => {
  const e = asmErr('JSR SYS.NOPE');
  return e !== null && /unknown built-in symbol/.test(e) ? null : `got ${e}`;
});

test('reserved name: .SYS declaration rejected', () => {
  const { perLine } = assembleProgram(['.SYS:RTS'], 0x9800);
  const msgs = perLine.flatMap(s => s.errors.map(e => e.message));
  return msgs.some(m => /reserved built-in namespace/.test(m))
    ? null : `expected reserved-name error, got ${JSON.stringify(msgs)}`;
});

test('reserved name: ORG $x .SYS block name rejected', () => {
  const { perLine } = assembleProgram(['ORG $9800 .SYS', 'RTS'], undefined);
  const msgs = perLine.flatMap(s => s.errors.map(e => e.message));
  return msgs.some(m => /reserved built-in namespace/.test(m))
    ? null : `expected reserved-name error, got ${JSON.stringify(msgs)}`;
});

// ── Back-patch directive integration (via applyAssembler) ───────────────────

function mkByte(v: number): ByteInfo {
  return { v, firstBit: 0, lastBit: 0, unclear: false, chkErr: false };
}
function mkProgram(lineTexts: string[]): Program {
  const START = 0x0501;
  const bytes: ByteInfo[] = [];
  const lines: LineInfo[] = [];
  for (let i = 0; i < 9; i++) bytes.push(mkByte(0));
  let next = START;
  for (const text of lineTexts) {
    const parsed = parseLine(text);
    if (!parsed) throw new Error(`parseLine failed: ${text}`);
    const memLen = 2 + parsed.bytes.length;
    const next2 = next + memLen;
    const firstByte = bytes.length;
    bytes.push(mkByte(next2 & 0xFF), mkByte((next2 >> 8) & 0xFF));
    for (const v of parsed.bytes) bytes.push(mkByte(v));
    const info: LineInfo = { v: '', elements: [], firstByte, lastByte: bytes.length - 1, lenErr: false };
    buildLineElements(info, bytes);
    lines.push(info);
    next = next2;
  }
  bytes.push(mkByte(0x00), mkByte(0x00));
  return {
    stream: emptyBitStream(), bytes, lines,
    name: 'test', originalSource: 'test', progNumber: 0,
    header: { byteIndex: 0, fileType: 0, autorun: false, startAddr: START, endAddr: next + 2 },
  } as Program;
}

test('back-patch CALL with SYS.MUSIC.V11 → CALL #FC18', () => {
  const p = mkProgram([
    "10 CALL #0 ' .SYS.MUSIC.V11",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length !== 0) return `unexpected errors: ${r.errors[0].message}`;
  if (!/^10 CALL #FC18/.test(p.lines[0].v)) return `line 0: ${p.lines[0].v}`;
  return null;
});

test('back-patch CALL with bare SYS.MUSIC → error', () => {
  const p = mkProgram([
    "10 CALL #0 ' .SYS.MUSIC",
  ]);
  const r = applyAssembler(p);
  if (r.errors.length === 0) return 'expected an error';
  return /differs between/.test(r.errors[0].message) ? null : `wrong: ${r.errors[0].message}`;
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
