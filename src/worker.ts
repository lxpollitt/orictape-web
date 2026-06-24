import { parseWavFile } from './wavfile';
import { readBitStreams, readPrograms } from './decoder';
import { conditionSamples } from './tapeAnalog';
import type { Program } from './decoder';

export interface WorkerRequest {
  buffer: ArrayBuffer;
}

export interface WorkerResult {
  ok: true;
  programs: Program[];
  sampleCount: number;
  /** Conditioned samples (input stage applied once, here off the main thread) for the
   *  waveform view - so the main thread never runs the heavy conditioning itself. */
  samples: Int16Array;
  sampleRate: number;
}

export interface WorkerError {
  ok: false;
  error: string;
}

export type WorkerResponse = WorkerResult | WorkerError;

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  try {
    const { left, sampleRate, sampleCount } = parseWavFile(e.data.buffer);
    const samples = conditionSamples(left, sampleRate);          // input stage, once, off the main thread
    const streams = readBitStreams(samples, sampleRate, true);   // already conditioned
    const programs = readPrograms(streams);
    const response: WorkerResult = { ok: true, programs, sampleCount, samples, sampleRate };
    self.postMessage(response);
  } catch (err) {
    const response: WorkerError = { ok: false, error: String(err) };
    self.postMessage(response);
  }
};
