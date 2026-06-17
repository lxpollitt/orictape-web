import type { Program } from './decoder';
import { encodeTapBlock } from './tapEncoder';
import { encodeWavFile } from './wavfile';

// ── Oric fast-format tape-audio synthesis ─────────────────────────────────────
//
// Encodes a Program as authentic Oric-1 cassette audio — the inverse of the
// decode pipeline in decoder.ts.  See oric-tape-format.md for the ROM-derived
// spec this implements.  The ideal square cell stream is shaped by the Oric
// output-stage one-pole low-pass (shapeOutputStage); the deep "U" / droop seen
// in real recordings is the cassette tape channel, which we deliberately do NOT
// model (it's tape physics, not the Oric — see oric-tape-format.md §6).

/** WAV sample rate.  48 kHz gives exact integer half-cycle lengths. */
export const SAMPLE_RATE = 48000;

/** Leader length: `SYNC_BYTES` framed 0x16 bytes before the 0x24. Matches
 * real Oric ROM. */
export const SYNC_BYTES = 259;

/** Half-cycle lengths in samples at 48 kHz: a 2400 Hz half-period is 10 samples
 *  (the always-short leading half); a 1200 Hz half-period is 20. */
const SHORT_HALF = 10;
const LONG_HALF  = 20;

/** Cell amplitude before the output-stage filter: 16384 = exactly -6 dBFS
 *  (2^14); shapeOutputStage normalises the final peak to this.  Leaves ~6 dB of
 *  headroom so the WAV won't clip if the playback chain adds a little gain, and
 *  it's still plenty hot for the Oric's edge-triggered input. */
const AMPLITUDE = 16384;

/** Output-stage low-pass corner (Hz).  The Oric tape-out is a one-pole RC:
 *  `PB7 -> R12 (22K) -> tape-out`, with `R13 (1K)` and `C7 (47nF)` both to
 *  ground at the tape-out node (R12/R13 divide to ~150 mV; C7 shunts).  Corner
 *  = 1/(2π·R·C7) with R = R12∥R13∥Z_load.  Unloaded, R12∥R13 ≈ 957Ω -> 3.5 kHz
 *  (the floor); the recorder's mic input (Z_load, in parallel) RAISES it — a
 *  ~1kΩ mic load gives ~6.9 kHz.  That's well above the 2400 Hz carrier, so this
 *  only softens the square's corners by a sample or two: the authentic Oric
 *  *output*.  The deep tape "U" is NOT this stage — see oric-tape-format.md §6.
 *  Tunable. */
const OUTPUT_STAGE_FC = 6900;

/** The Oric's write loop is inclusive of the (exclusive) endAddr, so it puts
 *  one byte past the program terminator on tape — RAM garbage on real hardware.
 *  We emit a fixed filler so output is deterministic.  See oric-tape-format.md. */
const EXTRA_BYTE = 0x52;

/** Lead-in / trailing silence per program (samples), 2 s each - enough that a
 *  bundled multi-program WAV has a workable real-hardware gap between segments
 *  (prev trailing + next lead-in = inter-program gap = ~4 s) for the Oric to
 *  finish a CLOAD, return to BASIC and re-CLOAD.  (The trailing's other role,
 *  letting the receiver latch the final bit, needs only ms.) */
const LEAD_IN_SILENCE  = 2 * SAMPLE_RATE;   // 2 s
const TRAILING_SILENCE = 2 * SAMPLE_RATE;   // 2 s

/**
 * Emit one bit-cell as square samples.  The leading half is always HIGH (+), the
 * trailing half LOW (-): a 1-bit is short+short, a 0-bit is short+long (if
 * longFirst is false) or long+short (if longFirst is true).
 *
 * That renders the real Oric's phase alternation: within a 0-bit's full cycle
 * the long half-cycle is either the first half-cycle (high half-cycle), or the 
 * second half-cycle (low half-cycle), and normally alternating between each byte
 * (The per-byte rule driving `longFirst` is in encodeProgramSamples. See also
 * oric-tape-format.md). In either case the cell's full cycle length is the
 * same, led by the same positive-going edge the decoder splits on, so it decodes
 * identically in either case. But we replicate these phase changes when encoding
 * our audio to be authentic to what a real Oric would generate.
 */
function pushCell(out: number[], bit: 0 | 1, longFirst = false): void {
  if (bit === 0 && longFirst) {
    for (let i = 0; i < LONG_HALF;  i++) out.push(AMPLITUDE);   // long half HIGH (leading)
    for (let i = 0; i < SHORT_HALF; i++) out.push(-AMPLITUDE);  // short half LOW (trailing)
  } else {
    for (let i = 0; i < SHORT_HALF; i++) out.push(AMPLITUDE);
    const trail = bit ? SHORT_HALF : LONG_HALF;
    for (let i = 0; i < trail; i++) out.push(-AMPLITUDE);
  }
}

