/**
 * Built-in Oric BASIC ROM symbols — the `SYS.` namespace.
 *
 * Curated from §5 of oric-asm-rom-v10-v11b-reference.md (the
 * "Curated symbol reference").  Section 6 raw `.sym` dumps are NOT
 * ingested; the curated section already gives corrected addresses for
 * the orix-dump errata, so there is nothing to filter.
 *
 * Two target ROMs:
 *   - V1.0  — Oric-1 (basic10.rom)
 *   - V1.1b — Oric Atmos (basic11b.rom); `V11` here means 1.1b.
 *
 * Symbol classes:
 *   - **invariant**  — same address on both ROMs.  Referenced as a
 *     bare `SYS.NAME`.  A version suffix on an invariant symbol is an
 *     error (keeps "suffix present ⇔ ROM-specific" airtight).
 *   - **variant**    — differs per ROM.  MUST be referenced with an
 *     explicit `.V10` / `.V11`; a bare `SYS.NAME` is an error.
 *   - **single-ROM** — exists on only one ROM (e.g. V1.1b-only).
 *     Still requires the explicit suffix; the absent side errors;
 *     bare also errors.  (No auto-defaulting to the only ROM.)
 *
 * Naming: the reference/manual name is used verbatim, upper-cased,
 * EXCEPT where it contains characters our identifier grammar can't
 * express.  The only such canonical renames (agreed in design):
 *   - `PTR_USR` → `USRVEC`   (the USR() indirect-jump vector)
 *   - `!VEC`    → `BANGVEC`  (the `!` command vector)
 *   - `&VEC`    → `AMPVEC`   (the `&` function vector)
 *   …named `*VEC` because they are jump vectors (ROM JMPs through
 *   them), distinct from data pointers like `TXTPTR`.
 *
 * Deferred to a follow-up (would need invented names): per-byte FAC
 * zero-page ($D0–$DD), screen/hires/charset RAM bases, cold-start /
 * NMI / IRQ "vector target" rows, user-ML scratch, "signed FAC→int",
 * and the dash-named VIA timer-latch registers ($0304–$0309, $030F).
 */

/** Resolved address(es) for one built-in symbol.  Shape selects the
 *  axis: `addr` ⇒ invariant; `v10`/`v11` ⇒ ROM-version axis (a
 *  missing side means single-ROM — "not available on that ROM");
 *  `text`/`hires` ⇒ video-mode axis (both always present — the
 *  block always exists, it just relocates). */
type SysEntry =
  | { addr: number }                        // invariant
  | { v10?: number; v11?: number }          // ROM-version axis (.V10/.V11)
  | { text: number; hires: number };        // video-mode axis (.TEXTMODE/.HIRESMODE)

/** Multi-byte symbols (16-bit pointers / vectors) resolve to the
 *  low-byte address (e.g. `USRVEC` → $21, the location you DOKE).
 *  All addresses verbatim from §5. */
