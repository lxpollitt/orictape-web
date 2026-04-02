import './style.css';
import { parseWavFile } from './wavfile';
import { WaveformView } from './waveform';
import type { WorkerResponse } from './worker';
import type { Program } from './decoder';
import {
  alignPrograms, bestSource,
  type MergedProgram, type LineStatus,
} from './merger';

// ── DOM ───────────────────────────────────────────────────────────────────────
const fileInput  = document.getElementById('file-input')       as HTMLInputElement;
const statusEl   = document.getElementById('status')           as HTMLParagraphElement;
const progTabs   = document.getElementById('prog-tabs')        as HTMLElement;
const hexPanel   = document.getElementById('hex-view')         as HTMLElement;
const basicPanel = document.getElementById('basic-view')       as HTMLElement;
const waveCanvas = document.getElementById('waveform-canvas')  as HTMLCanvasElement;
const statusBar  = document.getElementById('statusbar')        as HTMLElement;

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

// Convenience mirrors of the active tape — updated by activateTape().
// All existing per-tape rendering code reads these without change.
let programs:    Program[]         = [];
let leftSamples: Int16Array | null = null;

const waveform = new WaveformView(waveCanvas);

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
      btn.innerHTML   = escHtml(prog.name || `Prog ${pi + 1}`) +
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
        if (merged.conflicts > 0)
          badge = ` <span class="badge badge-err">${merged.conflicts} conflict${merged.conflicts !== 1 ? 's' : ''}</span>`;
        else if (merged.singles > 0 || merged.partial > 0)
          badge = ` <span class="badge badge-warn">${merged.singles + merged.partial} unverified</span>`;
      }
      const label = mergedProgs.length > 1 ? `Prog ${mi + 1}` : 'View';
      btn.innerHTML = label + badge;
      progTabs.appendChild(btn);
    });
  }
}

// ── Per-tape rendering (unchanged logic) ──────────────────────────────────────
function renderAll(): void {
  renderTabs();

  if (viewMode === 'merged') {
    const merged = mergedProgs[activeProgIdx] ?? null;
    if (!merged) { clearPanels(); return; }
    renderMergedBasic(merged);
    renderMergedHex(merged);
    // Show waveform from primary (tape 0) for now.
    const primProg    = tapes[0]?.programs[activeProgIdx];
    const primSamples = tapes[0]?.samples ?? null;
    if (primProg && primSamples) waveform.setData(primSamples, primProg);
    updateStatusBar();
    return;
  }

  const prog = programs[activeProgIdx];
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
    if ((i + 1) % 16 === 0) html += '<br>';
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

function renderMergedBasic(merged: MergedProgram): void {
  if (!merged.lines.length) {
    basicPanel.innerHTML = '<p class="hint">No BASIC content decoded.</p>';
    return;
  }

  const progs = mergeProgs();

  basicPanel.innerHTML = merged.lines.map((line, i) => {
    const src      = bestSource(line, progs);
    const prog     = progs[src.tapeIdx];
    const content  = prog?.lines[src.lineIdx].v ?? `(line ${line.lineNum})`;
    const hasLenErr = prog?.lines[src.lineIdx].lenErr ?? false;

    const dots = Array.from({ length: merged.tapeCount }, (_, t) => {
      const has   = line.sources.some(s => s.tapeIdx === t);
      const color = TAPE_COLORS[t % TAPE_COLORS.length];
      const cls   = has ? 'src-dot' : 'src-dot src-dot-absent';
      return `<span class="${cls}" style="color:${color}">●</span>`;
    }).join('');

    const cls = [
      'basic-line',
      ...(hasLenErr                     ? ['err']             : []),
      ...(line.status === 'conflict'    ? ['merged-conflict'] : []),
      ...(line.status === 'single'      ? ['merged-single']   : []),
      ...(line.status === 'partial'     ? ['merged-partial']  : []),
      ...(i === selMergeLine            ? ['sel']             : []),
    ].join(' ');

    return `<div class="${cls}" data-mli="${i}"><span class="src-dots">${dots}</span>${escHtml(content)}</div>`;
  }).join('');

  if (selMergeLine !== null) {
    basicPanel.querySelector<HTMLElement>(`[data-mli="${selMergeLine}"]`)
      ?.scrollIntoView({ block: 'nearest' });
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
    `</span><br>`;

  for (let i = firstB; i <= lastB; i++) {
    const b   = prog.bytes[i];
    const cls = ['hb',
      ...(b.chkErr  ? ['hb-err']     : []),
      ...(b.unclear ? ['hb-unclear'] : []),
    ].join(' ');
    html += `<span class="${cls}">${b.v.toString(16).padStart(2, '0')}</span>`;
    if (((i - firstB + 1) % 16) === 0) html += '<br>';
  }
  hexPanel.innerHTML = html + '</div>';
}

// ── Selection (event delegation) ──────────────────────────────────────────────
hexPanel.addEventListener('click', (e) => {
  if (viewMode !== 'tape') return;
  const el = (e.target as Element).closest<HTMLElement>('[data-i]');
  if (el) selectByte(+el.dataset.i!);
});

basicPanel.addEventListener('click', (e) => {
  if (viewMode === 'merged') {
    const el = (e.target as Element).closest<HTMLElement>('[data-mli]');
    if (!el) return;
    selMergeLine = +el.dataset.mli!;
    basicPanel.querySelector('.basic-line.sel')?.classList.remove('sel');
    el.classList.add('sel');
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
    if (merged.consensus > 0)
      parts.push(`<span style="color:var(--green)">${merged.consensus} consensus</span>`);
    if (merged.conflicts > 0)
      parts.push(`<span class="sb-err">${merged.conflicts} conflict${merged.conflicts !== 1 ? 's' : ''}</span>`);
    if (merged.singles + merged.partial > 0)
      parts.push(`<span class="sb-warn">${merged.singles + merged.partial} single-source</span>`);
    statusBar.innerHTML = parts.join(dot);
    return;
  }

  const line = merged.lines[selMergeLine];
  const STATUS_LABEL: Record<LineStatus, string> = {
    consensus: `<span style="color:var(--green)">Consensus</span>`,
    conflict:  `<span class="sb-err">Conflict · ${line.sources.length} tapes differ</span>`,
    partial:   `<span class="sb-warn">Partial · ${line.sources.length}/${merged.tapeCount} tapes</span>`,
    single:    `<span class="sb-warn">Single source · tape ${(line.sources[0]?.tapeIdx ?? 0) + 1}</span>`,
  };
  const segs = [`BASIC line ${line.lineNum}`, STATUS_LABEL[line.status]];
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
