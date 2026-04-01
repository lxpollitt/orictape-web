import './style.css';
import { parseWavFile } from './wavfile';
import { WaveformView } from './waveform';
import type { WorkerResponse } from './worker';
import type { Program } from './decoder';

// ── DOM ───────────────────────────────────────────────────────────────────────
const fileInput  = document.getElementById('file-input')       as HTMLInputElement;
const statusEl   = document.getElementById('status')           as HTMLParagraphElement;
const progTabs   = document.getElementById('prog-tabs')        as HTMLElement;
const hexPanel   = document.getElementById('hex-view')         as HTMLElement;
const basicPanel = document.getElementById('basic-view')       as HTMLElement;
const waveCanvas = document.getElementById('waveform-canvas')  as HTMLCanvasElement;

// ── State ─────────────────────────────────────────────────────────────────────
let programs:    Program[]         = [];
let leftSamples: Int16Array | null = null;
let activeIdx  = 0;
let selByte:     number | null     = null;

const waveform = new WaveformView(waveCanvas);

// ── Worker ────────────────────────────────────────────────────────────────────
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
  const data = e.data;
  if (!data.ok) { showError(data.error); return; }

  programs  = data.programs;
  activeIdx = 0;
  selByte   = null;
  statusEl.textContent =
    `Decoded ${programs.length} program${programs.length !== 1 ? 's' : ''} ` +
    `from ${(data.sampleCount / 44100).toFixed(1)}s of audio.`;
  renderAll();
};

worker.onerror = (e) => showError(e.message);

// ── File loading ──────────────────────────────────────────────────────────────
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;

  statusEl.textContent = 'Loading…';
  clearPanels();

  const buffer = await file.arrayBuffer();

  // Parse WAV on the main thread so we have samples available for the waveform
  // without needing to transfer them back from the worker.
  try {
    leftSamples = parseWavFile(buffer).left;
  } catch (err) {
    showError(String(err));
    return;
  }

  statusEl.textContent = 'Decoding…';
  worker.postMessage({ buffer });
});

// ── Rendering ─────────────────────────────────────────────────────────────────
function renderAll(): void {
  renderTabs();
  const prog = programs[activeIdx];
  if (!prog) { clearPanels(); return; }
  renderHex(prog);
  renderBasic(prog);
  if (leftSamples) waveform.setData(leftSamples, prog);
}

function renderTabs(): void {
  progTabs.innerHTML = '';
  programs.forEach((prog, i) => {
    const btn = document.createElement('button');
    btn.className = `prog-tab${i === activeIdx ? ' active' : ''}`;
    btn.textContent = prog.name || `stream ${i + 1}`;
    btn.addEventListener('click', () => {
      activeIdx = i;
      selByte   = null;
      renderAll();
    });
    progTabs.appendChild(btn);
  });
}

function renderHex(prog: Program): void {
  // Bytes before the first BASIC line are sync/header — dim them.
  const firstContent = prog.lines[0]?.firstByte ?? prog.bytes.length;

  // Determine the byte range of the selected BASIC line (if any).
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
    const lineClass = [
      'basic-line',
      ...(line.lenErr   ? ['err'] : []),
      ...(i === selLine ? ['sel'] : []),
    ].join(' ');
    const elemsHtml = line.elements.map((el, ei) => {
      const cls = `elem${i === selLine && ei === selElem ? ' sel' : ''}`;
      return `<span class="${cls}" data-ei="${ei}">${escHtml(el)}</span>`;
    }).join('');
    return `<div class="${lineClass}" data-li="${i}">${elemsHtml}</div>`;
  }).join('');

  if (selLine >= 0) {
    basicPanel.querySelector<HTMLElement>(`[data-li="${selLine}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }
}

// ── Selection (event delegation — handlers set up once at module load) ────────
hexPanel.addEventListener('click', (e) => {
  const el = (e.target as Element).closest<HTMLElement>('[data-i]');
  if (el) selectByte(+el.dataset.i!);
});

basicPanel.addEventListener('click', (e) => {
  const lineEl = (e.target as Element).closest<HTMLElement>('[data-li]');
  if (!lineEl) return;
  const line = programs[activeIdx]?.lines[+lineEl.dataset.li!];
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

  // Hex: swap selected-byte and line-range classes without rebuilding the DOM.
  hexPanel.querySelector('.hb-sel')?.classList.remove('hb-sel');
  hexPanel.querySelectorAll('.hb-line').forEach(el => el.classList.remove('hb-line'));
  const cell = hexPanel.querySelector<HTMLElement>(`[data-i="${i}"]`);
  cell?.classList.add('hb-sel');
  cell?.scrollIntoView({ block: 'nearest' });

  // Basic: find the containing line and highlight it, plus the specific element.
  const prog = programs[activeIdx];
  if (prog) {
    basicPanel.querySelector('.basic-line.sel')?.classList.remove('sel');
    basicPanel.querySelector('.elem.sel')?.classList.remove('sel');
    const li = prog.lines.findIndex(l => i >= l.firstByte && i <= l.lastByte);
    if (li >= 0) {
      const line = prog.lines[li];
      // Shade the line's full byte range in the hex panel.
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
