import './style.css';
import { parseWavFile } from './wavfile';
import { WaveformView } from './waveform';
import type { WorkerResponse } from './worker';
import type { Program, LineInfo, ByteInfo } from './decoder';
import {
  alignPrograms, bestSource,
  type MergedProgram,
} from './merger';
import { linesFromProgram, linesFromMerged, encodeTapFile, downloadTap, type TapBlock } from './encoder';

// ── DOM ───────────────────────────────────────────────────────────────────────
const fileInput  = document.getElementById('file-input')       as HTMLInputElement;
const statusEl   = document.getElementById('status')           as HTMLParagraphElement;
const progTabs   = document.getElementById('prog-tabs')        as HTMLElement;
const hexPanelOuter = document.getElementById('hex-panel')     as HTMLElement;
const hexPanel      = document.getElementById('hex-view')      as HTMLElement;
const basicPanel    = document.getElementById('basic-view')    as HTMLElement;
const waveCanvas = document.getElementById('waveform-canvas')  as HTMLCanvasElement;
const statusBar  = document.getElementById('statusbar')        as HTMLElement;
const basicTypeEl  = document.getElementById('basic-type')      as HTMLElement;
const wrapLabelEl  = document.getElementById('wrap-label')      as HTMLElement;
const wrapToggle   = document.getElementById('wrap-toggle')     as HTMLInputElement;
const buildTapBtn  = document.getElementById('build-tap')       as HTMLButtonElement;
const tapModal     = document.getElementById('tap-modal')       as HTMLElement;
const tapAvailEl   = document.getElementById('tap-avail')       as HTMLElement;
const tapQueueEl   = document.getElementById('tap-queue')       as HTMLElement;
const tapAutoEl    = document.getElementById('tap-auto')        as HTMLElement;
const tapCancelBtn = document.getElementById('tap-cancel')      as HTMLButtonElement;
const tapDlBtn     = document.getElementById('tap-download')    as HTMLButtonElement;

// ── State ─────────────────────────────────────────────────────────────────────
interface TapeData {
  filename: string;
  samples:  Int16Array;
  programs: Program[];
}

let tapes:        TapeData[]              = [];
let activeTapeIdx = 0;
let activeProgIdx = 0;
let viewMode:     'tape' | 'merged'       = 'tape';
let mergedProgs:  (MergedProgram | null)[] = [];
let selByte:      number | null            = null;
let selMergeLine: number | null            = null;
let wrapMode      = true;
/** Which panel most recently received focus — drives keyboard navigation. */
let focusedPanel: 'hex' | 'basic' | null  = null;

// ── TAP builder state ─────────────────────────────────────────────────────────
interface TapQueueEntry {
  /** 'tape' for individual programs; 'merged' for merged output. */
  kind:     'tape' | 'merged';
  tapeIdx:  number;   // index into tapes[] (meaningful when kind === 'tape')
  progIdx:  number;   // program ordinal within tape (or merged index)
  autorun:  boolean;
}

let tapQueue: TapQueueEntry[] = [];

// Convenience mirrors of the active tape — updated by activateTape().
// All existing per-tape rendering code reads these without change.
let programs:    Program[]         = [];
let leftSamples: Int16Array | null = null;

const waveform = new WaveformView(waveCanvas);

// Apply initial wrap state and keep in sync with the checkbox.
const appEl = document.getElementById('app')!;
appEl.classList.toggle('basic-wrap', wrapMode);
wrapToggle.checked = wrapMode;
wrapToggle.addEventListener('change', () => {
  wrapMode = wrapToggle.checked;
  appEl.classList.toggle('basic-wrap', wrapMode);
  // When toggling in merged mode, the CSS class change alters line rendering;
  // wait one frame for the browser to apply the new styles before measuring.
  if (viewMode === 'merged') requestAnimationFrame(applyMergeColumnWidths);
});

function activateTape(ti: number, pi: number): void {
  activeTapeIdx = ti;
  activeProgIdx = pi;
  programs    = tapes[ti]?.programs ?? [];
  leftSamples = tapes[ti]?.samples  ?? null;
}

// ── Worker ────────────────────────────────────────────────────────────────────
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
worker.onerror = (e) => showError(e.message);

function decodeInWorker(buffer: ArrayBuffer): Promise<WorkerResponse> {
  return new Promise(resolve => {
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => resolve(e.data);
    worker.postMessage({ buffer });
  });
}

// ── File loading ──────────────────────────────────────────────────────────────
fileInput.addEventListener('change', async () => {
  const files = fileInput.files;
  if (!files || files.length === 0) return;

  // Reset all state.
  tapes        = [];
  mergedProgs  = [];
  selByte      = null;
  selMergeLine = null;
  viewMode     = 'tape';
  clearPanels();
  updateStatusBar();

  for (let fi = 0; fi < files.length; fi++) {
    const file = files[fi];
    statusEl.textContent = files.length > 1
      ? `Decoding ${file.name} (${fi + 1}/${files.length})…`
      : 'Decoding…';

    let buffer: ArrayBuffer;
    try { buffer = await file.arrayBuffer(); }
    catch (err) { showError(`Failed to read ${file.name}: ${err}`); return; }

    let samples: Int16Array;
    try { samples = parseWavFile(buffer).left; }
    catch (err) { showError(`${file.name}: ${err}`); return; }

    const result = await decodeInWorker(buffer);
    if (!result.ok) { showError(`${file.name}: ${result.error}`); return; }

    tapes.push({ filename: file.name, samples, programs: result.programs });
  }

  // Compute line-level merged views for each program ordinal (cheap).
  const maxProgs = tapes.length ? Math.max(...tapes.map(t => t.programs.length)) : 0;
  mergedProgs = new Array(maxProgs).fill(null);
  if (tapes.length >= 2) {
    for (let pi = 0; pi < maxProgs; pi++) computeMerged(pi);
  }

  const totalProgs = tapes.reduce((n, t) => n + t.programs.length, 0);
  const dur = tapes.length
    ? (Math.max(...tapes.map(t => t.samples.length)) / 44100).toFixed(1)
    : '0';
  statusEl.textContent = tapes.length > 1
    ? `Loaded ${tapes.length} tapes · ${totalProgs} programs · ${dur}s max audio`
    : `Decoded ${totalProgs} program${totalProgs !== 1 ? 's' : ''} from ${dur}s of audio.`;

  activateTape(0, 0);
  selByte = null;
  renderAll();
});

