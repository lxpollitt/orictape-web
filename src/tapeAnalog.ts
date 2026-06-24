// ── Tape analog signal-path models ────────────────────────────────────────────
//
// Both ends of the Oric cassette analog path, kept together as one concern in
// two directions:
//   - applyInputStage  (decode side): the tape-IN conditioning a real Oric does
//     before the 6522 reads it - the C6/R5 AC-coupling, then optionally the IC3A
//     gain+clip and the IC3B comparator (the CB1 square). Modelled true to the
//     schematic; the final output is flipped once so it's always in the same phase.
//   - shapeOutputStage (encode side): the tape-OUT one-pole low-pass that softens
//     the ideal square before it reaches the recorder.
// Neither models the cassette tape channel itself (the deep "U" droop) - that's
// tape physics, not the Oric. See oric-tape-format.md / the input-stage notes.

// ───────────────────────────── INPUT stage (decode) ──────────────────────────


// ── Build-time input-stage selection (the flip point for corpus testing) ──
// Applied once at load (conditionSamples), so the decoder and the waveform view
// both work from the same conditioned signal.  Depth 0 = raw passthrough.
export const INPUT_STAGE_DEPTH: number = 0;   // 0 off | 1 AC-couple | 2 +IC3A (clip) | 3 +IC3B/TR1 (CB1 square)
export const INPUT_STAGE_DIODES       = true; // model D2/D3 + the dynamic-VREF network. Only bites at stages 2-3 (where IC3A clips); inert at 0-1.
export const INPUT_STAGE_VOLUME       = 50;   // cassette volume %, 0-100 (Oric manual: start at 50; ~65 keeps the diodes conducting - inert below ~55%)


/** Tape input-stage component values (OricSchematics Issue 6.1, tape.sch). */
const R5  = 10e3;    // ohms   - AC-coupling resistor
const C6  = 47e-9;   // farads - AC-coupling capacitor
const VREF = 2.5;    // mid-rail ref: RP3C/RP3D divider + C25 bypass → IC3A pin 3 (+) & IC3B pin 6 (-)
const VOH  = 3.5;    // IC3A (LM358) output ceiling on the +5V rail
const VOL  = 0.05;   // IC3A (LM358) output floor
const GAIN_A = 2.2;  // IC3A gain = (R29+RP3B)/R5 = 22k/10k
const R7  = 1e3;     // IC3A output → IC3B pin 5 (+)
const R8  = 100e3;   // IC3B output → pin 5 positive feedback (the Schmitt)

// ── Dynamic VREF / diode network (INPUT_STAGE_DIODES): D2/D3 + the VREF node, as-is ──
// With diodes OFF the inverting input (SUM) is assumed to sit exactly at a fixed 2.5 V.
// Diodes ON drops that: when IC3A clips, D2/D3 clamp SUM to VREF±Vf and inject that
// current onto VREF, which is a real node - the RP3C/RP3D divider (5k source impedance)
// with C25 across it, not a stiff rail.  Built from the component values; the sim
// decides what it does.
const VDD      = 5.0;        // +5V rail
const RP3D     = 10e3;       // VREF → +5V
const RP3C     = 10e3;       // VREF → DGND
const C25      = 100e-9;     // VREF bypass cap
const RF_A     = GAIN_A * R5; // IC3A feedback R29+RP3B = 22k (GAIN_A = RF_A/R5)
const DIODE_VF = 0.6;        // D2/D3 forward drop (generic small-signal Si)
const NET_OVERSAMPLE = 16;   // sub-steps per sample for the coupled ODE

/** C6/R5 AC-coupling high-pass corner: 1/(2π·R5·C6) ≈ 339 Hz. Below the
 *  1200-2400 Hz signal band, so in-band it passes the signal; its effect is to
 *  droop each cell (RC ≈ one bit-cell), which shifts the mid-line crossings
 *  readCycle keys off. Verified on the Welcome-A factory tape: this droop is
 *  what turns its symmetric "medium+medium" 0-bit cells back into "short+long". */
