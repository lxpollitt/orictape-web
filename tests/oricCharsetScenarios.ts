#!/usr/bin/env npx tsx
/**
 * Scenario tests for the Oric character-set conversion (oricCharset.ts)
 * and its integration into the assembler char/string paths and the
 * identifier grammar.
 *
 * Covers:
 *   - The single documented deviation: byte 0x5F ↔ `£`.
 *   - Identity passthrough for the rest of 0x20–0x7E.
 *   - Strict `_` rejection (ASCII underscore has no Oric glyph).
 *   - Round-trip invariant over the printable range.
 *   - Assembler `'c` literal and `DB "..."` going through the charset.
 *   - Identifier grammar: `_` no longer valid in declarations;
 *     synthesised `NAME.END` referenced via the dotted member form.
 *
 * Not part of CI — quick dev sanity check.  Run: npx tsx tests/oricCharsetScenarios.ts
 */

import { oricByteToChar, oricCharToByte } from '../src/oricCharset';
import { assemble, assembleProgram } from '../src/assembler6502';

type Test = { name: string; run: () => string | null };
const tests: Test[] = [];
function test(name: string, run: () => string | null) { tests.push({ name, run }); }

function asmErr(source: string): string | null {
  const { errors } = assemble(source, 0x0000);
  return errors.length === 0 ? null : errors[0].message;
}
function asmBytes(source: string): number[] {
  const { bytes, errors } = assemble(source, 0x0000);
  if (errors.length > 0) throw new Error(`${source} → ${errors.map(e => e.message).join('; ')}`);
  return bytes;
}

// ── Unit: byte → char ───────────────────────────────────────────────────────

test('oricByteToChar: 0x5F is £, 0x60 is ©', () => {
  if (oricByteToChar(0x5F) !== '£') return `0x5F → ${JSON.stringify(oricByteToChar(0x5F))}`;
  if (oricByteToChar(0x60) !== '©') return `0x60 → ${JSON.stringify(oricByteToChar(0x60))}`;
  return null;
});

test('oricByteToChar: identity for non-deviation bytes (incl. 0x5B [ , 0x5E ^ , 0x7E ~)', () => {
  // 0x5B/0x5E/0x7E are deliberately NOT modelled (standard / font bucket).
  for (const [b, c] of [[0x20, ' '], [0x41, 'A'], [0x5B, '['], [0x5E, '^'], [0x7E, '~']] as const) {
    if (oricByteToChar(b) !== c) return `0x${b.toString(16)} → ${JSON.stringify(oricByteToChar(b))}, want ${JSON.stringify(c)}`;
  }
  return null;
});

// ── Unit: char → byte ───────────────────────────────────────────────────────

test('oricCharToByte: £ is 0x5F, © is 0x60', () => {
  if (oricCharToByte('£') !== 0x5F) return `£ → ${oricCharToByte('£')}`;
  if (oricCharToByte('©') !== 0x60) return `© → ${oricCharToByte('©')}`;
  return null;
});

test('oricCharToByte: displaced ASCII slots rejected (strict): _ and backtick', () => {
  if (oricCharToByte('_') !== null) return `_ → ${oricCharToByte('_')}`;
  if (oricCharToByte('`') !== null) return `backtick → ${oricCharToByte('`')}`;
  return null;
});

test('oricCharToByte: identity for ASCII letters/punct (incl. ^ and ~)', () => {
  for (const [c, b] of [['A', 0x41], [' ', 0x20], ['~', 0x7E], ['^', 0x5E], ['[', 0x5B]] as const) {
    if (oricCharToByte(c) !== b) return `${JSON.stringify(c)} → ${oricCharToByte(c)}, want ${b}`;
  }
  return null;
});

test('oricCharToByte: non-Oric char (é) rejected', () =>
  oricCharToByte('é') === null ? null : `got ${oricCharToByte('é')}`);

// ── Round-trip invariant over the printable range ───────────────────────────

test('round-trip: byte → char → byte identity for 0x20–0x7E', () => {
  for (let b = 0x20; b <= 0x7E; b++) {
    const back = oricCharToByte(oricByteToChar(b));
    if (back !== b) return `0x${b.toString(16)} → ${JSON.stringify(oricByteToChar(b))} → ${back}`;
  }
  return null;
});

