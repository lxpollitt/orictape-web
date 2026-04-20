import './style.css';
import { parseWavFile } from './wavfile';
import { WaveformView, type StreamInfo } from './waveform';
import type { WorkerResponse } from './worker';
import type { Program, LineInfo, ByteInfo } from './decoder';
import { lineHealth, lineHasHardError, lineStatuses, programHealth, programSummary, programHasExplicitEdits, lineFirstAddr } from './decoder';
import { readProgramLines, readProgramBytes, flagNonMonotonicLines, splitProgram, joinPrograms } from './decoder';
import { applyLineEdit, splitLineWithEdits, joinLinesWithEdit, deleteLineEdit, restoreLineToOriginalBytes, fixPointersAndTerminators } from './editor';
import {
  alignPrograms, bestSource, isLineClean,
  hexViewProgram, progLineIdxForCol, mliForProgLineIdx,
  type MergedProgram,
} from './merger';
import { encodeTapFile, downloadTap, type TapEntry } from './tapEncoder';
import { parseTapFile } from './tapDecoder';

// ── DOM ───────────────────────────────────────────────────────────────────────
const fileInput  = document.getElementById('file-input')       as HTMLInputElement;
const statusEl   = document.getElementById('status')           as HTMLParagraphElement;
const progTabs   = document.getElementById('prog-tabs')        as HTMLElement;
const hexPanelOuter = document.getElementById('hex-panel')     as HTMLElement;
const hexPanel      = document.getElementById('hex-view')      as HTMLElement;
const hexTitleEl    = document.getElementById('hex-title')     as HTMLElement;
const basicPanel    = document.getElementById('basic-view')    as HTMLElement;
const waveCanvas = document.getElementById('waveform-canvas')  as HTMLCanvasElement;
const statusBar  = document.getElementById('statusbar')        as HTMLElement;
const basicTypeEl  = document.getElementById('basic-type')      as HTMLElement;
const wrapLabelEl      = document.getElementById('wrap-label')       as HTMLElement;
const wrapToggle       = document.getElementById('wrap-toggle')      as HTMLInputElement;
const fixLabelEl       = document.getElementById('fix-label')        as HTMLElement;
const fixToggle        = document.getElementById('fix-toggle')       as HTMLInputElement;
const normaliseToggle  = document.getElementById('normalise-toggle') as HTMLInputElement;
const zoomInBtn        = document.getElementById('zoom-in')          as HTMLButtonElement;
const zoomOutBtn       = document.getElementById('zoom-out')         as HTMLButtonElement;
const zoomResetBtn     = document.getElementById('zoom-reset')       as HTMLButtonElement;
const mergeBtnEl   = document.getElementById('merge-btn')       as HTMLButtonElement;
const mergeModal   = document.getElementById('merge-modal')     as HTMLElement;
const mergePickerEl = document.getElementById('merge-picker')   as HTMLElement;
const mergeCancelBtn = document.getElementById('merge-cancel')  as HTMLButtonElement;
const mergeOkBtn   = document.getElementById('merge-ok')        as HTMLButtonElement;
const buildTapBtn  = document.getElementById('build-tap')       as HTMLButtonElement;
const tapModal     = document.getElementById('tap-modal')       as HTMLElement;
const tapAvailEl   = document.getElementById('tap-avail')       as HTMLElement;
const tapQueueEl   = document.getElementById('tap-queue')       as HTMLElement;
const tapAutoEl    = document.getElementById('tap-auto')        as HTMLElement;
const tapCancelBtn = document.getElementById('tap-cancel')      as HTMLButtonElement;
const tapDlBtn     = document.getElementById('tap-download')    as HTMLButtonElement;
const tapMetaToggle = document.getElementById('tap-meta-toggle') as HTMLInputElement;
const searchBar    = document.getElementById('search-bar')      as HTMLElement;
const searchInput  = document.getElementById('search-input')    as HTMLInputElement;
const searchCount  = document.getElementById('search-count')    as HTMLElement;
const searchPrev   = document.getElementById('search-prev')     as HTMLButtonElement;
const searchNext   = document.getElementById('search-next')     as HTMLButtonElement;
const searchClose  = document.getElementById('search-close')    as HTMLButtonElement;

// ── State ─────────────────────────────────────────────────────────────────────
interface TapeData {
  filename:   string;
  samples:    Int16Array;
  sampleRate: number;
  programs:   Program[];
  /** True when loaded from a .tap file — no waveform data. */
  fromTap:    boolean;
}

/** Identifies one specific program from one tape. */
interface MergeSource {
  tapeIdx: number;
  progIdx: number;
}

/** A single user-requested merge between exactly two programs. */
interface UserMerge {
  sources: [MergeSource, MergeSource];
  result:  MergedProgram;
}

let tapes:        TapeData[]              = [];
let activeTapeIdx = 0;
let activeProgIdx = 0;
/** Monotonic counter for assigning Program.progNumber values.  Starts at 1
 *  and only ever increments — closing a tab does not free a number, and
 *  reloading a file does not reuse one.  This gives each loaded program a
 *  stable user-facing identity that survives tape reorderings, closures,
 *  and merge-snapshot lookups. */
let nextProgNumber = 1;

/** Stamp each program in the array with a fresh progNumber from the global
 *  counter.  Called once per batch of newly-loaded programs. */
function assignProgNumbers(progs: Program[]): void {
  for (const p of progs) p.progNumber = nextProgNumber++;
}

let viewMode:     'tape' | 'merged'       = 'tape';
let userMerges:   UserMerge[]             = [];
let selByte:      number | null            = null;
let selMergeLine: number | null            = null;
let selMergeCol:  0 | 1 | 2 | null        = null;
let selMergeElem: number | null            = null;
let searchMatches:  number[]               = [];   // line indices of current matches
let searchMatchIdx: number                 = -1;   // index into searchMatches
let wrapMode      = true;
let editingLine:    number | null          = null;  // line index being edited, or null
let editInput:      HTMLTextAreaElement | null = null;  // the inline edit textarea element
let editIsNewLine   = false;                         // true if editing a newly inserted line
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
waveform.setZoomLabel(document.getElementById('zoom-level') as HTMLElement);
waveform.setByteClickHandler((i) => {
  if (viewMode === 'tape' && programs[activeProgIdx]) selectByte(i);
});
waveform.setStreamSelectHandler((progIdx) => {
  if (viewMode === 'tape') {
    const savedView = waveform.saveView();
    activateTape(activeTapeIdx, progIdx);
    selByte = null;
    renderAll();
    waveform.restoreView(savedView);
  }
});

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

normaliseToggle.addEventListener('change', () => {
  waveform.setNormalise(normaliseToggle.checked);
});
waveform.setNormaliseCallback((checked) => {
  normaliseToggle.checked = checked;
});

// Fix pointers & terminators checkbox — runs fixPointersAndTerminators on the
// current program each time it is toggled off → on, then re-renders.  Step 1a
// semantics: always visible (when a single program is shown) and always
// enabled; unchecking is a no-op.  Step 1b will later tie the checkbox's
// visible/enabled state to whether the program currently has fixable issues.
fixToggle.addEventListener('change', () => {
  if (!fixToggle.checked) return;
  const prog = programs[activeProgIdx];
  if (!prog) return;
  fixPointersAndTerminators(prog);
  renderAll();
});

zoomInBtn   .addEventListener('click', () => waveform.zoomIn());
zoomOutBtn  .addEventListener('click', () => waveform.zoomOut());
zoomResetBtn.addEventListener('click', () => waveform.zoomReset());

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
  waveform.resetZoom();
  tapes           = [];
  userMerges      = [];
  selByte         = null;
  selMergeLine    = null;
  selMergeCol     = null;
  resetSearch();
  selMergeElem    = null;
  viewMode        = 'tape';
  mergeBtnEl.hidden = true;
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

    const isTap = file.name.toLowerCase().endsWith('.tap');

    if (isTap) {
      let programs: Program[];
      try { programs = parseTapFile(buffer); }
      catch (err) { showError(`${file.name}: ${err}`); return; }
      assignProgNumbers(programs);
      tapes.push({
        filename: file.name,
        samples:  new Int16Array(0),
        sampleRate: 48000,
        programs,
        fromTap:  true,
      });
    } else {
      let samples: Int16Array;
      let sampleRate: number;
      try { ({ left: samples, sampleRate } = parseWavFile(buffer)); }
      catch (err) { showError(`${file.name}: ${err}`); return; }

      const result = await decodeInWorker(buffer);
      if (!result.ok) { showError(`${file.name}: ${result.error}`); return; }

      assignProgNumbers(result.programs);
      tapes.push({ filename: file.name, samples, sampleRate, programs: result.programs, fromTap: false });
    }
  }

  const totalProgs = tapes.reduce((n, t) => n + t.programs.length, 0);
  mergeBtnEl.hidden = totalProgs < 2;
  const wavTapes = tapes.filter(t => !t.fromTap);
  const tapTapes = tapes.filter(t => t.fromTap);
  const dur = wavTapes.length
    ? (Math.max(...wavTapes.map(t => t.samples.length / t.sampleRate))).toFixed(1)
    : null;

  if (tapes.length > 1) {
    const parts = [`Loaded ${tapes.length} sources · ${totalProgs} programs`];
    if (dur !== null) parts.push(`${dur}s max audio`);
    statusEl.textContent = parts.join(' · ');
  } else if (tapTapes.length === 1) {
    statusEl.textContent = `Loaded ${totalProgs} program${totalProgs !== 1 ? 's' : ''} from TAP file.`;
  } else {
    statusEl.textContent = `Decoded ${totalProgs} program${totalProgs !== 1 ? 's' : ''} from ${dur}s of audio.`;
  }

  activateTape(0, 0);
  selByte = null;
  renderAll();
});

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
  selMergeCol  = null;
  selMergeElem = null;

  if (btn.dataset.mi !== undefined) {
    // ── → Merged tab ────────────────────────────────────────────────────────
    viewMode      = 'merged';
    activeProgIdx = +btn.dataset.mi;

    if (fromMode === 'tape' && fromSelByte !== null) {
      // Tape → Merged: translate the selected byte to a merged line index
      // via the BASIC line number.
      const fromProg = tapes[fromTapeIdx]?.programs[fromProgIdx];
      const merged   = userMerges[activeProgIdx]?.result;
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
      targetLineNum = userMerges[fromProgIdx]?.result.lines[fromMergeLine]?.lineNum ?? null;
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

  resetSearch();
  renderAll();

  // renderBasic/renderMergedBasic already call scrollIntoView for the BASIC
  // panel.  Mirror that for the hex panel and waveform (tape mode only).
  if (viewMode === 'tape' && selByte !== null) {
    hexPanel.querySelector<HTMLElement>(`[data-i="${selByte}"]`)
      ?.scrollIntoView({ block: 'nearest' });
    if (leftSamples && !tapes[activeTapeIdx]?.fromTap) {
      const byte = programs[activeProgIdx]?.bytes[selByte];
      waveform.selectByte(byte?.edited ? null : selByte);
    }
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
      const health = programHealth(prog);
      const hasErrors = health === 'error';
      const infoText  = prog.lines.length > 0
        ? `${prog.lines.length} line${prog.lines.length !== 1 ? 's' : ''}`
        : `${prog.bytes.length} byte${prog.bytes.length !== 1 ? 's' : ''}`;
      const badgesHtml = hasErrors
        ? '<span class="badge badge-err">errors</span>'
        : health === 'warning'
          ? '<span class="badge badge-warn">warnings</span>'
          : '';
      btn.innerHTML =
        `<div class="prog-tab-name"><span class="prog-num">${prog.progNumber}</span>${escHtml(prog.name || `Prog ${prog.progNumber}`)}</div>` +
        `<div class="prog-tab-info">${infoText}</div>` +
        `<div class="prog-tab-badges">${badgesHtml}</div>`;
      progTabs.appendChild(btn);
    });
  });

  // User-defined merged tabs.
  if (userMerges.length > 0) {
    const mergedLabel = document.createElement('span');
    mergedLabel.className = 'tape-label tape-label-sep';
    mergedLabel.textContent = 'Merged';
    progTabs.appendChild(mergedLabel);

    userMerges.forEach((merge, mi) => {
      const isActive = viewMode === 'merged' && mi === activeProgIdx;
      const btn      = document.createElement('button');
      btn.className  = `prog-tab merged-tab${isActive ? ' active' : ''}`;
      btn.dataset.mi = String(mi);

      const merged = merge.result;
      const issueBadgeClass = merged.issuesError > 0 ? 'badge-err' : 'badge-warn';
      let badge = '';
      if (merged.issues > 0)
        badge += ` <span class="badge ${issueBadgeClass}">${merged.issues} issue${merged.issues !== 1 ? 's' : ''}</span>`;
      if (merged.recovered > 0)
        badge += ` <span class="badge badge-ok">${merged.recovered} recovered</span>`;
      if (merged.unverified > 0 && merged.issues === 0)
        badge += ` <span class="badge badge-warn">${merged.unverified} unverified</span>`;

      // Read program numbers from the merge's own snapshot so the tab label
      // stays stable even if the original source tabs are later closed.
      const pn0 = merged.sources[0]?.progNumber ?? merge.sources[0].progIdx + 1;
      const pn1 = merged.sources[1]?.progNumber ?? merge.sources[1].progIdx + 1;
      btn.innerHTML =
        `<span class="prog-num">${pn0}</span>` +
        `<span class="prog-num">${pn1}</span>Merged` +
        badge;
      progTabs.appendChild(btn);
    });
  }
}

