import type { ByteInfo, BitStream, Program } from './decoder';
import { readProgramLines, flagNonMonotonicLines, flagElementErrors } from './decoder';
import { flagTokenisationMismatches } from './editor';
import { TAP_META_MAGIC, type TapMetadata } from './tapCommon';

/** A minimal empty BitStream for programs loaded from TAP (no waveform data). */
function emptyStream(format: 'fast' | 'slow' = 'fast'): BitStream {
  return {
    format:         'fast',
    bitCount:       0,
    bitV:           new Uint8Array(0),
    bitL1:          new Uint16Array(0),
    bitFirstSample: new Uint32Array(0),
    bitLastSample:  new Uint32Array(0),
    bitUnclear:     new Uint8Array(0),
    bitMaxIndex:    new Uint32Array(0),
    bitMinIndex:    new Uint32Array(0),
    firstSample:    0,
    lastSample:     0,
    minVal:         0,
    maxVal:         0,
  };
}

/**
 * Search for ORICTAPE_META magic in a byte range and parse the JSON metadata.
 * Returns null if no metadata is found.
 */
/**
 * Walk the program's bytes (and per-line deltas from metadata) in order,
 * assigning sequential originalIndex values to every non-edited byte and
 * every delta byte. Populates each line's originalBytesDelta.
 *
 * See encodeTapMetadata in tapEncoder.ts for the JSON structure of lineDeltas.
 */
function reassignOriginalIndicesWithDeltas(
  prog: Program,
  lineDeltas: { [l: string]: { i: number; v: number | number[] }[] },
): void {
  let nextOriginalIndex = 0;

  // Helper to normalize v to an array.
  const normalizeV = (v: number | number[]): number[] => Array.isArray(v) ? v : [v];

  // Find where lines span in prog.bytes.
  const firstLineByte = prog.lines.length > 0 ? prog.lines[0].firstByte : prog.bytes.length;
  const lastLineByte  = prog.lines.length > 0 ? prog.lines[prog.lines.length - 1].lastByte : -1;

  // Pre-first-line bytes.
  for (let i = 0; i < firstLineByte; i++) {
    const b = prog.bytes[i];
    if (!b.edited) b.originalIndex = nextOriginalIndex++;
    else           b.originalIndex = undefined;
  }

  // Each line, with delta interleaving.
  for (let li = 0; li < prog.lines.length; li++) {
    const line = prog.lines[li];
    const deltas = lineDeltas[li.toString()] || [];
    const deltaBytes: ByteInfo[] = [];

    // Walk the line's positions (line-relative offsets 0..length inclusive).
    // The extra iteration at offset === length handles trailing deltas (splice at end of line).
    const lineLen = line.lastByte - line.firstByte + 1;
    let deltaIdx = 0;
    for (let o = 0; o <= lineLen; o++) {
      // Insert any delta at this line-relative position.
      // At most one entry should match — deltas from storeOriginalBytesDelta
      // never have multiple runs at the same splice position.
      if (deltaIdx < deltas.length && deltas[deltaIdx].i === o) {
        const values = normalizeV(deltas[deltaIdx].v);
        for (const v of values) {
          deltaBytes.push({
            v,
            firstBit: 0, lastBit: 0,
            unclear: false, chkErr: false,
            originalIndex: nextOriginalIndex++,
          });
        }
        deltaIdx++;
        // Defensive check — shouldn't happen with deltas from storeOriginalBytesDelta.
        if (deltaIdx < deltas.length && deltas[deltaIdx].i === o) {
          console.warn('reassignOriginalIndicesWithDeltas: unexpected extra delta at same offset', { lineIdx: li, offset: o });
        }
      }
      // Process the current byte (if still within the line).
      if (o < lineLen) {
        const b = prog.bytes[line.firstByte + o];
        if (!b.edited) b.originalIndex = nextOriginalIndex++;
        else           b.originalIndex = undefined;
      }
    }

    if (deltaBytes.length > 0) {
      line.originalBytesDelta = deltaBytes;
    }
  }

  // Post-last-line bytes.
  for (let i = lastLineByte + 1; i < prog.bytes.length; i++) {
    const b = prog.bytes[i];
    if (!b.edited) b.originalIndex = nextOriginalIndex++;
    else           b.originalIndex = undefined;
  }
}