function computeMerged(progOrdinal: number): void {
  const progs = tapes.map(t => t.programs[progOrdinal]); // undefined if tape lacks it
  const validCount = progs.filter(Boolean).length;
  if (validCount >= 2) {
    mergedProgs[progOrdinal] = alignPrograms(progs);
  }
}

// ── Tab rendering & navigation ────────────────────────────────────────────────

/** Return the BASIC line number (integer) of the line containing byteIdx, or null. */
function lineNumForByte(prog: Program, byteIdx: number): number | null {
  const li = prog.lines.findIndex(l => byteIdx >= l.firstByte && byteIdx <= l.lastByte);
  if (li < 0) return null;
  return parseInt(prog.lines[li].elements[0] ?? '', 10);
}

/** Find the index of the line whose line number is closest to target. */
function nearestLineIdx(prog: Program, targetLineNum: number): number {
  let best = -1, bestDist = Infinity;
  for (let i = 0; i < prog.lines.length; i++) {
    const ln   = parseInt(prog.lines[i].elements[0] ?? '', 10);
    const dist = Math.abs(ln - targetLineNum);
    if (dist < bestDist) { bestDist = dist; best = i; }
  }
  return best;
}

progTabs.addEventListener('click', (e) => {
  const btn = (e.target as Element).closest<HTMLElement>('[data-ti],[data-mi]');
  if (!btn) return;

  // Snapshot current context so we can translate the selection.
  const fromMode      = viewMode;
  const fromTapeIdx   = activeTapeIdx;
  const fromProgIdx   = activeProgIdx;
  const fromSelByte   = selByte;
  const fromMergeLine = selMergeLine;

  selByte      = null;
  selMergeLine = null;

  if (btn.dataset.mi !== undefined) {
    // ── → Merged tab ────────────────────────────────────────────────────────
    viewMode      = 'merged';
    activeProgIdx = +btn.dataset.mi;

    if (fromMode === 'tape' && fromSelByte !== null) {
      // Tape → Merged: translate the selected byte to a merged line index
      // via the BASIC line number.
      const fromProg = tapes[fromTapeIdx]?.programs[fromProgIdx];
      const merged   = mergedProgs[activeProgIdx];
      if (fromProg && merged) {
        const lineNum = lineNumForByte(fromProg, fromSelByte);
        if (lineNum !== null) {
          const mli = merged.lines.findIndex(l => l.lineNum === lineNum);
          if (mli >= 0) selMergeLine = mli;
        }
      }
    } else if (fromMode === 'merged') {
      selMergeLine = fromMergeLine; // preserve when switching between merged tabs
    }

  } else {
    // ── → Tape tab ──────────────────────────────────────────────────────────
    viewMode      = 'tape';
    const toTi    = +(btn.dataset.ti ?? '0');
    const toPi    = +(btn.dataset.pi ?? '0');
    activateTape(toTi, toPi);

    // Resolve the BASIC line number we should navigate to.
    let targetLineNum: number | null = null;

    if (fromMode === 'merged' && fromMergeLine !== null) {
      // Merged → Tape: use the merged line's line number as the target.
      targetLineNum = mergedProgs[fromProgIdx]?.lines[fromMergeLine]?.lineNum ?? null;
    } else if (fromMode === 'tape' && fromSelByte !== null && toPi === fromProgIdx) {
      // Tape → Tape (same program ordinal): carry the line number across.
      const fromProg = tapes[fromTapeIdx]?.programs[fromProgIdx];
      if (fromProg) targetLineNum = lineNumForByte(fromProg, fromSelByte);
    }

    if (targetLineNum !== null) {
      const toProg = programs[toPi];
      if (toProg) {
        const li = nearestLineIdx(toProg, targetLineNum);
        if (li >= 0) selByte = toProg.lines[li].firstByte;
      }
    }
  }

  renderAll();

  // renderBasic/renderMergedBasic already call scrollIntoView for the BASIC
  // panel.  Mirror that for the hex panel and waveform (tape mode only).
  if (viewMode === 'tape' && selByte !== null) {
    hexPanel.querySelector<HTMLElement>(`[data-i="${selByte}"]`)
      ?.scrollIntoView({ block: 'nearest' });
    if (leftSamples) waveform.selectByte(selByte);
  }
});

function renderTabs(): void {
  progTabs.innerHTML = '';
  if (!tapes.length) return;

  const multiTape = tapes.length > 1;

  tapes.forEach((tape, ti) => {
    if (multiTape) {
      const label = document.createElement('span');
      label.className = ti === 0 ? 'tape-label' : 'tape-label tape-label-sep';
      label.textContent = shortName(tape.filename);
      progTabs.appendChild(label);
    }

    tape.programs.forEach((prog, pi) => {
      const isActive = viewMode === 'tape' && ti === activeTapeIdx && pi === activeProgIdx;
      const btn      = document.createElement('button');
      btn.className  = `prog-tab${isActive ? ' active' : ''}`;
      btn.dataset.ti = String(ti);
      btn.dataset.pi = String(pi);
      const hasErrors = prog.lines.some(l => l.lenErr);
      btn.innerHTML   = `<span class="prog-num">${pi + 1}</span>` +
        escHtml(prog.name || `Prog ${pi + 1}`) +
        (hasErrors ? ' <span class="badge badge-err">errors</span>' : '');
      progTabs.appendChild(btn);
    });
  });

  // Merged tabs — one per program ordinal when ≥ 2 tapes are loaded.
  if (tapes.length >= 2) {
    const mergedLabel = document.createElement('span');
    mergedLabel.className = 'tape-label tape-label-sep';
    mergedLabel.textContent = 'Merged';
    progTabs.appendChild(mergedLabel);

    mergedProgs.forEach((merged, mi) => {
      const isActive = viewMode === 'merged' && mi === activeProgIdx;
      const btn      = document.createElement('button');
      btn.className  = `prog-tab merged-tab${isActive ? ' active' : ''}`;
      btn.dataset.mi = String(mi);

      let badge = '';
      if (merged) {
        if (merged.issues > 0)
          badge += ` <span class="badge badge-err">${merged.issues} issue${merged.issues !== 1 ? 's' : ''}</span>`;
        if (merged.recovered > 0)
          badge += ` <span class="badge badge-ok">${merged.recovered} recovered</span>`;
        if (merged.unverified > 0 && merged.issues === 0)
          badge += ` <span class="badge badge-warn">${merged.unverified} unverified</span>`;
      }
      btn.innerHTML = `<span class="prog-num">${mi + 1}</span>Merged` + badge;
      progTabs.appendChild(btn);
    });
  }
}

