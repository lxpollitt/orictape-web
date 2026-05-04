# Orictape Web

A browser-based tool for decoding, inspecting, and recovering [Oric-1](https://en.wikipedia.org/wiki/Oric_(computer)) BASIC programs from old cassette-tape recordings (WAV files) and `.tap` files.

> **Status:** under active development, preview release only.

## Background

The Oric-1 was an 8-bit home computer released in 1983. Programs were typically distributed and saved on audio cassette — and 40+ years later, those tapes are degrading. This tool digitises a tape recording, decodes the BASIC programs stored on it, and lets you inspect, recover, and patch up the bits a flaky tape couldn't deliver cleanly.

## What it can do

- **Decode WAV recordings** of Oric tape audio into the original tokenised BASIC programs, with bit-level error recovery to cope with dropouts and noise.
- **Load `.tap` files** for inspection and editing alongside (or instead of) WAV captures.
- **Inspect every byte**: hex, ASCII, BASIC keyword tokens, decode-quality flags, and edit state are all visible per byte.
- **Browse the BASIC program** with line-level error highlighting, navigation, search, and inline editing.
- **Waveform view** that maps each audio sample back to the byte (and BASIC line) it decoded into — useful for spotting where a tape went bad and what's recoverable.
- **Multi-take merging**: load two recordings of the same program, align them, and pick the cleanest bytes from each to reconstruct a single clean copy.
- **Build TAP** to package recovered programs into a fresh `.tap` file ready for an emulator or modern Oric replacement hardware.
- **Inline 6502 assembler**: annotate `DATA` lines with assembler source; the tool re-tokenises the bytes on demand and back-patches `CALL` / `POKE` / `FOR`-loop addresses to match the assembled output. Designed around the conventions of hand-assembled Oric programs from the era. Full syntax reference in [`oric-asm-syntax.md`](./oric-asm-syntax.md).

## Built with

TypeScript and [Vite](https://vitejs.dev/). No frontend framework. WAV decoding, TAP parsing, BASIC tokenisation, the 6502 assembler, and the merging algorithm are all custom and live in [`src/`](./src/).

## Local development

```sh
npm install
npm run dev
```

Then open the URL Vite prints. Type-checking and the test suites are run separately:

```sh
npx tsc --noEmit
npx tsx tests/asmApplyScenarios.ts        # one of several scenario suites
```