function findMetadata(data: Uint8Array, start: number, end: number): TapMetadata | null {
  // Search for the magic string.
  outer:
  for (let i = start; i <= end - TAP_META_MAGIC.length - 1; i++) {
    for (let j = 0; j < TAP_META_MAGIC.length; j++) {
      if (data[i + j] !== TAP_META_MAGIC.charCodeAt(j)) continue outer;
    }
    // Found magic — expect null terminator then JSON.
    const jsonStart = i + TAP_META_MAGIC.length + 1; // skip null
    if (data[i + TAP_META_MAGIC.length] !== 0x00) continue;
    // Read JSON until end of region.
    let json = '';
    for (let k = jsonStart; k < end; k++) json += String.fromCharCode(data[k]);
    try {
      return JSON.parse(json);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Parse an Oric-1 TAP file and return one Program per BASIC block found.
 *
 * Each TAP program block has the structure:
 *   [0x16 × N]  sync bytes  (N ≥ 4)
 *   [0x24]      sync marker
 *   [9 bytes]   header  —  byte[2] === 0x00 means BASIC
 *   [name\0]    null-terminated program name
 *   [BASIC…]    lines in Oric memory format
 *   [0x00 0x00] end-of-program marker
 *
 * We feed the raw bytes for each block directly into the existing
 * readProgramLines() parser so error detection and BASIC decoding remain
 * identical to the WAV path.
 */
export function parseTapFile(buffer: ArrayBuffer): Program[] {
  const data = new Uint8Array(buffer);
  const programs: Program[] = [];

  // ── Find all block start positions ──────────────────────────────────────────
  // A block starts at the first 0x16 in a run of ≥ 4 consecutive 0x16 bytes.
  const blockStarts: number[] = [];
  let i = 0;
  while (i < data.length) {
    if (data[i] === 0x16) {
      const runStart = i;
      while (i < data.length && data[i] === 0x16) i++;
      if (i - runStart >= 4) blockStarts.push(runStart);
    } else {
      i++;
    }
  }

  // ── Parse each block ─────────────────────────────────────────────────────────
  for (let b = 0; b < blockStarts.length; b++) {
    const start = blockStarts[b];
    // The block ends at the start of the next block (or EOF).  readProgramLines
    // will stop at the 0x00 0x00 end-of-program marker regardless, so giving it
    // extra trailing bytes is safe.
    const end = b + 1 < blockStarts.length ? blockStarts[b + 1] : data.length;

    // Build ByteInfo[] — all bytes are clean by default.
    // Each byte gets a sequential originalIndex for tracking the original byte order.
    const bytes: ByteInfo[] = [];
    for (let j = start; j < end; j++) {
      bytes.push({ v: data[j], firstBit: 0, lastBit: 0, unclear: false, chkErr: false, originalIndex: bytes.length });
    }

    // Check for metadata between this block's data and the next sync / EOF.
    const meta = findMetadata(data, start, end);

    const prog: Program = {
      stream: emptyStream(meta?.format),
      bytes,
      lines:  [],
      name:   '',
      header: { byteIndex: 0, fileType: 0, startAddr: 0, endAddr: 0, autorun: false },
    };

    readProgramLines(prog);

    // Apply metadata flags to bytes if present.
    // Metadata indices are relative to the first header byte; offset them
    // to the TAP byte stream's prog.bytes indices.
    if (meta) {
      const headerStart = prog.header.byteIndex;
      if (meta.chkErr) {
        for (const idx of meta.chkErr) {
          const bi = idx + headerStart;
          if (bi >= 0 && bi < bytes.length) bytes[bi].chkErr = true;
        }
      }
      if (meta.unclear) {
        for (const idx of meta.unclear) {
          const bi = idx + headerStart;
          if (bi >= 0 && bi < bytes.length) bytes[bi].unclear = true;
        }
      }
      if (meta.edited?.explicit) {
        for (const idx of meta.edited.explicit) {
          const bi = idx + headerStart;
          if (bi >= 0 && bi < bytes.length) bytes[bi].edited = 'explicit';
        }
      }
      if (meta.edited?.automatic) {
        for (const idx of meta.edited.automatic) {
          const bi = idx + headerStart;
          if (bi >= 0 && bi < bytes.length) bytes[bi].edited = 'automatic';
        }
      }

      // Process lineDeltas: create ByteInfo entries for delta bytes and
      // re-assign originalIndex values so delta bytes slot into the
      // original-byte sequence correctly.
      if (meta.lineDeltas) {
        reassignOriginalIndicesWithDeltas(prog, meta.lineDeltas);
      } else {
        // No deltas — edited bytes should have undefined originalIndex.
        for (const b of bytes) {
          if (b.edited) b.originalIndex = undefined;
        }
      }

      // Apply ignoreLineErrors flags to the corresponding lines.
      if (meta.ignoreLineErrors) {
        for (const li of meta.ignoreLineErrors) {
          if (li >= 0 && li < prog.lines.length) prog.lines[li].ignoreErrors = true;
        }
      }
    } else {
      // No metadata — edited bytes shouldn't exist, but if any are set via
      // other means, ensure originalIndex invariant holds.
      for (const b of bytes) {
        if (b.edited) b.originalIndex = undefined;
      }
    }

    // Run post-processing flags AFTER metadata is applied so byte-level errors
    // (chkErr, unclear) from metadata contribute to element-level styling.
    flagNonMonotonicLines(prog);
    flagTokenisationMismatches(prog);
    flagElementErrors(prog);

    if (prog.lines.length > 0) {
      programs.push(prog);
    }
  }

  return programs;
}