const SYS_SYMBOLS: ReadonlyMap<string, SysEntry> = new Map([
  // ── §5.1 Zero page (invariant) ──────────────────────────────────
  ['USRVEC',   { addr: 0x21 }],   // PTR_USR $21/$22
  ['LINWID',   { addr: 0x31 }],
  ['TXTTAB',   { addr: 0x9A }],
  ['VARTAB',   { addr: 0x9C }],
  ['ARYTAB',   { addr: 0x9E }],
  ['STREND',   { addr: 0xA0 }],
  ['MEMSIZ',   { addr: 0xA6 }],
  ['CHRGOT',   { addr: 0xE8 }],
  ['TXTPTR',   { addr: 0xE9 }],
  ['CHRRTS',   { addr: 0xF9 }],
  ['CURBAS',   { addr: 0x12 }],
  ['GCL',      { addr: 0x1F }],
  ['GHC',      { addr: 0x20 }],

  // ── §5.2 Page 2 — stable on both ────────────────────────────────
  ['KEYAD',    { addr: 0x0208 }],
  ['KBSTAT',   { addr: 0x0209 }],
  ['CAPLCK',   { addr: 0x020C }],
  ['PAT',      { addr: 0x0213 }],
  ['CURX',     { addr: 0x0219 }],
  ['CURY',     { addr: 0x021A }],
  ['GRA',      { addr: 0x021F }],
  ['SXTNK',    { addr: 0x0220 }],
  ['CURROW',   { addr: 0x0268 }],
  ['CURCOL',   { addr: 0x0269 }],
  ['MODE0',    { addr: 0x026A }],
  ['BGND',     { addr: 0x026B }],
  ['FGND',     { addr: 0x026C }],
  ['CURINV',   { addr: 0x0271 }],
  ['TIMER1',   { addr: 0x0272 }],
  ['TIMER2',   { addr: 0x0274 }],
  ['TIMER3',   { addr: 0x0276 }],
  ['ICHAR',    { addr: 0x02DF }],
  ['PARAMS',   { addr: 0x02E0 }],
  ['BANGVEC',  { addr: 0x02F5 }], // !VEC $02F5/$02F6
  ['GCOL',     { addr: 0x02F8 }],
  ['AMPVEC',   { addr: 0x02FC }], // &VEC $02FC/$02FD

  // ── §5.2 Page 2 — V1.1b only (single-ROM) ───────────────────────
  ['XVDU',     { v11: 0x0238 }],
  ['XGETKY',   { v11: 0x023B }],
  ['XPRTCH',   { v11: 0x023E }],
  ['XSTOUT',   { v11: 0x0241 }],
  ['INTFS',    { v11: 0x0244 }],
  ['NMIJP',    { v11: 0x0247 }],
  ['INTSL',    { v11: 0x024A }],
  ['TSPEED',   { v11: 0x024D }],
  ['KBDLY',    { v11: 0x024E }],
  ['KBRPT',    { v11: 0x024F }],
  ['PWIDTH',   { v11: 0x0256 }],
  ['VWIDTH',   { v11: 0x0257 }],
  ['CURON',    { v11: 0x0270 }],
  ['VDUL2',    { v11: 0x0278 }],
  ['VDUL1',    { v11: 0x027A }],
  ['VDUCH',    { v11: 0x027C }],
  ['NOROWS',   { v11: 0x027E }],

  // ── §5.3 Sound family (variant) ─────────────────────────────────
  ['SOUND',     { v10: 0xFB26, v11: 0xFB40 }],
  ['PLAY',      { v10: 0xFBB6, v11: 0xFBD0 }],
  ['MUSIC',     { v10: 0xFBFE, v11: 0xFC18 }],
  ['KEYCLICKH', { v10: 0xFAFA, v11: 0xFB14 }],
  ['KEYCLICKL', { v10: 0xFB10, v11: 0xFB2A }],
  ['PING',      { v10: 0xFA85, v11: 0xFA9F }],
  ['SHOOT',     { v10: 0xFA9B, v11: 0xFAB5 }],
  ['EXPLODE',   { v10: 0xFAB1, v11: 0xFACB }],
  ['ZAP',       { v10: 0xFAC7, v11: 0xFAE1 }],

  // ── §5.4 Keyboard / IRQ / Timer ─────────────────────────────────
  ['IRQ',        { v10: 0xED09, v11: 0xEE22 }],
  ['READKBD',    { v10: 0xF43C, v11: 0xF495 }],
  ['CHECKKBD',   { v11: 0xEB78 }],            // V1.1b only (GETKEY)
  ['READKBDCOL', { addr: 0xF561 }],
  ['KEY2ASCII',  { addr: 0xF4EF }],
  ['FINDKEY',    { addr: 0xF523 }],
  ['SETUPTIMER', { v10: 0xECC7, v11: 0xEDE0 }],
  ['STOPTIMER',  { v10: 0xED01, v11: 0xEE1A }],
  ['RESETTIMER', { v10: 0xED70, v11: 0xEE8C }],
  ['GETTIMER',   { v10: 0xED81, v11: 0xEE9D }],
  ['SETTIMER',   { v10: 0xED8F, v11: 0xEEAB }],
  ['DELAY',      { v10: 0xEDAD, v11: 0xEEC9 }],

  // ── §5.5 Hardware (AY-3-8912) ───────────────────────────────────
  ['WRITETOAY',  { v10: 0xF535, v11: 0xF590 }],

  // ── §5.6 Floating point (USR exchange) ──────────────────────────
  ['INT2FAC',  { v10: 0xD8D5, v11: 0xD499 }],
  ['FAC2INT',  { v10: 0xD867, v11: 0xD922 }],
  ['BYTE2FAC', { v10: 0xD3FD, v11: 0xD4B6 }],
  ['ROUNDFPA', { v10: 0xDEEC, v11: 0xDEF4 }],

  // ── §5.7 Tape I/O ───────────────────────────────────────────────
  ['OUTLED', { v11: 0xE75A }],   // V1.0 address not curated-confirmed
  ['GETSYN', { v11: 0xE735 }],   // V1.0 address not curated-confirmed
  ['OUTBYT', { v10: 0xE5C6, v11: 0xE65E }],
  ['RDBYTE', { v10: 0xE630, v11: 0xE6C9 }],
  ['CSAVE',  { v10: 0xE7DB, v11: 0xE909 }],
  ['CLOAD',  { v10: 0xE7AA, v11: 0xE85B }],
  ['VERIFY', { addr: 0xE4F2 }],

  // ── §5.8 Graphics ──────────────────────────────────────────────
  ['CURSET',    { v10: 0xEBDF, v11: 0xF0C8 }],
  ['CURMOV',    { v10: 0xEBE2, v11: 0xF0FD }],
  ['DRAW',      { v10: 0xEBE5, v11: 0xF110 }],
  ['CIRCLE',    { v10: 0xEBE8, v11: 0xF37F }],
  ['PATTERN',   { v10: 0xEBEB, v11: 0xF11D }],
  ['CHAR',      { v10: 0xEBEE, v11: 0xF12D }],
  ['PAPER',     { v10: 0xEBF4, v11: 0xF204 }],
  ['INK',       { v10: 0xEBF7, v11: 0xF210 }],
  ['FILL',      { v10: 0xEBFA, v11: 0xF268 }],
  ['POINT',     { v10: 0xEC45, v11: 0xF1C8 }],
  ['HIRES',     { v10: 0xE9BB, v11: 0xEC33 }],
  ['TEXT',      { v10: 0xE9A9, v11: 0xEC21 }],
  ['LORES',     { v10: 0xD93D, v11: 0xD9DE }],
  ['HIMEM',     { v10: 0xE965, v11: 0xEBCE }],
  ['GRAB',      { v10: 0xE974, v11: 0xEBE7 }],
  ['RELEASE',   { v10: 0xE994, v11: 0xEC0C }],
  ['HIRESMODE', { addr: 0xF920 }],
  ['LORESMODE', { addr: 0xF967 }],

  // ── §5.9 Reset / cold-start / vectors ───────────────────────────
  // CPU hardware vectors are fixed locations (invariant on every
  // 6502 / both ROMs).  RESET is the cold-start entry the reset
  // vector points to (orix `.sym` label `Reset`; "Oric land" uses
  // the reset root for both — see oric-asm-rom-v10-v11b-reference.md
  // §5.9).
  ['NMIVEC',   { addr: 0xFFFA }],
  ['RESETVEC', { addr: 0xFFFC }],
  ['IRQVEC',   { addr: 0xFFFE }],
  ['RESET',    { v10: 0xF42D, v11: 0xF88F }],
  ['BASICSTART',   { addr: 0xF8AF }],
  ['BASICRESTART', { addr: 0xF8B5 }],
  ['STARTBASIC',   { addr: 0xECCC }],

  // ── §5.10 Memory landmarks ──────────────────────────────────────
  // CharSet (ROM charset copy) and KeyCodeTab are in ROM and were
  // validated as ROM-version-different (§5.10): V1.0 sits $8 lower
  // than V1.1b.  So they're `.V10`/`.V11` variant, not invariant.
  ['CHARSET',    { v10: 0xFC70, v11: 0xFC78 }],
  ['KEYCODETAB', { v10: 0xFF70, v11: 0xFF78 }],
  ['VIA',  { addr: 0x0300 }],         // 6522 VIA register block base
  ['ORB',  { addr: 0x0300 }],
  ['ORA',  { addr: 0x0301 }],
  ['DDRB', { addr: 0x0302 }],
  ['DDRA', { addr: 0x0303 }],
  ['SR',   { addr: 0x030A }],
  ['ACR',  { addr: 0x030B }],
  ['PCR',  { addr: 0x030C }],
  ['IFR',  { addr: 0x030D }],
  ['IER',  { addr: 0x030E }],

  // ── §5.10 Video-mode-dependent areas (mode axis) ────────────────
  // One block each; base address moves with the video mode (the
  // HIRES bitmap physically overlaps the text-mode screen/charset
  // region, so they can't share addresses).  48K addresses (16K is
  // −$8000 — handled later via address arithmetic, not parallel
  // labels).  Addresses per reference §5.10 (manual-documented).
  ['SCREEN',     { text: 0xBB80, hires: 0xA000 }],
  ['STDCHARSET', { text: 0xB400, hires: 0x9C00 }],
  ['ALTCHARSET', { text: 0xB800, hires: 0x9800 }],

  // ── §5.11 BASIC extension / interop (variant) ───────────────────
  ['GTVALS', { v10: 0xD996, v11: 0xDA22 }],
  ['SYNCHR', { v10: 0xCFDB, v11: 0xD067 }],
  ['PRINT',  { v10: 0xCB61, v11: 0xCBAB }],
]);

