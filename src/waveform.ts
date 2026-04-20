import type { Program } from './decoder';

const GREEN  = '#3d8c3d';
const YELLOW = '#c9a428';
const RED    = '#c94040';
const DIM    = '#444444';

// ── Zoom model ───────────────────────────────────────────────────────────────
//
// Zoom is expressed directly as `spp` (samples per pixel) — the physical
// view parameter.  Higher spp = more zoomed out.
//
// Two modes exist, distinguished by the current `spp`:
//   • Byte mode — fine-grained, individual bytes visible.  "100% byte zoom"
//     means spp = BYTE_BASE_SPP (3 samples per pixel).  In this mode the
//     displayed percentage is computed relative to BYTE_BASE_SPP.
//   • Overview mode — program-level or larger.  "100% overview zoom" means
//     the current program fills the canvas exactly (spp = programSamples /
//     canvasWidth).  In this mode the displayed percentage is computed
//     relative to the current program's overview-fit spp.
//
// Modes transition at MAX_BYTE_MODE_SPP: when zoomed out past this point
// (i.e. bytes getting too small to be useful), the label flips from byte to
// overview.  The displayed % jumps across the transition because the two
// reference points are different — this is a true semantic difference, not
// a bug.  It matches the user's mental model that "bytes this small aren't
// bytes any more".
const BYTE_BASE_SPP = 3;      // 100% byte zoom
const MIN_SPP = BYTE_BASE_SPP / 16;  // 1600% byte zoom — maximum zoom in
const MAX_BYTE_MODE_SPP = BYTE_BASE_SPP / 0.05;  // 5% byte zoom — byte/overview threshold

export interface StreamInfo {
  progIdx:     number;
  name:        string;
  lineCount:   number;
  byteCount:   number;
  firstSample: number;
  lastSample:  number;
}

export class WaveformView {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  private samples:    Int16Array | null = null;
  private prog:       Program | null    = null;
  private sampleRate  = 48000;
  private allStreams:  StreamInfo[] = [];
  private bitIsError:    Uint8Array | null = null; // per-bit: 1 if part of a chkErr byte (waveform colouring)
  private bitIsParityErr: Uint8Array | null = null; // per-bit: 1 only for the parity bit of a chkErr byte (label colouring)

  private viewStart   = 0;
  private spp         = 0;   // samples per pixel — the single source of truth for zoom
                             // (0 = uninitialised; setData picks overview-fit on first load)
  private selByte:    number | null = null;
  private vZoom       = 1;     // vertical zoom multiplier (1.0 = default, higher = amplified)
  private onNormaliseChange: ((checked: boolean) => void) | null = null;
  private zoomModeEl:  HTMLElement | null = null;
  private zoomLevelEl: HTMLElement | null = null;

  private hoverBit:       number | null = null;  // bit index under mouse cursor
  private hoverSample:    number = 0;            // sample position of mouse cursor
  private dragging        = false;
  private dragX           = 0;
  private dragView        = 0;
  private dragMoved       = false;
  private suppressRecentre = false;
  private clickedStream: StreamInfo | null = null;  // stream highlighted by clicking outside current program
  private clickedSample: number = 0;                // sample position of the click (for unmatched regions)
  private onByteClick: ((byteIndex: number) => void) | null = null;
  private onStreamSelect: ((progIdx: number) => void) | null = null;

