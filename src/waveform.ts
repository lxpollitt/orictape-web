import type { Program } from './decoder';

const GREEN  = '#3d8c3d';
const YELLOW = '#c9a428';
const RED    = '#c94040';
const DIM    = '#242424';

export class WaveformView {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  private samples:    Int16Array | null = null;
  private prog:       Program | null    = null;
  private bitIsError:    Uint8Array | null = null; // per-bit: 1 if part of a chkErr byte (waveform colouring)
  private bitIsParityErr: Uint8Array | null = null; // per-bit: 1 only for the parity bit of a chkErr byte (label colouring)

  private viewStart   = 0;
  private spp         = 10;  // samples per pixel (current view)
  private baseSpp     = 10;  // spp at 100% for the active view mode (overview or byte)
  private zoomFactor  = 1;   // persistent button zoom: 1 = 100%
  private selByte:    number | null = null;
  private normalise   = false;
  private zoomLabel:  HTMLElement | null = null;

  private dragging  = false;
  private dragX     = 0;
  private dragView  = 0;

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

  setData(samples: Int16Array, prog: Program): void {
    this.samples     = samples;
    this.prog        = prog;
    this.selByte     = null;
    this.noWaveform  = false;

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

    // Default view: fit the whole stream, scaled by the persistent zoom factor.
    const len    = prog.stream.lastSample - prog.stream.firstSample;
    this.baseSpp  = Math.max(1, len / this.canvas.width);
    this.spp      = Math.max(0.5, this.baseSpp / this.zoomFactor);
    this.viewStart = prog.stream.firstSample;
    this.clampView();
    this.updateZoomDisplay();
    this.draw();
  }

  setZoomLabel(el: HTMLElement): void {
    this.zoomLabel = el;
    this.updateZoomDisplay();
  }

  private updateZoomDisplay(): void {
    if (this.zoomLabel) {
      this.zoomLabel.textContent = Math.round(this.baseSpp / this.spp * 100) + '%';
    }
  }

  setNormalise(v: boolean): void {
    this.normalise = v;
    this.draw();
  }

  zoomIn():    void { this.zoomFactor = Math.min(8,   this.zoomFactor * 2); this.applyZoom(); }
  zoomOut():   void { this.zoomFactor = Math.max(0.5, this.zoomFactor / 2); this.applyZoom(); }
  zoomReset(): void { this.zoomFactor = 1; this.applyZoom(); }

  private applyZoom(): void {
    if (this.selByte !== null) {
      // Re-centre on the selected byte at the new zoom level.
      // selectByte updates baseSpp and the display.
      this.selectByte(this.selByte);
    } else if (this.samples && this.prog) {
      // Zoom the overview, anchoring on the current view centre.
      const len    = this.prog.stream.lastSample - this.prog.stream.firstSample;
      this.baseSpp  = Math.max(1, len / this.canvas.width);
      const centre = this.viewStart + (this.canvas.width / 2) * this.spp;
      this.spp       = Math.max(0.5, this.baseSpp / this.zoomFactor);
      this.viewStart = centre - (this.canvas.width / 2) * this.spp;
      this.clampView();
      this.updateZoomDisplay();
      this.draw();
    }
  }

  selectByte(byteIndex: number | null): void {
    this.selByte = byteIndex;
    if (byteIndex !== null && this.prog) {
      const stream = this.prog.stream;
      const b      = this.prog.bytes[byteIndex];
      if (b && b.firstBit < stream.bitCount && b.lastBit < stream.bitCount) {
        const s0  = stream.bitFirstSample[b.firstBit];
        const s1  = stream.bitLastSample[b.lastBit];
        const mid = (s0 + s1) / 2;
        // Centre on the byte at the current zoom level (default spp=3 at 100%).
        this.baseSpp   = 3;
        this.spp       = Math.max(0.5, 3 / this.zoomFactor);
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
    const amplitude = this.normalise
      ? Math.max(Math.abs(stream.minVal), Math.abs(stream.maxVal), 1)
      : 32768;
    const scaleY  = (waveH * 0.45) / amplitude;
    const spp     = this.spp;
    const vs      = this.viewStart;

    // Background
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, w, h);

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
        ctx.fillStyle = 'rgba(78,201,78,0.08)';
        ctx.fillRect(x0, 0, x1 - x0, h);
      }
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
      while (bi < stream.bitCount && stream.bitLastSample[bi] < sStart) bi++;

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
  }

  private attachEvents(): void {
    const { canvas } = this;

    canvas.addEventListener('mousedown', (e) => {
      this.dragging = true;
      this.dragX    = e.clientX;
      this.dragView = this.viewStart;
      canvas.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.dragging) return;
      this.viewStart = this.dragView - (e.clientX - this.dragX) * this.spp;
      this.clampView();
      this.draw();
    });

    window.addEventListener('mouseup', () => {
      if (!this.dragging) return;
      this.dragging = false;
      canvas.style.cursor = 'grab';
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.3 : 1 / 1.3;
      const anchor = this.viewStart + e.offsetX * this.spp;
      this.spp       = Math.max(0.5, Math.min(20000, this.spp * factor));
      this.viewStart = anchor - e.offsetX * this.spp;
      this.clampView();
      this.updateZoomDisplay();
      this.draw();
    }, { passive: false });

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
