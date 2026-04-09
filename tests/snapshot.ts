#!/usr/bin/env npx tsx
/**
 * Snapshot tool: bulk-decode WAV files and produce TAP files + summary.txt.
 *
 * Usage: npx tsx tests/snapshot.ts <input-dir> <output-dir>
 *
 * For each .wav file in <input-dir>, decodes all programs and writes:
 *   - <output-dir>/summary.txt         — human-readable summary of all programs
 *   - <output-dir>/<file>_<n>.tap      — TAP file for each program with BASIC lines
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { parseWavFile } from '../src/wavfile';
import { readBitStreams, readPrograms } from '../src/decoder';
import { linesFromProgram, encodeTapFile, encodeTapMetadata } from '../src/encoder';
import type { Program } from '../src/decoder';

function usage(): never {
  console.error('Usage: npx tsx tests/snapshot.ts <input-dir> <output-dir>');
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length !== 2) usage();

const [inputDir, outputDir] = args;

if (!existsSync(inputDir)) {
  console.error(`Input directory not found: ${inputDir}`);
  process.exit(1);
}

mkdirSync(outputDir, { recursive: true });

function summariseProgram(prog: Program, index: number, sampleRate: number): string {
  const name = prog.name ? `"${prog.name}"` : '(unnamed)';
  const format = prog.stream.format;
  const bytes = prog.bytes.length;
  const lines = prog.lines.length;

  // Start time from the first BASIC line (or first byte as fallback)
  const refByteIdx  = lines > 0 ? prog.lines[0].firstByte : 0;
  const refBit      = prog.bytes[refByteIdx]?.firstBit ?? 0;
  const refSample   = prog.stream.bitFirstSample[refBit] ?? 0;
  const startSec    = (refSample / sampleRate).toFixed(1);

  // Byte-level stats (across the full hex stream)
  const errorBytes   = prog.bytes.filter(b => b.chkErr).length;
  const unclearBytes = prog.bytes.filter(b => b.unclear).length;

  // Line-level stats (within decoded BASIC)
  const lenErrLines      = prog.lines.filter(l => l.lenErr).length;
  const earlyEndLines    = prog.lines.filter(l => l.earlyEnd).length;
  const unknownKwLines   = prog.lines.filter(l => l.unknownKeyword).length;
  const earlyTermination = prog.earlyTermination ? ' EARLY_END' : '';

  // Bytes within BASIC line range vs outside
  let preBytes = 0;
  let postBytes = 0;
  if (lines > 0) {
    const firstContent = prog.lines[0].firstByte;
    const lastContent  = prog.lines[lines - 1].lastByte + 1;
    preBytes  = firstContent;
    postBytes = bytes - lastContent;
  }

  const parts = [
    `  Program ${index + 1}: ${name} ${format} @${startSec}s`,
    `${bytes} bytes (${preBytes} pre, ${postBytes} post)`,
    `${lines} lines`,
    `${errorBytes} err-bytes`,
    `${unclearBytes} unclear-bytes`,
  ];

  const flags: string[] = [];
  if (lenErrLines > 0)    flags.push(`${lenErrLines} len-err-lines`);
  if (earlyEndLines > 0)  flags.push(`${earlyEndLines} early-end-lines`);
  if (unknownKwLines > 0) flags.push(`${unknownKwLines} unknown-kw-lines`);
  if (earlyTermination)   flags.push('early-termination');

  if (flags.length > 0) parts.push(flags.join(', '));

  return parts.join(' | ');
}

const wavFiles = readdirSync(inputDir)
  .filter(f => f.toLowerCase().endsWith('.wav'))
  .sort();

if (wavFiles.length === 0) {
  console.error(`No .wav files found in ${inputDir}`);
  process.exit(1);
}

const summaryLines: string[] = [];
let totalFiles = 0;
let totalPrograms = 0;
let totalTaps = 0;

for (const filename of wavFiles) {
  totalFiles++;
  const filePath = join(inputDir, filename);
  const base     = basename(filename, '.wav');

  let programs: Program[];
  let sampleRate = 44100;
  try {
    const buf     = readFileSync(filePath);
    const wav     = parseWavFile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    sampleRate    = wav.sampleRate;
    const streams = readBitStreams(wav.left, wav.sampleRate);
    programs      = readPrograms(streams);
  } catch (e: any) {
    summaryLines.push(`${filename}`);
    summaryLines.push(`  ERROR: ${e.message}`);
    summaryLines.push('');
    continue;
  }

  summaryLines.push(`${filename}`);

  if (programs.length === 0) {
    summaryLines.push('  (no programs detected)');
  }

  for (let pi = 0; pi < programs.length; pi++) {
    const prog = programs[pi];
    totalPrograms++;
    summaryLines.push(summariseProgram(prog, pi, sampleRate));

    // Write TAP file only for programs with a valid header and decoded BASIC lines.
    if (prog.name && prog.lines.length > 0) {
      // Derive start time from the first BASIC line's position in the WAV.
      const lineFirstByte   = prog.lines[0].firstByte;
      const lineFirstBit    = prog.bytes[lineFirstByte].firstBit;
      const lineFirstSample = prog.stream.bitFirstSample[lineFirstBit];
      const startSec        = Math.floor(lineFirstSample / sampleRate);

      const tapLines = linesFromProgram(prog);
      const tapBytes = encodeTapFile([{
        block: { name: prog.name, lines: tapLines, autorun: false },
        metadata: encodeTapMetadata(prog),
      }]);
      const tapFilename = `${base}_${prog.name}_${startSec}s.tap`;
      writeFileSync(join(outputDir, tapFilename), tapBytes);
      totalTaps++;
    }
  }

  summaryLines.push('');
}

writeFileSync(join(outputDir, 'summary.txt'), summaryLines.join('\n') + '\n');

console.log(`Processed ${totalFiles} WAV files → ${totalPrograms} programs, ${totalTaps} TAP files`);
console.log(`Output: ${outputDir}/summary.txt`);
