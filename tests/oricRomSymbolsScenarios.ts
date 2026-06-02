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

import { lookupSysSymbol, lookupSysSymbolsByAddress, lookupSysParamsOffset, isReservedSysName } from '../src/oricRomSymbols';
import { lookupOrixAnnotation } from '../src/oricRomOrixSymbols';
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

test('§5.10 6522 VIA: timer registers and ORANH resolve to their port addresses', () => {
  // Pre-existing entries (sanity that the test reaches this block):
  const orb = lookupSysSymbol('SYS.ORB');
  if (orb.kind !== 'ok' || orb.value !== 0x0300) return `ORB: ${JSON.stringify(orb)}`;
  const via = lookupSysSymbol('SYS.VIA');
  if (via.kind !== 'ok' || via.value !== 0x0300) return `VIA: ${JSON.stringify(via)}`;

  // Newly added: T1 counter/latch ports each get a single label.
  const t1Cases: [string, number][] = [
    ['SYS.T1CL', 0x0304], ['SYS.T1CH', 0x0305],
    ['SYS.T1LL', 0x0306], ['SYS.T1LH', 0x0307],
  ];
  for (const [n, want] of t1Cases) {
    const r = lookupSysSymbol(n);
    if (r.kind !== 'ok' || r.value !== want) {
      return `${n} → ${JSON.stringify(r)}, want $${want.toString(16)}`;
    }
  }

  // T2 shares $0308 between counter-read and latch-write — both
  // labels resolve to the same address, mirroring the Atmos manual's
  // dual "T2C-L / T2L-L" notation.
  const t2cl = lookupSysSymbol('SYS.T2CL');
  if (t2cl.kind !== 'ok' || t2cl.value !== 0x0308) return `T2CL: ${JSON.stringify(t2cl)}`;
  const t2ll = lookupSysSymbol('SYS.T2LL');
  if (t2ll.kind !== 'ok' || t2ll.value !== 0x0308) return `T2LL: ${JSON.stringify(t2ll)}`;
  if (t2cl.value !== t2ll.value) return `T2CL/T2LL dual-label desynced`;
  const t2ch = lookupSysSymbol('SYS.T2CH');
  if (t2ch.kind !== 'ok' || t2ch.value !== 0x0309) return `T2CH: ${JSON.stringify(t2ch)}`;

  // $030F (ORA, no handshake) — the one register with a renamed SYS
  // label (`ORA (no handshake)` isn't a legal identifier).
  const oranh = lookupSysSymbol('SYS.ORANH');
  if (oranh.kind !== 'ok' || oranh.value !== 0x030F) return `ORANH: ${JSON.stringify(oranh)}`;
  return null;
});

test('§5.10 6522 VIA: T2 dual labels assemble to the same operand bytes', () => {
  // Operand-position end-to-end: `STA SYS.T2LL` and `STA SYS.T2CL`
  // must produce identical 3-byte ABS encodings (8D 08 03).  Catches
  // a future regression where one of the dual labels drifts off
  // $0308 — the lookup test above wouldn't notice if both moved
  // together, but the assemble path would still expose a divergence.
  const a = asmBytes('STA SYS.T2CL');
  const b = asmBytes('STA SYS.T2LL');
  if (a.length !== 3 || a[0] !== 0x8D || a[1] !== 0x08 || a[2] !== 0x03) {
    return `T2CL operand: [${a.map(x => x.toString(16)).join(' ')}]`;
  }
  if (b.length !== 3 || b[0] !== 0x8D || b[1] !== 0x08 || b[2] !== 0x03) {
    return `T2LL operand: [${b.map(x => x.toString(16)).join(' ')}]`;
  }
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
    ['SYS.SCREEN.TEXT', 0xBB80], ['SYS.SCREEN.HIRES', 0xA000],
    ['SYS.STDCHARSET.TEXT', 0xB400], ['SYS.STDCHARSET.HIRES', 0x9C00],
    ['SYS.ALTCHARSET.TEXT', 0xB800], ['SYS.ALTCHARSET.HIRES', 0x9800],
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
    && /TEXT/.test(r.message) && /HIRES/.test(r.message)
    ? null : `got ${JSON.stringify(r)}`;
});