  /** True when a TAP file is active — shows "No waveform" label. */
  private noWaveform = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d')!;
    this.attachEvents();
    new ResizeObserver(() => {
      canvas.width  = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      this.draw();
    }).observe(canvas);
  }

  /** Clear waveform data and show a "No waveform" placeholder (used for TAP files). */
  clearData(): void {
    this.samples     = null;
    this.prog        = null;
    this.selByte     = null;
    this.noWaveform  = true;
    this.draw();
  }

  setData(samples: Int16Array, prog: Program, sampleRate = 48000, allStreams: StreamInfo[] = []): void {
    this.samples      = samples;
    this.prog         = prog;
    this.sampleRate   = sampleRate;
    this.allStreams    = allStreams;
    this.selByte      = null;
    this.clickedStream = null;
    this.noWaveform   = false;

    // Pre-compute per-bit flags from byte checksum errors.
    const { bitCount } = prog.stream;
    const bitIsError    = new Uint8Array(bitCount);
    const bitIsParityErr = new Uint8Array(bitCount);
    for (const byte of prog.bytes) {
      if (byte.chkErr) {
        for (let b = byte.firstBit; b <= byte.lastBit && b < bitCount; b++) {
          bitIsError[b] = 1;
        }
        // Mark only the parity bit for label-level highlighting.
        if (byte.lastBit < bitCount) bitIsParityErr[byte.lastBit] = 1;
      }
    }
    this.bitIsError     = bitIsError;
    this.bitIsParityErr = bitIsParityErr;

    // Zoom policy: preserve the caller-visible spp across program switches
    // so visual zoom stays constant.  On first load (spp === 0 sentinel),
    // fit the program to the canvas instead.  Always re-clamp to the new
    // valid range since max_spp = fileSamples / canvasWidth depends on the
    // new samples array.
    if (this.spp === 0) {
      this.spp = this.overview100Spp();
    } else {
      this.spp = this.clampSpp(this.spp);
    }

    // viewStart policy: preserve if the new program's sample range overlaps
    // any part of the current visible window — keeps the view visually
    // stationary across program switches in the common case.  Reset to the
    // new program's first sample only when there's no overlap (i.e. the
    // current view would otherwise be looking at empty space outside the
    // new program).
    const visEnd = this.viewStart + this.canvas.width * this.spp;
    const overlaps = visEnd > prog.stream.firstSample && this.viewStart < prog.stream.lastSample;
    if (!overlaps) {
      this.viewStart = prog.stream.firstSample;
    }
    this.clampView();
    this.updateZoomDisplay();
    this.draw();
  }

  setZoomLabel(modeEl: HTMLElement, levelEl: HTMLElement): void {
    this.zoomModeEl  = modeEl;
    this.zoomLevelEl = levelEl;
    this.updateZoomDisplay();
  }

  setByteClickHandler(cb: (byteIndex: number) => void): void {
    this.onByteClick = cb;
  }

  setStreamSelectHandler(cb: (progIdx: number) => void): void {
    this.onStreamSelect = cb;
  }

  /** Binary-search for the byte whose sample range contains `sample`.
   *  Falls back to the nearest byte when the click lands in a small gap
   *  between bytes within the program.  Returns null if the sample is
   *  outside the program's stream range entirely. */
  private sampleToByte(sample: number): number | null {
    if (!this.prog || this.prog.bytes.length === 0) return null;
    const { bytes, stream } = this.prog;
    // Reject clicks outside the program's stream range.
    if (sample < stream.firstSample || sample > stream.lastSample) return null;
    let lo = 0, hi = bytes.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const b = bytes[mid];
      if (b.firstBit >= stream.bitCount || b.lastBit >= stream.bitCount) { hi = mid - 1; continue; }
      const bFirst = stream.bitFirstSample[b.firstBit];
      const bLast  = stream.bitLastSample[b.lastBit];
      if      (sample < bFirst) hi = mid - 1;
      else if (sample > bLast)  lo = mid + 1;
      else return mid;
    }
    // Click landed in a gap between bytes within the program — return nearest byte.
    return Math.min(lo, bytes.length - 1);
  }

  /** Binary-search for the bit whose sample range contains `sample`.
   *  Returns null if no bit covers this sample. */
  private sampleToBit(sample: number): number | null {
    if (!this.prog) return null;
    const stream = this.prog.stream;
    let lo = 0, hi = stream.bitCount - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sample < stream.bitFirstSample[mid])      hi = mid - 1;
      else if (sample > stream.bitLastSample[mid])   lo = mid + 1;
      else return mid;
    }
    return null;  // sample falls in a gap between bits
  }

  /** Find which stream (if any) contains the given sample position. */
  private sampleToStream(sample: number): StreamInfo | null {
    for (const s of this.allStreams) {
      if (sample >= s.firstSample && sample <= s.lastSample) return s;
    }
    return null;
  }

  /** Program-fit spp for the currently-loaded program — the "100% overview
   *  zoom" reference point.  Changes per program (depends on program sample
   *  length).  Falls back to MAX_BYTE_MODE_SPP when no program is loaded. */
  private overview100Spp(): number {
    if (!this.prog) return MAX_BYTE_MODE_SPP;
    const len = this.prog.stream.lastSample - this.prog.stream.firstSample;
    return Math.max(1, len / this.canvas.width);
  }

  /** Maximum spp allowed — fits the entire audio file (all samples) into the
   *  canvas.  Depends only on samples and canvas width, not on which program
   *  is currently selected.  A program-independent ceiling. */
  private maxSpp(): number {
    if (!this.samples) return 20000;
    return Math.max(MAX_BYTE_MODE_SPP + 1, this.samples.length / this.canvas.width);
  }

  /** True if the current zoom falls in byte mode (bytes are big enough to
   *  be individually useful). */
  private isByteMode(): boolean {
    return this.spp <= MAX_BYTE_MODE_SPP;
  }

  /** Clamp an spp value to the global zoom range [MIN_SPP, maxSpp()]. */
  private clampSpp(spp: number): number {
    return Math.max(MIN_SPP, Math.min(this.maxSpp(), spp));
  }

  private updateZoomDisplay(): void {
    if (!this.zoomModeEl || !this.zoomLevelEl) return;
    if (this.isByteMode()) {
      this.zoomModeEl.textContent  = 'Bytes:';
      this.zoomLevelEl.textContent = Math.round(BYTE_BASE_SPP / this.spp * 100) + '%';
    } else {
      this.zoomModeEl.textContent  = 'Overview:';
      this.zoomLevelEl.textContent = Math.round(this.overview100Spp() / this.spp * 100) + '%';
    }
  }

  /** Reset view to show the full current program (overview 100%). */
  fitToProgram(): void {
    if (!this.prog) return;
    this.spp       = this.overview100Spp();
    this.viewStart = this.prog.stream.firstSample;
    this.clampView();
    this.updateZoomDisplay();
    this.draw();
  }

  /** Reset zoom to "not initialised" — next setData will fit to the new
   *  program's overview.  Called on file load so a fresh file starts at
   *  the natural overview zoom rather than inheriting zoom from the
   *  previous file. */
  resetZoom(): void {
    this.vZoom = 1;
    this.spp   = 0;
    this.updateZoomDisplay();
  }

  setNormalise(v: boolean): void {
    if (v && this.prog) {
      // Set vZoom so the stream's peak amplitude fills the display.
      const peakAmplitude = Math.max(Math.abs(this.prog.stream.minVal), Math.abs(this.prog.stream.maxVal), 1);
      this.vZoom = 32768 / peakAmplitude;
    } else {
      this.vZoom = 1;
    }
    this.draw();
  }

  setNormaliseCallback(cb: (checked: boolean) => void): void {
    this.onNormaliseChange = cb;
  }

  zoomIn():    void { this.setSppAnchored(this.spp / 2); }
  zoomOut():   void { this.setSppAnchored(this.spp * 2); }
  /** Reset button — incremental escape sequence.  Each press advances one
   *  step, skipping steps whose state is already satisfied:
   *
   *   1. Byte mode, not at 100% → snap to byte 100% (anchored on selected
   *      byte or canvas centre).
   *   2. Byte mode, at 100%, byte selected but not centred on it → stay
   *      at 100%, recentre on the selected byte.  (Supports the workflow:
   *      select a byte, scroll around to see nearby bytes, hit reset to
   *      jump back to the selection.)
   *   3. Byte mode at 100% & centred (or no selection), or any overview
   *      mode zoom → overview fit.
   *
   *  The "at 100%" check uses the rounded displayed percentage to stay
   *  robust against floating-point drift in spp.  The "centred" check
   *  uses canvas-pixel tolerance (< 1 px) so sub-pixel drift from the
   *  anchoring maths doesn't falsely report off-centre. */
  zoomReset(): void {
    if (!this.isByteMode()) { this.fitToProgram(); return; }

    const bytePct = Math.round(BYTE_BASE_SPP / this.spp * 100);
    if (bytePct !== 100) { this.setSppAnchored(BYTE_BASE_SPP); return; }

    // At byte 100%.  If a byte is selected and not already visually
    // centred, re-centre on it without changing zoom.
    if (this.selByte !== null && this.prog) {
      const b = this.prog.bytes[this.selByte];
      const stream = this.prog.stream;
      if (b && b.firstBit < stream.bitCount && b.lastBit < stream.bitCount) {
        const byteMid = (stream.bitFirstSample[b.firstBit] + stream.bitLastSample[b.lastBit]) / 2;
        const bytePx  = (byteMid - this.viewStart) / this.spp;
        const centrePx = this.canvas.width / 2;
        if (Math.abs(bytePx - centrePx) >= 1) {
          this.setSppAnchored(this.spp);  // re-anchors on selected byte at current spp
          return;
        }
      }
    }

    this.fitToProgram();
  }
  /** Set zoom to a specific byte-mode factor (1 = 100% byte zoom, 4 = 400%,
   *  etc.).  Used by the hex panel's click/dblclick shortcuts. */
  zoomTo(byteFactor: number): void { this.setSppAnchored(BYTE_BASE_SPP / byteFactor); }
  /** Current zoom as a byte-mode factor (3/spp).  In overview mode this
   *  value is < 0.05 (5%), which callers may use to detect "not in byte
   *  range any more". */
  getByteZoomFactor(): number { return BYTE_BASE_SPP / this.spp; }

  /** Change spp, anchoring the view on the selected byte (if any) or the
   *  current view centre (otherwise).  Clamps to the valid zoom range. */
  private setSppAnchored(newSpp: number): void {
    if (!this.samples || !this.prog) { this.spp = this.clampSpp(newSpp); return; }
    let anchorSample: number;
    const byte = this.selByte !== null ? this.prog.bytes[this.selByte] : null;
    const stream = this.prog.stream;
    if (byte && byte.firstBit < stream.bitCount && byte.lastBit < stream.bitCount) {
      anchorSample = (stream.bitFirstSample[byte.firstBit] + stream.bitLastSample[byte.lastBit]) / 2;
    } else {
      anchorSample = this.viewStart + (this.canvas.width / 2) * this.spp;
    }
    this.spp = this.clampSpp(newSpp);
    this.viewStart = anchorSample - (this.canvas.width / 2) * this.spp;
    this.clampView();
    this.updateZoomDisplay();
    this.draw();
  }

  selectByte(byteIndex: number | null): void {
    this.selByte = byteIndex;
    this.clickedStream = null;
    const recentre = !this.suppressRecentre;
    this.suppressRecentre = false;
    if (recentre && byteIndex !== null && this.prog) {
      const stream = this.prog.stream;
      const b      = this.prog.bytes[byteIndex];
      if (b && b.firstBit < stream.bitCount && b.lastBit < stream.bitCount) {
        const s0  = stream.bitFirstSample[b.firstBit];
        const s1  = stream.bitLastSample[b.lastBit];
        const mid = (s0 + s1) / 2;
        // If we're in overview mode, snap to 100% byte zoom so the byte is
        // visible.  If already in byte mode, preserve the user's current
        // byte-level zoom — just pan the view to centre on the selection.
        if (!this.isByteMode()) this.spp = this.clampSpp(BYTE_BASE_SPP);
        this.viewStart = mid - (this.canvas.width / 2) * this.spp;
        this.clampView();
      }
    }
    this.updateZoomDisplay();
    this.draw();
  }

  private draw(): void {
    const { canvas, ctx, samples, prog } = this;
    if (!samples || !prog) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (this.noWaveform) {
        ctx.fillStyle    = '#4a4a4a';
        ctx.font         = '12px ui-monospace, monospace';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('No waveform', canvas.width / 2, canvas.height / 2);
      }
      return;
    }

    const stream  = prog.stream;
    const w       = canvas.width;
    const h       = canvas.height;
    const LABEL_H = 20;
    const waveH   = h - LABEL_H;
    const midY    = waveH / 2;
    const scaleY  = (waveH * 0.45) / 32768 * this.vZoom;
    const spp     = this.spp;
    const vs      = this.viewStart;

    // Background
    ctx.fillStyle = '#181818';
    ctx.fillRect(0, 0, w, h);

    // Shade matched program stream ranges slightly lighter than the background
    // so unmatched signal areas are visually distinct.
    ctx.fillStyle = '#1a1a1a';
    for (const si of this.allStreams) {
      const x0 = (si.firstSample - vs) / spp;
      const x1 = (si.lastSample  - vs) / spp;
      if (x1 > 0 && x0 < w) ctx.fillRect(x0, 0, x1 - x0, h);
    }

    // Centre line
    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(w, midY);
    ctx.stroke();

    // Selected-byte highlight band (spans full canvas height including label strip)
    if (this.selByte !== null) {
      const b = prog.bytes[this.selByte];
      if (b && b.firstBit < stream.bitCount && b.lastBit < stream.bitCount) {
        const x0 = (stream.bitFirstSample[b.firstBit] - vs) / spp;
        const x1 = (stream.bitLastSample[b.lastBit]   - vs) / spp;
        ctx.fillStyle = '#1e3a1e';
        ctx.fillRect(x0, 0, x1 - x0, h);
      }
    }

    // Clicked-stream highlight (subtle brighter grey for the stream's sample range)
    if (this.clickedStream) {
      const cs = this.clickedStream;
      const x0 = (cs.firstSample - vs) / spp;
      const x1 = (cs.lastSample  - vs) / spp;
      ctx.fillStyle = '#2a2a2a';
      ctx.fillRect(x0, 0, x1 - x0, h);
    }

    // Advance bit pointer to the first bit that could be visible.
    // Save the starting index so the label pass can reuse it.
    let bi = 0;
    while (bi < stream.bitCount && stream.bitLastSample[bi] < vs) bi++;
    const biStart = bi;

    // Draw waveform left-to-right, batching canvas strokes by colour.
    let curColor = '';
    ctx.lineWidth = 1;

    for (let x = 0; x < w; x++) {
      const sStart = vs + x * spp;
      const sEnd   = sStart + spp;

      // Advance past bits that are fully left of this pixel.
      // Use Math.floor(sStart) so fractional pixel positions don't skip past
      // a bit whose last sample still overlaps this pixel.
      const sampleStart = Math.floor(sStart);
      while (bi < stream.bitCount && stream.bitLastSample[bi] < sampleStart) bi++;

      // Pick colour from the first overlapping bit (if any).
      let color = DIM;
      if (bi < stream.bitCount && stream.bitFirstSample[bi] <= sEnd) {
        color = this.bitIsError![bi] ? RED
              : stream.bitUnclear[bi]     ? YELLOW
              : GREEN;
      }

      // Min/max amplitude for this pixel column (sub-sampled for speed).
      const i0   = Math.max(0, Math.floor(sStart));
      const i1   = Math.min(samples.length, Math.ceil(sEnd));
      const step = Math.max(1, Math.floor((i1 - i0) / 150));
      let lo = 0, hi = 0;
      for (let s = i0; s < i1; s += step) {
        const v = samples[s];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }

      const y1 = midY - hi * scaleY;
      const y2 = midY - lo * scaleY;

      if (color !== curColor) {
        if (curColor) ctx.stroke();
        ctx.beginPath();
        ctx.strokeStyle = color;
        curColor = color;
      }
      ctx.moveTo(x + 0.5, y1);
      ctx.lineTo(x + 0.5, y2);
    }
    if (curColor) ctx.stroke();

    // ── Label strip ───────────────────────────────────────────────────────────
    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, waveH);
    ctx.lineTo(w, waveH);
    ctx.stroke();

    // Bit labels fade in as spp drops below BIT_FADE_START toward BIT_FADE_FULL.
    const BIT_FADE_START = 4;  // spp at which labels begin to appear
    const BIT_FADE_FULL  = 2;  // spp at which labels are fully opaque
    const bitAlpha = Math.min(1, Math.max(0,
      (BIT_FADE_START - spp) / (BIT_FADE_START - BIT_FADE_FULL)));

    if (bitAlpha > 0) {
      ctx.font          = '13px ui-monospace, Cascadia Code, Consolas, monospace';
      ctx.textAlign     = 'center';
      ctx.textBaseline  = 'middle';
      ctx.globalAlpha   = bitAlpha;
      const labelY = waveH + LABEL_H / 2;

      for (let lbi = biStart; lbi < stream.bitCount; lbi++) {
        const x0 = (stream.bitFirstSample[lbi] - vs) / spp;
        if (x0 > w) break;
        const x1  = (stream.bitLastSample[lbi] - vs) / spp;
        const cx  = (x0 + x1) / 2;
        if (cx < 0) continue;
        const col = this.bitIsParityErr![lbi] ? RED
                  : stream.bitUnclear[lbi]    ? YELLOW
                  : GREEN;
        ctx.fillStyle = col;
        ctx.fillText(stream.bitV[lbi] === 1 ? '1' : '0', cx, labelY);
      }

      ctx.globalAlpha = 1;
    }

    // ── Hover bit markers (vertical lines at bit edges and L1/L2 split) ──────
    if (spp <= 0.75 && this.hoverBit !== null) {
      const bi    = this.hoverBit;
      const first = stream.bitFirstSample[bi];
      const last  = stream.bitLastSample[bi];
      const l1    = stream.bitL1[bi];
      const xStart = (first - vs) / spp;
      const xEnd   = (last + 1 - vs) / spp;

      // Solid lines at bit edges.
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(xStart + 0.5, 0); ctx.lineTo(xStart + 0.5, waveH);
      ctx.moveTo(xEnd + 0.5, 0);   ctx.lineTo(xEnd + 0.5, waveH);
      ctx.stroke();

      // Dotted line at L1/L2 split (crossover point).
      if (l1 > 0) {
        const xSplit = (first + l1 - vs) / spp;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(xSplit + 0.5, 0); ctx.lineTo(xSplit + 0.5, waveH);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Sparse dotted lines at maxIndex and minIndex (debug: where readCycle found extrema).
      const xMax = (stream.bitMaxIndex[bi] - vs) / spp;
      const xMin = (stream.bitMinIndex[bi] - vs) / spp;
      ctx.strokeStyle = '#00b4ff';
      ctx.setLineDash([2, 6]);
      ctx.beginPath();
      ctx.moveTo(xMax + 0.5, 0); ctx.lineTo(xMax + 0.5, waveH);
      ctx.moveTo(xMin + 0.5, 0); ctx.lineTo(xMin + 0.5, waveH);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ── Hover info overlay ─────────────────────────────────────────────────────
    if (spp <= 0.75 && (this.hoverBit !== null || this.hoverSample > 0)) {
      const fmt = (n: number) => n.toLocaleString();
      let lines: string[];
      let hzSuffix = '';
      let timeSuffix = '';

      if (this.hoverBit !== null) {
        const bi = this.hoverBit;
        const first = stream.bitFirstSample[bi];
        const last  = stream.bitLastSample[bi];
        const len   = last - first + 1;
        const l1    = stream.bitL1[bi];
        const l2    = len - l1;
        const hz = Math.round(this.sampleRate / len);
        const timeSec = (first / this.sampleRate).toFixed(3);
        lines = [
          `Bit ${fmt(bi)}`,
          `Samples ${fmt(first)} - ${fmt(last)}`,
          `Length ${len} (${l1}+${l2})`,
        ];
        hzSuffix = `  ~${fmt(hz)}Hz`;
        timeSuffix = `${timeSec}s`;
      } else {
        // Hovering over a gap between bits — find bounds from adjacent bits.
        const sample = this.hoverSample;
        // Find the bit just before and just after this gap.
        let prevEnd = stream.firstSample;
        let nextStart = stream.lastSample;
        for (let bi = 0; bi < stream.bitCount; bi++) {
          if (stream.bitLastSample[bi] < sample) {
            prevEnd = stream.bitLastSample[bi] + 1;
          }
          if (stream.bitFirstSample[bi] > sample) {
            nextStart = stream.bitFirstSample[bi];
            break;
          }
        }
        const gapLen = nextStart - prevEnd;
        const hz = gapLen > 0 ? Math.round(this.sampleRate / gapLen) : 0;
        const timeSec = (prevEnd / this.sampleRate).toFixed(3);
        lines = [
          `Gap`,
          `Samples ${fmt(prevEnd)} - ${fmt(nextStart - 1)}`,
          `Length ${gapLen}`,
        ];
        hzSuffix = hz > 0 ? `  ~${fmt(hz)}Hz` : '';
        timeSuffix = `${timeSec}s`;
      }

      ctx.font         = '11px ui-monospace, Cascadia Code, Consolas, monospace';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'top';
      const lineH   = 14;
      const padX    = 6;
      const padY    = 4;
      const timeSuffixGap = timeSuffix ? '    ' : '';  // gap between first line text and timestamp
      const firstLineFullW = ctx.measureText(lines[0]).width + ctx.measureText(timeSuffixGap + timeSuffix).width;
      const lastLine = lines[lines.length - 1] + hzSuffix;
      const allLineWidths = [firstLineFullW, ...lines.slice(1, -1).map(l => ctx.measureText(l).width), ctx.measureText(lastLine).width];
      const boxW    = Math.max(...allLineWidths) + padX * 2;
      const boxH    = lines.length * lineH + padY * 2;
      const boxX    = 4;
      const boxY    = 4;

      ctx.fillStyle   = 'rgba(0, 0, 0, 0.75)';
      ctx.fillRect(boxX, boxY, boxW, boxH);
      ctx.fillStyle   = '#ccc';
      for (let li = 0; li < lines.length; li++) {
        const y = boxY + padY + li * lineH;
        ctx.fillText(lines[li], boxX + padX, y);
        if (li === 0 && timeSuffix) {
          ctx.fillStyle = '#777';
          ctx.textAlign = 'right';
          ctx.fillText(timeSuffix, boxX + boxW - padX, y);
          ctx.textAlign = 'left';
          ctx.fillStyle = '#ccc';
        }
        if (li === lines.length - 1 && hzSuffix) {
          const mainW = ctx.measureText(lines[li]).width;
          ctx.fillStyle = '#777';
          ctx.fillText(hzSuffix, boxX + padX + mainW, y);
          ctx.fillStyle = '#ccc';
        }
      }
    }

    // ── Clicked stream info popup ────────────────────────────────────────────
    if (this.clickedStream && this.hoverBit === null) {
      const cs = this.clickedStream;
      const fmt = (n: number) => n.toLocaleString();
      const lines: string[] = [];
      lines.push(cs.name
        ? `Program ${cs.progIdx + 1}: ${cs.name}`
        : `Program ${cs.progIdx + 1}`);
      lines.push(`${fmt(cs.byteCount)} bytes · ${fmt(cs.lineCount)} lines`);
      const startSec = (cs.firstSample / this.sampleRate).toFixed(1);
      const endSec   = (cs.lastSample / this.sampleRate).toFixed(1);
      lines.push(`${startSec}s - ${endSec}s`);
      const hintLine = '(click again to select)';

      ctx.font         = '11px ui-monospace, Cascadia Code, Consolas, monospace';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'top';
      const lineH = 14;
      const padX  = 6;
      const padY  = 4;
      const allLines = [...lines, hintLine];
      const boxW  = Math.max(...allLines.map(l => ctx.measureText(l).width)) + padX * 2;
      const boxH  = allLines.length * lineH + padY * 2;
      const boxX  = 4;
      const boxY  = 4;

      ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
      ctx.fillRect(boxX, boxY, boxW, boxH);
      ctx.fillStyle = '#ccc';
      for (let li = 0; li < lines.length; li++) {
        ctx.fillText(lines[li], boxX + padX, boxY + padY + li * lineH);
      }
      ctx.fillStyle = '#666';
      ctx.fillText(hintLine, boxX + padX, boxY + padY + lines.length * lineH);
    } else if (this.clickedSample > 0 && !this.clickedStream && this.hoverBit === null && this.selByte === null) {
      // Clicked on a region not mapped to any program.
      const fmt = (n: number) => n.toLocaleString();
      const timeSec = (this.clickedSample / this.sampleRate).toFixed(3);
      const lines = [
        'Unmatched signal',
        `@${timeSec}s (sample ${fmt(this.clickedSample)})`,
      ];

      ctx.font         = '11px ui-monospace, Cascadia Code, Consolas, monospace';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'top';
      const lineH = 14;
      const padX  = 6;
      const padY  = 4;
      const boxW  = Math.max(...lines.map(l => ctx.measureText(l).width)) + padX * 2;
      const boxH  = lines.length * lineH + padY * 2;
      const boxX  = 4;
      const boxY  = 4;

      ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
      ctx.fillRect(boxX, boxY, boxW, boxH);
      ctx.fillStyle = '#777';
      for (let li = 0; li < lines.length; li++) {
        ctx.fillText(lines[li], boxX + padX, boxY + padY + li * lineH);
      }
    }
  }

  private attachEvents(): void {
    const { canvas } = this;

    canvas.addEventListener('mousedown', (e) => {
      this.dragging  = true;
      this.dragMoved = false;
      this.dragX     = e.clientX;
      this.dragView  = this.viewStart;
      canvas.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.dragging) return;
      if (Math.abs(e.clientX - this.dragX) > 4) this.dragMoved = true;
      this.viewStart = this.dragView - (e.clientX - this.dragX) * this.spp;
      this.clampView();
      this.draw();
    });

    window.addEventListener('mouseup', () => {
      if (!this.dragging) return;
      this.dragging = false;
      canvas.style.cursor = 'grab';
      if (!this.dragMoved) {
        const rect   = canvas.getBoundingClientRect();
        const x      = this.dragX - rect.left;
        const sample = this.viewStart + x * this.spp;
        const idx    = this.sampleToByte(sample);
        if (idx !== null && this.onByteClick) {
          // Click inside the current program — select the byte, never change
          // the view.  suppressRecentre = true prevents selectByte from
          // zooming / panning; the user can reach bit detail by explicit
          // zoom (scroll wheel) or double-click to fit-to-overview.
          this.clickedStream    = null;
          this.suppressRecentre = true;
          this.onByteClick(idx);
        } else {
          // Click outside current program.
          const stream = this.sampleToStream(sample);
          if (stream && this.clickedStream === stream && this.onStreamSelect) {
            // Second click on the same already-highlighted stream — navigate
            // to it.  main.ts's streamSelect handler wraps this in
            // saveView/restoreView so the view is visually preserved across
            // the program switch.
            this.clickedStream = null;
            this.clickedSample = 0;
            this.onStreamSelect(stream.progIdx);
          } else {
            // First click — highlight the stream and show info, or record
            // a dead-space click position for the timestamp readout.
            this.clickedStream = stream;
            this.clickedSample = sample;
          }
          this.draw();
        }
      }
    });

    // Double-click: zoom to overview-fit for whichever bitstream is
    // clicked on.  Inside the current program: fit directly.  On another
    // program's stream: navigate first (via onStreamSelect — which
    // restores view, but we override with fitToProgram right after).
    // Dead space: no action.
    canvas.addEventListener('dblclick', (e) => {
      const rect   = canvas.getBoundingClientRect();
      const x      = e.clientX - rect.left;
      const sample = this.viewStart + x * this.spp;
      const idx    = this.sampleToByte(sample);
      if (idx !== null) {
        this.fitToProgram();
        this.draw();
      } else {
        const stream = this.sampleToStream(sample);
        if (stream && this.onStreamSelect) {
          this.clickedStream = null;
          this.clickedSample = 0;
          this.onStreamSelect(stream.progIdx);
          this.fitToProgram();
          this.draw();
        }
      }
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey) {
        // Pinch/stretch gesture → zoom both axes (like a map).
        // Pinch sends positive deltaY; invert so pinch = zoom in.
        // Vertical zooms 3x slower than horizontal since the waveform is wider than tall.
        const factor = e.deltaY > 0 ? 1 / 1.1 : 1.1;
        const vFactor = e.deltaY > 0 ? 1 / 1.033 : 1.033;  // ~1/3 of horizontal rate
        // Vertical zoom.
        this.vZoom = Math.max(1, Math.min(100, this.vZoom * vFactor));
        this.onNormaliseChange?.(false);
        // Horizontal zoom, anchored on cursor position.
        const anchor = this.viewStart + e.offsetX * this.spp;
        this.spp       = this.clampSpp(this.spp / factor);
        this.viewStart = anchor - e.offsetX * this.spp;
        this.clampView();
        this.updateZoomDisplay();
      } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        // Vertical scroll → vertical zoom (amplitude).
        const factor = e.deltaY > 0 ? 1.1 : 1 / 1.1;
        this.vZoom = Math.max(1, Math.min(100, this.vZoom * factor));
        this.onNormaliseChange?.(false);
      } else {
        // Horizontal scroll → horizontal pan.
        this.viewStart += e.deltaX * this.spp * 2;
        this.clampView();
      }
      this.draw();
    }, { passive: false });

    canvas.addEventListener('mousemove', (e) => {
      if (this.dragging || !this.prog || this.spp > 0.75) {
        if (this.hoverBit !== null || this.hoverSample !== 0) {
          this.hoverBit = null; this.hoverSample = 0; this.draw();
        }
        return;
      }
      const sample = Math.round(this.viewStart + e.offsetX * this.spp);
      const bit = this.sampleToBit(sample);
      if (bit !== this.hoverBit || (bit === null && sample !== this.hoverSample)) {
        this.hoverBit = bit;
        this.hoverSample = sample;
        this.draw();
      }
    });

    canvas.addEventListener('mouseleave', () => {
      if (this.hoverBit !== null) {
        this.hoverBit = null;
        this.draw();
      }
    });

    canvas.style.cursor = 'grab';
  }

  private clampView(): void {
    if (!this.samples) return;
    this.viewStart = Math.max(
      0,
      Math.min(this.samples.length - this.canvas.width * this.spp, this.viewStart),
    );
  }
}
