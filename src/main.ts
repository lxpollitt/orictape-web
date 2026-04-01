import './style.css';
import type { WorkerResponse } from './worker';
import type { Program } from './decoder';

const fileInput = document.getElementById('file-input') as HTMLInputElement;
const status    = document.getElementById('status')     as HTMLParagraphElement;
const output    = document.getElementById('output')     as HTMLDivElement;

// The worker runs the decode off the main thread so the UI never freezes.
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
  const data = e.data;
  if (!data.ok) {
    status.textContent = '';
    output.innerHTML = `<p class="error">Error: ${escHtml(data.error)}</p>`;
    return;
  }
  const { programs, sampleCount } = data;
  status.textContent =
    `Decoded ${programs.length} program${programs.length !== 1 ? 's' : ''} ` +
    `from ${(sampleCount / 44100).toFixed(1)}s of audio.`;
  renderPrograms(programs);
};

worker.onerror = (e) => {
  status.textContent = '';
  output.innerHTML = `<p class="error">Worker error: ${escHtml(e.message)}</p>`;
};

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;

  status.textContent = 'Loading…';
  output.innerHTML = '';

  // Read the file, then hand the ArrayBuffer to the worker.
  // We do NOT transfer it (we keep a copy) so the main thread can
  // access the raw samples later for the waveform view.
  const buffer = await file.arrayBuffer();
  status.textContent = 'Decoding… (large files may take several seconds)';
  worker.postMessage({ buffer } satisfies { buffer: ArrayBuffer });
});

function renderPrograms(programs: Program[]): void {
  if (programs.length === 0) {
    output.innerHTML = '<p class="hint">No programs found. Is this an Oric cassette recording?</p>';
    return;
  }
  let html = '';
  for (const prog of programs) {
    const hasErrors = prog.lines.some(l => l.lenErr);
    html += `<section>`;
    html += `<h2>${escHtml(prog.name || '(unnamed)')}`;
    if (hasErrors) html += ` <span class="badge-err">errors</span>`;
    html += `</h2><pre>`;
    for (const line of prog.lines) {
      const text = escHtml(line.v);
      html += line.lenErr
        ? `<span class="line-err" title="Line length mismatch">${text}</span>\n`
        : `${text}\n`;
    }
    html += `</pre></section>`;
  }
  output.innerHTML = html;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