test('wrong-axis suffixes error helpfully', () => {
  // ROM suffix on a mode-variant symbol.
  const a = lookupSysSymbol('SYS.SCREEN.V11');
  if (a.kind !== 'error' || !/varies by video mode, not ROM/.test(a.message)) {
    return `SCREEN.V11: ${JSON.stringify(a)}`;
  }
  // Mode suffix on a ROM-variant symbol.
  const b = lookupSysSymbol('SYS.MUSIC.HIRES');
  if (b.kind !== 'error' || !/varies by ROM, not video mode/.test(b.message)) {
    return `MUSIC.HIRES: ${JSON.stringify(b)}`;
  }
  // Mode suffix on an invariant symbol.
  const c = lookupSysSymbol('SYS.PARAMS.TEXT');
  if (c.kind !== 'error' || !/same on both ROMs and video modes/.test(c.message)) {
    return `PARAMS.TEXT: ${JSON.stringify(c)}`;
  }
  return null;
});

test('SYS.PARAMS+1 (the manual idiom) resolves to $02E1', () => {
  // STA SYS.PARAMS+1 → 8D E1 02 (ABS; PARAMS=$02E0).
  const b = asmBytes('STA SYS.PARAMS+1');
  return (b.length === 3 && b[0] === 0x8D && b[1] === 0xE1 && b[2] === 0x02)
    ? null : `got [${b.map(x => x.toString(16)).join(' ')}]`;
});

test('SYS.PARAMS+3 in immediate byte-extract: #<SYS.PARAMS+3 → A9 E3', () => {
  const b = asmBytes('LDA #<SYS.PARAMS+3');
  return (b.length === 2 && b[0] === 0xA9 && b[1] === 0xE3)
    ? null : `got [${b.map(x => x.toString(16)).join(' ')}]`;
});

test('arithmetic on a bare ROM-variant symbol still errors first', () => {
  const e = asmErr('JSR SYS.MUSIC+1');
  return e !== null && /differs between/.test(e) ? null : `got ${e}`;
});

