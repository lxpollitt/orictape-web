import type { Program } from './decoder';
import type { MergedProgram } from './merger';
import { bestSource } from './merger';
import { TAP_META_MAGIC } from './tapCommon';

/**
 * BASIC programs always load at 0x0501 on the Oric-1 / Atmos.
 */
const START_ADDR = 0x0501;

// ── Line extraction ───────────────────────────────────────────────────────────

interface TapLine {
  lineNum: number;
  tokens:  number[];
}

/**
 * Extract BASIC lines (as token-byte arrays) from a decoded Program.
 */
export function linesFromProgram(prog: Program): TapLine[] {
  return prog.lines.map(line => {
    const tokens: number[] = [];
    // prog.bytes layout per line (indices relative to firstByte):
    //   +0, +1  next-line pointer (recalculated by encoder)
    //   +2, +3  line number
    //   +4 … lastByte-1  token content
    //   lastByte  0x00 terminator
    for (let i = line.firstByte + 4; i < line.lastByte; i++) {
      tokens.push(prog.bytes[i].v);
    }
    // elements[0] is the line-number string e.g. "100 "
    const lineNum = parseInt(line.elements[0] ?? '', 10);
    return { lineNum: isNaN(lineNum) ? 0 : lineNum, tokens };
  });
}

/**
 * Extract BASIC lines from a MergedProgram, choosing the best source per line.
 */
export function linesFromMerged(
  merged: MergedProgram,
  progs:  ReadonlyArray<Program | undefined>,
): TapLine[] {
  const lines: TapLine[] = [];
  for (const alignedLine of merged.lines) {
    if (alignedLine.rejected) continue;
    const src  = bestSource(alignedLine, progs);
    const prog = progs[src.tapeIdx];
    if (!prog) continue;
    const line   = prog.lines[src.lineIdx];
    const tokens: number[] = [];
    for (let i = line.firstByte + 4; i < line.lastByte; i++) {
      tokens.push(prog.bytes[i].v);
    }
    lines.push({ lineNum: alignedLine.lineNum, tokens });
  }
  return lines;
}

// ── TAP block encoding ────────────────────────────────────────────────────────

export interface TapBlock {
  /** Program name (max 16 ASCII chars). */
  name:    string;
  lines:   TapLine[];
  /** 0x80 = auto-RUN on load; 0x00 = no autostart. */
  autorun: boolean;
}

/**
 * Encode a single TAP block into bytes (sync + header + name + BASIC data).
 *
 * TAP format:
 *   [0x16 × 8]  sync bytes
 *   [0x24]      sync marker
 *   [9 bytes]   header  — [0x00, 0x00, 0x00, autostart, end_hi, end_lo, start_hi, start_lo, 0x00]
 *   [name\0]    ASCII program name, null-terminated
 *   [BASIC...]  lines in Oric BASIC memory format, terminated by 0x00 0x00
 *
 * Each BASIC line:
 *   next_ptr_lo  next_ptr_hi   — little-endian absolute address of next line
 *   linenum_lo   linenum_hi    — little-endian line number
 *   token bytes…
 *   0x00                       — line terminator
 *
 * Note: header addresses are big-endian; in-line pointers are little-endian.
 */
function encodeTapBlock(block: TapBlock): number[] {
  const { name, lines, autorun } = block;

  // Each line: 2 (next ptr) + 2 (line num) + tokens.length + 1 (0x00)
  const lineSizes      = lines.map(l => 4 + l.tokens.length + 1);
  const totalBasicSize = lineSizes.reduce((a, b) => a + b, 0) + 2; // +2 for 0x00 0x00
  const END_ADDR       = START_ADDR + totalBasicSize; // exclusive: first byte past the data

  const out: number[] = [];

  // Sync
  for (let i = 0; i < 8; i++) out.push(0x16);
  out.push(0x24);

  // 9-byte header (addresses big-endian)
  out.push(
    0x00,                        // [0] always 0
    0x00,                        // [1] always 0
    0x00,                        // [2] file type: 0x00 = BASIC
    autorun ? 0x80 : 0x00,       // [3] autostart flag
    (END_ADDR   >> 8) & 0xFF,    // [4] end address high
     END_ADDR         & 0xFF,    // [5] end address low
    (START_ADDR >> 8) & 0xFF,    // [6] start address high (= 0x05)
     START_ADDR       & 0xFF,    // [7] start address low  (= 0x01)
    0x00,                        // [8] separator
  );

  // Program name (max 16 chars) + null terminator
  const nameBytes = Array.from(name.slice(0, 16), c => c.charCodeAt(0) & 0x7F);
  out.push(...nameBytes, 0x00);

  // BASIC line data with recalculated next-line pointers
  let currentAddr = START_ADDR;
  for (let i = 0; i < lines.length; i++) {
    const { lineNum, tokens } = lines[i];
    const nextLineAddr = currentAddr + lineSizes[i];

    out.push( nextLineAddr        & 0xFF);  // next ptr low  (little-endian)
    out.push((nextLineAddr >> 8)  & 0xFF);  // next ptr high
    out.push( lineNum             & 0xFF);  // line number low
    out.push((lineNum    >> 8)    & 0xFF);  // line number high
    out.push(...tokens);
    out.push(0x00);                          // line terminator

    currentAddr = nextLineAddr;
  }

  // End-of-program marker
  out.push(0x00, 0x00);

  return out;
}

export interface TapEntry {
  block:     TapBlock;
  metadata?: number[];   // optional metadata bytes to append after the block
}

/**
 * Encode one or more TAP entries into a single TAP file byte stream.
 * Each entry has its own sync sequence and header, optionally followed by metadata.
 */