// ── Per-tape rendering (unchanged logic) ──────────────────────────────────────
function buildStreamInfos(tape: typeof tapes[0]): StreamInfo[] {
  return tape.programs.map((prog, i) => ({
    progIdx:     i,
    name:        prog.name,
    lineCount:   prog.lines.length,
    byteCount:   prog.bytes.length,
    firstSample: prog.stream.firstSample,
    lastSample:  prog.stream.lastSample,
  }));
}

function renderAll(): void {
  renderTabs();
  basicPanel.classList.toggle('merge-active', viewMode === 'merged');
  const anyProgs = tapes.some(t => t.programs.length > 0);
  buildTapBtn.hidden = !anyProgs;

  if (viewMode === 'merged') {
    const userMerge = userMerges[activeProgIdx] ?? null;
    const merged    = userMerge?.result ?? null;
    basicTypeEl.textContent = 'BASIC program (merged)';
    wrapLabelEl.hidden = !merged;
    // Fix pointers & terminators operates on a single Program; it is not
    // wired up for merged programs yet (see the merger-byte-stream todo).
    fixLabelEl.hidden = true;
    if (!merged) { clearPanels(); return; }
    renderMergeView(merged);
    renderMergedHex(merged);
    // Merge view has no single tape backing — samples aren't snapshotted
    // (they're tape-level, not Program-level), so the waveform is always
    // empty here.  Any attempt to show source samples would break the
    // merge's self-contained guarantee.
    waveform.clearData();
    updateStatusBar();
    return;
  }

  const prog = programs[activeProgIdx];
  basicTypeEl.textContent = prog ? 'BASIC program' : '';
  wrapLabelEl.hidden = !prog;
  fixLabelEl.hidden = !prog;
  if (prog) {
    // Reflect whether the program has any pointer/terminator issues: checkbox
    // is unchecked + enabled when there are issues to fix, checked + disabled
    // when everything is already clean ("in fixed state").
    const hasIssues = !!prog.pointerAndTerminatorIssues;
    fixToggle.checked  = !hasIssues;
    fixToggle.disabled = !hasIssues;
  }
  if (!prog) { clearPanels(); return; }
  renderHex(prog, selByte);
  renderBasic(prog);
  const activeTape = tapes[activeTapeIdx];
  if (prog && activeTape && !activeTape.fromTap && leftSamples) {
    waveform.setData(leftSamples, prog, activeTape.sampleRate, buildStreamInfos(activeTape));
  } else {
    waveform.clearData();
  }
  updateStatusBar();
}

/**
 * Build the HTML label for a Program, in "{filename} {prog-num-badge} {name}"
 * format.  Shared by merge-view column headers and hex-panel headers so the
 * two visually match.  `fallbackProgIdx` is used if the Program is missing
 * (shouldn't happen in practice but keeps the call site total).
 *
 * Returned HTML is safe — filename/name are escaped, progNumber is numeric.
 */
function progHeaderHtml(
  prog:            Program | undefined,
  filenameLabel:   string,
  fallbackProgIdx: number,
): string {
  const pn   = prog?.progNumber ?? fallbackProgIdx + 1;
  const name = prog?.name ?? '';
  return `${escHtml(filenameLabel)}<span class="prog-num">${pn}</span>${escHtml(name)}`;
}

/** Build the hex header HTML for a tape-mode program (current active tape). */
function tapeHexHeaderHtml(prog: Program): string {
  const tape = tapes[activeTapeIdx];
  const base = tape ? shortName(tape.filename) : `Tape ${activeTapeIdx + 1}`;
  return progHeaderHtml(prog, base, activeProgIdx);
}

/**
 * Render a Program's byte stream into the hex panel.
 *
 * Used for both tape programs (tape view) and merged output (merge view).
 * Selection is supplied by the caller so there's no implicit coupling to
 * the `selByte` / `selMergeLine` globals:
 *   - selectedByte (optional): highlight this specific byte with hb-sel and
 *                              highlight its containing line with hb-line.
 *   - selectedLineIdx (optional): if no selectedByte, use this LineInfo
 *                                 index to drive the hb-line highlight.
 *   - labelHtml (optional): HTML shown in the hex panel's header bar so the
 *                           user knows which program the hex bytes belong
 *                           to.  Defaults to tapeHexHeaderHtml(prog) which
 *                           matches the merge-view column header format.
 */
