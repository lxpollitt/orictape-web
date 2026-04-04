import { parseWavFile } from './wavfile';
import { readBitStreams, readPrograms } from './decoder';
import type { Program } from './decoder';

export interface WorkerRequest {
  buffer: ArrayBuffer;
}

export interface WorkerResult {
  ok: true;
  programs: Program[];
  sampleCount: number;
}

export interface WorkerError {
  ok: false;
  error: string;
}

export type WorkerResponse = WorkerResult | WorkerError;

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  try {
    const { left, sampleRate, sampleCount } = parseWavFile(e.data.buffer);
    const streams = readBitStreams(left, sampleRate);
    const programs = readPrograms(streams);
    const response: WorkerResult = { ok: true, programs, sampleCount };
    self.postMessage(response);
  } catch (err) {
    const response: WorkerError = { ok: false, error: String(err) };
    self.postMessage(response);
  }
};