const DEFAULT_HP_FC = 1 / (2 * Math.PI * R5 * C6);

/** CB1 square amplitude (arbitrary; the decoder slices adaptively). */
const CB1_AMPLITUDE = 20000;

// Fidelity notes (for the schematic authenticity check):
//  - Diodes OFF: IC3A's output rails [VOL,VOH] stand in for D2/D3, and VREF is a fixed
//    2.5 V.  Diodes ON drops both - it models D2/D3 as a SUM clamp injecting current
//    onto a real VREF node (RP3C/RP3D divider + C25).  Neither models the op-amp's own
//    slew/GBW: at 0.3 V/µs and ~455 kHz those are ~7-400x faster than the tape signal in
//    the usable volume range, so they don't move the crossings (slew-headroom calc) -
//    the clip and the diode current are the live effects.
//  - Supply noise on VREF (what C25 chiefly rejects on real hardware) is absent here:
//    the input is a clean tape capture, so there is no +5V switching to reject.

/** Cassette-player volume → TAPE_IN volts: the peak voltage the loudest sample maps
 *  to at full volume (100%).  ~2.5 V peak is the firm-data anchor - it puts the
 *  usual 50-80% dial range on the ~0.5-2 V the Oric service manual expects at its
 *  cassette input (≈ the ~1 V RMS working level seen across period gear).  One
 *  adjustable constant; retune if a real deck is ever measured.  NB at these levels
 *  the ×2.2 gain already clips IC3A, so depth 3 (CB1) is the most authentic tap. */
const HEADPHONE_MAX_VPEAK = 2.5;

/** Volt-scaling level reference: the trimmed peak of |sample| - the loudest
 *  LEVEL_TRIM fraction is dropped (a histogram quantile) so a brief transient (a
 *  tape/capture click) can't hijack the calibration the way a plain whole-file max
 *  would.  4096 buckets = 8-unit resolution (<2% even on a quiet ~500 peak; the
 *  level only matters in the clipping regime, where the bulk height tracks it). */
const LEVEL_HIST_BUCKETS = 4096;
const LEVEL_TRIM         = 0.01;   // drop the loudest 1% (99th percentile) - tunable

/** Peak of |samples| after discarding the loudest LEVEL_TRIM fraction - a robust
 *  max that ignores impulse outliers.  Histogram, one O(n) pass, no sort. */
function trimmedMax(samples: Int16Array): number {
  const W = 32768 / LEVEL_HIST_BUCKETS;             // bucket width
  const hist = new Int32Array(LEVEL_HIST_BUCKETS);
  const n = samples.length;
  for (let i = 0; i < n; i++) {
    const a = samples[i] < 0 ? -samples[i] : samples[i];
    hist[Math.min(LEVEL_HIST_BUCKETS - 1, (a / W) | 0)]++;
  }
  const drop = Math.floor(n * LEVEL_TRIM);
  let acc = 0;
  for (let b = LEVEL_HIST_BUCKETS - 1; b > 0; b--) {
    acc += hist[b];
    if (acc > drop) return (b + 1) * W;             // upper edge of this bucket
  }
  return W;                                          // all-quiet fallback (no /0)
}