function renderHex(
  prog: Program,
  selectedByte: number | null = null,
  selectedLineIdx: number | null = null,
  labelHtml?: string,
): void {
  hexTitleEl.innerHTML = labelHtml ?? tapeHexHeaderHtml(prog);
  const firstContent = prog.lines[0]?.firstByte                          ?? prog.bytes.length;
  const lastLine     = prog.lines[prog.lines.length - 1];
  const lastContent  = lastLine ? lastLine.lastByte + 1 : 0;

  // Determine which line (if any) should be highlighted.  selectedByte takes
  // precedence: its containing line gets highlighted.  Otherwise fall back to
  // the explicit selectedLineIdx.
  let selLine = -1;
  if (selectedByte !== null) {
    selLine = prog.lines.findIndex(l => selectedByte >= l.firstByte && selectedByte <= l.lastByte);
  } else if (selectedLineIdx !== null && selectedLineIdx >= 0 && selectedLineIdx < prog.lines.length) {
    selLine = selectedLineIdx;
  }
  const lineFirst = selLine >= 0 ? prog.lines[selLine].firstByte : -1;
  const lineLast  = selLine >= 0 ? prog.lines[selLine].lastByte  : -1;

  let html = '<div class="hex-grid">';
  prog.bytes.forEach((b, i) => {
    const cls: string[] = ['hb'];
    if (i < firstContent || i >= lastContent) cls.push('hb-pre');
    if (b.chkErr)                        cls.push('hb-err');
    else if (b.unclear)                  cls.push('hb-unclear');
    if (b.edited === 'explicit')         cls.push('hb-edited');
    else if (b.edited === 'automatic')   cls.push('hb-auto-edited');
    if (i >= lineFirst && i <= lineLast) cls.push('hb-line');
    if (i === selectedByte)              cls.push('hb-sel');
    html += `<span class="${cls.join(' ')}" data-i="${i}">${b.v.toString(16).padStart(2, '0')}</span>`;
  });
  hexPanel.innerHTML = html + '</div>';

  // Auto-scroll: selected byte wins over selected line.
  const scrollTarget = selectedByte !== null
    ? selectedByte
    : (lineFirst >= 0 ? lineFirst : -1);
  if (scrollTarget >= 0) {
    hexPanel.querySelector<HTMLElement>(`[data-i="${scrollTarget}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }
}

function elemIdxForByte(line: { firstByte: number; lastByte: number }, byteIdx: number): number {
  const off = byteIdx - line.firstByte;
  if (off === 2 || off === 3) return 0;
  if (off >= 4 && off < line.lastByte) return off - 3;
  return -1;
}


// ── BASIC search ─────────────────────────────────────────────────────────────

function openSearch(): void {
  if (viewMode !== 'tape') return;
  searchBar.hidden = false;
  searchInput.focus();
  searchInput.select();
  runSearch(searchInput.value);
}

function closeSearch(): void {
  searchBar.hidden = true;
  resetSearch();
  const prog = programs[activeProgIdx];
  if (prog) renderBasic(prog);
}

/** Reset search state without triggering a re-render (call before renderAll). */
function resetSearch(): void {
  searchMatches  = [];
  searchMatchIdx = -1;
  searchInput.value        = '';
  searchCount.textContent  = '';
  searchCount.className    = '';
  searchInput.classList.remove('no-match');
}

function runSearch(query: string): void {
  const prog = programs[activeProgIdx];
  if (!prog) return;

  if (!query) {
    searchMatches  = [];
    searchMatchIdx = -1;
  } else {
    const q = query.toLowerCase();
    searchMatches  = prog.lines.reduce<number[]>((acc, line, i) => {
      if (line.v.toLowerCase().includes(q)) acc.push(i);
      return acc;
    }, []);
    searchMatchIdx = searchMatches.length > 0 ? 0 : -1;
  }

  updateSearchCount();
  renderBasic(prog);
  scrollToSearchMatch();
}

function navigateSearch(dir: 1 | -1): void {
  if (!searchMatches.length) return;
  searchMatchIdx = (searchMatchIdx + dir + searchMatches.length) % searchMatches.length;
  updateSearchCount();
  const prog = programs[activeProgIdx];
  if (prog) renderBasic(prog);
  scrollToSearchMatch();
}

function scrollToSearchMatch(): void {
  if (searchMatchIdx < 0 || !searchMatches.length) return;
  const lineIdx = searchMatches[searchMatchIdx];
  basicPanel.querySelector<HTMLElement>(`[data-li="${lineIdx}"]`)
    ?.scrollIntoView({ block: 'nearest' });
}

function updateSearchCount(): void {
  const hasQuery = searchInput.value.length > 0;
  if (!hasQuery) {
    searchCount.textContent = '';
    searchCount.className   = '';
    searchInput.classList.remove('no-match');
  } else if (!searchMatches.length) {
    searchCount.textContent = 'No matches';
    searchCount.className   = 'no-match';
    searchInput.classList.add('no-match');
  } else {
    searchCount.textContent = `${searchMatchIdx + 1} / ${searchMatches.length}`;
    searchCount.className   = '';
    searchInput.classList.remove('no-match');
  }
}

// Search button / input event wiring.
searchInput.addEventListener('input', () => runSearch(searchInput.value));
searchNext .addEventListener('click', () => navigateSearch(1));
searchPrev .addEventListener('click', () => navigateSearch(-1));
searchClose.addEventListener('click', () => closeSearch());
searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    navigateSearch(e.shiftKey ? -1 : 1);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeSearch();
    basicPanel.focus();
  }
});

/**
 * Return the edit-provenance status of element `ei` of `line` — based on the
 * `edited` flag(s) on the backing byte(s).  Element 0 spans 2 bytes (line
 * number); others are single bytes.  Mixed element-0 returns 'explicit' if
 * either byte is explicit, else 'automatic' if either is automatic, else null.
 */
function elementEditStatus(
  prog: Program, line: LineInfo, ei: number,
): 'explicit' | 'automatic' | null {
  const pick = (b: ByteInfo | undefined): 'explicit' | 'automatic' | null =>
    b?.edited === 'explicit' ? 'explicit' : b?.edited === 'automatic' ? 'automatic' : null;
  if (ei === 0) {
    const a = pick(prog.bytes[line.firstByte + 2]);
    const b = pick(prog.bytes[line.firstByte + 3]);
    return a === 'explicit' || b === 'explicit' ? 'explicit'
         : a === 'automatic' || b === 'automatic' ? 'automatic'
         : null;
  }
  return pick(prog.bytes[line.firstByte + 3 + ei]);
}

/** CSS class for an element's edit status (empty if not edited). */
function elementEditClass(status: 'explicit' | 'automatic' | null): string {
  return status === 'explicit' ? 'elem-edit-explicit'
       : status === 'automatic' ? 'elem-edit-auto'
       : '';
}

function renderBasic(prog: Program): void {
  if (!prog.lines.length) {
    basicPanel.innerHTML =
      '<p class="hint">No BASIC content decoded.</p>' +
      '<p class="hint">' +
        '<button id="force-decode-btn" class="zoom-btn">Force decode as BASIC</button> ' +
        (prog.bytes.length > 0 && prog.bytes[0].firstBit > 0
          ? ' <button id="force-decode-bytes-btn" class="zoom-btn">Force read from start of bitstream</button>'
          : '') +
      '</p>';
    document.getElementById('force-decode-btn')?.addEventListener('click', () => {
      prog.lines = [];
      prog.name = '';
      readProgramLines(prog, true);
      flagNonMonotonicLines(prog);
      renderHex(prog, selByte);
      renderBasic(prog);
      updateStatusBar();
    });
    document.getElementById('force-decode-bytes-btn')?.addEventListener('click', () => {
      const rebuilt = readProgramBytes(prog.stream, true);
      prog.bytes = rebuilt.bytes;
      prog.lines = [];
      prog.name = '';
      renderHex(prog, selByte);
      renderBasic(prog);
      updateStatusBar();
    });
    return;
  }

  const selLine = selByte !== null
    ? prog.lines.findIndex(l => selByte! >= l.firstByte && selByte! <= l.lastByte)
    : -1;
  const selElem = selLine >= 0 ? elemIdxForByte(prog.lines[selLine], selByte!) : -1;

  const matchSet = new Set(searchMatches);
  basicPanel.innerHTML = prog.lines.map((line, i) => {
    const health = lineHealth(prog, i);
    const hasChkErr  = health === 'error';
    const hasUnclear = health === 'warning';
    const isMatch   = matchSet.has(i);
    const isCurrent = isMatch && searchMatchIdx >= 0 && searchMatches[searchMatchIdx] === i;
    const lineClass = [
      'basic-line',
      ...(hasChkErr  ? ['err']  : []),
      ...(hasUnclear ? ['warn'] : []),
      ...(line.ignoreErrors   ? ['ignore-errors']         : []),
      ...(i === selLine       ? ['sel']                  : []),
      ...(isMatch             ? ['search-match']         : []),
      ...(isCurrent           ? ['search-match-current'] : []),
    ].join(' ');

    const elemsHtml = line.elements.map((el, ei) => {
      const elemSev = line.elementErrors?.[ei];
      const errCls = elemSev === 'error' ? 'elem-err' : elemSev === 'warning' ? 'elem-warn' : '';
      const editCls = elementEditClass(elementEditStatus(prog, line, ei));
      const selCls = (i === selLine && ei === selElem) ? ' sel' : '';
      const extraCls = [errCls, editCls].filter(Boolean).join(' ');
      return `<span class="elem${extraCls ? ' ' + extraCls : ''}${selCls}" data-ei="${ei}">${escHtml(el)}</span>`;
    }).join('');

    return `<div class="${lineClass}" data-li="${i}">${elemsHtml}</div>`;
  }).join('');

  if (selLine >= 0) {
    basicPanel.querySelector<HTMLElement>(`[data-li="${selLine}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }
}

// ── Inline BASIC line editing ─────────────────────────────────────────────────

/**
 * Insert a blank line into the program and immediately enter edit mode on it.
 * The line has line number 0 and no content until the user types something.
 * If the user cancels (Escape) or leaves it empty, the line is deleted.
 */
function insertNewLine(prog: Program, insertAt: number): void {
  // Determine where to insert in the byte stream.
  // Insert before the target line's bytes, or at the end if inserting past the last line.
  const bytePos = insertAt < prog.lines.length
    ? prog.lines[insertAt].firstByte
    : (prog.lines.length > 0 ? prog.lines[prog.lines.length - 1].lastByte + 1 : 0);

  // Minimal line: next-line pointer (2 bytes) + line number 0 (2 bytes) + null terminator (1 byte).
  const newBytes: ByteInfo[] = [
    { v: 0, firstBit: 0, lastBit: 0, unclear: false, chkErr: false, edited: 'explicit' },  // ptr lo
    { v: 0, firstBit: 0, lastBit: 0, unclear: false, chkErr: false, edited: 'explicit' },  // ptr hi
    { v: 0, firstBit: 0, lastBit: 0, unclear: false, chkErr: false, edited: 'explicit' },  // linenum lo
    { v: 0, firstBit: 0, lastBit: 0, unclear: false, chkErr: false, edited: 'explicit' },  // linenum hi
    { v: 0, firstBit: 0, lastBit: 0, unclear: false, chkErr: false, edited: 'explicit' },  // null terminator
  ];
  prog.bytes.splice(bytePos, 0, ...newBytes);

  // Shift all lines at or after insertAt.
  for (let li = insertAt; li < prog.lines.length; li++) {
    prog.lines[li].firstByte += 5;
    prog.lines[li].lastByte  += 5;
  }

  // Create the new LineInfo entry (empty — user will type the line number and content).
  const newLine: LineInfo = {
    v: '',
    elements: [],
    firstByte: bytePos,
    lastByte: bytePos + 4,
    lenErr: false,
  };
  prog.lines.splice(insertAt, 0, newLine);

  // Recalculate next-line pointers.
  const startAddr = prog.header.startAddr;
  const firstLineOffset = prog.lines[0].firstByte;
  for (let li = 0; li < prog.lines.length; li++) {
    const l = prog.lines[li];
    let ptrValue: number;
    if (li < prog.lines.length - 1) {
      const nextLineByteOffset = prog.lines[li + 1].firstByte - firstLineOffset;
      ptrValue = startAddr + nextLineByteOffset;
    } else {
      ptrValue = 0x0000;
    }
    prog.bytes[l.firstByte].v     = ptrValue & 0xFF;
    prog.bytes[l.firstByte + 1].v = (ptrValue >> 8) & 0xFF;
  }

  // Render and enter edit mode on the new line.
  renderHex(prog, selByte);
  renderBasic(prog);
  editIsNewLine = true;
  enterEditMode(insertAt);
}

/**
 * Enter edit mode on a BASIC line.
 * @param lineIdx   Index into prog.lines
 * @param replaceElem  If set, replace the element at this index with `insertChar`
 * @param insertChar   The character to insert (replacing the selected element)
 */
function enterEditMode(lineIdx: number, replaceElem?: number, insertChar?: string): void {
  const prog = programs[activeProgIdx];
  if (!prog || lineIdx < 0 || lineIdx >= prog.lines.length) return;

  // Clear any previous selection highlighting.
  basicPanel.querySelector('.basic-line.sel')?.classList.remove('sel');
  basicPanel.querySelector('.elem.sel')?.classList.remove('sel');
  selByte = null;

  editingLine = lineIdx;
  const line = prog.lines[lineIdx];
  const lineText = line.elements.join('');

  // Find the line div and replace its content with a textarea.
  const lineEl = basicPanel.querySelector<HTMLElement>(`[data-li="${lineIdx}"]`);
  if (!lineEl) return;

  const ta = document.createElement('textarea');
  ta.value = lineText;
  ta.className = 'basic-edit-input';
  ta.autocomplete = 'off';
  ta.spellcheck = false;
  ta.rows = 1;

  // Auto-size height to fit content.
  const autoSize = () => {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  };
  ta.addEventListener('input', autoSize);

  // ta.addEventListener('blur', () => {
  //   if (editingLine !== null) exitEditMode(true);
  // });

  ta.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && e.shiftKey) {
      // Shift+Enter: split line at cursor.
      e.preventDefault();
      const prog = programs[activeProgIdx];
      if (!prog || editingLine === null) return;
      const curPos = ta.selectionStart;
      const textBefore = ta.value.slice(0, curPos);
      const textAfter  = ta.value.slice(curPos);
      const savedLineIdx = editingLine;
      const newLineIdx = splitLineWithEdits(prog, savedLineIdx, textBefore, textAfter);

      editingLine = null;
      editInput = null;
      editIsNewLine = false;

      renderHex(prog, selByte);
      if (selByte !== null && prog.bytes[selByte]?.edited) {
        waveform.selectByte(null);
      }
      renderBasic(prog);

      // Enter edit mode on the new second line.
      if (newLineIdx !== null) {
        enterEditMode(newLineIdx);
        if (editInput) {
          const eta = editInput as HTMLTextAreaElement;
          eta.value = textAfter;
          eta.selectionStart = eta.selectionEnd = 0;
        }
      }
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      // Ctrl/Cmd+Enter: save, ignore errors on this line, and exit edit mode.
      e.preventDefault();
      const prog = programs[activeProgIdx];
      if (prog && editingLine !== null) {
        prog.lines[editingLine].ignoreErrors = true;
      }
      exitEditMode(true);
    } else if (e.key === 'Enter' && !e.shiftKey) {
      // Enter: save, clear ignoreErrors flag, and exit edit mode.
      e.preventDefault();
      const prog = programs[activeProgIdx];
      if (prog && editingLine !== null) {
        prog.lines[editingLine].ignoreErrors = undefined;
      }
      exitEditMode(true);
    } else if (e.key === 'Escape' && e.shiftKey) {
      // Shift+Escape: restore line to original bytes.
      e.preventDefault();
      const prog = programs[activeProgIdx];
      if (prog && editingLine !== null) {
        const savedLineIdx = editingLine;
        editingLine = null;
        editInput = null;
        editIsNewLine = false;
        restoreLineToOriginalBytes(prog, savedLineIdx);
        renderHex(prog, selByte);
        renderBasic(prog);
        selectByte(byteForElem(prog.lines[savedLineIdx], 0));
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      exitEditMode(false);
    } else if (e.key === 'Backspace' && ta.selectionStart === 0 && ta.selectionEnd === 0) {
      // Backspace at start of line: join with previous line.
      const prog = programs[activeProgIdx];
      if (!prog || editingLine === null || editingLine === 0) return;
      e.preventDefault();
      const savedLineIdx = editingLine;
      const curText = ta.value;

      // Exit edit mode without saving (joinLinesWithEdit handles the merge).
      editingLine = null;
      editInput = null;
      editIsNewLine = false;

      const joinPoint = joinLinesWithEdit(prog, savedLineIdx, curText, -1);

      renderHex(prog, selByte);
      if (selByte !== null && prog.bytes[selByte]?.edited) {
        waveform.selectByte(null);
      }
      renderBasic(prog);

      // Enter edit mode on the surviving line (previous line) with cursor at join point.
      if (joinPoint !== null) {
        const survivorIdx = savedLineIdx - 1;
        enterEditMode(survivorIdx);
        if (editInput) {
          const eta = editInput as HTMLTextAreaElement;
          eta.selectionStart = eta.selectionEnd = joinPoint;
        }
      }
    } else if (e.key === 'Delete' && ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length) {
      // Delete at end of line: join with next line.
      const prog = programs[activeProgIdx];
      if (!prog || editingLine === null || editingLine >= prog.lines.length - 1) return;
      e.preventDefault();
      const savedLineIdx = editingLine;
      const curText = ta.value;

      // Exit edit mode without saving (joinLinesWithEdit handles the merge).
      editingLine = null;
      editInput = null;
      editIsNewLine = false;

      const joinPoint = joinLinesWithEdit(prog, savedLineIdx, curText, 1);

      renderHex(prog, selByte);
      if (selByte !== null && prog.bytes[selByte]?.edited) {
        waveform.selectByte(null);
      }
      renderBasic(prog);

      // Enter edit mode on the surviving line (same line) with cursor at join point.
      if (joinPoint !== null) {
        enterEditMode(savedLineIdx);
        if (editInput) {
          const eta = editInput as HTMLTextAreaElement;
          eta.selectionStart = eta.selectionEnd = joinPoint;
        }
      }
    } else if (e.key === 'ArrowLeft' && ta.selectionStart === 0 && ta.selectionEnd === 0 && editingLine !== null && editingLine > 0) {
      // Cursor-left at start of line: save and select last element of previous line.
      e.preventDefault();
      const targetLine = editingLine - 1;
      exitEditMode(true);
      const prog = programs[activeProgIdx];
      if (prog && targetLine < prog.lines.length) {
        const line = prog.lines[targetLine];
        selectByte(byteForElem(line, line.elements.length - 1));
      }
    } else if (e.key === 'ArrowRight' && ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length && editingLine !== null && editingLine < (programs[activeProgIdx]?.lines.length ?? 0) - 1) {
      // Cursor-right at end of line: save and select first element of next line.
      e.preventDefault();
      const targetLine = editingLine + 1;
      exitEditMode(true);
      const prog = programs[activeProgIdx];
      if (prog && targetLine < prog.lines.length) {
        selectByte(byteForElem(prog.lines[targetLine], 0));
      }
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      // Capture cursor position before the browser moves it.
      // After a minimal timeout, check if the cursor hit a boundary
      // (moved to 0 for Up, or value.length for Down).
      const posBefore = ta.selectionStart;
      const direction = e.key === 'ArrowUp' ? -1 : 1;
      e.stopPropagation();  // prevent global handler from double-processing
      setTimeout(() => {
        if (editingLine === null) return;  // already exited
        const atBoundary = direction === -1
          ? ta.selectionStart === 0
          : ta.selectionStart === ta.value.length;
        if (atBoundary) {
          ta.selectionStart = ta.selectionEnd = posBefore;
          exitEditMode(true, direction);
        }
      }, 0);
      return;
    }
    e.stopPropagation();
  });

  lineEl.textContent = '';
  lineEl.appendChild(ta);
  editInput = ta;

  if (replaceElem !== undefined && replaceElem >= 0 && replaceElem < line.elements.length) {
    // Calculate the character range of the target element in the text.
    let charStart = 0;
    for (let ei = 0; ei < replaceElem; ei++) charStart += line.elements[ei].length;
    const charEnd = charStart + line.elements[replaceElem].length;

    if (insertChar !== undefined) {
      // Replace the element text with the typed character.
      ta.value = lineText.slice(0, charStart) + insertChar + lineText.slice(charEnd);
      ta.focus();
      ta.selectionStart = ta.selectionEnd = charStart + insertChar.length;
    } else {
      // Position cursor at the end of the selected element (no replacement).
      ta.focus();
      ta.selectionStart = ta.selectionEnd = charEnd;
    }
  } else {
    ta.focus();
    ta.select();
  }

  autoSize();  // initial sizing
  updateStatusBar();
}

/**
 * Exit edit mode, optionally applying the edit and navigating to an adjacent line.
 * @param confirmed  true = apply the edit, false = discard
 * @param direction  -1 = move to previous line, 1 = next line, 0 = stay (default)
 */
function exitEditMode(confirmed: boolean, direction = 0): void {
  if (editingLine === null || !editInput) return;

  const prevEditingLine = editingLine;
  const cursorPos = editInput ? (editInput as HTMLTextAreaElement).selectionStart ?? 0 : 0;

  if (confirmed) {
    const text = editInput.value;
    const prog = programs[activeProgIdx];
    if (prog && editingLine !== null && editingLine < prog.lines.length) {
      if (text.trim() === '') {
        // Empty input — delete the line.
        deleteLineEdit(prog, editingLine);
        selByte = null;
        renderHex(prog, selByte);
        waveform.selectByte(null);
      } else {
        applyLineEdit(prog, editingLine, text);
        renderHex(prog, selByte);
        // Clear waveform selection only if the selected byte is now edited.
        if (selByte !== null && prog.bytes[selByte]?.edited) {
          waveform.selectByte(null);
        }
      }
    }
  } else {
    // Cancelled — if this was a new line insertion, delete it.
    if (editIsNewLine) {
      const prog = programs[activeProgIdx];
      if (prog && editingLine !== null && editingLine < prog.lines.length) {
        deleteLineEdit(prog, editingLine);
        selByte = null;
        renderHex(prog, selByte);
        waveform.selectByte(null);
      }
    }
  }

  editingLine = null;
  editInput = null;
  editIsNewLine = false;

  // Re-render to restore the normal line display.
  const prog = programs[activeProgIdx];
  if (prog) {
    renderBasic(prog);

    // Map cursor position to element on the edited line, then optionally navigate.
    if (prevEditingLine >= 0 && prevEditingLine < prog.lines.length) {
      const editedLine = prog.lines[prevEditingLine];
      // Find which element the cursor was in.
      let targetEi = 0;
      let charCount = 0;
      for (let ei = 0; ei < editedLine.elements.length; ei++) {
        charCount += editedLine.elements[ei].length;
        if (charCount >= cursorPos) { targetEi = ei; break; }
        targetEi = ei;
      }
      // Select that element on the edited line (puts it in the DOM with .sel).
      selectByte(byteForElem(editedLine, targetEi));

      // If navigating up/down, use the existing visual navigation from this position.
      if (direction !== 0) {
        const key = direction === -1 ? 'ArrowUp' : 'ArrowDown';
        navigateBasic(key, false, prog);
      }
    }

    updateStatusBar();
  }
}

// ── Merged view rendering ─────────────────────────────────────────────────────

function mergeProgs(): ReadonlyArray<Program | undefined> {
  // Read from the merge's own snapshot so rendering is independent of live
  // tape/program state (edits, tab closures) on the original sources.
  return userMerges[activeProgIdx]?.result.sources ?? [];
}

/**
 * Render a single BASIC line as an HTML string.
 * `extraClass` is appended to the basic-line div's class list (e.g. 'not-merged').
 */
function renderBasicLineHtml(
  prog: Program,
  lineIdx: number,
  extraClass = '',
  selElem: number | null = null,
): string {
  const line      = prog.lines[lineIdx];
  const health    = lineHealth(prog, lineIdx);
  const hasChkErr  = health === 'error';
  const hasUnclear = health === 'warning';
  const cls = [
    'basic-line',
    ...(hasChkErr  ? ['err']  : []),
    ...(hasUnclear ? ['warn'] : []),
    ...(extraClass ? [extraClass] : []),
  ].join(' ');
  const elems = line.elements.map((el, ei) => {
    const elemSev = line.elementErrors?.[ei];
    const errCls = elemSev === 'error' ? 'elem-err' : elemSev === 'warning' ? 'elem-warn' : '';
    const editCls = elementEditClass(elementEditStatus(prog, line, ei));
    const selCls = ei === selElem ? ' sel' : '';
    const extraCls = [errCls, editCls].filter(Boolean).join(' ');
    return `<span class="elem${extraCls ? ' ' + extraCls : ''}${selCls}" data-ei="${ei}">${escHtml(el)}</span>`;
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
  const ti0      = 0;   // slot index for left column
  const ti1      = 1;   // slot index for right column

  const rowsHtml = merged.lines.map((line, i) => {
    const rowSel = i === selMergeLine ? ' sel' : '';

    // Determine which element (if any) is selected within each column.
    const isSel = i === selMergeLine;
    const sel0   = isSel && selMergeCol === 0 ? selMergeElem : null;
    const selMid = isSel && selMergeCol === 1 ? selMergeElem : null;
    const sel1   = isSel && selMergeCol === 2 ? selMergeElem : null;

    if (line.rejected) {
      // Rejected lines: show in source columns (dimmed) but empty merged column.
      const srcLeft  = line.sources.find(s => s.tapeIdx === ti0);
      const progLeft = progs[ti0];
      const col0 = srcLeft && progLeft
        ? renderBasicLineHtml(progLeft, srcLeft.lineIdx, 'not-merged', sel0)
        : '';

      const srcRight  = line.sources.find(s => s.tapeIdx === ti1);
      const progRight = progs[ti1];
      const col1 = srcRight && progRight
        ? renderBasicLineHtml(progRight, srcRight.lineIdx, 'not-merged', sel1)
        : '';

      return `<div class="merge-row${rowSel}" data-mli="${i}">` +
        `<div class="merge-col" data-col="0">${col0}</div>` +
        `<div class="merge-col merge-col-result" data-col="1"></div>` +
        `<div class="merge-col" data-col="2">${col1}</div>` +
        `</div>`;
    }

    const src = bestSource(merged, line);

    // Left column — source 0 tape
    const srcLeft  = line.sources.find(s => s.tapeIdx === ti0);
    const progLeft = progs[ti0];
    const col0 = srcLeft && progLeft
      ? renderBasicLineHtml(progLeft, srcLeft.lineIdx,
          line.status === 'conflict' && src.tapeIdx !== ti0 ? 'not-merged' : '',
          sel0)
      : '';

    // Middle column — best-source merged line.
    // Force error colouring for 'issue' lines even when the chosen source looks
    // clean (e.g. two byte-perfect sources that disagree — one must be wrong).
    const bestProg = progs[src.tapeIdx];
    const colMid = bestProg
      ? renderBasicLineHtml(bestProg, src.lineIdx, line.quality === 'issue' ? 'err' : '', selMid)
      : `<div class="basic-line err">(line ${line.lineNum})</div>`;

    // Right column — source 1 tape
    const srcRight  = line.sources.find(s => s.tapeIdx === ti1);
    const progRight = progs[ti1];
    const col1 = srcRight && progRight
      ? renderBasicLineHtml(progRight, srcRight.lineIdx,
          line.status === 'conflict' && src.tapeIdx !== ti1 ? 'not-merged' : '',
          sel1)
      : '';

    return `<div class="merge-row${rowSel}" data-mli="${i}">` +
      `<div class="merge-col" data-col="0">${col0}</div>` +
      `<div class="merge-col merge-col-result" data-col="1">${colMid}</div>` +
      `<div class="merge-col" data-col="2">${col1}</div>` +
      `</div>`;
  }).join('');

  // The header row lives inside .merge-rows so it scrolls horizontally with the
  // columns. Each cell is a full .merge-col (13px font → correct ch units for
  // min-width) containing a .merge-col-head span that applies the 11px styling.
  // Column header content uses the same helper as the hex panel header so the
  // two visually match.
  const headerHtml =
    `<div class="merge-row-head">` +
      `<div class="merge-col"><span class="merge-col-head">${mergeHexHeaderHtml(merged, 0)}</span></div>` +
      `<div class="merge-col merge-col-result"><span class="merge-col-head merge-col-head-result">Merged</span></div>` +
      `<div class="merge-col"><span class="merge-col-head">${mergeHexHeaderHtml(merged, 2)}</span></div>` +
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
    const rowEl = basicPanel.querySelector<HTMLElement>(`[data-mli="${selMergeLine}"]`);
    const selEl = selMergeCol !== null && selMergeElem !== null
      ? rowEl?.querySelector<HTMLElement>(`[data-col="${selMergeCol}"] [data-ei="${selMergeElem}"]`)
      : null;
    (selEl ?? rowEl)?.scrollIntoView({ block: 'nearest' });
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

/**
 * Render the hex panel in merge view, following the currently selected merge
 * column: col 0 → left source, col 1 → merged output, col 2 → right source.
 *
 * Delegates to shared renderHex() with the column's Program, the line within
 * that Program corresponding to selMergeLine (if any), and a header label
 * identifying what the user is looking at.
 *
 * selByte is interpreted as "byte in the currently displayed program".
 * selectMergeElem and selectMergeByteAt keep it in sync with the column
 * switch, so renderMergedHex just passes it through.
 */
function renderMergedHex(merged: MergedProgram): void {
  const col = (selMergeCol ?? 1) as 0 | 1 | 2;
  const prog = hexViewProgram(merged, col);
  if (!prog) {
    // Source slot is absent (edge case: a tape/program was removed before
    // the merge could snapshot it).  Clear the panel cleanly.
    hexTitleEl.innerHTML = '';
    hexPanel.innerHTML   = '';
    return;
  }
  const progLineIdx = selMergeLine !== null
    ? progLineIdxForCol(merged, selMergeLine, col)
    : -1;
  const labelHtml = mergeHexHeaderHtml(merged, col);
  renderHex(prog, selByte, progLineIdx >= 0 ? progLineIdx : null, labelHtml);
}

/**
 * Build the hex header HTML for the given merge-view column.  For col 1
 * (merged output) returns the simple "Merged" label.  For source columns
 * returns the "{filename} {prog-num-badge} {name}" format that matches the
 * basic-view column headers.
 */
function mergeHexHeaderHtml(merged: MergedProgram, col: 0 | 1 | 2): string {
  if (col === 1) return 'Merged';
  const userMerge = userMerges[activeProgIdx];
  if (!userMerge) return '';
  const slotIdx = col === 0 ? 0 : 1;
  const src  = userMerge.sources[slotIdx];
  const tape = tapes[src.tapeIdx];
  const base = tape ? shortName(tape.filename) : `Tape ${src.tapeIdx + 1}`;
  return progHeaderHtml(merged.sources[slotIdx], base, src.progIdx);
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
        `<span class="prog-num">${prog.progNumber}</span>` +
        `<span class="tap-item-name">${escHtml(prog.name || `Prog ${prog.progNumber}`)}</span>` +
        btn +
        `</div>`;
    });
  });

  if (userMerges.length > 0) {
    availHtml += `<div class="tap-group-head">Merged</div>`;
    userMerges.forEach((merge, mi) => {
      const key    = entryKey('merged', 0, mi);
      const inQ    = queued.has(key);
      const dimmed = inQ ? ' tap-item-dimmed' : '';
      const btn    = inQ ? '' : `<button class="tap-btn" data-add-kind="merged" data-add-ti="0" data-add-pi="${mi}">→</button>`;
      // Read program numbers from the merge's own snapshot so labels are
      // stable if source tabs are later closed.
      const pn0 = merge.result.sources[0]?.progNumber ?? merge.sources[0].progIdx + 1;
      const pn1 = merge.result.sources[1]?.progNumber ?? merge.sources[1].progIdx + 1;
      const label =
        `<span class="prog-num">${pn0}</span>` +
        `<span class="prog-num">${pn1}</span>Merged`;
      availHtml +=
        `<div class="tap-item${dimmed}">` +
        label +
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
      name = prog?.name || `Prog ${prog?.progNumber ?? entry.progIdx + 1}`;
      sub  = `Tape ${entry.tapeIdx + 1}`;
    } else {
      const um = userMerges[entry.progIdx];
      if (um) {
        // Read program numbers from the merge's own snapshot so labels are
        // stable if source tabs are later closed.
        const pn0 = um.result.sources[0]?.progNumber ?? um.sources[0].progIdx + 1;
        const pn1 = um.result.sources[1]?.progNumber ?? um.sources[1].progIdx + 1;
        name = `[${pn0}][${pn1}] Merged`;
      } else {
        name = 'Merged';
      }
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

  const includeMeta = tapMetaToggle.checked;
  const entries: TapEntry[] = [];

  for (const entry of tapQueue) {
    if (entry.kind === 'tape') {
      const prog = tapes[entry.tapeIdx]?.programs[entry.progIdx];
      if (!prog) continue;
      entries.push({
        prog,
        autorun:         entry.autorun,
        includeMetadata: includeMeta,
      });
    } else {
      const um = userMerges[entry.progIdx];
      if (!um) continue;
      const merged = um.result;
      // Serialize the merge's own pre-built byte-level output — a Program
      // like any other.  Independent of live source edits / tab closures.
      // Metadata (generated inside encodeTapFile) reflects merged.output's
      // error/edit state, including any fixEndAddr edits applied at save
      // time.  Using a source Program here would produce flags and
      // lineDeltas at offsets that don't match the merged content whenever
      // bestSource picked different sources for different lines.
      entries.push({
        prog:            merged.output,
        autorun:         entry.autorun,
        includeMetadata: includeMeta,
      });
    }
  }

  if (entries.length === 0) return;

  // Derive filename from the first entry's program name.
  const filename = `${entries[0].prog.name || 'tape'}.tap`;
  const bytes    = encodeTapFile(entries);
  downloadTap(bytes, filename);
  closeTapBuilder();
}

// ── Merge modal ───────────────────────────────────────────────────────────────

/** Items selected in the merge picker; at most 2. */
let mergePickerSelected: MergeSource[] = [];

mergeBtnEl.addEventListener('click', openMergeModal);
mergeCancelBtn.addEventListener('click', closeMergeModal);
mergeModal.addEventListener('click', (e) => {
  if (e.target === mergeModal) closeMergeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !mergeModal.hidden) closeMergeModal();
});

function openMergeModal(): void {
  mergePickerSelected = [];
  renderMergePicker();
  mergeModal.hidden = false;
}

function closeMergeModal(): void {
  mergeModal.hidden = true;
}

function renderMergePicker(): void {
  const selKeys = new Set(mergePickerSelected.map(s => `${s.tapeIdx}:${s.progIdx}`));
  let html = '';

  tapes.forEach((tape, ti) => {
    html += `<div class="tap-group-head">${escHtml(shortName(tape.filename))}</div>`;
    tape.programs.forEach((prog, pi) => {
      const key     = `${ti}:${pi}`;
      const checked = selKeys.has(key);
      html +=
        `<div class="merge-pick-item${checked ? ' merge-pick-sel' : ''}" ` +
        `data-pick-ti="${ti}" data-pick-pi="${pi}">` +
        `<span class="prog-num">${prog.progNumber}</span>` +
        `<span class="tap-item-name">${escHtml(prog.name || `Prog ${prog.progNumber}`)}</span>` +
        `</div>`;
    });
  });

  mergePickerEl.innerHTML = html;
  mergeOkBtn.disabled = mergePickerSelected.length !== 2;
}

mergePickerEl.addEventListener('click', (e) => {
  const item = (e.target as Element).closest<HTMLElement>('[data-pick-ti]');
  if (!item) return;
  const ti  = +(item.dataset.pickTi ?? '0');
  const pi  = +(item.dataset.pickPi ?? '0');
  const idx = mergePickerSelected.findIndex(s => s.tapeIdx === ti && s.progIdx === pi);
  if (idx >= 0) {
    mergePickerSelected.splice(idx, 1); // deselect
  } else if (mergePickerSelected.length < 2) {
    mergePickerSelected.push({ tapeIdx: ti, progIdx: pi });
  }
  renderMergePicker();
});

mergeOkBtn.addEventListener('click', () => {
  if (mergePickerSelected.length !== 2) return;
  const sources: [MergeSource, MergeSource] = [mergePickerSelected[0], mergePickerSelected[1]];
  // Build progs array by slot index (0, 1) so that two programs from the same
  // tape are kept as distinct entries.  LineSource.tapeIdx values in the result
  // are slot indices, not actual tape indices.
  const progs = sources.map(src => tapes[src.tapeIdx]?.programs[src.progIdx]);
  const result = alignPrograms(progs);
  userMerges.push({ sources, result });

  closeMergeModal();
  // Navigate to the new merged tab.
  viewMode      = 'merged';
  activeProgIdx = userMerges.length - 1;
  selMergeLine  = null;
  renderAll();
});

// ── Selection (event delegation) ──────────────────────────────────────────────

hexPanelOuter.addEventListener('focus', () => { focusedPanel = 'hex'; });
hexPanel.addEventListener('click', (e) => {
  focusedPanel = 'hex';
  const el = (e.target as Element).closest<HTMLElement>('[data-i]');
  if (!el) return;
  const byteIdx = +el.dataset.i!;
  if (viewMode === 'tape') {
    if (byteIdx === selByte) {
      // Already selected — toggle between 100% and 400% byte-level zoom.
      waveform.zoomTo(waveform.getZoomFactor() >= 4 ? 1 : 4);
    } else {
      selectByte(byteIdx);
    }
  } else {
    // Merge mode: the byte index refers to whichever column's Program is
    // currently shown.  Default to the merged-output column (1) when no
    // column is selected yet.
    selectMergeByteAt((selMergeCol ?? 1) as 0 | 1 | 2, byteIdx);
  }
});
hexPanel.addEventListener('dblclick', (e) => {
  const el = (e.target as Element).closest<HTMLElement>('[data-i]');
  if (!el) return;
  const byteIdx = +el.dataset.i!;
  if (viewMode === 'tape') {
    if (byteIdx !== selByte) selectByte(byteIdx);
    // Double-click always zooms to 400%.
    waveform.zoomTo(4);
  } else {
    selectMergeByteAt((selMergeCol ?? 1) as 0 | 1 | 2, byteIdx);
  }
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
    const rowEl  = (e.target as Element).closest<HTMLElement>('[data-mli]');
    if (!rowEl) return;
    const mli    = +rowEl.dataset.mli!;
    const colEl  = (e.target as Element).closest<HTMLElement>('[data-col]');
    const elemEl = (e.target as Element).closest<HTMLElement>('[data-ei]');
    if (colEl && elemEl) {
      selectMergeElem(mli, +colEl.dataset.col! as 0 | 1 | 2, +elemEl.dataset.ei!);
    } else {
      // Click on row but not on a specific element — select row only.
      selMergeLine = mli;
      selMergeCol  = null;
      selMergeElem = null;
      basicPanel.querySelector('.merge-row.sel')?.classList.remove('sel');
      basicPanel.querySelector('.elem.sel')?.classList.remove('sel');
      rowEl.classList.add('sel');
      rowEl.scrollIntoView({ block: 'nearest' });
      const merged = userMerges[activeProgIdx]?.result;
      if (merged) renderMergedHex(merged);
      updateStatusBar();
    }
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

  // Don't navigate the waveform for edited bytes (no waveform backing).
  const byte = prog?.bytes[i];
  if (byte?.edited) {
    waveform.selectByte(null);
  } else {
    waveform.selectByte(i);
  }
  updateStatusBar();
}

/**
 * Select a specific element in the merged basic view.
 * Updates state, DOM selection classes, hex panel, and status bar.  Also
 * computes the corresponding byte in the column's Program and stores it in
 * selByte so the hex panel (which follows selMergeCol) can highlight it
 * with byte-level precision.
 */
function selectMergeElem(mli: number, col: 0 | 1 | 2, ei: number): void {
  selMergeLine = mli;
  selMergeCol  = col;
  selMergeElem = ei;

  // Update row highlight.
  basicPanel.querySelector('.merge-row.sel')?.classList.remove('sel');
  const rowEl = basicPanel.querySelector<HTMLElement>(`[data-mli="${mli}"]`);
  rowEl?.classList.add('sel');

  // Update element highlight.
  basicPanel.querySelector('.elem.sel')?.classList.remove('sel');
  const elemEl = rowEl?.querySelector<HTMLElement>(`[data-col="${col}"] [data-ei="${ei}"]`);
  elemEl?.classList.add('sel');
  rowEl?.scrollIntoView({ block: 'nearest' });

  // Compute selByte in the context of the column's Program (the one the hex
  // panel is about to render).  Each column maps to its own Program with its
  // own line byte layout; selByte must index into that Program's bytes.
  const merged = userMerges[activeProgIdx]?.result;
  if (merged) {
    const prog        = hexViewProgram(merged, col);
    const progLineIdx = progLineIdxForCol(merged, mli, col);
    if (prog && progLineIdx >= 0) {
      const progLine = prog.lines[progLineIdx];
      // Clamp ei to this Program's element count — source columns can have
      // fewer elements than the output when content differs between sources.
      const safeEi = Math.min(ei, progLine.elements.length - 1);
      selByte = byteForElem(progLine, Math.max(0, safeEi));
    } else {
      selByte = null;
    }
    renderMergedHex(merged);
  }

  updateStatusBar();
}

/**
 * Select a byte in the currently-displayed merge hex panel (called from hex
 * click or keyboard navigation in the merge view).  `col` identifies which
 * column's Program the byte index refers to — the click handler and cursor
 * keys pass the current selMergeCol so the byte resolves against the right
 * Program.
 *
 * Updates merge-specific selection state (selMergeLine/Col/Elem) and selByte.
 * Omits waveform interaction (merges have no single-tape waveform backing).
 */
function selectMergeByteAt(col: 0 | 1 | 2, byteIdx: number): void {
  const merged = userMerges[activeProgIdx]?.result;
  if (!merged) return;
  const prog = hexViewProgram(merged, col);
  if (!prog) return;

  selByte     = byteIdx;
  selMergeCol = col;

  // Find which line (if any) in the column's Program contains this byte.
  // Bytes in sync/header/name/end-marker don't belong to any line — clear
  // the merge element selection in that case.
  const progLineIdx = prog.lines.findIndex(l => byteIdx >= l.firstByte && byteIdx <= l.lastByte);
  if (progLineIdx >= 0) {
    const mli = mliForProgLineIdx(merged, col, progLineIdx);
    const ei  = elemIdxForByte(prog.lines[progLineIdx], byteIdx);
    selMergeLine = mli >= 0 ? mli : null;
    selMergeElem = ei >= 0 ? ei : null;
  } else {
    selMergeLine = null;
    selMergeElem = null;
  }

  // Re-render both panels so basic-view highlight tracks the selection.
  renderMergeView(merged);
  renderMergedHex(merged);
  updateStatusBar();
}

// ── Merged-view navigation helpers ───────────────────────────────────────────

/** Return the {prog, lineIdx} backing column col of merged row mli, or null.
 *  col 0 = left tape, col 1 = best-source (middle), col 2 = right tape. */
function mergeColSource(col: 0|1|2, mli: number): { prog: Program; lineIdx: number } | null {
  const um = userMerges[activeProgIdx];
  if (!um) return null;
  const merged = um.result;
  const line = merged.lines[mli];
  if (!line) return null;
  const ti0 = 0;   // slot index for left column
  const ti1 = 1;   // slot index for right column
  let src: { tapeIdx: number; lineIdx: number } | undefined;
  if      (col === 0) src = line.sources.find(s => s.tapeIdx === ti0);
  else if (col === 2) src = line.sources.find(s => s.tapeIdx === ti1);
  else if (line.rejected) return null;  // rejected lines have no merged content
  else                src = bestSource(merged, line);
  if (!src) return null;
  const prog = merged.sources[src.tapeIdx];
  return prog ? { prog, lineIdx: src.lineIdx } : null;
}

/** True if element ei in column col of merged line mli has a visible error highlight. */
function mergeColElemHasError(col: 0|1|2, mli: number, ei: number): boolean {
  const s = mergeColSource(col, mli);
  if (!s) return false;
  const line = s.prog.lines[s.lineIdx];
  return line.elementErrors?.[ei] != null;
}

/**
 * Keyboard navigation for the merged basic view.
 * Stays locked to the currently-selected column (defaulting to the middle).
 * Arrow keys move element by element / line by line.
 * Alt+Arrow keys jump between elements or lines that have errors/issues.
 */
function navigateMerge(key: string, alt: boolean): void {
  const um = userMerges[activeProgIdx];
  if (!um || !um.result.lines.length) return;
  const merged = um.result;
  const nLines = merged.lines.length;

  const col: 0|1|2 = selMergeCol ?? 1;  // default to middle column
  const curMli     = selMergeLine ?? -1;
  const curEi      = selMergeElem ?? -1;

  if (!alt) {
    switch (key) {
      case 'ArrowUp':
      case 'ArrowDown': {
        // Visual navigation: query only elements within the locked column.
        const up = key === 'ArrowUp';
        const allElems = Array.from(
          basicPanel.querySelectorAll<HTMLElement>(`[data-col="${col}"] [data-ei]`),
        );
        if (!allElems.length) break;

        // Reference point: selected element span if any, else first elem of selected row.
        const refEl: HTMLElement | null =
          basicPanel.querySelector<HTMLElement>(`[data-col="${col}"] .elem.sel`) ??
          (selMergeLine !== null
            ? basicPanel.querySelector<HTMLElement>(
                `[data-mli="${selMergeLine}"] [data-col="${col}"] [data-ei]`)
            : null);

        if (!refEl) {
          const target = up ? allElems[allElems.length - 1] : allElems[0];
          const rowEl  = target.closest<HTMLElement>('[data-mli]')!;
          selectMergeElem(+rowEl.dataset.mli!, col, +target.dataset.ei!);
          break;
        }

        const refRect   = refEl.getBoundingClientRect();
        const elemRects = allElems.map(el => el.getBoundingClientRect());

        // Pass 1: nearest visual row above/below.
        let targetRowTop = up ? -Infinity : Infinity;
        for (const r of elemRects) {
          if (up  && r.bottom <= refRect.top    + 0.5 && r.top > targetRowTop) targetRowTop = r.top;
          if (!up && r.top   >= refRect.bottom  - 0.5 && r.top < targetRowTop) targetRowTop = r.top;
        }
        if (!isFinite(targetRowTop)) break; // already at first/last visual row

        // Pass 2: element closest in x on that row.
        let bestEl: HTMLElement | null = null;
        let bestDist = Infinity;
        for (let i = 0; i < allElems.length; i++) {
          if (Math.abs(elemRects[i].top - targetRowTop) < 3) {
            const dist = Math.abs(elemRects[i].left - refRect.left);
            if (dist < bestDist) { bestDist = dist; bestEl = allElems[i]; }
          }
        }
        if (!bestEl) break;

        const rowEl = bestEl.closest<HTMLElement>('[data-mli]')!;
        selectMergeElem(+rowEl.dataset.mli!, col, +bestEl.dataset.ei!);
        break;
      }

      case 'ArrowLeft': {
        if (curMli < 0) {
          const s = mergeColSource(col, 0);
          if (s) selectMergeElem(0, col, 0);
          break;
        }
        const src = mergeColSource(col, curMli);
        if (!src) break;
        if (curEi < 0) {
          // No element selected yet — snap to start of line.
          selectMergeElem(curMli, col, 0);
          break;
        }
        if (curEi > 0) {
          selectMergeElem(curMli, col, curEi - 1);
        } else {
          // Cross to the last element of the previous line in this column.
          for (let mli = curMli - 1; mli >= 0; mli--) {
            const ps = mergeColSource(col, mli);
            if (ps) {
              selectMergeElem(mli, col, ps.prog.lines[ps.lineIdx].elements.length - 1);
              break;
            }
          }
        }
        break;
      }

      case 'ArrowRight': {
        if (curMli < 0) {
          const s = mergeColSource(col, 0);
          if (s) selectMergeElem(0, col, 0);
          break;
        }
        const src = mergeColSource(col, curMli);
        if (!src) break;
        if (curEi < 0) {
          // No element selected yet — snap to start of line.
          selectMergeElem(curMli, col, 0);
          break;
        }
        const line = src.prog.lines[src.lineIdx];
        if (curEi < line.elements.length - 1) {
          selectMergeElem(curMli, col, curEi + 1);
        } else {
          // Cross to the first element of the next line in this column.
          for (let mli = curMli + 1; mli < nLines; mli++) {
            const ns = mergeColSource(col, mli);
            if (ns) { selectMergeElem(mli, col, 0); break; }
          }
        }
        break;
      }
    }
    return;
  }

  // Alt+Up/Down — jump to the next/prev merged line with 'issue' quality,
  // landing on the first error element (or element 0 if none visible).
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const step  = key === 'ArrowUp' ? -1 : 1;
    const start = curMli < 0 ? (step < 0 ? nLines : -1) : curMli;
    for (let mli = start + step; mli >= 0 && mli < nLines; mli += step) {
      if (col === 1 && merged.lines[mli].rejected) continue;  // skip rejected lines in merged column
      const src = mergeColSource(col, mli);
      if (!src) continue; // skip lines where this column has no source
      // For the merged column, only stop at issue lines. For source columns,
      // stop at any line that has errors in that column's source.
      if (col === 1) {
        if (merged.lines[mli].quality !== 'issue') continue;
      } else {
        if (isLineClean(src.prog, src.lineIdx)) continue;
      }
      const landLine = src.prog.lines[src.lineIdx];
      let landed = false;
      for (let ei = 0; ei < landLine.elements.length; ei++) {
        if (mergeColElemHasError(col, mli, ei)) {
          selectMergeElem(mli, col, ei);
          landed = true;
          break;
        }
      }
      if (!landed) selectMergeElem(mli, col, 0);
      return;
    }
    // No issue line found — end-of-search feedback: jump to first/last line.
    const edgeMli = step < 0 ? 0 : nLines - 1;
    const edgeSrc = mergeColSource(col, edgeMli);
    if (edgeSrc) {
      const el = edgeSrc.prog.lines[edgeSrc.lineIdx];
      selectMergeElem(edgeMli, col, step < 0 ? 0 : el.elements.length - 1);
    }
    return;
  }

  // Alt+Left/Right — scan elements for errors, crossing line boundaries.
  if (curMli < 0) return;
  const step = key === 'ArrowLeft' ? -1 : 1;

  // Current line: start from element adjacent to current position.
  const curSrc = mergeColSource(col, curMli);
  if (curSrc) {
    const curLine = curSrc.prog.lines[curSrc.lineIdx];
    const eiStart = curEi < 0
      ? (step < 0 ? curLine.elements.length - 1 : 0)
      : curEi + step;
    for (let ei = eiStart; ei >= 0 && ei < curLine.elements.length; ei += step) {
      if (mergeColElemHasError(col, curMli, ei)) { selectMergeElem(curMli, col, ei); return; }
    }
  }

  // Remaining lines.
  for (let mli = curMli + step; mli >= 0 && mli < nLines; mli += step) {
    const src = mergeColSource(col, mli);
    if (!src) continue;
    const line    = src.prog.lines[src.lineIdx];
    const eiStart = step < 0 ? line.elements.length - 1 : 0;
    for (let ei = eiStart; ei >= 0 && ei < line.elements.length; ei += step) {
      if (mergeColElemHasError(col, mli, ei)) { selectMergeElem(mli, col, ei); return; }
    }
  }
  // No error element found — end-of-search feedback: jump to first/last element.
  const edgeMli = step < 0 ? 0 : nLines - 1;
  const edgeSrc = mergeColSource(col, edgeMli);
  if (edgeSrc) {
    const el = edgeSrc.prog.lines[edgeSrc.lineIdx];
    selectMergeElem(edgeMli, col, step < 0 ? 0 : el.elements.length - 1);
  }
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

function isExplicitEditByte(b: ByteInfo): boolean {
  return b.edited === 'explicit';
}

function lineHasError(prog: Program, li: number): boolean {
  return lineHealth(prog, li) !== 'clean';
}

function lineHasExplicitEdit(prog: Program, li: number): boolean {
  const line = prog.lines[li];
  for (let i = line.firstByte; i <= line.lastByte; i++) {
    if (prog.bytes[i]?.edited === 'explicit') return true;
  }
  return false;
}

/** Number of bytes per visual row in the current hex grid, measured by
 *  Y-position rather than width arithmetic.  Counting cells whose top
 *  matches the first cell's top avoids off-by-one errors from padding /
 *  subpixel rounding that width-based calculation is prone to. */
function hexBytesPerRow(): number {
  const cells = hexPanel.querySelectorAll<HTMLElement>('.hb');
  if (!cells.length) return 16;
  const firstRowY = cells[0].getBoundingClientRect().top;
  for (let i = 1; i < cells.length; i++) {
    if (cells[i].getBoundingClientRect().top > firstRowY + 0.5) return i;
  }
  return cells.length;
}

/**
 * Keyboard navigation for the hex panel.  `select` is the byte-selection
 * callback — selectByte for tape mode, selectMergeByteAt for merge mode.
 * This keeps the navigation logic mode-agnostic.
 */
function navigateHex(key: string, shift: boolean, prog: Program, select: (i: number) => void): void {
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
    select(next[key] ?? cur);
    return;
  }

  // Alt+Left/Right — scan linearly for next error/warning/edited byte.
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const step = key === 'ArrowLeft' ? -1 : 1;
    for (let i = cur + step; i >= 0 && i < n; i += step) {
      const b = prog.bytes[i];
      if (isErrByte(b) || isExplicitEditByte(b)) { select(i); return; }
    }
    // No match found — go to the start or end of the file as end-of-search feedback.
    select(step < 0 ? 0 : n - 1);
    return;
  }

  // Alt+Up/Down — jump to the first error/edited byte of the next/prev row
  // that contains one.  Column position is intentionally not preserved in
  // this first iteration but the row-walking structure makes it easy to add
  // later.
  const bpr  = hexBytesPerRow();
  const step = key === 'ArrowUp' ? -1 : 1;
  let row = Math.floor(cur / bpr) + step;
  while (row >= 0 && row * bpr < n) {
    const rowStart = row * bpr;
    const rowEnd   = Math.min(rowStart + bpr - 1, n - 1);
    for (let b = rowStart; b <= rowEnd; b++) {
      const by = prog.bytes[b];
      if (isErrByte(by) || isExplicitEditByte(by)) { select(b); return; }
    }
    row += step;
  }
  // No matching row found — go to the start or end of the file as end-of-search feedback.
  select(step < 0 ? 0 : n - 1);
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

  // Shift+Up/Down — jump to the next/prev BASIC line that contains any
  // error or edit, landing on the first error/edit element in that line.
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const step  = key === 'ArrowUp' ? -1 : 1;
    const start = li < 0 ? (step < 0 ? lines.length : -1) : li;
    for (let i = start + step; i >= 0 && i < lines.length; i += step) {
      if (!lineHasError(prog, i) && !lineHasExplicitEdit(prog, i)) continue;
      const line = lines[i];
      // Prefer the first element that has a visibly-highlighted error or edit
      // (the corruption / change site).  Only fall back to element 0 when the
      // issue is purely line-level (lenErr / checksum mismatch with no bad or
      // edited element bytes), since in that case there is no more specific
      // location to point at.
      let landed = false;
      for (let ei = 0; ei < line.elements.length; ei++) {
        if (line.elementErrors?.[ei] || elementEditStatus(prog, line, ei) === 'explicit') {
          selectByte(byteForElem(line, ei));
          landed = true;
          break;
        }
      }
      if (!landed) selectByte(byteForElem(line, 0));
      return;
    }
    // No matching line found — go to the first/last element as end-of-search feedback.
    const edge = step < 0 ? lines[0] : lines[lines.length - 1];
    selectByte(byteForElem(edge, step < 0 ? 0 : edge.elements.length - 1));
    return;
  }

  // Alt+Left/Right — scan visible elements for the next/prev error or edit,
  // crossing line boundaries when needed.
  if (li < 0 || selByte === null) return;
  const step = key === 'ArrowLeft' ? -1 : 1;

  // Current line: start from element adjacent to current position.
  const curLine = lines[li];
  const curEi   = elemForByte(curLine, selByte);
  const curStart = curEi < 0
    ? (step < 0 ? curLine.elements.length - 1 : 0)
    : curEi + step;
  for (let ei = curStart; ei >= 0 && ei < curLine.elements.length; ei += step) {
    if (curLine.elementErrors?.[ei] || elementEditStatus(prog, curLine, ei) === 'explicit') {
      selectByte(byteForElem(curLine, ei));
      return;
    }
  }

  // Remaining lines.
  for (let lj = li + step; lj >= 0 && lj < lines.length; lj += step) {
    const l     = lines[lj];
    const start = step < 0 ? l.elements.length - 1 : 0;
    for (let ei = start; ei >= 0 && ei < l.elements.length; ei += step) {
      if (l.elementErrors?.[ei] || elementEditStatus(prog, l, ei) === 'explicit') {
        selectByte(byteForElem(l, ei));
        return;
      }
    }
  }
  // No matching element found — go to the first/last element as end-of-search feedback.
  const edge = step < 0 ? lines[0] : lines[lines.length - 1];
  selectByte(byteForElem(edge, step < 0 ? 0 : edge.elements.length - 1));
}

