#!/usr/bin/env npx tsx
/**
 * Extract program names from TAP and WAV files.
 *
 * Usage: npx tsx tests/extractNames.ts <path> [path...]
 *
 *   path  file (.tap or .wav) or directory. Directories are searched recursively.
 *
 * Output:
 *   one line per program found:  "<filename>: <name>"
 *
 * Both BASIC and machine code programs are reported.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { parseTapFile } from '../src/tapDecoder';
import { parseWavFile } from '../src/wavfile';
import { readBitStreams, readPrograms } from '../src/decoder';
import type { Program } from '../src/decoder';

function usage(): never {
  console.error('Usage: npx tsx tests/extractNames.ts <path> [path...]');
  console.error('  path  file (.tap or .wav) or directory (searched recursively)');
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0) usage();

// ── File discovery ───────────────────────────────────────────────────────────

function findFiles(path: string, out: string[]): void {
  let st;
  try { st = statSync(path); }
  catch { console.error(`Cannot access: ${path}`); return; }

  if (st.isDirectory()) {
    for (const entry of readdirSync(path)) {
      findFiles(join(path, entry), out);
    }
  } else if (st.isFile()) {
    const lower = path.toLowerCase();
    if (lower.endsWith('.tap') || lower.endsWith('.wav')) {
      out.push(path);
    }
  }
}

const files: string[] = [];
for (const arg of args) findFiles(arg, files);
files.sort();

// ── Name extraction ──────────────────────────────────────────────────────────

function programName(p: Program): string {
  if (p.name) return p.name;
  return p.header.fileType !== 0 ? '(unnamed machine code)' : '(unnamed)';
}

let totalPrograms = 0;

for (const file of files) {
  let programs: Program[] = [];
  try {
    const buf = readFileSync(file);
    const ab  = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    if (file.toLowerCase().endsWith('.tap')) {
      programs = parseTapFile(ab);
    } else {
      const wav     = parseWavFile(ab);
      const streams = readBitStreams(wav.left, wav.sampleRate);
      programs      = readPrograms(streams);
    }
  } catch (e: any) {
    console.error(`${file}: ERROR ${e.message}`);
    continue;
  }

  if (programs.length === 0) {
    console.log(`${file}: (no programs)`);
    continue;
  }

  for (const p of programs) {
    console.log(`${file}: ${programName(p)}`);
    totalPrograms++;
  }
}

console.error(`\nProcessed ${files.length} file(s), found ${totalPrograms} program(s).`);