// ── Per-tape rendering (unchanged logic) ──────────────────────────────────────
function renderAll(): void {
  renderTabs();
  basicPanel.classList.toggle('merge-active', viewMode === 'merged');
  const anyProgs = tapes.some(t => t.programs.length > 0);
  buildTapBtn.hidden = !anyProgs;

  if (viewMode === 'merged') {
    const merged = mergedProgs[activeProgIdx] ?? null;
    basicTypeEl.textContent = 'BASIC program (merged)';
    wrapLabelEl.hidden = !merged;
    if (!merged) { clearPanels(); return; }
    renderMergeView(merged);
    renderMergedHex(merged);
    // Show waveform from primary (tape 0) for now.
    const primProg    = tapes[0]?.programs[activeProgIdx];
    const primSamples = tapes[0]?.samples ?? null;
    if (primProg && primSamples) waveform.setData(primSamples, primProg);
    updateStatusBar();
    return;
  }

  const prog = programs[activeProgIdx];
  basicTypeEl.textContent = prog ? 'BASIC program found' : '';
  wrapLabelEl.hidden = !prog;
  if (!prog) { clearPanels(); return; }
  renderHex(prog);
  renderBasic(prog);
  if (leftSamples) waveform.setData(leftSamples, prog);
  updateStatusBar();
}

function renderHex(prog: Program): void {
  const firstContent = prog.lines[0]?.firstByte ?? prog.bytes.length;
  const selLine = selByte !== null
    ? prog.lines.findIndex(l => selByte! >= l.firstByte && selByte! <= l.lastByte)
    : -1;
  const lineFirst = selLine >= 0 ? prog.lines[selLine].firstByte : -1;
  const lineLast  = selLine >= 0 ? prog.lines[selLine].lastByte  : -1;

  let html = '<div class="hex-grid">';
  prog.bytes.forEach((b, i) => {
    const cls: string[] = ['hb'];
    if (i < firstContent)                cls.push('hb-pre');
    if (b.chkErr)                        cls.push('hb-err');
    else if (b.unclear)                  cls.push('hb-unclear');
    if (i >= lineFirst && i <= lineLast) cls.push('hb-line');
    if (i === selByte)                   cls.push('hb-sel');
    html += `<span class="${cls.join(' ')}" data-i="${i}">${b.v.toString(16).padStart(2, '0')}</span>`;
  });
  hexPanel.innerHTML = html + '</div>';
}

function elemIdxForByte(line: { firstByte: number; lastByte: number }, byteIdx: number): number {
  const off = byteIdx - line.firstByte;
  if (off === 2 || off === 3) return 0;
  if (off >= 4 && off < line.lastByte) return off - 3;
  return -1;
}

/**
 * Return the CSS error class for element `ei` of a BASIC line based on the
 * byte(s) it corresponds to — independent of whether the element is selected.
 * Element 0 = line-number field (2 bytes at offsets +2,+3 from firstByte).
 * Element ei ≥ 1 = single content byte at offset ei+3 from firstByte.
 */
function elemErrorClass(prog: Program, firstByte: number, ei: number): string {
  const offsets = ei === 0 ? [2, 3] : [ei + 3];
  let chkErr = false, unclear = false;
  for (const off of offsets) {
    const b = prog.bytes[firstByte + off];
    if (b?.chkErr)       chkErr   = true;
    else if (b?.unclear) unclear  = true;
  }
  return chkErr ? 'elem-err' : unclear ? 'elem-warn' : '';
}