export interface InputStageConfig {
  /** AC-coupling high-pass corner, Hz. Defaults to the C6/R5 component value
   *  (~339 Hz); exposed so a setting can sweep it. */
  highPassFc?: number;
  /** Which node to tap: 'ac' = C6/R5 output, 'ic3a' = + IC3A (gain + clip), 'cb1' =
   *  + IC3B/TR1 (the CB1 square).  The '…net' variants add the D2/D3 + dynamic-VREF
   *  network: 'cb1net'/'ic3anet' are 'cb1'/'ic3a' with it on; 'vref'/'sum' expose that
   *  network's internal node voltages (script diagnostics - they don't decode). Default 'ac'. */
  stage?: 'ac' | 'ic3a' | 'cb1' | 'cb1net' | 'ic3anet' | 'vref' | 'sum';
  /** Cassette-player volume, 0-100 %. Maps the tape signal's peak (a trimmed max,
   *  so a transient can't skew it) to (volume/100) × HEADPHONE_MAX_VPEAK volts at
   *  TAPE_IN. Only matters for 'ic3a'/'cb1' (it sets how hard IC3A clips); inert
   *  for 'ac' (linear → the decoder's midline adapts). */
  volume?: number;
  /** Sub-steps per sample for the diodes-on coupled ODE (default NET_OVERSAMPLE).
   *  Lower = faster load; verify it doesn't move the output before trusting a low value. */
  oversample?: number;
}

/**
 * Apply the Oric tape input stage to a sample buffer ahead of decoding, returning
 * a new same-length Int16Array (indices preserved, so BitStream sample positions
 * and the waveform view stay aligned with the original).
 *
 * Modelled true to the schematic, real inversions intact:
 *   C6/R5 AC-couple → IC3A (inverting ×2.2, output rails) → IC3B (Schmitt about
 *   VREF via R7/R8) → TR1 (inverts) → CB1.  The two inversions cancel, so CB1 is
 *   in phase with TAPE_IN.  `cfg.stage` picks which node to tap:
 *     - 'ac'   : the AC-couple node hp     (in phase)  → no flip
 *     - 'ic3a' : the IC3A analog output    (inverted)  → flip once
 *     - 'cb1'  : the CB1 square            (in phase)  → no flip
 *   and we digitally flip only the inverted tap, so the value handed to the decoder
 *   is always in phase regardless of stage (byte decode is polarity-invariant
 *   anyway; this just keeps stage comparisons honest).
 *
 * `volume` (0-100 %) maps the tape signal's (trimmed) peak to (volume/100)×
 * HEADPHONE_MAX_VPEAK volts so the rail/Schmitt thresholds mean something; inert for
 * 'ac' (linear → the decoder's midline is adaptive).
 */