/** Result of resolving a `SYS.`-prefixed reference.
 *  - `ok`      — resolved to a concrete address.
 *  - `error`   — a real diagnostic (ROM-specific bare ref, wrong ROM
 *                suffix, suffix on invariant, unknown name, …).
 *  - `notSys`  — the name is not in the `SYS.` namespace; caller
 *                should fall through to normal symbol resolution. */
export type SysLookup =
  | { kind: 'ok'; value: number }
  | { kind: 'error'; message: string }
  | { kind: 'notSys' };

/** Resolve a (possibly `SYS.`-prefixed, possibly version-suffixed)
 *  symbol name.  Encodes every built-in rule; pure and unit-testable.
 *
 *  Recognised forms:
 *    SYS.NAME              invariant symbol (no suffix)
 *    SYS.NAME.V10/.V11     ROM-version-variant symbol
 *    SYS.NAME.TEXTMODE     video-mode-variant symbol (text screen/charset)
 *    SYS.NAME.HIRESMODE    video-mode-variant symbol (hires)
 *
 *  Two independent variant axes (ROM version, video mode), each with
 *  the same rule shape: a symbol that varies on an axis *requires*
 *  the matching suffix (bare → error); the wrong axis's suffix is an
 *  error; and a suffix on an invariant symbol is an error.  This
 *  keeps "a suffix is present iff the address genuinely varies"
 *  airtight in source.
 *
 *  Names are matched case-insensitively (the built-ins are well-known
 *  mnemonics; the canonical table is upper-case). */