test('round-trip: char → byte → char identity for representable chars', () => {
  // Every printable Oric char (the 0x20–0x7E glyphs, with 0x5F as £).
  for (let b = 0x20; b <= 0x7E; b++) {
    const ch = oricByteToChar(b);
    const byte = oricCharToByte(ch);
    if (byte === null) return `${JSON.stringify(ch)} unexpectedly rejected`;
    if (oricByteToChar(byte) !== ch) return `${JSON.stringify(ch)} → ${byte} → ${JSON.stringify(oricByteToChar(byte))}`;
  }
  return null;
});

// ── Assembler char literal / DB string integration ──────────────────────────

test("'£ literal assembles to 0x5F (95)", () => {
  // LDA #'£  → A9 5F
  const b = asmBytes("LDA #'£");
  return (b.length === 2 && b[0] === 0xA9 && b[1] === 0x5F)
    ? null : `got [${b.map(x => x.toString(16)).join(' ')}]`;
});

test('DB "A£B" → 41 5F 42', () => {
  const b = asmBytes('DB "A£B"');
  return (b.length === 3 && b[0] === 0x41 && b[1] === 0x5F && b[2] === 0x42)
    ? null : `got [${b.map(x => x.toString(16)).join(' ')}]`;
});

test("'© literal assembles to 0x60 (96)", () => {
  const b = asmBytes("LDA #'©");
  return (b.length === 2 && b[0] === 0xA9 && b[1] === 0x60)
    ? null : `got [${b.map(x => x.toString(16)).join(' ')}]`;
});

test('DB "©1983" → 60 31 39 38 33', () => {
  const b = asmBytes('DB "©1983"');
  const want = [0x60, 0x31, 0x39, 0x38, 0x33];
  return (b.length === want.length && want.every((v, i) => b[i] === v))
    ? null : `got [${b.map(x => x.toString(16)).join(' ')}]`;
});

test('DB "`" errors (backtick — displaced ASCII slot, not in Oric charset)', () => {
  const e = asmErr('DB "`"');
  if (e === null) return 'expected an error';
  return /not in the Oric character set/i.test(e) ? null : `wrong message: ${e}`;
});

test('DB "_" errors (underscore not in Oric charset)', () => {
  const e = asmErr('DB "_"');
  if (e === null) return 'expected an error';
  return /not in the Oric character set/i.test(e) ? null : `wrong message: ${e}`;
});

test("'_ literal errors (underscore not in Oric charset)", () => {
  const e = asmErr("LDA #'_");
  if (e === null) return 'expected an error';
  return /not in the Oric character set/i.test(e) ? null : `wrong message: ${e}`;
});

// ── Identifier grammar ──────────────────────────────────────────────────────

test('declaration with underscore is rejected', () => {
  // `.MY_LABEL` is no longer a valid declarable name (no `_` — byte
  // 0x5F is `£` on the Oric).
  const e = asmErr('.MY_LABEL:RTS');
  if (e === null) return 'expected a declaration error for .MY_LABEL';
  return /invalid declaration/i.test(e) ? null : `wrong message: ${e}`;
});

test('synthesised NAME.END is referenceable via dotted member form', () => {
  // ORG .BLOCKA opens a block; .BLOCKA.END resolves to its last byte.
  // One RTS at $9800 → block end = $9800.  JMP BLOCKA.END → 4C 00 98.
  const prog = [
    'ORG $9800 .BLOCKA',
    'RTS',
    'ORG $9900',          // closes BLOCKA, fixing BLOCKA.END = $9800
    'JMP BLOCKA.END',
  ];
  const r = assembleProgram(prog, undefined, prog.map(() => false), prog.map(() => false));
  const errs = r.perLine.flatMap(s => s.errors.map(e => e.message));
  if (errs.length > 0) return `unexpected errors: ${errs.join('; ')}`;
  const jmp = r.perLine[3].bytes;
  return (jmp[0] === 0x4C && jmp[1] === 0x00 && jmp[2] === 0x98)
    ? null : `JMP bytes: [${jmp.map(x => x.toString(16)).join(' ')}]`;
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