export function applyInputStage(
  samples: Int16Array,
  sampleRate: number,
  cfg: InputStageConfig = {},
): Int16Array {
  const fc = cfg.highPassFc ?? DEFAULT_HP_FC;
  const dt = 1 / sampleRate;
  const alpha = 1 / (1 + 2 * Math.PI * fc * dt);
  const n = samples.length;
  const stage = cfg.stage ?? 'ac';

  // 'ac' (committed baseline): the C6/R5 node - the signal at IC3A's input - in
  // phase, raw-sample domain, level-invariant.  Bit-identical.
  if (stage === 'ac') {
    const out = new Int16Array(n);
    let hp = 0, xPrev = 0;
    for (let i = 0; i < n; i++) {
      const x = samples[i];
      hp = alpha * (hp + x - xPrev);
      xPrev = x;
      const v = Math.round(hp);
      out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
    }
    return out;
  }

  // Circuit path ('ic3a' / 'cb1') - in volts.  volume maps the tape signal's peak
  // (a trimmed max, so a transient can't skew it) to its TAPE_IN voltage, so the
  // rail and Schmitt thresholds bite at the right place.
  const level = trimmedMax(samples);
  const vPeak = ((cfg.volume ?? 50) / 100) * HEADPHONE_MAX_VPEAK;
  const toVolts = vPeak / level;

  const out = new Int16Array(n);
  let hp = 0, xPrev = 0, st = VOL;   // st = IC3B output state (VOH high / VOL low)

  if (stage === 'cb1') {
    // Full chain → CB1.  TR1's inversion cancels IC3A's, so no flip is needed.
    for (let i = 0; i < n; i++) {
      const x = samples[i] * toVolts;
      hp = alpha * (hp + x - xPrev); xPrev = x;             // C6/R5 AC-couple
      let a = VREF - GAIN_A * hp;                           // IC3A (inverting)
      a = a > VOH ? VOH : a < VOL ? VOL : a;                // output rails (~ D2/D3)
      const p5 = (a * R8 + st * R7) / (R7 + R8);            // IC3B pin 5: signal + R8 feedback
      if (st > VREF && p5 < VREF) st = VOL;                 // IC3B Schmitt about VREF
      else if (st < VREF && p5 > VREF) st = VOH;
      out[i] = st <= VREF ? CB1_AMPLITUDE : -CB1_AMPLITUDE; // TR1 inverts → CB1 in phase
    }
    return out;
  }

  if (stage === 'cb1net' || stage === 'ic3anet' || stage === 'vref' || stage === 'sum') {
    // Diodes-on network: full chain with D2/D3 and the VREF node modelled as drawn.  Oversampled
    // because the diode current pulses within each carrier cycle.  IC3A is ideal-but-
    // railed (its slew/GBW don't bite in-band); the live extras over 'cb1' are the diode
    // clamp on SUM and the current it injects onto a *real* VREF node (RP3C/RP3D + C25).
    //   'cb1net'  → CB1 square (for decoding)
    //   'ic3anet' → IC3A analog output, flipped in-phase + normalised (waveform view)
    //   'vref'/'sum' → that internal node's deviation from 2.5 V, FIXED scale (±1 V ≈ full
    //                  height) so magnitude is honest, with the peak logged to the console.
    const K = cfg.oversample ?? NET_OVERSAMPLE, dts = dt / K;
    const G5 = 1 / R5, Gf = 1 / RF_A, tauC6 = R5 * C6;
    const NODE_VIEW = 28000;     // int16 per volt of node deviation from 2.5 V
    let Vj1 = VREF, vref = VREF, vinPrev = 0, outA = VREF, sum = VREF;
    const analog = stage === 'ic3anet' ? new Float32Array(n) : null;
    const node = stage === 'vref' || stage === 'sum' ? stage : null;
    let m = 1e-9, nodePeak = 0;
    for (let i = 0; i < n; i++) {
      const vinS = samples[i] * toVolts;
      const dvin = (vinS - vinPrev) / K;                       // input change per sub-step
      for (let k = 0; k < K; k++) {
        outA = vref - GAIN_A * (Vj1 - vref);                   // IC3A (inverting) about the live VREF
        if (outA <= VOH && outA >= VOL) {
          sum = vref;                                          // not railed: op-amp holds SUM=VREF
        } else {
          outA = outA > VOH ? VOH : VOL;                       // railed
          const sf = (Vj1 * G5 + outA * Gf) / (G5 + Gf);       // SUM node-solve (feedback broken)
          sum = sf > vref + DIODE_VF ? vref + DIODE_VF         // D2/D3 clamp |SUM-VREF| ≤ Vf
              : sf < vref - DIODE_VF ? vref - DIODE_VF : sf;
        }
        const iDiode = (Vj1 - sum) * G5 + (outA - sum) * Gf;   // diode current → VREF (0 unclamped)
        vref += ((VDD - vref) / RP3D - vref / RP3C + iDiode) / C25 * dts;  // VREF node (C25)
        Vj1  += dvin - (Vj1 - sum) * dts / tauC6;              // C6/R5, terminated at the real SUM
        const sense = (outA * R8 + st * R7) / (R7 + R8);       // IC3B pin 5
        if (st > vref && sense < vref) st = VOL;               // Schmitt about the live VREF
        else if (st < vref && sense > vref) st = VOH;
      }
      vinPrev = vinS;
      if (analog) {
        const v = -(outA - vref);                             // flip inverted IC3A node → in phase
        analog[i] = v;
        const av = v < 0 ? -v : v; if (av > m) m = av;
      } else if (node) {
        const dev = (node === 'vref' ? vref : sum) - VREF;     // deviation from 2.5 V
        const iv = Math.round(dev * NODE_VIEW);
        out[i] = iv > 32767 ? 32767 : iv < -32767 ? -32767 : iv;
        const ad = dev < 0 ? -dev : dev; if (ad > nodePeak) nodePeak = ad;
      } else {
        out[i] = st <= vref ? CB1_AMPLITUDE : -CB1_AMPLITUDE; // TR1 inverts → CB1 in phase
      }
    }
    if (analog) {
      const kk = 28000 / m;                                    // normalise to fill int16 (decoder is level-adaptive)
      for (let i = 0; i < n; i++) out[i] = Math.round(analog[i] * kk);
    }
    if (node) console.log(`[input-stage ${node === 'vref' ? 'depth 6 VREF' : 'depth 7 SUM'}] peak deviation from 2.5 V = ${(nodePeak * 1000).toFixed(1)} mV  (view: ±1 V ≈ full height)`);
    return out;
  }

  // stage === 'ic3a': tap IC3A's analog output (inverted), flip it back into phase,
  // then normalise to fill int16 (the decoder is level-adaptive).
  const node = new Float32Array(n);
  let m = 1e-9;
  for (let i = 0; i < n; i++) {
    const x = samples[i] * toVolts;
    hp = alpha * (hp + x - xPrev); xPrev = x;               // C6/R5 AC-couple
    let a = VREF - GAIN_A * hp;                             // IC3A (inverting)
    a = a > VOH ? VOH : a < VOL ? VOL : a;                  // output rails (~ D2/D3)
    const v = -(a - VREF);                                  // flip the inverted IC3A node → in phase
    node[i] = v;
    const av = v < 0 ? -v : v; if (av > m) m = av;
  }
  const k = 28000 / m;
  for (let i = 0; i < n; i++) out[i] = Math.round(node[i] * k);
  return out;
}