export function encodeTapFile(entries: TapEntry[]): Uint8Array {
  const out: number[] = [];
  for (const entry of entries) {
    out.push(...encodeTapBlock(entry.block));
    if (entry.metadata) out.push(...entry.metadata);
  }
  return new Uint8Array(out);
}

// ── Metadata encoding ─────────────────────────────────────────────────────────

/**
 * Encode decode-quality metadata for a program as bytes to append after a TAP block.
 * Format: magic string + null terminator + UTF-8 JSON.
 *
 * JSON structure:
 * {
 *   v: 1,                       // metadata format version
 *   format: "fast" | "slow",    // waveform format (from WAV decode)
 *   chkErr:  [i1, i2, ...],     // byte indices with checksum errors
 *   unclear: [i1, i2, ...],     // byte indices with unclear bits
 *   edited: {
 *     explicit:  [i1, ...],     // byte indices marked as user-explicit edits
 *     automatic: [i1, ...]      // byte indices marked as automatic edits (e.g. pointer fixups)
 *   },
 *   lineDeltas: {               // displaced original bytes per line
 *     "<l>": [                  // l = line index (string key)
 *       { i: <offset>,          // splice position within the line's current bytes
 *         v: <byte> | [b1, b2, ...] }  // single byte or run of contiguous-originalIndex bytes
 *     ], ...
 *   }
 * }
 *
 * All byte indices in chkErr/unclear/edited are relative to the first header byte
 * (byte after 0x24 sync marker), so they are stable regardless of how many
 * sync/pre-sync bytes the byte stream contains.
 */
export function encodeTapMetadata(prog: Program): number[] {
  const headerStart = prog.header.byteIndex;
  const chkErr:  number[] = [];
  const unclear: number[] = [];
  const editedExplicit:  number[] = [];
  const editedAutomatic: number[] = [];
  for (let i = 0; i < prog.bytes.length; i++) {
    if (prog.bytes[i].chkErr)  chkErr.push(i - headerStart);
    if (prog.bytes[i].unclear) unclear.push(i - headerStart);
    if (prog.bytes[i].edited === 'explicit')  editedExplicit.push(i - headerStart);
    if (prog.bytes[i].edited === 'automatic') editedAutomatic.push(i - headerStart);
  }

  // Build per-line originalBytesDelta entries. Delta bytes are sorted by
  // originalIndex. We group consecutive originalIndex runs into a single entry
  // with v as an array; single bytes get v as a number (more compact JSON).
  const lineDeltas: { [l: string]: { i: number; v: number | number[] }[] } = {};
  for (let li = 0; li < prog.lines.length; li++) {
    const line = prog.lines[li];
    if (!line.originalBytesDelta || line.originalBytesDelta.length === 0) continue;

    // Compute splice positions within the lines current bytes: walk the line's 
    // current bytes and the delta bytes together in originalIndex order to figure 
    // out where each delta byte would splice back in (as an offset relative to the
    // line's start). Current non-edited bytes and delta bytes are interleaved by
    // originalIndex. Start by finding all the current non-edited bytes.
    const delta = line.originalBytesDelta;
    const entries: { i: number; v: number | number[] }[] = [];
    const currentNonEdited: { origIdx: number; lineOffset: number }[] = [];
    for (let o = 0; o < line.lastByte - line.firstByte + 1; o++) {
      const b = prog.bytes[line.firstByte + o];
      if (b.edited) continue;
      if (b.originalIndex === undefined) {
        console.warn('encodeTapMetadata: non-edited byte has no originalIndex', { lineIdx: li, offset: o, byte: b });
        continue;
      }
      currentNonEdited.push({ origIdx: b.originalIndex, lineOffset: o });
    }

    // For each delta byte, its splice position in the current line's bytes is
    // determined by how many current non-edited bytes have a smaller originalIndex.
    // Group consecutive deltas (by originalIndex) that map to the same splice position.
    let runStart = 0;
    while (runStart < delta.length) {
      const spliceIdx = delta[runStart].originalIndex;
      // Count current non-edited bytes with originalIndex < this delta's originalIndex.
      let lineOffset = 0;
      while (lineOffset < currentNonEdited.length
             && currentNonEdited[lineOffset].origIdx < spliceIdx!) {
        lineOffset++;
      }
      const i = lineOffset < currentNonEdited.length
        ? currentNonEdited[lineOffset].lineOffset
        : line.lastByte - line.firstByte + 1;  // past the end
      // Collect consecutive delta bytes that have contiguous originalIndex
      // values AND the same splice position.
      const run: number[] = [delta[runStart].v];
      let runEnd = runStart + 1;
      while (runEnd < delta.length
             && delta[runEnd].originalIndex === delta[runEnd - 1].originalIndex! + 1) {
        run.push(delta[runEnd].v);
        runEnd++;
      }
      entries.push({ i, v: run.length === 1 ? run[0] : run });
      runStart = runEnd;
    }
    if (entries.length > 0) lineDeltas[li.toString()] = entries;
  }

  const json = JSON.stringify({
    v: 1,
    format: prog.stream.format,
    chkErr,
    unclear,
    edited: { explicit: editedExplicit, automatic: editedAutomatic },
    lineDeltas,
  });

  const out: number[] = [];
  for (let i = 0; i < TAP_META_MAGIC.length; i++) out.push(TAP_META_MAGIC.charCodeAt(i));
  out.push(0x00); // null terminator
  for (let i = 0; i < json.length; i++) out.push(json.charCodeAt(i));
  return out;
}

// ── Browser download helper ───────────────────────────────────────────────────

/**
 * Trigger a browser file download for the given bytes.
 */
export function downloadTap(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