const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

document.addEventListener('keydown', (e: KeyboardEvent) => {
  // Don't let any keys fire while the edit input or search input has focus — they handle their own keys.
  if (editInput && document.activeElement === editInput) return;
  if (document.activeElement === searchInput) return;

  // Cmd/Ctrl+F: open search bar (tape view only).
  if (e.key === 'f' && (e.metaKey || e.ctrlKey)) {
    if (viewMode === 'tape' && programs[activeProgIdx]) {
      e.preventDefault();
      openSearch();
    }
    return;
  }

  // Shift+Escape: restore selected line to original bytes (tape view only).
  if (e.key === 'Escape' && e.shiftKey && viewMode === 'tape' && focusedPanel === 'basic' && selByte !== null) {
    const prog = programs[activeProgIdx];
    if (prog) {
      const li = prog.lines.findIndex(l => selByte! >= l.firstByte && selByte! <= l.lastByte);
      if (li >= 0) {
        e.preventDefault();
        restoreLineToOriginalBytes(prog, li);
        renderHex(prog, selByte);
        renderBasic(prog);
        selectByte(byteForElem(prog.lines[li], 0));
      }
    }
    return;
  }

  // Enter: enter edit mode on the selected line, cursor at end of selected element (tape view only).
  // Ctrl/Cmd+Enter: mark the selected line's errors as ignored (tape view only).
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.shiftKey && viewMode === 'tape' && focusedPanel === 'basic' && selByte !== null) {
    const prog = programs[activeProgIdx];
    if (prog) {
      const li = prog.lines.findIndex(l => selByte! >= l.firstByte && selByte! <= l.lastByte);
      if (li >= 0) {
        e.preventDefault();
        prog.lines[li].ignoreErrors = true;
        renderBasic(prog);
      }
    }
    return;
  }

  // Enter: enter edit mode on the selected line, cursor at end of selected element (tape view only).
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && viewMode === 'tape' && focusedPanel === 'basic' && selByte !== null) {
    const prog = programs[activeProgIdx];
    if (prog) {
      const li = prog.lines.findIndex(l => selByte! >= l.firstByte && selByte! <= l.lastByte);
      if (li >= 0) {
        e.preventDefault();
        const ei = elemIdxForByte(prog.lines[li], selByte!);
        enterEditMode(li, ei >= 0 ? ei : undefined);
      }
    }
    return;
  }

  // Shift+Enter: split the line before the selected element (tape view only).
  if (e.key === 'Enter' && e.shiftKey && viewMode === 'tape' && focusedPanel === 'basic' && selByte !== null) {
    const prog = programs[activeProgIdx];
    if (prog) {
      const li = prog.lines.findIndex(l => selByte! >= l.firstByte && selByte! <= l.lastByte);
      if (li >= 0) {
        e.preventDefault();
        const line = prog.lines[li];
        const ei = elemIdxForByte(line, selByte!);
        // Split at the start of the selected element.
        const lineText = line.elements.join('');
        let charStart = 0;
        if (ei >= 0) {
          for (let i = 0; i < ei; i++) charStart += line.elements[i].length;
        }
        const textBefore = lineText.slice(0, charStart);
        const textAfter = lineText.slice(charStart);
        const newLineIdx = splitLineWithEdits(prog, li, textBefore, textAfter);
        renderHex(prog, selByte);
        if (selByte !== null && prog.bytes[selByte]?.edited) {
          waveform.selectByte(null);
        }
        renderBasic(prog);
        // Enter edit mode on the new second line.
        if (newLineIdx !== null) {
          enterEditMode(newLineIdx);
          if (editInput) {
            const eta = editInput as HTMLTextAreaElement;
            eta.value = textAfter;
            eta.selectionStart = eta.selectionEnd = 0;
          }
        }
      }
    }
    return;
  }

  // HEX panel: Shift+Enter — split the current program into two at the
  // selected byte.  The selected byte becomes the first byte of the new
  // second program (matches the BASIC-panel split-line model).  Both
  // halves get fresh progNumbers to cleanly disambiguate them from any
  // older references (e.g. in merge-source labels).  After the split,
  // focus moves to the new second program with the cursor at byte 0.
  if (e.key === 'Enter' && e.shiftKey
      && viewMode === 'tape' && focusedPanel === 'hex' && selByte !== null) {
    const prog = programs[activeProgIdx];
    if (prog && selByte > 0 && selByte < prog.bytes.length) {
      e.preventDefault();
      const pi    = activeProgIdx;
      const name  = prog.name || `Prog ${prog.progNumber}`;
      const warn  = programHasExplicitEdits(prog) ? confirmDangerBanner() : '';
      confirmAction(
        warn +
        `Split program <span class="prog-num">${prog.progNumber}</span>${escHtml(name)} ` +
        `into two parts at the selected byte?<br><br>` +
        `Any edits to this program will be lost.`,
      ).then((ok) => {
        if (!ok) return;
        const [first, second] = splitProgram(prog, selByte!);
        first.progNumber  = nextProgNumber++;
        second.progNumber = nextProgNumber++;
        tapes[activeTapeIdx].programs.splice(pi, 1, first, second);
        activeProgIdx = pi + 1;
        selByte       = 0;
        renderAll();
      });
    }
    return;
  }

  // HEX panel: Backspace at byte 0 — join this program with the previous
  // one in the same tape.  The joined program gets a fresh progNumber.
  // Cursor lands on the byte that was previously the first byte of the
  // current (absorbed) program — i.e. offset by the previous program's
  // length in the joined byte stream.
  if (e.key === 'Backspace' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey
      && viewMode === 'tape' && focusedPanel === 'hex' && selByte === 0
      && activeProgIdx > 0) {
    const prog = programs[activeProgIdx];
    const prev = programs[activeProgIdx - 1];
    if (prog && prev) {
      e.preventDefault();
      const pi       = activeProgIdx;
      const prevLen  = prev.bytes.length;
      const prevName = prev.name || `Prog ${prev.progNumber}`;
      const currName = prog.name || `Prog ${prog.progNumber}`;
      const warn     = (programHasExplicitEdits(prev) || programHasExplicitEdits(prog))
                         ? confirmDangerBanner() : '';
      confirmAction(
        warn +
        `Join program <span class="prog-num">${prev.progNumber}</span>${escHtml(prevName)} ` +
        `with program <span class="prog-num">${prog.progNumber}</span>${escHtml(currName)}?` +
        `<br><br>Any edits to either program will be lost.`,
      ).then((ok) => {
        if (!ok) return;
        const joined = joinPrograms([prev, prog]);
        joined.progNumber = nextProgNumber++;
        tapes[activeTapeIdx].programs.splice(pi - 1, 2, joined);
        activeProgIdx = pi - 1;
        selByte       = prevLen;
        renderAll();
      });
    }
    return;
  }

  // HEX panel: Delete at the last byte — join this program with the next
  // one in the same tape.  Same progNumber / confirm model as Backspace
  // above.  Cursor position is unchanged (same byte offset still valid
  // in the joined program).
  if (e.key === 'Delete' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey
      && viewMode === 'tape' && focusedPanel === 'hex' && selByte !== null) {
    const prog = programs[activeProgIdx];
    const next = programs[activeProgIdx + 1];
    if (prog && next && selByte === prog.bytes.length - 1) {
      e.preventDefault();
      const pi          = activeProgIdx;
      const savedSelByte = selByte;
      const currName    = prog.name || `Prog ${prog.progNumber}`;
      const nextName    = next.name || `Prog ${next.progNumber}`;
      const warn        = (programHasExplicitEdits(prog) || programHasExplicitEdits(next))
                            ? confirmDangerBanner() : '';
      confirmAction(
        warn +
        `Join program <span class="prog-num">${prog.progNumber}</span>${escHtml(currName)} ` +
        `with program <span class="prog-num">${next.progNumber}</span>${escHtml(nextName)}?` +
        `<br><br>Any edits to either program will be lost.`,
      ).then((ok) => {
        if (!ok) return;
        const joined = joinPrograms([prog, next]);
        joined.progNumber = nextProgNumber++;
        tapes[activeTapeIdx].programs.splice(pi, 2, joined);
        selByte = savedSelByte;
        renderAll();
      });
      return;
    }
    // Fall through: Delete not at end-of-program is not a hex-panel
    // action — let it reach the trailing NAV_KEYS gate which no-ops
    // for non-nav keys.
  }

  // Delete (non-edit mode): delete forward from the selected element.
  if (e.key === 'Delete' && !e.metaKey && !e.ctrlKey && !e.altKey
      && viewMode === 'tape' && focusedPanel === 'basic' && selByte !== null) {
    const prog2 = programs[activeProgIdx];
    if (prog2) {
      const li2 = prog2.lines.findIndex(l => selByte! >= l.firstByte && selByte! <= l.lastByte);
      if (li2 >= 0) {
        const line2 = prog2.lines[li2];
        const ei2 = elemIdxForByte(line2, selByte!);
        if (ei2 >= line2.elements.length - 1 && li2 < prog2.lines.length - 1) {
          // Last element on the line: join with next line.
          e.preventDefault();
          joinLinesWithEdit(prog2, li2, undefined, 1);
          renderHex(prog2, selByte);
          renderBasic(prog2);
          selectByte(byteForElem(prog2.lines[li2], ei2));
        } else if (ei2 >= 0 && ei2 < line2.elements.length - 1) {
          // Not last element: enter edit mode, deleting the next element.
          e.preventDefault();
          enterEditMode(li2, ei2 + 1, '');
        }
        return;
      }
    }
  }

  // Printable character or Delete: start editing the selected BASIC line,
  // replacing the selected element (tape view, BASIC panel focused).
  if ((e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete')
      && !e.metaKey && !e.ctrlKey && !e.altKey
      && viewMode === 'tape' && focusedPanel === 'basic' && selByte !== null) {
    const prog2 = programs[activeProgIdx];
    if (prog2) {
      const li2 = prog2.lines.findIndex(l => selByte! >= l.firstByte && selByte! <= l.lastByte);
      if (li2 >= 0) {
        const ei2 = elemIdxForByte(prog2.lines[li2], selByte!);
        e.preventDefault();
        const insertChar = e.key.length === 1 ? e.key : '';  // Delete/Backspace = remove element
        enterEditMode(li2, ei2 >= 0 ? ei2 : undefined, insertChar);
        return;
      }
    }
  }

  if (!NAV_KEYS.has(e.key)) return;
  if (viewMode === 'merged') {
    if (focusedPanel === 'basic') { e.preventDefault(); navigateMerge(e.key, e.altKey); return; }
    if (focusedPanel === 'hex') {
      const merged = userMerges[activeProgIdx]?.result;
      if (merged) {
        const col  = (selMergeCol ?? 1) as 0 | 1 | 2;
        const prog = hexViewProgram(merged, col);
        if (prog) {
          e.preventDefault();
          navigateHex(e.key, e.altKey, prog, (byteIdx) => selectMergeByteAt(col, byteIdx));
        }
      }
    }
    return;
  }
  if (viewMode !== 'tape') return;
  const prog = programs[activeProgIdx];
  if (!prog) return;
  if (focusedPanel === 'hex') {
    e.preventDefault();
    navigateHex(e.key, e.altKey, prog, selectByte);
  } else if (focusedPanel === 'basic') {
    e.preventDefault();
    navigateBasic(e.key, e.altKey, prog);
  }
});