/** Apply the configured input stage to freshly-loaded samples (raw passthrough at
 *  depth 0).  Called at load so decode and display share the conditioned signal. */
export function conditionSamples(samples: Int16Array, sampleRate: number): Int16Array {
  if (INPUT_STAGE_DEPTH <= 0) return samples;
  const d = INPUT_STAGE_DIODES;                          // diodes only act once IC3A clips (stages 2-3)
  const stage = INPUT_STAGE_DEPTH === 1 ? 'ac'
              : INPUT_STAGE_DEPTH === 2 ? (d ? 'ic3anet' : 'ic3a')
              : (d ? 'cb1net' : 'cb1');
  return applyInputStage(samples, sampleRate, { stage, volume: INPUT_STAGE_VOLUME });
}

// ───────────────────────────── OUTPUT stage (encode) ─────────────────────────

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

/**
 * Shape the ideal square cell stream into the Oric output-stage waveform: a
 * one-pole RC low-pass at `fc` (default OUTPUT_STAGE_FC), then normalise the peak
 * to `amplitude`.  This is the pluggable waveform-renderer seam — swap for a
 * different output model later.  The filter runs over the whole buffer (silence
 * included; its state starts at 0, matching the lead-in silence) and, being well
 * above the carrier, preserves the cell edge timings the decoder keys off, so the
 * round-trip is unaffected.
 */
export function shapeOutputStage(
  square: number[],
  sampleRate: number,
  amplitude: number,
  fc = OUTPUT_STAGE_FC,
): Int16Array {
  const alpha = 1 - Math.exp(-2 * Math.PI * fc / sampleRate);
  const y = new Float64Array(square.length);
  let prev = 0, peak = 0;
  for (let i = 0; i < square.length; i++) {
    prev += alpha * (square[i] - prev);
    y[i] = prev;
    const m = prev < 0 ? -prev : prev;
    if (m > peak) peak = m;
  }
  const scale = peak > 0 ? amplitude / peak : 1;
  const out = new Int16Array(square.length);
  for (let i = 0; i < square.length; i++) out[i] = Math.round(y[i] * scale);
  return out;
}