test('mode-variant assembles in operand position', () => {
  const b = asmBytes('LDA SYS.SCREEN.HIRES');   // AD 00 A0 (ABS)
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
    && /\.TEXT or \.HIRES/.test(r.message)
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

// ── Reverse lookup (disassembler) ───────────────────────────────────────────

test('reverse lookup: invariant address → bare SYS.NAME', () => {
  const m = lookupSysSymbolsByAddress(0x02E0);
  return m.length === 1 && m[0] === 'SYS.PARAMS' ? null : `got ${JSON.stringify(m)}`;
});

test('reverse lookup: ROM-variant address → suffixed label', () => {
  const v11 = lookupSysSymbolsByAddress(0xFB40);   // SOUND.V11
  if (!(v11.length === 1 && v11[0] === 'SYS.SOUND.V11')) return `V11: ${JSON.stringify(v11)}`;
  const v10 = lookupSysSymbolsByAddress(0xFB26);   // SOUND.V10
  if (!(v10.length === 1 && v10[0] === 'SYS.SOUND.V10')) return `V10: ${JSON.stringify(v10)}`;
  return null;
});

test('reverse lookup: video-mode-variant address → .TEXT / .HIRES', () => {
  const t = lookupSysSymbolsByAddress(0xBB80);   // SCREEN.TEXT
  if (!(t.length === 1 && t[0] === 'SYS.SCREEN.TEXT')) return `text: ${JSON.stringify(t)}`;
  const h = lookupSysSymbolsByAddress(0xA000);   // SCREEN.HIRES
  if (!(h.length === 1 && h[0] === 'SYS.SCREEN.HIRES')) return `hires: ${JSON.stringify(h)}`;
  return null;
});

test('reverse lookup: block-base alias deprioritised below specific symbol', () => {
  // $0300 is both SYS.VIA (block base) and SYS.ORB.  Specific symbol
  // wins as the primary; block base appears as an alias.
  const m = lookupSysSymbolsByAddress(0x0300);
  if (m.length !== 2)        return `expected 2 matches, got ${JSON.stringify(m)}`;
  if (m[0] !== 'SYS.ORB')    return `primary should be SYS.ORB, got ${m[0]}`;
  if (m[1] !== 'SYS.VIA')    return `alias should be SYS.VIA, got ${m[1]}`;
  return null;
});

test('reverse lookup: no match returns empty array', () => {
  const m = lookupSysSymbolsByAddress(0x1234);
  return m.length === 0 ? null : `expected [], got ${JSON.stringify(m)}`;
});

test('PARAMS offset: +0 returns bare SYS.PARAMS', () => {
  const r = lookupSysParamsOffset(0x02E0);
  return r === 'SYS.PARAMS' ? null : `got ${JSON.stringify(r)}`;
});

test('PARAMS offset: +1 through +8 within the documented cap', () => {
  for (let off = 1; off <= 8; off++) {
    const r = lookupSysParamsOffset(0x02E0 + off);
    const want = `SYS.PARAMS+${off}`;
    if (r !== want) return `+${off}: got ${JSON.stringify(r)}, want ${want}`;
  }
  return null;
});

test('PARAMS offset: +9 (above cap) and below-base return null', () => {
  if (lookupSysParamsOffset(0x02E9) !== null) return `+9 should be null`;
  if (lookupSysParamsOffset(0x02DF) !== null) return `-1 should be null`;
  if (lookupSysParamsOffset(0x0300) !== null) return `+0x20 should be null`;
  return null;
});

// ── Orix .sym fallback annotations (Phase 2) ────────────────────────────────

test('orix: V1.1b-only address → `Name?`', () => {
  // WriteFileHeader at $E607 is in basic11b.sym only (V1.1b ran the
  // routine at this address; V1.0 has nothing here).
  const r = lookupOrixAnnotation(0xE607);
  return r === 'WriteFileHeader?' ? null : `got ${JSON.stringify(r)}`;
});

test('orix: V1.0-only address → `Name??`', () => {
  // GetTapeParams at $E725 is in basic10.sym only (V1.1b moved this
  // routine to $E7B2).
  const r = lookupOrixAnnotation(0xE725);
  return r === 'GetTapeParams??' ? null : `got ${JSON.stringify(r)}`;
});

test('orix: same label both ROMs → emit once at higher tier', () => {
  // JumpTab at $C006 is an invariant entry — same label on both ROMs.
  // Should collapse to a single `Name?` rather than `Name? Name??`.
  const r = lookupOrixAnnotation(0xC006);
  return r === 'JumpTab?' ? null : `got ${JSON.stringify(r)}`;
});

test('orix: different labels at same address → `V11? / V10??`', () => {
  // $FACB is labelled `EXPLODE` on V1.1b and `ExplodeData` on V1.0 —
  // the routines genuinely shifted between ROMs and the same address
  // serves different purposes.  Emit both, V1.1b first (higher tier).
  const r = lookupOrixAnnotation(0xFACB);
  return r === 'EXPLODE? / ExplodeData??' ? null : `got ${JSON.stringify(r)}`;
});

test('orix: documented V1.0 mislabels are excluded at source', () => {
  // $F88F: V1.0 .sym mislabels this as `Reset` (correct V1.0 Reset is
  // $F42D — exposed via SYS.RESET.V10).  We omit the bad V1.0 entry,
  // but V1.1b genuinely has Reset at $F88F so the V1.1b match still
  // surfaces.  Confirms the filter doesn't accidentally strip the
  // correct cross-ROM match.
  const r88F = lookupOrixAnnotation(0xF88F);
  if (r88F !== 'Reset?') return `$F88F: ${JSON.stringify(r88F)}`;

  // $E0AD: V1.0 .sym mislabels this as `Delay` (correct V1.0 Delay is
  // $EDAD — likely a digit-transposition typo upstream).  V1.1b has
  // nothing at $E0AD.  After filtering, neither ROM contributes —
  // result should be null.
  const rE0AD = lookupOrixAnnotation(0xE0AD);
  if (rE0AD !== null) return `$E0AD should be null after filter, got ${JSON.stringify(rE0AD)}`;
  return null;
});

test('orix: no match returns null', () => {
  // $F41E: the unattested address the user surfaced as a real-world
  // example — neither ROM's .sym labels it.  Regression guard.
  const r = lookupOrixAnnotation(0xF41E);
  return r === null ? null : `got ${JSON.stringify(r)}`;
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