export function lookupSysSymbol(name: string): SysLookup {
  const parts = name.split('.');
  if (parts.length === 0 || parts[0].toUpperCase() !== 'SYS') {
    return { kind: 'notSys' };
  }
  if (parts.length < 2 || parts.length > 3) {
    return { kind: 'error', message: `malformed built-in symbol: ${name}` };
  }
  const sym = parts[1].toUpperCase();
  const sfx = parts.length === 3 ? parts[2].toUpperCase() : undefined;

  // Classify the suffix (if any) onto its axis up front.
  const romSfx  = sfx === 'V10' || sfx === 'V11';
  const modeSfx = sfx === 'TEXTMODE' || sfx === 'HIRESMODE';
  if (sfx !== undefined && !romSfx && !modeSfx) {
    return {
      kind: 'error',
      message: `unknown suffix '.${parts[2]}' on SYS.${parts[1]} `
             + `(expected .V10, .V11, .TEXTMODE or .HIRESMODE)`,
    };
  }

  const entry = SYS_SYMBOLS.get(sym);
  if (entry === undefined) {
    return { kind: 'error', message: `unknown built-in symbol SYS.${parts[1]}` };
  }

  // Invariant symbol — no suffix of any axis.
  if ('addr' in entry) {
    if (sfx !== undefined) {
      return {
        kind: 'error',
        message: `SYS.${sym} is the same on both ROMs and video modes — `
               + `drop the .${sfx} suffix`,
      };
    }
    return { kind: 'ok', value: entry.addr };
  }

  // Video-mode-variant symbol.
  if ('text' in entry) {
    if (romSfx) {
      return {
        kind: 'error',
        message: `SYS.${sym} varies by video mode, not ROM — `
               + `use SYS.${sym}.TEXTMODE or SYS.${sym}.HIRESMODE`,
      };
    }
    if (sfx === undefined) {
      return {
        kind: 'error',
        message: `SYS.${sym} depends on the video mode — `
               + `use SYS.${sym}.TEXTMODE or SYS.${sym}.HIRESMODE`,
      };
    }
    return { kind: 'ok', value: sfx === 'TEXTMODE' ? entry.text : entry.hires };
  }

  // ROM-version-variant symbol.
  if (modeSfx) {
    return {
      kind: 'error',
      message: `SYS.${sym} varies by ROM, not video mode — `
             + `use SYS.${sym}.V10 or SYS.${sym}.V11`,
    };
  }
  if (sfx === undefined) {
    const have: string[] = [];
    if (entry.v10 !== undefined) have.push('SYS.' + sym + '.V10');
    if (entry.v11 !== undefined) have.push('SYS.' + sym + '.V11');
    return {
      kind: 'error',
      message: `SYS.${sym} differs between BASIC V1.0 and V1.1b — `
             + `use ${have.join(' or ')}`,
    };
  }
  const addr = sfx === 'V10' ? entry.v10 : entry.v11;
  if (addr === undefined) {
    const romName = sfx === 'V10' ? 'V1.0 (Oric-1)' : 'V1.1b (Atmos)';
    return {
      kind: 'error',
      message: `SYS.${sym} is not available on BASIC ${romName}`,
    };
  }
  return { kind: 'ok', value: addr };
}

/** True if `name` (case-insensitively) is exactly `SYS` — the
 *  reserved built-in namespace token.  Used to reject user
 *  declarations that would shadow the namespace. */
export function isReservedSysName(name: string): boolean {
  return name.toUpperCase() === 'SYS';
}