function renderBasic(prog: Program): void {
  if (!prog.lines.length) {
    basicPanel.innerHTML = '<p class="hint">No BASIC content decoded.</p>';
    return;
  }

  const selLine = selByte !== null
    ? prog.lines.findIndex(l => selByte! >= l.firstByte && selByte! <= l.lastByte)
    : -1;
  const selElem = selLine >= 0 ? elemIdxForByte(prog.lines[selLine], selByte!) : -1;

  basicPanel.innerHTML = prog.lines.map((line, i) => {
    // Classify the line: 'err' if lenErr or any chkErr byte; 'warn' if only
    // unclear bytes (no hard errors).  Background tints are applied via CSS.
    const lineBytes = prog.bytes.slice(line.firstByte, line.lastByte + 1);
    const hasChkErr = line.lenErr || lineBytes.some(b => b?.chkErr);
    const hasUnclear = !hasChkErr && lineBytes.some(b => b?.unclear);
    const lineClass = [
      'basic-line',
      ...(hasChkErr  ? ['err']  : []),
      ...(hasUnclear ? ['warn'] : []),
      ...(i === selLine ? ['sel'] : []),
    ].join(' ');

    const elemsHtml = line.elements.map((el, ei) => {
      // Error class is always applied so errors are visible without selecting.
      const errCls = elemErrorClass(prog, line.firstByte, ei);
      const selCls = (i === selLine && ei === selElem) ? ' sel' : '';
      return `<span class="elem${errCls ? ' ' + errCls : ''}${selCls}" data-ei="${ei}">${escHtml(el)}</span>`;
    }).join('');

    return `<div class="${lineClass}" data-li="${i}">${elemsHtml}</div>`;
  }).join('');

  if (selLine >= 0) {
    basicPanel.querySelector<HTMLElement>(`[data-li="${selLine}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }
}

// ── Merged view rendering ─────────────────────────────────────────────────────
// One colour per tape slot — up to 6 tapes before cycling.
const TAPE_COLORS = ['#4a9eff', '#c97aff', '#4affb0', '#ffa04a', '#ff6b6b', '#ffd93d'];

function mergeProgs(): ReadonlyArray<Program | undefined> {
  return tapes.map(t => t.programs[activeProgIdx]);
}

/**
 * Render a single BASIC line as an HTML string.
 * `extraClass` is appended to the basic-line div's class list (e.g. 'not-merged').
 */
function renderBasicLineHtml(prog: Program, lineIdx: number, extraClass = ''): string {
  const line      = prog.lines[lineIdx];
  const lineBytes = prog.bytes.slice(line.firstByte, line.lastByte + 1);
  const hasChkErr  = line.lenErr || lineBytes.some(b => b?.chkErr);
  const hasUnclear = !hasChkErr && lineBytes.some(b => b?.unclear);
  const cls = [
    'basic-line',
    ...(hasChkErr  ? ['err']  : []),
    ...(hasUnclear ? ['warn'] : []),
    ...(extraClass ? [extraClass] : []),
  ].join(' ');
  const elems = line.elements.map((el, ei) => {
    const errCls = elemErrorClass(prog, line.firstByte, ei);
    return `<span class="elem${errCls ? ' ' + errCls : ''}">${escHtml(el)}</span>`;
  }).join('');
  return `<div class="${cls}">${elems}</div>`;
}

/**
 * Render the three-column merge view (tape 0 | merged | tape 1) into basicPanel.
 *
 * Uses a single per-row flex layout so the DOM itself keeps columns aligned —
 * no JS scroll synchronisation required.  Lines inside each column wrap at
 * exactly 40 characters (matching the Oric-1 LIST display) via CSS.
 */
function renderMergeView(merged: MergedProgram): void {
  if (!merged.lines.length) {
    basicPanel.innerHTML = '<p class="hint">No BASIC content decoded.</p>';
    return;
  }

  const progs    = mergeProgs();
  const col0Name = tapes[0] ? shortName(tapes[0].filename) : 'Tape 1';
  const col1Name = tapes[1] ? shortName(tapes[1].filename) : 'Tape 2';

  const rowsHtml = merged.lines.map((line, i) => {
    const src    = bestSource(line, progs);
    const rowSel = i === selMergeLine ? ' sel' : '';

    // Left column — tape 0
    const src0  = line.sources.find(s => s.tapeIdx === 0);
    const prog0 = progs[0];
    const col0 = src0 && prog0
      ? renderBasicLineHtml(prog0, src0.lineIdx,
          line.status === 'conflict' && src.tapeIdx !== 0 ? 'not-merged' : '')
      : '';

    // Middle column — best-source merged line.
    // Force error colouring for 'issue' lines even when the chosen source looks
    // clean (e.g. two byte-perfect sources that disagree — one must be wrong).
    const bestProg = progs[src.tapeIdx];
    const colMid = bestProg
      ? renderBasicLineHtml(bestProg, src.lineIdx, line.quality === 'issue' ? 'err' : '')
      : `<div class="basic-line err">(line ${line.lineNum})</div>`;

    // Right column — tape 1
    const src1  = line.sources.find(s => s.tapeIdx === 1);
    const prog1 = progs[1];
    const col1 = src1 && prog1
      ? renderBasicLineHtml(prog1, src1.lineIdx,
          line.status === 'conflict' && src.tapeIdx !== 1 ? 'not-merged' : '')
      : '';

    return `<div class="merge-row${rowSel}" data-mli="${i}">` +
      `<div class="merge-col">${col0}</div>` +
      `<div class="merge-col merge-col-result">${colMid}</div>` +
      `<div class="merge-col">${col1}</div>` +
      `</div>`;
  }).join('');

  // The header row lives inside .merge-rows so it scrolls horizontally with the
  // columns. Each cell is a full .merge-col (13px font → correct ch units for
  // min-width) containing a .merge-col-head span that applies the 11px styling.
  const headerHtml =
    `<div class="merge-row-head">` +
      `<div class="merge-col"><span class="merge-col-head">${escHtml(col0Name)}</span></div>` +
      `<div class="merge-col merge-col-result"><span class="merge-col-head merge-col-head-result">Merged</span></div>` +
      `<div class="merge-col"><span class="merge-col-head">${escHtml(col1Name)}</span></div>` +
    `</div>`;

  basicPanel.innerHTML =
    `<div class="merge-view">` +
    `<div class="merge-rows">${headerHtml}${rowsHtml}</div>` +
    `</div>`;

  applyMergeColumnWidths();

  // Attach directly to the scroll container so currentTarget is unambiguous.
  // Each renderMergeView() replaces the DOM so the old listener is GC'd with
  // the old element; the fresh .merge-rows gets a fresh listener.
  basicPanel.querySelector<HTMLElement>('.merge-rows')
    ?.addEventListener('wheel', (e: WheelEvent) => {
      if (e.deltaX === 0) return;
      const el = e.currentTarget as HTMLElement;
      const atLeft  = el.scrollLeft <= 0                               && e.deltaX < 0;
      const atRight = el.scrollLeft + el.clientWidth >= el.scrollWidth && e.deltaX > 0;
      if (atLeft || atRight) e.preventDefault();
    }, { passive: false });

  if (selMergeLine !== null) {
    basicPanel.querySelector<HTMLElement>(`[data-mli="${selMergeLine}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }
}

/**
 * In no-wrap mode, measure each column's true content width (via scrollWidth,
 * which includes hidden overflow) and lock it with an inline style so the three
 * columns are exactly as wide as their widest line rather than clipping at 1/3
 * of the container.  In wrap mode, clear any previously applied inline widths
 * so the flex layout resumes normally.
 */
function applyMergeColumnWidths(): void {
  const rows = Array.from(
    basicPanel.querySelectorAll<HTMLElement>('.merge-row, .merge-row-head'),
  );
  if (!rows.length) return;

  if (wrapMode) {
    // Restore flex layout — clear any JS-set widths.
    for (const row of rows) {
      row.querySelectorAll<HTMLElement>('.merge-col').forEach(col => {
        col.style.flex  = '';
        col.style.width = '';
      });
    }
    return;
  }

  // Measure the maximum content width for each column position (0, 1, 2).
  // scrollWidth captures overflow even when overflow-x: hidden.
  const maxW = [0, 0, 0];
  for (const row of rows) {
    row.querySelectorAll<HTMLElement>('.merge-col').forEach((col, i) => {
      if (i < 3) maxW[i] = Math.max(maxW[i], col.scrollWidth);
    });
  }

  // Apply fixed widths and opt each column out of flex grow/shrink.
  for (const row of rows) {
    row.querySelectorAll<HTMLElement>('.merge-col').forEach((col, i) => {
      if (i < 3) {
        col.style.flex  = 'none';
        col.style.width = `${maxW[i]}px`;
      }
    });
  }
}

function renderMergedHex(merged: MergedProgram): void {
  if (selMergeLine === null) {
    hexPanel.innerHTML = '<p class="hint">Select a BASIC line to inspect its bytes.</p>';
    return;
  }

  const line = merged.lines[selMergeLine];
  if (!line || !line.sources.length) {
    hexPanel.innerHTML = '<p class="hint">No byte data available for this line.</p>';
    return;
  }

  const progs   = mergeProgs();
  const src     = bestSource(line, progs);
  const prog    = progs[src.tapeIdx];
  if (!prog) { hexPanel.innerHTML = ''; return; }

  const lineData = prog.lines[src.lineIdx];
  const firstB   = lineData.firstByte;
  const lastB    = lineData.lastByte;

  const tapeColor = TAPE_COLORS[src.tapeIdx % TAPE_COLORS.length];
  let html = `<div class="hex-grid">` +
    `<span class="hex-source-label" style="color:${tapeColor}">` +
    `Tape ${src.tapeIdx + 1} · BASIC line ${line.lineNum}` +
    `</span>`;

  for (let i = firstB; i <= lastB; i++) {
    const b   = prog.bytes[i];
    const cls = ['hb',
      ...(b.chkErr  ? ['hb-err']     : []),
      ...(b.unclear ? ['hb-unclear'] : []),
    ].join(' ');
    html += `<span class="${cls}">${b.v.toString(16).padStart(2, '0')}</span>`;
  }
  hexPanel.innerHTML = html + '</div>';
}

// ── TAP builder modal ─────────────────────────────────────────────────────────

buildTapBtn.addEventListener('click', openTapBuilder);
tapCancelBtn.addEventListener('click', closeTapBuilder);
tapModal.addEventListener('click', (e) => {
  if (e.target === tapModal) closeTapBuilder();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !tapModal.hidden) closeTapBuilder();
});

function openTapBuilder(): void {
  tapQueue = [];
  renderTapBuilder();
  tapModal.hidden = false;
}

function closeTapBuilder(): void {
  tapModal.hidden = true;
}

/**
 * Return a stable key string for a queue entry to track which items are queued.
 */
function entryKey(kind: 'tape' | 'merged', tapeIdx: number, progIdx: number): string {
  return `${kind}:${tapeIdx}:${progIdx}`;
}

function renderTapBuilder(): void {
  // Build a set of queued keys for fast lookup.
  const queued = new Set(tapQueue.map(e => entryKey(e.kind, e.tapeIdx, e.progIdx)));

  // ── Available column ────────────────────────────────────────────────────────
  let availHtml = '';

  tapes.forEach((tape, ti) => {
    availHtml += `<div class="tap-group-head">${escHtml(shortName(tape.filename))}</div>`;
    tape.programs.forEach((prog, pi) => {
      const key    = entryKey('tape', ti, pi);
      const inQ    = queued.has(key);
      const dimmed = inQ ? ' tap-item-dimmed' : '';
      const btn    = inQ ? '' : `<button class="tap-btn" data-add-kind="tape" data-add-ti="${ti}" data-add-pi="${pi}">→</button>`;
      availHtml +=
        `<div class="tap-item${dimmed}">` +
        `<span class="prog-num">${pi + 1}</span>` +
        `<span class="tap-item-name">${escHtml(prog.name || `Prog ${pi + 1}`)}</span>` +
        btn +
        `</div>`;
    });
  });

  if (mergedProgs.some(m => m !== null)) {
    availHtml += `<div class="tap-group-head">Merged</div>`;
    mergedProgs.forEach((merged, mi) => {
      if (!merged) return;
      const key    = entryKey('merged', 0, mi);
      const inQ    = queued.has(key);
      const dimmed = inQ ? ' tap-item-dimmed' : '';
      const btn    = inQ ? '' : `<button class="tap-btn" data-add-kind="merged" data-add-ti="0" data-add-pi="${mi}">→</button>`;
      availHtml +=
        `<div class="tap-item${dimmed}">` +
        `<span class="prog-num">${mi + 1}</span>` +
        `<span class="tap-item-name">Merged</span>` +
        btn +
        `</div>`;
    });
  }

  tapAvailEl.innerHTML = availHtml;

  // ── Save-order and auto-run columns ─────────────────────────────────────────
  let queueHtml = '';
  let autoHtml  = '';

  tapQueue.forEach((entry, qi) => {
    let name: string;
    let sub: string;
    if (entry.kind === 'tape') {
      const prog = tapes[entry.tapeIdx]?.programs[entry.progIdx];
      name = prog?.name || `Prog ${entry.progIdx + 1}`;
      sub  = `Tape ${entry.tapeIdx + 1}`;
    } else {
      name = mergedProgs.filter(m => m).length > 1
        ? `Merged prog ${entry.progIdx + 1}`
        : 'Merged';
      sub  = 'Merged';
    }
    queueHtml +=
      `<div class="tap-item">` +
      `<span class="tap-item-name">${escHtml(name)}</span>` +
      `<span class="tap-item-sub">${escHtml(sub)}</span>` +
      `<button class="tap-btn" data-remove-qi="${qi}">←</button>` +
      `</div>`;
    autoHtml +=
      `<div class="tap-auto-row">` +
      `<input type="checkbox" data-auto-qi="${qi}"${entry.autorun ? ' checked' : ''}>` +
      `</div>`;
  });

  tapQueueEl.innerHTML = queueHtml;
  tapAutoEl.innerHTML  = autoHtml;

  tapDlBtn.disabled = tapQueue.length === 0;
}

// Event delegation for the modal body.
tapAvailEl.addEventListener('click', (e) => {
  const btn = (e.target as Element).closest<HTMLElement>('[data-add-kind]');
  if (!btn) return;
  const kind    = btn.dataset.addKind as 'tape' | 'merged';
  const tapeIdx = +(btn.dataset.addTi ?? '0');
  const progIdx = +(btn.dataset.addPi ?? '0');
  // Don't add duplicates.
  if (tapQueue.some(q => q.kind === kind && q.tapeIdx === tapeIdx && q.progIdx === progIdx)) return;
  tapQueue.push({ kind, tapeIdx, progIdx, autorun: false });
  renderTapBuilder();
});

tapQueueEl.addEventListener('click', (e) => {
  const btn = (e.target as Element).closest<HTMLElement>('[data-remove-qi]');
  if (!btn) return;
  const qi = +(btn.dataset.removeQi ?? '0');
  tapQueue.splice(qi, 1);
  renderTapBuilder();
});

tapAutoEl.addEventListener('change', (e) => {
  const cb = (e.target as Element).closest<HTMLInputElement>('[data-auto-qi]');
  if (!cb) return;
  const qi = +(cb.dataset.autoQi ?? '0');
  if (tapQueue[qi]) tapQueue[qi].autorun = cb.checked;
});

tapDlBtn.addEventListener('click', doDownloadTap);

function doDownloadTap(): void {
  if (tapQueue.length === 0) return;

  const blocks: TapBlock[] = [];
  for (const entry of tapQueue) {
    if (entry.kind === 'tape') {
      const prog = tapes[entry.tapeIdx]?.programs[entry.progIdx];
      if (!prog) continue;
      blocks.push({ name: prog.name || 'PROG', lines: linesFromProgram(prog), autorun: entry.autorun });
    } else {
      const merged = mergedProgs[entry.progIdx];
      if (!merged) continue;
      const progs = tapes.map(t => t.programs[entry.progIdx]);
      const name  = tapes.map(t => t.programs[entry.progIdx]?.name).find(n => n) ?? 'MERGED';
      blocks.push({ name, lines: linesFromMerged(merged, progs), autorun: entry.autorun });
    }
  }

  if (blocks.length === 0) return;

  // Derive filename from first block's name.
  const filename = `${blocks[0].name || 'tape'}.tap`;
  const bytes    = encodeTapFile(blocks);
  downloadTap(bytes, filename);
  closeTapBuilder();
}

// ── Selection (event delegation) ──────────────────────────────────────────────

hexPanelOuter.addEventListener('focus', () => { focusedPanel = 'hex'; });
hexPanel.addEventListener('click', (e) => {
  if (viewMode !== 'tape') return;
  focusedPanel = 'hex';
  const el = (e.target as Element).closest<HTMLElement>('[data-i]');
  if (el) selectByte(+el.dataset.i!);
});

// Prevent Safari's swipe-back/forward navigation gesture from firing when the
// user reaches the horizontal scroll boundary of the BASIC panel.  We intercept
// wheel events and call preventDefault() only when the nearest scrollable
// ancestor is already at its left/right limit in the direction of travel.
// { passive: false } is required — passive listeners cannot call preventDefault().
// Prevent Safari's swipe-back/forward navigation when reaching horizontal
// scroll boundaries.  We attach directly to each scroll container so
// currentTarget is unambiguous.  In tape mode basicPanel IS the scroll
// container; in merged mode .merge-rows is (listener added after each render).
basicPanel.addEventListener('wheel', (e: WheelEvent) => {
  if (e.deltaX === 0 || viewMode !== 'tape') return;
  const el = basicPanel;
  const atLeft  = el.scrollLeft <= 0                               && e.deltaX < 0;
  const atRight = el.scrollLeft + el.clientWidth >= el.scrollWidth && e.deltaX > 0;
  if (atLeft || atRight) e.preventDefault();
}, { passive: false });

basicPanel.addEventListener('focus', () => { focusedPanel = 'basic'; });
basicPanel.addEventListener('click', (e) => {
  focusedPanel = 'basic';
  if (viewMode === 'merged') {
    const el = (e.target as Element).closest<HTMLElement>('[data-mli]');
    if (!el) return;
    selMergeLine = +el.dataset.mli!;
    basicPanel.querySelector('.merge-row.sel')?.classList.remove('sel');
    el.classList.add('sel');
    el.scrollIntoView({ block: 'nearest' });
    const merged = mergedProgs[activeProgIdx];
    if (merged) renderMergedHex(merged);
    updateStatusBar();
    return;
  }

  const lineEl = (e.target as Element).closest<HTMLElement>('[data-li]');
  if (!lineEl) return;
  const line = programs[activeProgIdx]?.lines[+lineEl.dataset.li!];
  if (!line) return;
  const elemEl = (e.target as Element).closest<HTMLElement>('[data-ei]');
  if (elemEl) {
    const ei = +elemEl.dataset.ei!;
    selectByte(line.firstByte + (ei === 0 ? 2 : ei + 3));
  } else {
    selectByte(line.firstByte);
  }
});

function selectByte(i: number): void {
  selByte = i;

  hexPanel.querySelector('.hb-sel')?.classList.remove('hb-sel');
  hexPanel.querySelectorAll('.hb-line').forEach(el => el.classList.remove('hb-line'));
  const cell = hexPanel.querySelector<HTMLElement>(`[data-i="${i}"]`);
  cell?.classList.add('hb-sel');
  cell?.scrollIntoView({ block: 'nearest' });

  const prog = programs[activeProgIdx];
  if (prog) {
    basicPanel.querySelector('.basic-line.sel')?.classList.remove('sel');
    // elem-err/elem-warn are render-time state set by renderBasic; only 'sel' is transient.
    basicPanel.querySelector('.elem.sel')?.classList.remove('sel');
    const li = prog.lines.findIndex(l => i >= l.firstByte && i <= l.lastByte);
    if (li >= 0) {
      const line = prog.lines[li];
      for (let b = line.firstByte; b <= line.lastByte; b++) {
        hexPanel.querySelector(`[data-i="${b}"]`)?.classList.add('hb-line');
      }
      const lineEl = basicPanel.querySelector<HTMLElement>(`[data-li="${li}"]`);
      lineEl?.classList.add('sel');
      lineEl?.scrollIntoView({ block: 'nearest' });
      const ei = elemIdxForByte(line, i);
      if (ei >= 0) {
        lineEl?.querySelector<HTMLElement>(`[data-ei="${ei}"]`)?.classList.add('sel');
      }
    }
  }

  waveform.selectByte(i);
  updateStatusBar();
}

// ── Keyboard navigation ───────────────────────────────────────────────────────

/** Byte index for element ei on a BASIC line.
 *  ei === 0 → line-number field (2 bytes; maps to firstByte+2).
 *  ei  >= 1 → single content byte at firstByte+ei+3. */
function byteForElem(line: LineInfo, ei: number): number {
  return line.firstByte + (ei === 0 ? 2 : ei + 3);
}

/** Visible element index for byteIdx within a BASIC line.
 *  Returns -1 for non-visible bytes (link-pointer pair and terminator). */
function elemForByte(line: LineInfo, byteIdx: number): number {
  const off = byteIdx - line.firstByte;
  if (off === 2 || off === 3) return 0;
  const ei = off - 3;
  return (off >= 4 && ei <= line.elements.length - 1) ? ei : -1;
}

function isErrByte(b: ByteInfo): boolean {
  return b.chkErr || b.unclear;
}

function lineHasError(prog: Program, li: number): boolean {
  const line = prog.lines[li];
  if (line.lenErr) return true;
  for (let b = line.firstByte; b <= line.lastByte; b++) {
    const byte = prog.bytes[b];
    if (byte && isErrByte(byte)) return true;
  }
  return false;
}

/** Number of bytes per visual row in the current hex grid, measured from DOM.
 *  Uses hexPanel (#hex-view) rather than hexPanelOuter (#hex-panel) so that
 *  the 6px left+right padding on #hex-panel is naturally excluded. */
function hexBytesPerRow(): number {
  const firstHb = hexPanel.querySelector<HTMLElement>('.hb');
  if (!firstHb) return 16;
  const cellW = firstHb.getBoundingClientRect().width;
  if (cellW <= 0) return 16;
  return Math.max(1, Math.floor(hexPanel.clientWidth / cellW));
}

function navigateHex(key: string, shift: boolean, prog: Program): void {
  const n   = prog.bytes.length;
  const cur = selByte ?? prog.lines[0]?.firstByte ?? 0;

  if (!shift) {
    const bpr = hexBytesPerRow();
    const next: Record<string, number> = {
      ArrowLeft:  Math.max(0,     cur - 1),
      ArrowRight: Math.min(n - 1, cur + 1),
      ArrowUp:    Math.max(0,     cur - bpr),
      ArrowDown:  Math.min(n - 1, cur + bpr),
    };
    selectByte(next[key] ?? cur);
    return;
  }

  // Shift+Left/Right — scan linearly for next error/warning byte.
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const step = key === 'ArrowLeft' ? -1 : 1;
    for (let i = cur + step; i >= 0 && i < n; i += step) {
      if (isErrByte(prog.bytes[i])) { selectByte(i); return; }
    }
    return;
  }

  // Shift+Up/Down — jump to the first error byte of the next/prev row that
  // contains an error.  Column position is intentionally not preserved in this
  // first iteration but the row-walking structure makes it easy to add later.
  const bpr  = hexBytesPerRow();
  const step = key === 'ArrowUp' ? -1 : 1;
  let row = Math.floor(cur / bpr) + step;
  while (row >= 0 && row * bpr < n) {
    const rowStart = row * bpr;
    const rowEnd   = Math.min(rowStart + bpr - 1, n - 1);
    for (let b = rowStart; b <= rowEnd; b++) {
      if (isErrByte(prog.bytes[b])) { selectByte(b); return; }
    }
    row += step;
  }
}

function navigateBasic(key: string, shift: boolean, prog: Program): void {
  const lines = prog.lines;
  if (!lines.length) return;

  const li = selByte !== null
    ? lines.findIndex(l => selByte! >= l.firstByte && selByte! <= l.lastByte)
    : -1;

  if (!shift) {
    switch (key) {
      case 'ArrowUp':
      case 'ArrowDown': {
        const up = key === 'ArrowUp';
        // Visual navigation: find the nearest row above/below by measuring DOM
        // positions.  This works correctly whether wrap is ON (a BASIC line may
        // span several visual rows) or OFF (each BASIC line is one visual row).
        const allElems = Array.from(
          basicPanel.querySelectorAll<HTMLElement>('[data-li] [data-ei]'),
        );
        if (!allElems.length) break;

        // Reference point: selected elem span if available, else selected line.
        const refEl: HTMLElement | null =
          basicPanel.querySelector<HTMLElement>('.elem.sel') ??
          basicPanel.querySelector<HTMLElement>('.basic-line.sel');

        if (!refEl) {
          // No selection yet — jump to very first/last element.
          const target = up ? allElems[allElems.length - 1] : allElems[0];
          const lEl = target.closest<HTMLElement>('[data-li]')!;
          selectByte(byteForElem(prog.lines[+lEl.dataset.li!], +target.dataset.ei!));
          break;
        }

        const refRect = refEl.getBoundingClientRect();
        // Read all rects up-front to avoid interleaved layout reflows.
        const elemRects = allElems.map(el => el.getBoundingClientRect());

        // Pass 1: find the top-coordinate of the nearest visual row above/below.
        let targetRowTop = up ? -Infinity : Infinity;
        for (const r of elemRects) {
          if (up  && r.bottom <= refRect.top    + 0.5 && r.top > targetRowTop) targetRowTop = r.top;
          if (!up && r.top   >= refRect.bottom  - 0.5 && r.top < targetRowTop) targetRowTop = r.top;
        }
        if (!isFinite(targetRowTop)) break; // already at first/last visual row

        // Pass 2: among elements on that row, pick the one closest in x.
        let bestEl: HTMLElement | null = null;
        let bestDist = Infinity;
        for (let i = 0; i < allElems.length; i++) {
          if (Math.abs(elemRects[i].top - targetRowTop) < 3) {
            const dist = Math.abs(elemRects[i].left - refRect.left);
            if (dist < bestDist) { bestDist = dist; bestEl = allElems[i]; }
          }
        }
        if (!bestEl) break;

        const lEl = bestEl.closest<HTMLElement>('[data-li]')!;
        selectByte(byteForElem(prog.lines[+lEl.dataset.li!], +bestEl.dataset.ei!));
        break;
      }
      case 'ArrowLeft': {
        if (li < 0) { selectByte(byteForElem(lines[0], 0)); break; }
        const line = lines[li];
        let ei = elemForByte(line, selByte!);
        if (ei < 0) ei = 0; // snap to start of line if on a non-visible byte
        if (ei > 0) {
          selectByte(byteForElem(line, ei - 1));
        } else if (li > 0) {
          // Cross line boundary — land on the last visible element of the prev line.
          const prev = lines[li - 1];
          selectByte(byteForElem(prev, prev.elements.length - 1));
        }
        break;
      }
      case 'ArrowRight': {
        if (li < 0) { selectByte(byteForElem(lines[0], 0)); break; }
        const line = lines[li];
        let ei = elemForByte(line, selByte!);
        if (ei < 0) ei = line.elements.length - 1; // snap to end if on a non-visible byte
        if (ei < line.elements.length - 1) {
          selectByte(byteForElem(line, ei + 1));
        } else if (li < lines.length - 1) {
          // Cross line boundary — land on the first visible element of the next line.
          selectByte(byteForElem(lines[li + 1], 0));
        }
        break;
      }
    }
    return;
  }

  // Shift+Up/Down — jump to the next/prev BASIC line that contains any error,
  // landing on the first error element in that line (consistent regardless of
  // direction, so the result is always predictable).
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const step  = key === 'ArrowUp' ? -1 : 1;
    const start = li < 0 ? (step < 0 ? lines.length : -1) : li;
    for (let i = start + step; i >= 0 && i < lines.length; i += step) {
      if (!lineHasError(prog, i)) continue;
      const line = lines[i];
      // Prefer the first element that has a visibly-highlighted error byte (the
      // corruption site).  Only fall back to element 0 when the error is purely
      // at the line level (lenErr / checksum mismatch with no bad element bytes),
      // since in that case there is no more specific location to point at.
      let landed = false;
      for (let ei = 0; ei < line.elements.length; ei++) {
        const b = byteForElem(line, ei);
        // Element 0 covers two bytes (line-number field); check both.
        const check = ei === 0 ? [b, b + 1] : [b];
        if (check.some(idx => { const by = prog.bytes[idx]; return by && isErrByte(by); })) {
          selectByte(b);
          landed = true;
          break;
        }
      }
      if (!landed) selectByte(byteForElem(line, 0));
      return;
    }
    return;
  }

  // Shift+Left/Right — scan visible elements for the next/prev error, crossing
  // line boundaries when needed.
  if (li < 0 || selByte === null) return;
  const step = key === 'ArrowLeft' ? -1 : 1;

  // Current line: start from element adjacent to current position.
  const curLine = lines[li];
  const curEi   = elemForByte(curLine, selByte);
  const curStart = curEi < 0
    ? (step < 0 ? curLine.elements.length - 1 : 0)
    : curEi + step;
  for (let ei = curStart; ei >= 0 && ei < curLine.elements.length; ei += step) {
    const b = byteForElem(curLine, ei);
    if (prog.bytes[b] && isErrByte(prog.bytes[b])) { selectByte(b); return; }
  }

  // Remaining lines.
  for (let lj = li + step; lj >= 0 && lj < lines.length; lj += step) {
    const l     = lines[lj];
    const start = step < 0 ? l.elements.length - 1 : 0;
    for (let ei = start; ei >= 0 && ei < l.elements.length; ei += step) {
      const b = byteForElem(l, ei);
      if (prog.bytes[b] && isErrByte(prog.bytes[b])) { selectByte(b); return; }
    }
  }
}