// ── Status bar ────────────────────────────────────────────────────────────────

/**
 * For a byte that falls outside a BASIC line (preamble, header, or after the
 * last line), return a human-readable description of what it represents.
 *
 * Layout of prog.bytes[], working backwards from prog.lines[0].firstByte (F):
 *   F-1            : name null terminator
 *   F-1-nameLen .. F-2 : name characters  (absent when name is empty)
 *   F-1-nameLen-9 .. F-1-nameLen-1 : 9-byte header (header[0]…[8])
 *   F-1-nameLen-10 : 0x24 sync marker
 *   0 .. F-1-nameLen-11 : 0x16 sync bytes
 */
/**
 * Return the Oric memory address of a byte within BASIC content as "$NNNN",
 * or null for preamble bytes (which precede the loaded address range).
 * Address = start_address_from_header + (byteIdx - firstContentByte).
 */
function progByteAddr(prog: Program, byteIdx: number): string | null {
  const lines = prog.lines;
  if (!lines.length) return null;
  if (byteIdx < lines[0].firstByte) return null; // preamble — no address

  // Find the line that contains this byte, or fall back to the last line for
  // bytes beyond the last parsed line (e.g. orphaned post-program bytes).
  // Use lineFirstAddr (derived from the chain of next-line pointers) so the
  // address stays correct even when the byte stream has gained or lost bytes
  // due to corruption.
  let lineIdx = lines.findIndex(l => byteIdx >= l.firstByte && byteIdx <= l.lastByte);
  if (lineIdx === -1) lineIdx = lines.length - 1;
  const line = lines[lineIdx];
  const addr = lineFirstAddr(prog, lineIdx) + (byteIdx - line.firstByte);
  return '$' + (addr & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
}

function describeProgRegion(prog: Program, byteIdx: number): string {
  const lines     = prog.lines;
  const lastLine  = lines[lines.length - 1];

  // After the last parsed BASIC line.
  if (lastLine && byteIdx > lastLine.lastByte) {
    const extra = byteIdx - lastLine.lastByte;
    return `After program data · byte +${extra}`;
  }

  // Preamble — need firstByte to locate fields.
  const firstByte = lines[0]?.firstByte;
  if (firstByte === undefined) return 'Preamble';

  const nameLen     = prog.name.length;
  const nameTermIdx = firstByte - 1;
  const nameStart   = firstByte - 1 - nameLen;   // first name char (= nameTermIdx when empty)
  const h0          = firstByte - 1 - nameLen - 9; // header[0]
  const syncMarker  = h0 - 1;                      // 0x24

  if (byteIdx === nameTermIdx && nameLen === 0) return 'Header · name: (empty)';
  if (byteIdx === nameTermIdx)                  return 'Header · name terminator';
  if (nameLen > 0 && byteIdx >= nameStart && byteIdx < nameTermIdx)
    return `Header · name: "${escHtml(prog.name)}"`;

  const ho = byteIdx - h0;
  if (ho >= 0 && ho <= 8) {
    const b      = prog.bytes;
    const endHi  = b[h0 + 4]?.v ?? 0;
    const endLo  = b[h0 + 5]?.v ?? 0;
    const staHi  = b[h0 + 6]?.v ?? 0;
    const staLo  = b[h0 + 7]?.v ?? 0;
    const endAddr = (endHi << 8) | endLo;
    const staAddr = (staHi << 8) | staLo;
    const dataLen = endAddr - staAddr; // endAddr is exclusive
    const hex4    = (n: number) => '$' + n.toString(16).toUpperCase().padStart(4, '0');

    switch (ho) {
      case 0: case 1: case 8: return 'Header · reserved';
      case 2: {
        const v = b[byteIdx]?.v ?? 0;
        const s = v === 0x00 ? 'BASIC' : v === 0x80 ? 'machine code'
                : `0x${v.toString(16).toUpperCase().padStart(2, '0')}`;
        return `Header · type: ${s}`;
      }
      case 3: {
        const v = b[byteIdx]?.v ?? 0;
        const s = v === 0x00 ? 'off' : v === 0x80 ? 'on (BASIC)' : v === 0xC7 ? 'on (machine code)'
                : `0x${v.toString(16).toUpperCase().padStart(2, '0')}`;
        return `Header · autorun: ${s}`;
      }
      case 4: return `Header · end address (hi) · ${hex4(endAddr)}`;
      case 5: return `Header · end address (lo) · ${hex4(endAddr)}`;
      case 6: return `Header · start address (hi) · ${hex4(staAddr)} · data length: ${dataLen} bytes`;
      case 7: return `Header · start address (lo) · ${hex4(staAddr)} · data length: ${dataLen} bytes`;
    }
  }

  if (byteIdx === syncMarker) return 'Sync marker (0x24)';
  return 'Sync preamble (0x16)';
}

function updateStatusBar(): void {
  if (viewMode === 'merged') {
    updateMergedStatusBar();
    return;
  }

  if (editingLine !== null) {
    statusBar.innerHTML = '<span class="sb-dim">Enter to save · Esc to cancel · Ctrl+Enter to ignore errors · Shift+Esc to restore original bytes</span>';
    return;
  }

  const prog = programs[activeProgIdx];
  if (selByte === null || !prog) {
    // Show program identifier matching compareTaps naming convention.
    const tape = tapes[activeTapeIdx];
    if (prog && tape) {
      const refByteIdx  = prog.lines.length > 0 ? prog.lines[0].firstByte : 0;
      const refBit      = prog.bytes[refByteIdx]?.firstBit ?? 0;
      const refSample   = prog.stream.bitFirstSample[refBit] ?? 0;
      const startSec    = Math.floor(refSample / tape.sampleRate);
      const base        = tape.filename.replace(/\.wav$/i, '');
      const name        = prog.name || '(unnamed)';
      const summary = programSummary(prog);
      const summaryParts = summary.map(s => `${s.count} ${s.label}`).join(' · ');
      const pipe = '  <span class="sb-dim">│</span>  ';
      statusBar.innerHTML = `<span class="sb-dim">${escHtml(base)}_${escHtml(name)}_${startSec}s</span>${pipe}<span class="sb-dim">${summaryParts}</span>`;
    } else {
      statusBar.innerHTML = '<span class="sb-dim">Click a byte or BASIC line to inspect.</span>';
    }
    return;
  }

  const byte = prog.bytes[selByte];
  if (!byte) { statusBar.innerHTML = ''; return; }

  const dot  = ' <span class="sb-dim">·</span> ';
  const pipe = '  <span class="sb-dim">│</span>  ';

  const headerStart  = prog.header.byteIndex;
  const byteNum      = selByte - headerStart;
  const byteLabel    = byteNum < 0 ? 'Pre-header byte' : 'Byte';
  const byteSegs: string[] = [`${byteLabel} ${byteNum}`];
  const addr = progByteAddr(prog, selByte!);
  if (addr) byteSegs.push(addr);
  if (byte.unclear) byteSegs.push('<span class="sb-warn">Unclear</span>');
  if (byte.chkErr)  byteSegs.push('<span class="sb-err">Checksum error</span>');

  const sections: string[] = [byteSegs.join(dot)];

  if (prog.lines.length > 0) {
    const li = prog.lines.findIndex(l => selByte! >= l.firstByte && selByte! <= l.lastByte);
    const lineSegs: string[] = [];
    if (li < 0) {
      lineSegs.push(describeProgRegion(prog, selByte!));
    } else {
      lineSegs.push(`Line ${li + 1}`);
      for (const s of lineStatuses(prog, li)) {
        const cls = s.severity === 'error' ? 'sb-err' : 'sb-warn';
        lineSegs.push(`<span class="${cls}">${s.message}</span>`);
      }
    }
    sections.push(lineSegs.join(dot));
  }

  statusBar.innerHTML = sections.join(pipe);
}

function updateMergedStatusBar(): void {
  const um     = userMerges[activeProgIdx];
  const merged = um?.result;
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
  let qualityLabel: string;
  if (line.rejected) {
    qualityLabel = `<span style="color:var(--green)">Recovered · corrupted line safely ignored</span>`;
  } else {
    const QUALITY_LABEL: Record<string, string> = {
      clean:      `<span style="color:var(--green)">Clean</span>`,
      recovered:  `<span style="color:var(--green)">Recovered · clean source chosen over corrupt</span>`,
      issue:      (() => {
                    const src = bestSource(merged, line);
                    const prog = merged.sources[src.tapeIdx];
                    const hasHardErr = prog && lineHasHardError(prog, src.lineIdx);
                    const cls = hasHardErr ? 'sb-err' : 'sb-warn';
                    const errWord = hasHardErr ? 'errors' : 'unclear';
                    return line.status === 'consensus'
                      ? `<span class="${cls}">Issue · sources agree but ${errWord}</span>`
                      : line.status === 'single'
                        ? `<span class="${cls}">Issue · only source is ${errWord}</span>`
                        : line.status === 'partial'
                          ? `<span class="${cls}">Issue · source is ${errWord}, absent from other tape</span>`
                          : `<span class="${cls}">Issue · sources conflict</span>`;
                  })(),
      unverified: line.status === 'single'
                    ? `<span class="sb-warn">Unverified · single source (tape ${(um!.sources[line.sources[0]?.tapeIdx ?? 0]?.tapeIdx ?? 0) + 1})</span>`
                    : `<span class="sb-warn">Unverified · ${line.sources.length}/${merged.tapeCount} tapes</span>`,
    };
    qualityLabel = QUALITY_LABEL[line.quality];
  }
  const segs = [`BASIC line ${line.lineNum}`, qualityLabel];
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

/**
 * HTML for a prominent "DANGER" banner suitable for prepending to a
 * confirm-dialog message body.  Used by split / join handlers to warn
 * when the operation will discard user-typed (explicit) edits.
 */
function confirmDangerBanner(): string {
  return '<div class="confirm-modal-warn"><span class="warn-icon">⚠</span> DANGER: Edits will be lost!</div>';
}

/**
 * Show a confirm dialog with a message body (HTML) and OK/Cancel buttons.
 * Returns a Promise that resolves to true on OK, false on Cancel or Escape.
 *
 * Reuses the existing .tap-modal-overlay / .tap-modal-box CSS pattern with
 * a .confirm-modal-box size override (smaller than the save-TAP / merge
 * modals).  Enter accepts, Escape cancels.  The OK button is focused on
 * open so keyboard users can accept immediately.
 *
 * The `messageHtml` string is inserted as HTML — callers are responsible
 * for escaping any user-supplied text (e.g. program names via escHtml).
 * In return callers can embed styled badges like the .prog-num class used
 * elsewhere in the UI.
 */
function confirmAction(messageHtml: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'tap-modal-overlay';
    overlay.innerHTML =
      '<div class="tap-modal-box confirm-modal-box">' +
        `<div class="tap-modal-body confirm-modal-body">${messageHtml}</div>` +
        '<div class="tap-modal-footer">' +
          '<button class="confirm-cancel">Cancel</button>' +
          '<button class="confirm-ok">OK</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    const close = (result: boolean): void => {
      overlay.remove();
      resolve(result);
    };

    overlay.querySelector<HTMLButtonElement>('.confirm-cancel')!
      .addEventListener('click', () => close(false));
    overlay.querySelector<HTMLButtonElement>('.confirm-ok')!
      .addEventListener('click', () => close(true));

    // Keydown captured at the overlay so it doesn't bubble to the global
    // keydown handler (which would otherwise fire the same Escape / Enter
    // semantics we defined here for other contexts).
    overlay.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(true); }
    });

    overlay.querySelector<HTMLButtonElement>('.confirm-ok')!.focus();
  });
}
