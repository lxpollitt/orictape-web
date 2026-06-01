# Oric BASIC ROM Reference — V1.0 and V1.1b

A standalone reference for working with the two dominant Oric BASIC ROMs from machine code: BASIC V1.0 (shipped with the Oric-1, 1983) and BASIC V1.1b (shipped with the Oric Atmos, 1984). Intended to support cross-ROM machine-code development and debugging where ROM routines are called directly with parameters set up by the caller, and to document the labels supported by the built in assembler.

---

## 1. Known Oric BASIC ROM variants

The Oric ecosystem has several BASIC ROM variants. The table below is curated from the Defence Force Encounter HD source (`code/system_testing.c`), which ships a CRC32-indexed table of various known ROMs.

| ROM | Machine | Practical status |
|---|---|---|
| `basic10.rom` | Oric-1 | Dominant for Oric-1; the only ROM on stock Oric-1 hardware |
| `basic11b.rom` | Oric Atmos | Dominant for Atmos; also Pravetz 8D, LOCI/EREBUS patched Atmos |
| `basic11a.rom` | Oric Atmos (early production) | Buggy cassette routines; quickly superseded by V1.1b; uncommon in the wild |
| `pravetzt.rom` | Pravetz 8D (Bulgarian Atmos clone) | 97.6% byte-identical to V1.1b; SOUND/PLAY/MUSIC byte-identical to V1.1b |
| `pravetzt-1.0.rom` | Pravetz (V1.0-era variant) | Rare |
| `hyperbas.rom` | Oric Telestrat | Telestrat-only, fundamentally different OS |
| `teleass.rom`, `telmon24.rom` | Telestrat tools | Telestrat-only |
| `8dos.rom` | Pravetz disk OS | Pravetz disk-specific |
| Atmos ROM 1.1 (LOCI patch) | Atmos with LOCI interface | Surgical patches on V1.1b |
| Atmos ROM 1.1 (EREBUS patch) | Atmos with EREBUS interface | Surgical patches on V1.1b |