/** Emit one short half-cycle at the given level - authentically modelling the CSAVE startup. */
function pushHalf(out: number[], level: number): void {
  for (let i = 0; i < SHORT_HALF; i++) out.push(level);
}

/**
 * Frame one byte: start bit (0), 8 data bits LSB-first, then the parity bit.
 * Parity = NOT(popcount & 1) — the value the decoder treats as non-error (and
 * the ROM's `EOR #$01` / `LSR A`).  Stop bits belong to the inter-byte cadence
 * and are emitted by the caller.
 */
function pushFrame(out: number[], byte: number, longFirst = false): void {
  pushCell(out, 0, longFirst);
  let ones = 0;
  for (let i = 0; i < 8; i++) {
    const b = ((byte >> i) & 1) as 0 | 1;
    pushCell(out, b, longFirst);
    ones += b;
  }
  pushCell(out, ((ones & 1) ^ 1) as 0 | 1, longFirst);
}

/**
 * The byte stream to put on tape: a long sync leader + 0x24 + header + name +
 * data + the one trailing filler byte the ROM emits past endAddr.
 *
 * Uses the same paradigm as a TAP save (encodeTapBlock with fixEndAddr=true):
 * the header end-address gets the same automatic correction, the autorun byte
 * is normalised, and the program body is emitted as-is (no auto-repair — the
 * user applies "Fix pointers & terminators" first if they want that).  So a WAV
 * and a TAP of the same program carry identical content (bar the longer leader).
 * Exported for the round-trip test.
 */
export function buildByteStream(prog: Program, autorun?: boolean): number[] {
  return [...encodeTapBlock(prog, autorun, true, SYNC_BYTES), EXTRA_BYTE];
}

/**
 * Stop-bit cadence across the name->data gap (Oric-1 1.0 ROM, forward-derived).
 *
 * Between the name and the program data the ROM does non-tape work while the VIA
 * T1 free-runs emitting idle short half-periods.  Cycle-counted from the real
 * ROM (verified on a cycle-accurate 6502 emulator), the work splits into:
 *
 *   chunk           cycles        what the ROM does
 *   fixed chunk 1     590         finish the name byte's write, clear the status
 *                                 line, print "Saving ", and set up the name print
 *   variable      19 * nameLen    poke each program-name char to the screen
 *                                 (a 19-cycle screen-copy loop, one char each)
 *   fixed chunk 2      58         finish the name print, set up the data pointer,
 *                                 and start the write of the first data byte
 *
 * so gap_cycles(nameLen) = 648 + 19 * nameLen   (G0 = 590 + 58 = 648 fixed cycles).
 * The short half-period is 210 CPU cycles (VIA T1 latch $00D0 + 2); the VIA is
 * clocked by the CPU's phi2, so the timer and the instruction stream never
 * drift.  The first data byte re-syncs to the next timer timeout, so the whole
 * effect reduces to one integer q = floor(gap_cycles / 210): its magnitude sets
 * the first data byte's stop-run base (q+2) and its parity flips the post-gap
 * toggle phase.  This reproduces every measured real-tape name length exactly.
 *
 * There is a further few-cycle, irreducible cost we deliberately do NOT model:
 * the latency between the timer firing and the CPU's BVC noticing it (0-6
 * cycles, phase-dependent).  It only nudges G0 within [631, 687], and every
 * value in that window gives the identical cadence for any realistic name
 * length, so it has no effect on the output.
 *
 * Returns the stop-bit run for the first data byte (`first`) and for the byte
 * after it (`second`), from which the data body resumes the plain 3/4 toggle.
 */
function gapCadence(nameLen: number): { first: number; second: number } {
  const q = Math.floor((648 + 19 * nameLen) / 210);
  const e = nameLen & 1;
  const qEven = (q & 1) === 0;
  return {
    first:  (q + 2) - (qEven && e === 1 ? 1 : 0),
    second: qEven ? 3 + e : 4 - e,
  };
}

/**
 * Shape the ideal square cell stream into the Oric output-stage waveform: a
 * one-pole RC low-pass at OUTPUT_STAGE_FC, then normalise the peak to AMPLITUDE.
 * This is the pluggable waveform-renderer seam — swap for a different output
 * model later.  The filter runs over the whole buffer (silence included; its
 * state starts at 0, matching the lead-in silence) and, being well above the
 * carrier, preserves the cell edge timings the decoder keys off, so the
 * round-trip is unaffected.
 */
function shapeOutputStage(square: number[]): Int16Array {
  const alpha = 1 - Math.exp(-2 * Math.PI * OUTPUT_STAGE_FC / SAMPLE_RATE);
  const y = new Float64Array(square.length);
  let prev = 0, peak = 0;
  for (let i = 0; i < square.length; i++) {
    prev += alpha * (square[i] - prev);
    y[i] = prev;
    const m = prev < 0 ? -prev : prev;
    if (m > peak) peak = m;
  }
  const scale = peak > 0 ? AMPLITUDE / peak : 1;
  const out = new Int16Array(square.length);
  for (let i = 0; i < square.length; i++) out[i] = Math.round(y[i] * scale);
  return out;
}

