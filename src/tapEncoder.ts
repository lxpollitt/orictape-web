import type { Program } from './decoder';
import { fixHeaderEndAddr } from './editor';
import { TAP_META_MAGIC } from './tapCommon';

// ── TAP block encoding ────────────────────────────────────────────────────────

/**
 * Encode a Program as a TAP block (sync + header + name + program data).
 *
 * TAP format:
 *   [0x16 × 8]  sync bytes
 *   [0x24]      sync marker
 *   [9 bytes]   header  — [0x00, 0x00, fileType, autorun, end_hi, end_lo, start_hi, start_lo, 0x00]
 *   [name\0]    ASCII program name, null-terminated
 *   [data...]   BASIC lines (in Oric memory format, terminated by 0x00 0x00)
 *               or machine-code bytes, sized by header endAddr − startAddr.
 *
 * Largely a byte-level serializer: it copies prog.bytes directly and does
 * NOT recompute line pointers or line terminators (philosophy: "save what
 * you see" rather than silently patching the program — fixing those is a
 * deliberate user action via fixPointersAndTerminators).
 *
 * Narrow deviations from verbatim pass-through:
 *   1. Sync bytes are always the canonical 8× 0x16 + 0x24 (pre-header
 *      sync in prog.bytes is tape-discovery padding, not program data).
 *   2. The autorun bit (header byte 3) is overridable via the optional
 *      `autorun` argument — when omitted, the Program's embedded autorun
 *      value is used (useful for quick-save flows that should inherit
 *      whatever was loaded).
 *   3. When `fixEndAddr` is true (default), the encoder calls
 *      `fixHeaderEndAddr(prog)` — mutating prog.bytes and header.endAddr
 *      so the header's end-address matches the actual program layout.
 *      Displaced original bytes are captured in header.originalBytesDelta
 *      and the updated bytes are marked `edited: 'automatic'`, so the
 *      correction round-trips as a tracked edit in the saved TAP's
 *      metadata.  A mismatched endAddr causes Oric-1 CLOAD to read too
 *      many or too few bytes — the "too many" case pulls appended
 *      metadata into RAM, breaking LIST.  Callers can pass false to
 *      preserve prog.header.endAddr verbatim (forensic / raw-pass-through
 *      modes).  Mutation note: caller's Program will be modified when
 *      fixEndAddr=true; encodeTapFile relies on this to generate metadata
 *      that reflects the correction.
 *
 * For programs whose last line lacks a 0x00 terminator (e.g. truncated
 * fragments), fixHeaderEndAddr's layout-based formula sets endAddr one
 * byte shy of ideal — a minor imperfection we accept given that the
 * 3-zero guard in encodeTapFile makes the saved TAP still LIST-loadable
 * on common Oric-1 emulators, and the user can always apply the full
 * fix via the UI's "Fix pointers & terminators" checkbox.
 */