const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (!NAV_KEYS.has(e.key) || viewMode !== 'tape') return;
  const prog = programs[activeProgIdx];
  if (!prog) return;
  if (focusedPanel === 'hex') {
    e.preventDefault();
    navigateHex(e.key, e.shiftKey, prog);
  } else if (focusedPanel === 'basic') {
    e.preventDefault();
    navigateBasic(e.key, e.shiftKey, prog);
  }
});

// ── Status bar ────────────────────────────────────────────────────────────────
function updateStatusBar(): void {
  if (viewMode === 'merged') {
    updateMergedStatusBar();
    return;
  }

  const prog = programs[activeProgIdx];
  if (selByte === null || !prog) {
    statusBar.innerHTML = '<span class="sb-dim">Click a byte or BASIC line to inspect.</span>';
    return;
  }

  const byte = prog.bytes[selByte];
  if (!byte) { statusBar.innerHTML = ''; return; }

  const dot  = ' <span class="sb-dim">·</span> ';
  const pipe = '  <span class="sb-dim">│</span>  ';

  const contentStart = prog.lines[0]?.firstByte;
  const byteNum      = contentStart !== undefined ? selByte - contentStart : selByte;
  const byteSegs: string[] = [`Byte ${byteNum}`];
  if (byte.unclear) byteSegs.push('<span class="sb-warn">Unclear</span>');
  if (byte.chkErr)  byteSegs.push('<span class="sb-err">Checksum error</span>');

  const sections: string[] = [byteSegs.join(dot)];

  if (prog.lines.length > 0) {
    const li = prog.lines.findIndex(l => selByte! >= l.firstByte && selByte! <= l.lastByte);
    const lineSegs: string[] = [];
    if (li < 0) {
      lineSegs.push('Line -');
    } else {
      const line = prog.lines[li];
      lineSegs.push(`Line ${li + 1}`);
      if (line.lenErr) {
        const expected = line.expectedLastByte - line.firstByte + 1;
        const actual   = line.lastByte         - line.firstByte + 1;
        lineSegs.push(`<span class="sb-err">Line length error (expected ${expected} bytes, found ${actual})</span>`);
      }
    }
    sections.push(lineSegs.join(dot));
  }

  statusBar.innerHTML = sections.join(pipe);
}