For finer-grained fingerprinting than this document covers (e.g. distinguishing LOCI-patched from vanilla Atmos), CRC32 over the full 16K ROM is the canonical approach. The Encounter HD source provides a working 6502 CRC32 implementation and a maintained table of known ROM CRCs: [Dhebug/Encounter — code/system_testing.c](https://github.com/Dhebug/Encounter/blob/master/code/system_testing.c).

---

## 2. Why V1.0 and V1.1b are the practical targets for assembler integration

For new code that wants the broadest realistic compatibility on real Oric hardware:

- **V1.0** is the ROM on a stock Oric-1. Supporting Oric-1 hardware requires V1.0.
- **V1.1b** is the ROM on the standard Atmos. It also appears to share addresses with the Pravetz 8D (Bulgarian Atmos clone, sound/keyboard byte-identical to V1.1b) and the LOCI/EREBUS patched Atmos ROMs (surgical fixes that don't relocate the sound or keyboard areas, so code targeting V1.1b addresses continues to work).
- **V1.1a** was the original Atmos production ROM, but had buggy cassette routines and was quickly replaced. 
- The **Telestrat** runs a fundamentally different OS (HyperBASIC). Supporting it would require a separate codepath, not just symbol substitution.
- The **Pravetz V1.0 / 8DOS** variants are rarer and are treated as "unsupported" rather than first-class targets.

---

## 3. Runtime ROM detection

A simple single check is the **reset vector at `$FFFC/$FFFD`**:

| ROM | `$FFFC` | `$FFFD` | Cold-start target |
|---|---|---|---|
| V1.0 | `$2D` | `$F4` | `$F42D` |
| V1.1b | `$8F` | `$F8` | `$F88F` |
| Pravetz 8D | `$8F` | `$F8` | `$F88F` |

Why the reset vector works well for this:

- It's two fixed-address bytes on every 6502 machine — no scanning needed.
- It cleanly distinguishes V1.0 from V1.1, and Pravetz collapses automatically into the V1.1b dispatch case.

For stronger fingerprinting (e.g. distinguishing LOCI from vanilla V1.1b), see the CRC32 table referenced in Section 1.

---

## 4. Cross-ROM portability properties

Two properties make portability of machine code between V1.0 and V1.1b easier in some cases:

1. **The parameter ABI (Application Binary Interface) appears to be identical in many cases.** For example, `SOUND`, `PLAY`, and `MUSIC` all read their parameters from `$02E1`–`$02E8` on both ROMs (with `$02E0` as the error flag). So caller-side parameter setup is the same on both ROMs.

2. **Keyboard handling appears to be ROM-independent.** For example, the IRQ-updated "last key" byte at `$02DF` is in RAM at the same address on both ROMs, with the same semantics (bit 7 = valid). 

The practical implication: for a game using only screen, keyboard, and BASIC sound calls, the ROM-specific code is reduced to a small number of `JSR` operand bytes that can be handled by detecting at startup and patching those operands in place.

---

## 5. Curated symbol reference

The labels that seem most useful for machine-code programs that interface with the ROM: manual-documented entry points; useful system variables; and a small set of additional ROM routines verified at byte level. Aimed at the realistic use cases for game and application development on the Oric. The full `.sym` dumps from orix-software/basic are in Section 7 for completeness, but many of those entries are BASIC interpreter internals (FP arithmetic helpers, parser plumbing, editor internals, tape state machines) that probably less useful for direct user written machine code use.

Authoritative sources for inclusion in this section:

- **Atmos manual** (Appendix 9, "ROM Routines and Addresses", pp. 266–272) — documents ~25 ROM routines and ~30 page-0/page-2 system variables as the public V1.1b ABI.
- **Oric-1 manual** (Chapter 13, "Machine code programs", pp. 121–129) — documents the V1.0 USR/FAC mechanism and the `!`/`&` extension command pattern, including specific V1.0 addresses for `GTVALS`, `SYNCHR`, `Int2FAC`, `FAC2Int`, and others.
- **Byte-level cross-ROM verification** of the routine bodies (for entries marked `✓ both`).

Grouped by function. Addresses without a separate column entry are the same on both ROMs.

**Built-in assembler (`SYS.`) names.** The tool exposes these as `SYS.<NAME>` (invariant), `SYS.<NAME>.V10` / `.V11` (address differs per ROM), or `SYS.<NAME>.TEXT` / `.HIRES` (address differs per video mode — §5.10 screen/charset areas). `<NAME>` is the name in the tables below **verbatim, upper-cased** (`HiresMode` → `SYS.HIRESMODE`, `FAC2Int` → `SYS.FAC2INT`); matching is case-insensitive, so the table keeps its readable mixed case. Names containing characters that aren't legal identifier chars are adapted: dashes are mechanically dropped (`T1C-L` → `SYS.T1CL`, etc., per the §5.10 VIA-timer rows), and four names that can't be repaired mechanically are *renamed* — these are tagged inline below:

| Reference name | `SYS.` name |
|---|---|
| `PTR_USR` | `SYS.USRVEC` |
| `!VEC` | `SYS.BANGVEC` |
| `&VEC` | `SYS.AMPVEC` |
| `ORA (no handshake)` | `SYS.ORANH` |

(`*VEC` because the ROM JMPs *through* them, distinct from data pointers like `TXTPTR`.) See [`oric-asm-syntax.md`](./oric-asm-syntax.md) "Built-in ROM symbols" for the full rule set (the suffix ⇔ ROM-specific invariant, error behaviours, the deferred-symbols list).

**Verification status convention.** Each table has a `Verified` column indicating the strength of cross-ROM evidence for that row:

| Marker | Meaning |
|---|---|
| `✓` | Strongly verified — tested in working machine code, or byte-identical instructions referencing the address in the same role on both ROMs, or the same address documented in a manual *and* corroborated by some other independent check. |
| `~` | Partially verified — referenced on both ROMs with overlap of enclosing routine names or matching access patterns, but not byte-identically confirmed. Same purpose plausible from convergent evidence but not proven. |
| (blank) | Sourced from the orix-software/basic `.sym` files or a single manual reference only. Plausible but no independent cross-ROM check. Recommended to byte-check before relying on for novel use. |
| `✗` | Known errata — label points to wrong content. See Section 6. |

Where a row's status differs between V1.0 and V1.1b, the column notes which ROM the check applies to (e.g. `✓ V1.1` or `✓ both`).

### 5.1 Zero page (FAC, USR, and manual-documented labels)

FAC and USR vector. The `$D0`–`$D5` and `$33`/`$34` entries are verified by byte-identical instructions referencing them at the same offsets inside the `FAC2Int` and `Int2FAC` routines on both ROMs. `$D6` is verified by matching enclosing-routine sets on both ROMs (referenced exclusively from `GetNumber` and `SeriesEval`). `$D7`–`$DD` are inferred from MS BASIC FAC convention plus partial enclosing-routine overlap; not byte-level confirmed.

| Symbol | Address | Verified | Notes |
|---|---|---|---|
| `PTR_USR` | `$21`, `$22` | ✓ both | USR jump vector; user-pokeable from BASIC. **Assembler: `SYS.USRVEC`.** |
| `FAC2Int` output LSB | `$33` | ✓ both | After `JSR FAC2Int`, LSB of integer result. Documented in Oric-1 manual Ch. 13. |
| `FAC2Int` output MSB | `$34` | ✓ both | After `JSR FAC2Int`, MSB of integer result. Documented in Oric-1 manual Ch. 13. |
| FAC exponent | `$D0` | ✓ both | Main floating-point accumulator |
| FAC mantissa byte 1 (`Int2FAC` input MSB) | `$D1` | ✓ both | After `Int2FAC(A,Y)`, holds the A input (before normalisation) |
| FAC mantissa byte 2 (`Int2FAC` input LSB) | `$D2` | ✓ both | After `Int2FAC(A,Y)`, holds the Y input (before normalisation) |
| FAC mantissa byte 3 (`FAC2Int` output MSB) | `$D3` | ✓ both | After `JSR FAC2Int`, MSB of extracted integer (same value also at `$34`) |
| FAC mantissa byte 4 (`FAC2Int` output LSB) | `$D4` | ✓ both | After `JSR FAC2Int`, LSB of extracted integer (same value also at `$33`) |
| FAC sign | `$D5` | ✓ both | Bit 7 = negative |
| Rounding byte | `$D6` | ✓ both | Used during FP rounding operations |
| FAC sign-extend byte | `$D7` | ~ both | |
| Work FPA | `$D8`–`$DD` | ~ both | Secondary FP accumulator used by two-operand arithmetic (ADD, SUB, MUL, DIV). |

Atmos manual-documented page-zero labels (Appendix 9, p. 271). These are MS BASIC zero-page conventions inherited unchanged by both Oric BASIC ROMs.

| Symbol | Address | Verified | Notes |
|---|---|---|---|
| `LINWID` | `$31` | ✓ both | Terminal line width (V1.0 also doubles as printer width) |
| `TXTTAB` | `$9A`–`$9B` | ✓ both | Start of BASIC program text |
| `VARTAB` | `$9C`–`$9D` | ✓ both | Start of BASIC variables |
| `ARYTAB` | `$9E`–`$9F` | ✓ both | Start of BASIC arrays |
| `STREND` | `$A0`–`$A1` | ~ both | End of variables / lo-mem boundary (both ROMs reference, minor opcode-set difference) |
| `MEMSIZ` | `$A6`–`$A7` | ✓ both | HIMEM / top of FRE area |
| `CHRGOT` | `$E8` | ~ both | Char-fetch routine entry (LDA instruction); used to peek the next BASIC character without advancing |
| `TXTPTR` | `$E9`–`$EA` | ~ both | Pointer to current BASIC character being interpreted (51 refs V1.0, 47 V1.1b — very heavily used) |
| `CHRRTS` | `$F9` | — | RTS at end of CHRGET routine; manual label; no direct refs in either ROM (it's an instruction, not a state byte) |

Additional zero-page state from the Oric-1 manual's `!` extension example (Chapter 13, p. 128). Useful only if you're writing BASIC extensions that interact with the screen subsystem; for typical game code these are marginal.

| Symbol | Address | Verified | Notes |
|---|---|---|---|
| `CURBAS` | `$12`–`$13` | — | Cursor base address (16-bit). Set/read by the screen routines when positioning the cursor. |
| `GCL` | `$1F` | — | Graphics column low. |
| `GHC` | `$20` | — | Graphics column high. |

These appear in the Oric-1 manual `!`-command example. Not independently byte-verified across ROMs.

### 5.2 Page 2 (manual-documented labels, sound parameters, keyboard, timers, error)

This section incorporates the page-2 labels documented in the Atmos manual (Appendix 9, pp. 271–272). Two groups:

**Stable on both ROMs:**

| Address | Symbol | Verified | Notes |
|---|---|---|---|
| `$0208` | `KEYAD` | ~ both | Key address from matrix scan when a key is pressed. Both ROMs reference it from keyboard-scan code; V1.1b's scan is refactored across `FindKey`/`Key2ASCII`/`ReadKbd` while V1.0 has it all in `ReadKbd`. |
| `$0209` | `KBSTAT` | ~ both | Keyboard modifier state. `$A4` = left shift, `$A7` = right shift. Same refactoring pattern as `KEYAD`. |
| `$020C` | `CAPLCK` | ~ both | Caps lock state. `$80` = CAPS active. Referenced from `ControlChr` and `ClearLine` on both ROMs. |
| `$0213` | `PAT` | ~ both | PATTERN register for CIRCLE / DRAW operations. V1.0 graphics routines aren't fully labelled in the `.sym`, so cross-ROM routine overlap is limited. |
| `$0219` | `CURX` | ~ both | Graphics cursor X coordinate. Same V1.0 `.sym` sparseness caveat as `PAT`. |
| `$021A` | `CURY` | ~ both | Graphics cursor Y coordinate. Same V1.0 `.sym` sparseness caveat as `PAT`. |
| `$021F` | `GRA` | ~ both | Graphics-mode flag: `1` = HIRES, `0` = TEXT/LORES. Both ROMs reference from `BASICRestart` and `HiresMode`. |
| `$0220` | `SXTNK` | ~ both | Memory size flag: `1` = 16K machine, else 48K. V1.0 references from `SetupText`, V1.1b from `RamTest` — different routine names, but both are early-boot RAM-size probes (plausibly same purpose). |
| `$0268` | `CURROW` | ✓ both | Cursor row position. Heavy `ControlChr` references on both ROMs plus `BASICRestart`. |
| `$0269` | `CURCOL` | ~ both | Cursor column position. Paired with `CURROW`; documented in the Oric-1 manual `!` extension example (Ch. 13, p. 128). |
| `$026A` | `MODE0` | ✓ both | Mode flag byte. Bit 0 = cursor on; bit 1 = VDU on; bit 3 = key click off; bit 4 = last char was ESC; bit 5 = protect cols 0/1; bits 2,6,7 spare. Five enclosing routines overlap on both ROMs (`BASICRestart`, `Char2Scr`, `ControlChr`, `HiresMode`, `ReadKbd`). |
| `$026B` | `BGND` | ~ both | Background colour (PAPER + 16). Referenced from `BASICRestart` and `ControlChr` on both ROMs. |
| `$026C` | `FGND` | ~ both | Foreground colour (INK). Same evidence pattern as `BGND`. |
| `$0271` | `CURINV` | ✓ both | Cursor invert flag. `SetupTimer` clears it during cursor initialisation. |
| `$0272`–`$0273` | `TIMER1` | ✓ both | 16-bit keyboard timer (Atmos manual). LSB at `$0272`, MSB at `$0273`. Decremented by IRQ. Used internally by ROM keyboard handling — leaving it alone is recommended. |
| `$0274`–`$0275` | `TIMER2` | ✓ both | 16-bit cursor blink timer. Accessed by the ROM via `$0272,Y` indexing — no direct absolute references, but `ResetTimer` clears all six timer bytes contiguously. Stable layout on both ROMs. Used by cursor blink — leave alone. |
| `$0276`–`$0277` | `TIMER3` | ✓ both | **16-bit "spare" / WAIT timer.** Decrements every 1/100 second. Same access pattern as `TIMER2`. Free for user/game use — the canonical one to poke for game timing. |
| `$02DF` | `ICHAR` | ✓ both | Current key pressed (Atmos manual label). Set by IRQ scan with bit 7 = valid; consumer should clear after reading. Verified by Alex's live code on both ROMs and by byte-level reference check. |
| `$02E0`+ | `PARAMS` | ✓ both | Parameter block buffer for graphics and sound. Manual labels the base as `PARAMS`; `PARAMS + 0` ( = `$02E0`) is the error flag (`1` on error). Slots at `+1`, `+3`, `+5`, `+7` etc. are the call parameters per the routine table in Section 5.3. |
| `$02F5`–`$02F6` | `!VEC` | ✓ both | Vector for the `!` command — user extension command hook. `DOKE $2F5, addr` installs an ML routine that gets called when BASIC encounters `!`. Documented in Oric-1 manual Chapter 13, used by OSDK's `_bang` builtin. **Assembler: `SYS.BANGVEC`.** |
| `$02F8` | `GCOL` | — | Graphics column (used by `!` example). Stable purpose plausibly inferred from the Oric-1 manual example but not independently byte-verified across ROMs. |
| `$02FC`–`$02FD` | `&VEC` | ✓ both | Vector for the `&` function — user extension function hook (returns a value to BASIC via FAC). `DOKE $2FC, addr` installs an ML routine that gets called when BASIC encounters `&(arg)`. Documented in Oric-1 manual Chapter 13. **Assembler: `SYS.AMPVEC`.** |

**V1.1b only** — referenced on V1.1b but not on V1.0. On V1.0 these addresses either don't exist as documented features (e.g. configurable auto-repeat was added in V1.1) or are accessed differently. Writing to these on V1.0 is generally harmless (no effect) but reading them tells you nothing useful:

| Address | Symbol | Verified | Notes |
|---|---|---|---|
| `$0238` | `XVDU` | ✓ V1.1 | Vector slot: jump to VDU routine. Manual label. |
| `$023B` | `XGETKY` | ✓ V1.1 | Vector slot: `JMP $EB78` (GTORKB direct keyboard read) |
| `$023E` | `XPRTCH` | ✓ V1.1 | Vector slot: jump to printer output routine |
| `$0241` | `XSTOUT` | ✓ V1.1 | Vector slot: jump to status-line output routine |
| `$0244` | `INTFS` | ✓ V1.1 | Vector slot: jump to interrupt handler |
| `$0247` | `NMIJP` | ✓ V1.1 | Vector slot: jump to NMI routine |
| `$024A` | `INTSL` | ✓ V1.1 | Return-from-interrupt slot (normally RTI, patchable to a JMP) |
| `$024D` | `TSPEED` | ✓ V1.1 | Tape speed: `0` = fast, non-zero = slow |
| `$024E` | `KBDLY` | ✓ V1.1 | Initial keyboard auto-repeat delay (IRQ ticks). V1.0 has no configurable auto-repeat — writing to `$024E` on V1.0 has no effect. |
| `$024F` | `KBRPT` | ✓ V1.1 | Subsequent keyboard auto-repeat rate. Same V1.0 caveat as `$024E`. |
| `$0256` | `PWIDTH` | ✓ V1.1 | Printer width (default 80) |
| `$0257` | `VWIDTH` | ✓ V1.1 | Screen width (default 40) |
| `$0270` | `CURON` | — | Cursor on/off flag. Manual label; no direct refs in either ROM (likely written at boot only or accessed via indirect mode). |
| `$0278`–`$0279` | `VDUL2` | ✓ V1.1 | Address of second screen line |
| `$027A`–`$027B` | `VDUL1` | ✓ V1.1 | Address of first screen line |
| `$027C`–`$027D` | `VDUCH` | ✓ V1.1 | Number of characters to scroll (default 26×40 = 1040) |
| `$027E` | `NOROWS` | ✓ V1.1 | Number of rows on screen |

**TIMER3 usage pattern for game timing:**

```asm
        ; Set TIMER3 = N centiseconds.  The 16-bit store must be
        ; atomic w.r.t. the IRQ (which decrements TIMER3): an IRQ
        ; landing between the two STAs would decrement a half-updated
        ; value and a borrow into the MSB would then be lost.
        SEI
        LDA #lsb_of_N
        STA $0276
        LDA #msb_of_N
        STA $0277
        CLI
        ; ... do work ...
wait_loop:
        SEI                ; sample the 16-bit timer atomically.  The
        LDA $0277          ; SEI/CLI bracket MUST be per-iteration, not
        ORA $0276          ; around the whole loop — the IRQ has to keep
        CLI                ; firing between iterations to decrement it.
        BNE wait_loop      ; spin until TIMER3 reaches zero
```

### 5.3 Sound family (the routines that shift by `$1A`)

| Symbol | V1.0 | V1.1b | Verified | Parameters (in `$02Ex`) |
|---|---|---|---|---|
| `SOUND` | `$FB26` | `$FB40` | ✓ both | `E1`, `E3`, `E4`, `E5` |
| `PLAY` | `$FBB6` | `$FBD0` | ✓ both | `E1`, `E3`, `E5`, `E7`, `E8` |
| `MUSIC` | `$FBFE` | `$FC18` | ✓ both | `E1`, `E3`, `E5` |
| `KeyClickH` | `$FAFA` | `$FB14` | | — |
| `KeyClickL` | `$FB10` | `$FB2A` | | — |
| `PING` | `$FA85` | `$FA9F` | | — |
| `SHOOT` | `$FA9B` | `$FAB5` | | — |
| `EXPLODE` | `$FAB1` | `$FACB` | | — |
| `ZAP` | `$FAC7` | `$FAE1` | | — |

`SOUND`, `PLAY`, and `MUSIC` are verified by byte-level cross-reference of the routine bodies: identical parameter-load instructions on both ROMs, internal JSR targets shifted by `$1A` to resolve correctly within each ROM. The four sound-effect routines (`PING`/`SHOOT`/`EXPLODE`/`ZAP`) follow the same `$1A` shift in the `.sym` files but are not independently verified.

Call pattern from machine code, illustrated with `SOUND` (parameter meanings and ranges are in the Oric Atmos manual, Appendix 9):

```asm
        LDA #channel
        STA $02E1       ; PARAMS+1
        LDA #period
        STA $02E3       ; PARAMS+3
        LDA #volume
        STA $02E5       ; PARAMS+5
        JSR $FB40       ; SOUND on V1.1b — patch operand to $FB26 for V1.0
        ; on return $02E0 (PARAMS+0) = 1 if a parameter was out of range
```

### 5.4 Keyboard, IRQ, and Timer routines

Keyboard / IRQ:

| Symbol | V1.0 | V1.1b | Verified | Notes |
|---|---|---|---|---|
| `IRQ` (vector target) | `$ED09` | `$EE22` | ✓ V1.1 | Cf. IRQ vector at `$FFFE` |
| `ReadKbd` (strobe) | `$F43C` | `$F495` | ✓ V1.1 | Internal IRQ keyboard scan |
| `CheckKbd` (GETKEY) | — | `$EB78` | ✓ V1.1 | **V1.1b only** - direct GETKEY |
| `ReadKbdCol` | `$F561` | `$F561` | | |
| `Key2ASCII` | `$F4EF` | `$F4EF` | | |
| `FindKey` | `$F523` | `$F523` | | |

Timer routines (all verified byte-identical between V1.0 and V1.1b at their respective entry points, modulo internal JSR operands; the routines operate on the same page-2 addresses `$0271`-`$0277` on both ROMs):

| Symbol | V1.0 | V1.1b | Verified | Notes |
|---|---|---|---|---|
| `SetupTimer` | `$ECC7` | `$EDE0` | ✓ both (byte signature) | One-time IRQ vector/timer setup |
| `StopTimer` | `$ED01` | `$EE1A` | ✓ both (byte signature) | Disables IRQ-driven timer ticks |
| `ResetTimer` | `$ED70` | `$EE8C` | ✓ both (byte signature) | Zeros all three timer pairs (`$0272`–`$0277`) |
| `GetTimer` | `$ED81` | `$EE9D` | ✓ both (byte signature) | Read a timer; X selects which |
| `SetTimer` | `$ED8F` | `$EEAB` | ✓ both (byte signature) | Write a timer; X selects which |
| `Delay` | `$EDAD` | `$EEC9` | ✓ both (byte signature) | Spin-wait via TIMER3. **V1.0 `.sym` mislabels this as `$E0AD` — see Section 6.** |

For straightforward game timing, directly poking `$0276`/`$0277` (TIMER3) and polling them in a loop is usually simpler than calling the ROM routines — see Section 5.2 for the pattern.

Recommended portable pattern (works on both ROMs):

```asm
        LDA $02DF        ; ICHAR, set by IRQ
        BPL no_key       ; bit 7 clear => no new key
        AND #$7F         ; strip validity flag
        STA keypress
        LDA #0
        STA $02DF        ; consume the event
        ; ... handle keypress ...
no_key:
```

### 5.5 Hardware (AY-3-8912)

| Symbol | V1.0 | V1.1b | Verified |
|---|---|---|---|
| `WriteToAY` | `$F535` | `$F590` | ✓ both |

`WriteToAY` is verified by byte-level cross-reference: both `SOUND` and `PLAY` routines contain `JSR $F535` on V1.0 and `JSR $F590` on V1.1b at corresponding offsets within their bodies, confirming the address is the AY register-write helper on each ROM.

### 5.6 Floating-point operations (USR exchange)

The FAC entry points commonly needed for USR-style argument exchange and for ML routines called from BASIC via `!` or `&`. The V1.0 entries are documented in the Oric-1 manual (Chapter 13, p. 127); V1.1b entries are verified in working code.

Naming note: `FAC2Int` is listed in the orix-software `.sym` files as `FP2Int` — the same routine, just relabelled here for symmetry with `Int2FAC`.

| Symbol | V1.0 | V1.1b | Verified | Notes |
|---|---|---|---|---|
| `Int2FAC` (A=MSB, Y=LSB → FAC) | `$D8D5` | `$D499` | ✓ both (manual + tested) | Caller's contract: `LDA #msb : LDY #lsb : JMP $XXXX` (falls through to RTS). Equivalent to MS BASIC's GIVAYF. Entry-point code differs between ROMs but both honour the same A/Y → FAC contract. |
| `FAC2Int` / unsigned (validates 0..65535) | `$D867` | `$D922` | ✓ both (manual + byte) | FAC → A=MSB, Y=LSB, also `$33` (LSB) / `$34` (MSB). Raises `ILLEGAL QUANTITY` on negative or ≥65536. Both routines are byte-identical except for one internal JSR target. The canonical "FAC to integer" for USR-style argument receipt. |
| `Byte2FAC` (Y=byte → FAC) | `$D3FD` | `$D4B6` | ✓ both (byte signature) | Single-byte → FAC. Useful for `&` functions returning small integer values (the Oric-1 manual's `&` example uses this pattern: `LDY $0268 : JMP $D3FD` to return CURROW as the function's value). |
| `RoundFPA` | `$DEEC` | `$DEF4` | ✓ both (byte signature) | Prepend before truncating conversion if rounding rather than truncating is wanted. (V1.0 `.sym` mislabels this at `$DEF4` — see Section 6.) |
| Signed FAC → int | _(pending)_ | `$D2A9` | ✓ V1.1 | V1.1b writes `$D3` (MSB) / `$D4` (LSB). Allows full signed 16-bit -32768..32767. No A/Y return — read `$D3`/`$D4` manually. Equivalent to MS BASIC's AYINT. V1.0 equivalent not yet recorded. |

**Worked example (USR receiving an integer argument, calling back with an integer result):** the following idiom works on both ROMs by selecting the appropriate `Int2FAC` and `FAC2Int` addresses per ROM at startup-detection time. Cycle counts are identical on both ROMs since only the operand bytes of the two `JSR`s differ.

```asm
        ; entry: USR arg already in FAC ($D0–$D5)
        JSR FAC2Int      ; FAC -> A=MSB, Y=LSB; validates 0..65535
                        ;   patch operand: $D867 (V1.0) or $D922 (V1.1b)
        JSR your_logic  ; your machine code; assume it returns 16-bit in A,Y
        JMP Int2FAC     ; A,Y -> FAC; falls through to RTS, returns to BASIC
                        ;   patch operand: $D8D5 (V1.0) or $D499 (V1.1b)
```

**FP arithmetic internals** (`Normalise`, `AddMantissas`, `UnpackFPA`, `FPAMult10`, `FPADiv10`, `AddToFPA`, `Byte2Hex`, `GetByteExpr`, `GetNumber`, `FPA2Int`) are not included here — they're implementation details of the FAC routines, not designed for external use. See Section 6 if you need their addresses.

### 5.7 Tape I/O (manual-documented)

The Atmos manual (Appendix 9, pp. 267–268) documents these as the publicly-callable tape interface; the lower-level helpers in the orix `.sym` (`SyncTape`, `WriteLeader`, `SetupTape`, `GetTapeParams`, etc.) are internals of these.

| Symbol | V1.0 | V1.1b | Verified | Notes |
|---|---|---|---|---|
| `OUTLED` (write 9-char SYN leader) | (TBD) | `$E75A` | ✓ V1.1 (manual) | Outputs 9 chars of ASCII 16 (SYN) to tape at current speed. Manual-documented. V1.0 likely at `$E6BA` per .sym (`WriteLeader` label). |
| `GETSYN` (sync read) | (TBD) | `$E735` | ✓ V1.1 (manual) | Reads tape bytes until in sync. V1.0 likely `$E696` per .sym (`SyncTape` label). |
| `OUTBYT` (write byte) | `$E5C6` | `$E65E` | | A = byte to write at current speed |
| `RDBYTE` (read byte) | `$E630` | `$E6C9` | | A = byte read at current speed |
| `CSAVE` (keyword target) | `$E7DB` | `$E909` | | |
| `CLOAD` (keyword target) | `$E7AA` | `$E85B` | | |
| `VERIFY` (keyword target) | `$E4F2` | `$E4F2` | | |

Note on tape speed: location `$024D` `TSPEED` controls tape speed (0 = fast, non-zero = slow). This is V1.1b-only per the byte-level check (Section 5.2).

Note on sub-revisions: tape routines saw the largest internal changes between V1.0 and V1.1, and again between V1.1a and V1.1b. Behaviour on V1.1a may differ from V1.1b for the same address. For game code that doesn't need tape, this section is safely ignored.

### 5.8 Graphics (manual-documented)

These are the graphics routines documented in the Atmos manual (Appendix 9, pp. 268–269) as callable from machine code, with parameters passed in `PARAMS+1`, `PARAMS+3`, etc. (i.e. `$02E1`, `$02E3`, etc.). All take `PARAMS+0` (`$02E0`) as the error-return flag (set to 1 on out-of-range error).

| Symbol | V1.0 | V1.1b | Verified | Parameters (in `$02Ex`) |
|---|---|---|---|---|
| `CURSET` | `$EBDF` ⚠ | `$F0C8` | ✓ V1.1 (manual) | `+1` x, `+3` y, `+5` fb |
| `CURMOV` | `$EBE2` ⚠ | `$F0FD` | ✓ V1.1 (manual) | `+1` x, `+3` y, `+5` fb |
| `DRAW` | `$EBE5` ⚠ | `$F110` | ✓ V1.1 (manual) | `+1` x, `+3` y, `+5` fb |
| `CIRCLE` | `$EBE8` ⚠ | `$F37F` | ✓ V1.1 (manual) | `+1` radius, `+3` fb |
| `PATTERN` (`PATRN`) | `$EBEB` ⚠ | `$F11D` | ✓ V1.1 (manual) | `+1` pattern value |
| `CHAR` | `$EBEE` ⚠ | `$F12D` | ✓ V1.1 (manual) | `+1` ASCII char, `+3` charset (0=std, 1=alt), `+5` fb |
| `PAPER` | `$EBF4` ⚠ | `$F204` | ✓ V1.1 (manual) | `+1` colour |
| `INK` | `$EBF7` ⚠ | `$F210` | ✓ V1.1 (manual) | `+1` colour |
| `FILL` | `$EBFA` ⚠ | `$F268` | ✓ V1.1 (manual) | `+1` rows, `+3` cells, `+5` value |
| `POINT` | `$EC45` ⚠ | `$F1C8` | ✓ V1.1 (manual) | `+1` x, `+3` y; returns `+1`=0/1 (background/foreground). **Note: orix `.sym` lists POINT at `$EC45` on V1.1b but Atmos manual says `$F1C8`. Manual should be more authoritative for V1.1b user-facing entry; the .sym address is maybe an internal helper?** |
| `HIRES` | `$E9BB` ⚠ | `$EC33` | | |
| `TEXT` | `$E9A9` ⚠ | `$EC21` | | |
| `LORES` | `$D93D` ⚠ | `$D9DE` | | |
| `HIMEM` | `$E965` ⚠ | `$EBCE` | | |
| `GRAB` | `$E974` ⚠ | `$EBE7` | | |
| `RELEASE` | `$E994` ⚠ | `$EC0C` | | |
| `HiresMode` | `$F920` | `$F920` | | Internal mode-switch — listed as same on both per .sym; byte-check recommended before use |
| `LoresMode` | `$F967` | `$F967` | | Same |

**⚠ Note on V1.0 graphics addresses.** The V1.0 `.sym` lists `CURSET`–`FILL` at 3-byte-spaced addresses `$EBDF`–`$EBFA`, which is a textbook jump-table layout — these addresses are almost certainly JMP-instruction entries that indirect to the real routine code elsewhere in the V1.0 ROM. The labels are likely correct as call targets (JSRing to them does the right thing) but the actual routine bodies live at unlabelled addresses. Byte-level verification of the parameter ABI on V1.0 hasn't been done.

Note on PLOT: the BASIC keyword `PLOT` uses a different column convention on V1.0 vs V1.1b (off-by-one) — `GTVALS` on V1.0 has an extra `INX` before storing the column. This was an oft-used historical signature for runtime ROM detection from BASIC.

### 5.9 Reset / cold-start / vectors

| Symbol | V1.0 | V1.1b | Verified | Notes |
|---|---|---|---|---|
| `NMI vector` | `$FFFA` | `$FFFA` | ✓ both (6502 fixed) | CPU NMI vector. **Assembler: `SYS.NMIVEC`.** |
| `RESET vector` | `$FFFC` | `$FFFC` | ✓ both (6502 fixed) | CPU reset vector; basis of ROM detection (§3). **Assembler: `SYS.RESETVEC`.** |
| `IRQ vector` | `$FFFE` | `$FFFE` | ✓ both (6502 fixed) | CPU IRQ/BRK vector. **Assembler: `SYS.IRQVEC`.** |
| `Reset` (cold-start target) | `$F42D` | `$F88F` | ✓ both | The ROM cold-start entry the reset vector points to; orix `.sym` labels this `Reset`. Basis of detection. **Assembler: `SYS.RESET.V10` / `SYS.RESET.V11`.** |
| `BASICStart` | `$F8AF` | `$F8AF` | | Same address per .sym — byte-check recommended. **Assembler: `SYS.BASICSTART`.** |
| `BASICRestart` | `$F8B5` | `$F8B5` | | Same address per .sym — byte-check recommended. **Assembler: `SYS.BASICRESTART`.** |
| `StartBASIC` | `$ECCC` | `$ECCC` | | Same address per .sym — byte-check recommended. **Assembler: `SYS.STARTBASIC`.** |
| NMI vector target | `$022B` | `$0247` | ✓ both | At `$FFFA/B`. (Deferred — not a built-in `SYS.` symbol; partially overlaps `NMIJP` $0247.) |
| IRQ vector target | `$0228` | `$0244` | ✓ both | At `$FFFE/F`. (Deferred — not a built-in `SYS.` symbol; partially overlaps `INTFS` $0244.) |

### 5.10 Memory landmarks

| Symbol | V1.0 | V1.1b | Verified | `SYS.` |
|---|---|---|---|---|
| `CharSet` (ROM copy) | `$FC70` | `$FC78` | ✓ both | `SYS.CHARSET.V10` / `.V11` |
| `KeyCodeTab` | `$FF70` | `$FF78` | ✓ both | `SYS.KEYCODETAB.V10` / `.V11` |
| 6522 VIA block base | `$0300` | `$0300` | ✓ both | `SYS.VIA` (+ clean regs `SYS.ORB` … `SYS.IER`) |

**Video-mode-dependent areas.** The screen and the two writable charsets addresses depend on the video mode:

| Area | TEXT mode | HIRES mode |
|---|---|---|
| Screen | `$BB80` | `$A000` |
| Standard charset (writable) | `$B400` | `$9C00` |
| Alternate charset (writable) | `$B800` | `$9800` |

The assembler exposes these as `SYS.` labels with a video-mode suffix (`SYS.SCREEN.TEXT` / `SYS.SCREEN.HIRES` etc.) 

**16K vs 48K.** The screen and writable-charset RAM addresses above are for the **48K** Oric. On a 16K machine they are all `−$8000` (e.g. screen `$3B80`, hires `$2000`). The assumbler defines **48K value based labels only**.

#### 6522 VIA registers ($0300-$030F)

Per Atmos manual Appendix 5 (memory map). Used for printer, keyboard scan, sound chip access, and data transfer control. These are hardware addresses fixed by the 6522 chip — identical on both ROMs.

The block base address is exposed as `SYS.VIA` ($0300) for code that wants to address registers by offset.

| Address | Name | Function | Assembler |
|---|---|---|---|
| `$0300` | ORB | Port B output register | `SYS.ORB` |
| `$0301` | ORA | Port A output register | `SYS.ORA` |
| `$0302` | DDRB | Port B data direction register | `SYS.DDRB` |
| `$0303` | DDRA | Port A data direction register | `SYS.DDRA` |
| `$0304` | T1C-L / T1L-L | Timer 1 counter / latch low byte | `SYS.T1CL` (dash dropped) |
| `$0305` | T1C-H | Timer 1 counter high byte | `SYS.T1CH` |
| `$0306` | T1L-L | Timer 1 latch low byte | `SYS.T1LL` |
| `$0307` | T1L-H | Timer 1 latch high byte | `SYS.T1LH` |
| `$0308` | T2C-L / T2L-L | Timer 2 counter / latch low byte (T2 has no separate latch port — same address, dual role) | `SYS.T2CL` **and** `SYS.T2LL` (both → $0308) |
| `$0309` | T2C-H | Timer 2 counter high byte | `SYS.T2CH` |
| `$030A` | SR | Shift register | `SYS.SR` |
| `$030B` | ACR | Auxiliary control register | `SYS.ACR` |
| `$030C` | PCR | Peripheral control register | `SYS.PCR` |
| `$030D` | IFR | Interrupt flag register | `SYS.IFR` |
| `$030E` | IER | Interrupt enable register | `SYS.IER` |
| `$030F` | ORA (no handshake) | Port A output, no handshake | `SYS.ORANH` (invented short form) |

Note: the BASIC ROM uses these heavily for IRQ-driven keyboard scan, sound chip register access (via Port A), and printer output. Direct manipulation by user code can interfere with ROM operation — typically only read for diagnostic purposes or written when bypassing the ROM's keyboard/sound subsystems entirely.

### 5.11 BASIC extension and interop

Routines and vectors used when interfacing ML code with the BASIC interpreter — typically for writing `!` extension commands, `&` extension functions, or BASIC-callable ML routines that parse parameters from the BASIC source text. Documented in the Oric-1 manual Chapter 13 (pp. 127–129).

| Symbol | V1.0 | V1.1b | Verified | Notes |
|---|---|---|---|---|
| `GTVALS` (parse parameters from BASIC text) | `$D996` | `$DA22` | ✓ both (byte signature) | Parses comma-separated X,Y text screen coordinate parameters from the BASIC text following the command, storing results into screen-coordinate variables. Used by `!`-extension commands with positional args like `!X,Y`. V1.0 has an extra `INX` for 1-based PLOT columns (vs 0-based on V1.1b). |
| `SYNCHR` (require specific char) | `$CFDB` | `$D067` | ✓ both (byte signature) | Checks that the next character in BASIC text matches the value in A; raises `SYNTAX ERROR` if not. Used to validate the syntax of `!`-extension commands (e.g. requiring a `;` separator before the string argument). |
| `PRINT` (jump to BASIC PRINT) | `$CB61` | `$CBAB` | ✓ both (byte signature + .sym) | Entry point for the BASIC PRINT statement. Useful for ML extensions that want to delegate string output back to BASIC's print routine. |
| `!VEC` (! command vector) | `$02F5`–`$02F6` | `$02F5`–`$02F6` | ✓ both | `DOKE $2F5, addr` installs an ML routine as the `!` command handler. **Assembler: `SYS.BANGVEC`.** |
| `&VEC` (& function vector) | `$02FC`–`$02FD` | `$02FC`–`$02FD` | ✓ both | `DOKE $2FC, addr` installs an ML routine as the `&` function handler. **Assembler: `SYS.AMPVEC`.** |
| `Byte2FAC` (Y→FAC) | `$D3FD` | `$D4B6` | ✓ both (byte signature) | Convert byte in Y to FAC, then RTS. Useful for `&` functions returning small integer values. |
| User ML scratch area | `$0400`–`$0420` | `$0400`–`$0420` | ✓ both (Oric-1 manual) | 33 bytes of page 4 reserved for short user ML routines per the Oric-1 manual. For longer routines, use anywhere with `HIMEM` lowered to protect it from BASIC. |

The Oric-1 manual's `!` example installs a `PRINT @ X,Y; "text"` command at `$0400`:

```asm
;       ! handler for "PRINT @ X,Y ; string" syntax
$0400:  JSR GTVALS         ; parse "X,Y" into screen coords ($D996 V1.0 / $DA22 V1.1b)
        LDY GCOL            ; AC F8 02 — load parsed column from $02F8
        INY                 ; (+1 moves past INK column; would need to be +2 on Atmos due 1.0 vs 1.1 GTVALS difference)
        STY CURCOL          ; 8C 69 02 — set cursor column to $0269
        LDA GCL : LDY GHC   ; load graphics column low/high from $1F/$20
        STA CURBAS : STY CURBAS+1  ; set cursor base to $12/$13
        LDA #';' : JSR SYNCHR  ; require ';' next in BASIC text
        JMP PRINT           ; hand off to BASIC PRINT
;       installed via:   DOKE #2F5, #400
```

---

## 6. Full symbol dumps and known errata (appendix)

The complete label sets from the orix-software/basic project's `basic10.sym` and `basic11b.sym` files, preserved verbatim. The bulk of these are BASIC interpreter internals (FP arithmetic helpers, parser plumbing, editor and tape state machines) not designed for direct ML use — the curated set in Section 5 is what you'd typically ingest into an assembler. This appendix is for occasions when you need an internal routine that didn't make the cut.

### Suspected V1.0 `.sym` mislabels

Four labels in `basic10.sym` seem to point to wrong content - possibly the result of V1.1b labels being ported by name without re-checking V1.0 addresses, where V1.1's lower-ROM insertions shifted the V1.0 location of a routine. As a yellow-flag heuristic: any V1.0 label that happens to coincide with its V1.1b address might be worth byte-level verification, especially in the FP area (`$D000`–`$E0FF`) and the late-ROM area (`$F800`+).

| Symbol | V1.0 `.sym` says | Correct V1.0 address | How identified |
|---|---|---|---|
| `MusicData` | `$FC5E` | Unknown | V1.0 `$FC5E` contains code (`20 0F F4 8A 10 03 ...`), not the table data at V1.1b `$FC5E` (`00 07 07 06 06 05 ...`). |
| `Reset` | `$F88F` | `$F42D` | V1.0 cold-start vector at `$FFFC/$FFFD` points to `$F42D`. |
| `RoundFPA` | `$DEF4` | `$DEEC` | Byte signature `A5 D0 F0 FB 06 DF 90 F7 ...` matches at `$DEEC` on V1.0. |
| `Delay` | `$E0AD` | `$EDAD` | Byte signature (call SetTimer, call GetTimer, spin until X+Y zero, RTS) matches at `$EDAD` on V1.0. Likely a digit-transposition typo in the `.sym`. |

Authoritative cross-check sources: Whewell's *Advanced User Guide* ROM disassembly for V1.1b; the Bob Maunder Oric-1 disassembly for V1.0.

### Symbol dump format

Format is `address label` per line, hexadecimal address, lowercase — identical to the upstream `.sym` files.

### 6.1 V1.0 (`basic10.sym`)

```
c006 JumpTab
c0ea Keywords
c2ac ErrorMsgs
c3ca FindForVar
c3f8 VarAlloc
c448 FreeMemCheck
c47c PrintError
c4b5 BackToBASIC
c4e3 InsDelLine
c4e0 DeleteLine
c524 InsertLine
c56f SetLineLinkPtrs
c5a2 GetLine
c5f8 ReadKey
c60a TokeniseLine
c6a5 EDIT
c6de FindLine
c719 NEW
c738 CLEAR
c773 LIST
c824 LLIST
c832 LPRINT
c841 FOR
c8c1 DoNextLine
c8fe DoStatement
c91f RESTORE
c93f STOP
c941 END
c91e CONT
c98b RUN
c996 GOSUB
c9b3 GOTO
c9e0 RETURN
ca0a DATA
ca1c FindEndOfStatement
ca1f FindEOL
ca3e IF
ca61 REM
ca78 ON
ca98 Txt2Int
cad2 LET
cb61 PRINT
cb9f NewLine
cc59 SetCursor
cbed PrintString
cc0a CLS
cc8c TRON
cc8f TROFF
ccba GET
ccc9 INPUT
ccfd READ
ce0c NEXT
ce77 GetExpr
ce8b EvalExpr
cfac DoOper
cf74 GetItem
d03c NOT
d059 EvalBracket
cff0 GetVarVal
d087 Compare
d0f2 DIM
d0fc GetVarFromText
d361 DimArray
d3eb GetArrayElement
d47e FRE
d4a6 POS
d401 DEF
d593 STR
d5a3 SetupString
d4fa GetString
d595 GarbageCollect
d730 CopyString
d767 StrCat
d816 CHR
d82a LEFT
d856 RIGHT
d861 MID
d8a6 LEN
d8b5 ASC
d80a GetByteExpr
d867 FP2Int
d938 PEEK
d894 POKE
d89d WAIT
d8ac DOKE
d983 DEEK
d993 Byte2Hex
d9b5 HEX
d93d LORES
d965 RowCalc
da3f SCRN
d9c6 PLOT
da16 UNTIL
daab REPEAT
dada KEY
da6b TxtTest
db92 Normalise
dbb9 AddMantissas
dc79 LN
dd4d UnpackFPA
dda3 FPAMult10
ddbf FPADiv10
d0d0 LOG
de77 PI
def4 RoundFPA
df0b FALSE
df0f TRUE
df04 GetSign
df12 SGN
df31 ABS
df4c CompareFPA
df8c FPA2Int
dfa5 INT
dfcf GetNumber
e076 AddToFPA
e0c1 PrintInt
e22a SQR
e27c ExpData
e2a6 EXP
e313 SeriesEval
e34b RND
e387 COS
e38e SIN
e3d7 TAN
e407 TrigData
e43b ATN
e46f ATNData
e4a8 TapeSync
e4f2 VERIFY
e554 IncTapeCount
e57d PrintSearching
e585 PrintSaving
e58c PrintFName
e594 PrintFound
e5a4 PrintLoading
e5ab PrintVerifying
e5b6 PrintMsg
e5ea ClrStatus
e563 ClrTapeStatus
e5c6 PutTapeByte
e630 GetTapeByte
e696 SyncTape
e6ba WriteLeader
e6ca SetupTape
e725 GetTapeParams
e7aa CLOAD
e903 CLEAR
e7db CSAVE
e80d CALL
e987 STORE
e9d1 RECALL
e87d HiresTest
e905 CheckKbd
e965 HIMEM
e974 GRAB
e994 RELEASE
e9a9 TEXT
e9bb HIRES
ec45 POINT
eccc StartBASIC
edc4 CopyMem
ecc7 SetupTimer
ed01 StopTimer
ed09 IRQ
ed70 ResetTimer
ed81 GetTimer
ed8f SetTimer
e0ad Delay
eee8 WritePixel
eef8 DrawLine
ebdf CURSET
ebe2 CURMOV
ebe5 DRAW
ebeb PATTERN
ebee CHAR
ebf4 PAPER
ebf7 INK
ebfa FILL
ebe8 CIRCLE
f43c ReadKbd
f4ef Key2ASCII
f523 FindKey
f561 ReadKbdCol
f535 WriteToAY
f57b PrintChar
f5d3 ControlChr
f71a ClearLine
f73f Char2Scr
f7e4 PrintA
f7e0 AltChars
f82f PrintStatus
f88f Reset
f8af BASICStart
f8b5 BASICRestart
f920 HiresMode
f967 LoresMode
f960 ResetVIA
f9c9 SetupText
fa14 RamTest
fa85 PING
faa7 PingData
fa9b SHOOT
fabd ShootData
fab1 EXPLODE
facb ExplodeData
fac7 ZAP
fb06 ZapData
fafa KeyClickH
fb1c KeyClickHData
fb10 KeyClickL
fb32 KeyClickLData
fb26 SOUND
fbb6 PLAY
fbfe MUSIC
fc5e MusicData
fc78 CharSet
ff78 KeyCodeTab
```

### 6.2 V1.1b (`basic11b.sym`)

```
c006 JumpTab
c0ea Keywords
c2a8 ErrorMsgs
c3c6 FindForVar
c3f4 VarAlloc
c444 FreeMemCheck
c47c PrintError
c4a8 BackToBASIC
c4d3 InsDelLine
c4e0 DeleteLine
c524 InsertLine
c55f SetLineLinkPtrs
c592 GetLine
c5e8 ReadKey
c5fa TokeniseLine
c692 EDIT
c6b3 FindLine
c6ee NEW
c70d CLEAR
c748 LIST
c7fd LLIST
c809 LPRINT
c816 SetPrinter
c82f SetScreen
c855 FOR
c8c1 DoNextLine
c915 DoStatement
c952 RESTORE
c971 STOP
c973 END
c9a0 CONT
c9bd RUN
c9c8 GOSUB
c9e5 GOTO
ca12 RETURN
ca3c DATA
ca4e FindEndOfStatement
ca51 FindEOL
ca70 IF
ca99 REM
cac2 ON
cae2 Txt2Int
cb1c LET
cbab PRINT
cbf0 NewLine
cc59 SetCursor
ccb0 PrintString
ccce CLS
cd16 TRON
cd19 TROFF
cd46 GET
cd55 INPUT
cd89 READ
ce98 NEXT
cf03 GetExpr
cf17 EvalExpr
cfac DoOper
d000 GetItem
d03c NOT
d059 EvalBracket
d07c GetVarVal
d113 Compare
d17e DIM
d188 GetVarFromText
d361 DimArray
d3eb GetArrayElement
d47e FRE
d4a6 POS
d4ba DEF
d593 STR
d5a3 SetupString
d5b5 GetString
d650 GarbageCollect
d730 CopyString
d767 StrCat
d816 CHR
d82a LEFT
d856 RIGHT
d861 MID
d8a6 LEN
d8b5 ASC
d8c5 GetByteExpr
d922 FP2Int
d938 PEEK
d94f POKE
d958 WAIT
d967 DOKE
d983 DEEK
d993 Byte2Hex
d9b5 HEX
d9de LORES
da0c RowCalc
da3f SCRN
da51 PLOT
daa1 UNTIL
daab REPEAT
dada KEY
daf6 TxtTest
db92 Normalise
dbb9 AddMantissas
dcaf LN
dd51 UnpackFPA
dda7 FPAMult10
ddc3 FPADiv10
ddd4 LOG
de77 PI
def4 RoundFPA
df0b FALSE
df0f TRUE
df13 GetSign
df21 SGN
df49 ABS
df4c CompareFPA
df8c FPA2Int
dfbd INT
dfe7 GetNumber
e076 AddToFPA
e0c5 PrintInt
e22e SQR
e27c ExpData
e2aa EXP
e313 SeriesEval
e34f RND
e38b COS
e392 SIN
e3db TAN
e407 TrigData
e43f ATN
e46f ATNData
e4ac TapeSync
e4e0 GetTapeData
e4f2 VERIFY
e56c IncTapeCount
e57d PrintSearching
e585 PrintSaving
e58c PrintFName
e594 PrintFound
e5a4 PrintLoading
e5ab PrintVerifying
e5b6 PrintMsg
e5ea ClrStatus
e5f5 ClrTapeStatus
e607 WriteFileHeader
e65e PutTapeByte
e6c9 GetTapeByte
e735 SyncTape
e75a WriteLeader
e76a SetupTape
e7b2 GetTapeParams
e85b CLOAD
e903 CLEAR
e909 CSAVE
e946 CALL
e987 STORE
e9d1 RECALL
eaf0 HiresTest
eb78 CheckKbd
ebce HIMEM
ebe7 GRAB
ec0c RELEASE
ec21 TEXT
ec33 HIRES
ec45 POINT
eccc StartBASIC
edc4 CopyMem
ede0 SetupTimer
ee1a StopTimer
ee22 IRQ
ee8c ResetTimer
ee9d GetTimer
eeab SetTimer
eec9 Delay
eee8 WritePixel
eef8 DrawLine
f0c8 CURSET
f0fd CURMOV
f110 DRAW
f11d PATTERN
f12d CHAR
f204 PAPER
f210 INK
f268 FILL
f37f CIRCLE
f495 ReadKbd
f4ef Key2ASCII
f523 FindKey
f561 ReadKbdCol
f590 WriteToAY
f5c1 PrintChar
f602 ControlChr
f71a ClearLine
f77c Char2Scr
f7e4 PrintA
f816 AltChars
f865 PrintStatus
f88f Reset
f8af BASICStart
f8b5 BASICRestart
f920 HiresMode
f967 LoresMode
f9aa ResetVIA
f9c9 SetupText
fa14 RamTest
fa9f PING
faa7 PingData
fab5 SHOOT
fabd ShootData
facb EXPLODE
fad3 ExplodeData
fae1 ZAP
fb06 ZapData
fb14 KeyClickH
fb1c KeyClickHData
fb2a KeyClickL
fb32 KeyClickLData
fb40 SOUND
fbd0 PLAY
fc18 MUSIC
fc5e MusicData
fc78 CharSet
ff78 KeyCodeTab
```

---

## 7. Sources and references

| Source | Purpose | Location |
|---|---|---|
| Whewell, *Advanced User Guide* — ROM disassembly | Definitive V1.1b ROM disassembly with comments (127 pages). The most authoritative single reference for V1.1b. | [PDF mirror](https://library.defence-force.org/books/content/oric_advanced_user_guide_rom_disassembly.pdf) |
| raxiss browsable V1.1 disassembly | Same content as Whewell, hyperlinked HTML — convenient for following cross-references. | [iss.sandacite.com mirror](https://iss.sandacite.com/tools/oric-atmos-rom.html), [raxiss.com](https://raxiss.com/article/id/29-Oric-Rom) |
| ATMOS-ROM.sym65 (6502bench) | Labelled symbol map for SourceGen disassembler. | [GitHub](https://github.com/fadden/6502bench/blob/master/SourceGen/RuntimeData/Oric/ATMOS-ROM.sym65) |
| orix-software/basic | Source for both V1.0 and V1.1b BASIC ROMs, including the `.sym` files used as the basis for this document. | [GitHub](https://github.com/orix-software/basic) |
| Dhebug/Encounter | Defence Force game source, including `code/system_testing.c` with CRC32 fingerprint table of known ROMs in the wild. | [GitHub](https://github.com/Dhebug/Encounter) |
| Oric-Software-Development-Kit / Keyboard-FullMatrix | Reference implementation for hand-rolled multi-key matrix scanning, bypassing ROM. | [GitHub](https://github.com/Oric-Software-Development-Kit/Keyboard-FullMatrix) |
| OSDK (nekoniaow mirror) | Modern Oric SDK; the canonical example of "hardcoded V1.1, no detection" approach. Sound library directly JSRs `$FBD0`/`$FC18`/`$FB40`. | [GitHub](https://github.com/nekoniaow/OSDK) |
| Defence Force forum | Active Oric community; archive of detailed Q&A. The "Atmos ROM 1.1 1st version" thread documents V1.1a's existence and checksum. | [forum.defence-force.org](https://forum.defence-force.org) |

---

*Document compiled from primary-source analysis of the `basic10.rom`, `basic11b.rom`, and `pravetzt.rom` ROM images shipped in the orix-software/basic repository, plus cross-reference against Whewell's V1.1b disassembly and the Defence Force Encounter HD source.*