/**
 * Encode a single program as Oric fast-format tape audio, returning 16-bit PCM
 * samples at SAMPLE_RATE.  Builds the ideal square cell stream, then runs it
 * through shapeOutputStage (the output-stage low-pass) for the final waveform.
 *
 * Cadence: the stop run before each byte alternates 3/4, seeded so the run
 * before the 0x24 (byte index SYNC_BYTES) is 3 - real Oric saves always show 3
 * there.  At the name->data boundary the ROM's gap perturbs it (see
 * gapCadence); everywhere else it is the plain toggle.  The first byte opens
 * with the real CSAVE startup half-cycles (low pedestal, first toggle, start-bit
 * leading half) instead of stop bits, matching the very start of a real save.
 */
export function encodeProgramSamples(prog: Program, autorun?: boolean): Int16Array {
  const bytes = buildByteStream(prog, autorun);
  const out: number[] = [];

  for (let i = 0; i < LEAD_IN_SILENCE; i++) out.push(0);

  // Locate the first data byte (just past the name's NUL) so the name->data gap
  // cadence lands there; everywhere else is the plain 3/4 toggle.
  const nameStart = SYNC_BYTES + 10;           // leader + 0x24 + 9 header bytes
  let nul = nameStart;
  while (nul < bytes.length && bytes[nul] !== 0x00) nul++;
  const { first, second } = gapCadence(nul - nameStart);
  const firstData = nul + 1;

  let stop = (SYNC_BYTES % 2 === 0) ? 3 : 4;   // 3/4 toggle, seeded so 0x24 = 3
  for (let i = 0; i < bytes.length; i++) {
    let run: number;
    let longFirst: boolean;
    if (i === firstData) {
      run  = first;          // the name->data gap
      stop = second;         // data body resumes the toggle from `second`
      // The gap byte's own run is anomalous, so its polarity can't be read from
      // it - it's the opposite of the (normal) 2nd data byte: long-first iff
      // `second` is odd (3).
      longFirst = (second & 1) === 1;
    } else {
      run  = stop;
      stop = stop === 3 ? 4 : 3;
      // long-first (long half high) iff the run is even (4), else low (3): the
      // run's parity and the polarity phase track together (both follow the
      // running half-period parity).  First data byte is the exception (above).
      longFirst = (run & 1) === 0;
    }
    if (i === 0) {
      // Open with the real CSAVE startup, not stop bits: the ROM drives PB7 low
      // at the T1C-H write, so the signal leads with a low pedestal half-cycle,
      // then the timer's first toggle (high), then the start bit's leading low
      // half.  pushFrame is high-half-first, so it can't emit that leading low
      // half - we hand-emit these three and let it resume at the start bit's
      // (long) high half.  See oric-tape-format.md.
      pushHalf(out, -AMPLITUDE);   // pedestal       (short, low)
      pushHalf(out, +AMPLITUDE);   // first toggle   (short, high)
      pushHalf(out, -AMPLITUDE);   // start-bit lead (short, low)
    } else {
      for (let s = 0; s < run; s++) pushCell(out, 1);
    }
    pushFrame(out, bytes[i], longFirst);
  }
  // Final byte's stop run, then a terminating 0 as the last bit, then silence
  // so the receiver latches it.  (Exact tail confirmed by the capture round-trip.)
  for (let s = 0; s < stop; s++) pushCell(out, 1);
  pushCell(out, 0);
  for (let i = 0; i < TRAILING_SILENCE; i++) out.push(0);

  return shapeOutputStage(out);
}

/** Encode a single program as a complete WAV file (mono, 16-bit, SAMPLE_RATE). */
export function encodeProgramWav(prog: Program, autorun?: boolean): Uint8Array {
  return encodeWavFile(encodeProgramSamples(prog, autorun), SAMPLE_RATE);
}

/**
 * Encode several programs into one WAV file (mono, 16-bit, SAMPLE_RATE): each
 * program's samples (with its own lead-in / trailing silence) concatenated in
 * order, the silences forming the inter-program gaps.  Mirrors the multi-program
 * bundling of a TAP save; the audio loads one program at a time (CLOAD each).
 */
export function encodeProgramsWav(progs: { prog: Program; autorun?: boolean }[]): Uint8Array {
  const chunks = progs.map(p => encodeProgramSamples(p.prog, p.autorun));
  const total  = chunks.reduce((n, c) => n + c.length, 0);
  const all    = new Int16Array(total);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.length; }
  return encodeWavFile(all, SAMPLE_RATE);
}