export function encodeTapBlock(
  prog:        Program,
  autorun?:    boolean,
  fixEndAddr:  boolean = true,
): number[] {
  if (fixEndAddr) fixHeaderEndAddr(prog);

  const out: number[] = [];
  const hdrStart   = prog.header.byteIndex;
  const useAutorun = autorun ?? prog.header.autorun;

  // Canonical sync.
  for (let i = 0; i < 8; i++) out.push(0x16);
  out.push(0x24);

  // 9 header bytes — copied verbatim from prog.bytes (possibly updated by
  // fixHeaderEndAddr above), with byte 3 (autorun) overridden.
  for (let i = 0; i < 9; i++) {
    if (i === 3) out.push(useAutorun ? 0x80 : 0x00);
    else         out.push(prog.bytes[hdrStart + i]?.v ?? 0);
  }

  // Name — copy from byteIndex+9 through the null terminator (inclusive).
  // If the name region overruns prog.bytes (malformed), synthesize 0x00.
  let nameEnd = hdrStart + 9;
  while (nameEnd < prog.bytes.length && prog.bytes[nameEnd].v !== 0) nameEnd++;
  for (let i = hdrStart + 9; i <= nameEnd; i++) {
    out.push(i < prog.bytes.length ? prog.bytes[i].v : 0x00);
  }

  // Program data.
  //   BASIC (lines present): copy from the first line's firstByte through
  //     the 2-byte end-marker position (lastByte + 2 inclusive).  Whatever
  //     values are at those positions get written — if the Program lacks a
  //     proper end marker, we still write the raw bytes found there.
  //   Machine code (no lines): copy from the byte after the name null
  //     through header.endAddr − startAddr bytes of data.
  // Anything past the derived endpoint (e.g. metadata bytes left in
  // prog.bytes from a previous round-trip) is intentionally excluded.
  const firstContentByte = nameEnd + 1;
  let endExclusive: number;
  if (prog.lines.length > 0) {
    const last = prog.lines[prog.lines.length - 1];
    endExclusive = last.lastByte + 3;   // include bytes at lastByte+1, +2
  } else {
    endExclusive = firstContentByte + (prog.header.endAddr - prog.header.startAddr);
  }
  endExclusive = Math.min(endExclusive, prog.bytes.length);
  for (let i = firstContentByte; i < endExclusive; i++) {
    out.push(prog.bytes[i].v);
  }

  return out;
}

export interface TapEntry {
  prog:      Program;
  /** Autorun override.  Defaults to prog.header.autorun when omitted. */
  autorun?:  boolean;
  /** Whether to let the encoder correct the header's end-address (default
   *  true).  When true, encodeTapBlock calls fixHeaderEndAddr on prog —
   *  so the mutation round-trips as a tracked edit in the metadata.
   *  See encodeTapBlock docstring for details. */
  fixEndAddr?:      boolean;
  /** Whether to append decode-quality metadata (chkErr, unclear, edit flags,
   *  line deltas, ignoreLineErrors) after the block.  Generated inside
   *  encodeTapFile — *after* any fixEndAddr mutation — so the metadata
   *  reflects the encoder's corrections. */
  includeMetadata?: boolean;
}

/**
 * Encode one or more TAP entries into a single TAP file byte stream.
 * Each entry contributes a TAP block and optionally its metadata bytes.
 *
 * Metadata is generated here (rather than by the caller) so it reflects
 * any mutations made by encodeTapBlock via fixHeaderEndAddr.  Between the
 * block's program data and the metadata magic we guarantee at least 3
 * trailing 0x00 bytes — mirrors the canonical end-of-program sequence
 * "(line terminator 0x00)(program terminator 0x00 0x00)" = three zeros,
 * so Oric loaders see a well-formed program even when the source Program
 * was malformed.  No-op when the block already ends with 3 zeros — the
 * common case.
 */
export function encodeTapFile(entries: TapEntry[]): Uint8Array {
  const out: number[] = [];
  for (const entry of entries) {
    const blockBytes = encodeTapBlock(entry.prog, entry.autorun, entry.fixEndAddr);
    out.push(...blockBytes);
    if (entry.includeMetadata) {
      let trailingZeros = 0;
      while (trailingZeros < 3
             && out.length - 1 - trailingZeros >= 0
             && out[out.length - 1 - trailingZeros] === 0x00) {
        trailingZeros++;
      }
      for (let i = trailingZeros; i < 3; i++) out.push(0x00);
      out.push(...encodeTapMetadata(entry.prog));
    }
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
 *   },
 *   ignoreLineErrors: [l1, ...] // line indices where user has marked errors as ignored
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

  // Collect line indices where the user has marked errors as ignored.
  const ignoreLineErrors: number[] = [];
  for (let li = 0; li < prog.lines.length; li++) {
    if (prog.lines[li].ignoreErrors) ignoreLineErrors.push(li);
  }

  const json = JSON.stringify({
    v: 1,
    format: prog.stream.format,
    chkErr,
    unclear,
    edited: { explicit: editedExplicit, automatic: editedAutomatic },
    lineDeltas,
    ignoreLineErrors,
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