function updateMergedStatusBar(): void {
  const merged = mergedProgs[activeProgIdx];
  if (!merged) { statusBar.innerHTML = '<span class="sb-dim">No merged data available.</span>'; return; }

  const dot  = ' <span class="sb-dim">·</span> ';
  const pipe = '  <span class="sb-dim">│</span>  ';

  if (selMergeLine === null) {
    // Summary view.
    const parts: string[] = [`${merged.total} lines`];
    if (merged.clean > 0)
      parts.push(`<span style="color:var(--green)">${merged.clean} clean</span>`);
    if (merged.recovered > 0)
      parts.push(`<span style="color:var(--green)">${merged.recovered} recovered</span>`);
    if (merged.issues > 0)
      parts.push(`<span class="sb-err">${merged.issues} issue${merged.issues !== 1 ? 's' : ''}</span>`);
    if (merged.unverified > 0)
      parts.push(`<span class="sb-warn">${merged.unverified} unverified</span>`);
    statusBar.innerHTML = parts.join(dot);
    return;
  }

  const line = merged.lines[selMergeLine];

  // Per-line quality label with structural detail.
  const QUALITY_LABEL: Record<string, string> = {
    clean:      `<span style="color:var(--green)">Clean</span>`,
    recovered:  `<span style="color:var(--green)">Recovered · clean source chosen over corrupt</span>`,
    issue:      line.status === 'consensus'
                  ? `<span class="sb-err">Issue · sources agree but contain errors</span>`
                  : `<span class="sb-err">Issue · ${line.sources.length} sources conflict</span>`,
    unverified: line.status === 'single'
                  ? `<span class="sb-warn">Unverified · single source (tape ${(line.sources[0]?.tapeIdx ?? 0) + 1})</span>`
                  : `<span class="sb-warn">Unverified · ${line.sources.length}/${merged.tapeCount} tapes</span>`,
  };
  const segs = [`BASIC line ${line.lineNum}`, QUALITY_LABEL[line.quality]];
  statusBar.innerHTML = segs.join(dot) + pipe + `Line ${selMergeLine + 1}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function clearPanels(): void {
  hexPanel.innerHTML   = '';
  basicPanel.innerHTML = '';
}

function showError(msg: string): void {
  statusEl.textContent = '';
  hexPanel.innerHTML   = `<p class="error">Error: ${escHtml(msg)}</p>`;
  basicPanel.innerHTML = '';
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function shortName(filename: string): string {
  return filename.replace(/\.[^.]+$/, '').slice(0, 24);
}
