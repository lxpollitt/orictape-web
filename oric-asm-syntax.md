# Oric 6502 Annotation Syntax

Conventions for assembler annotations and tool directives embedded in Oric BASIC `'` (end-of-line comment) sections.

## Container

- All annotations follow Oric BASIC `'`.  What counts as the annotation-opening `'` depends on the host line kind (see Host Line Eligibility below); apostrophes that don't match the host's required shape are ordinary literal characters, not annotation markers.
- Assembler code annotations pair with a `DATA` statement on the same line — the DATA's values are what the annotation assembles to.
- Declarations (`ORG`, labels, equates) may live on `REM` lines with no DATA attached.
- BASIC back-patch directives live on `CALL` / `POKE` / `DOKE` / `PEEK` / `DEEK` lines.

## Host Line Eligibility

Annotations are only interpreted as assembler input when they appear on a line whose first statement (immediately after the line number) is one of:

- `REM` — the line is recognised as an assembler host only when the body directly after the `REM` keyword starts with `'` (allowing any whitespace between), i.e. exactly the shape `<line number> REM ' …`.  REM lines whose body starts with anything else — including ordinary comments containing apostrophes like `REM UDG's` or `REM don't touch` — are plain BASIC comments and are left untouched.  When the line is a host, the annotation (everything after the opening `'`) must consist of valid assembly fragments only (declarations like `ORG`, labels, and equates, separated by `:`); human comments are permitted only at the very end via `;`.  Single statement per line.
- `DATA` — single statement per line.  The annotation's assembled bytes overwrite the DATA's values in full — any pre-existing values on the DATA (in any count or format) are replaced by the assembled output.  Annotation must consist of valid assembly fragments only (instructions, and/or `:`-separated local label declarations); trailing `;` comments are permitted.
- `CALL` / `POKE` / `DOKE` / `PEEK` / `DEEK` / `FOR` / `TO` — any line containing one or more of these tokens (as statements, or as function calls inside expressions).  The annotation is interpreted as back-patch directives only when its first non-whitespace token is `.` or `-:`.

Annotations on lines of any other kind (e.g. `PRINT`, `LET`, `GOTO`) — and REM/DATA lines that violate the single-statement rule above — are treated as human comments and ignored outright.

**Bare-line form (type-2 regions).**  For mostly-assembler programs — e.g. converting existing "type 2" sources where lots of lines are pure assembly — a more compact input form is available.  A line whose content begins with `[[` (at the start of the line, immediately after the line number) opens a **bare-line assembler region**; every subsequent line is treated as bare assembler source (no `REM ' ` prefix) until a line beginning with `]]` closes the region.  Inside such a region the line's entire content is passed to the assembler as if it were the annotation body.  Note: Oric BASIC tokenises some 6502 mnemonic substrings into keyword bytes (e.g. `OR` inside `ORG`, `AND` as an instruction), but the tool renders them back losslessly when joining keyword text with adjacent ASCII, so `ORG $9800`, `AND #$0F`, `EOR $04`, etc. all round-trip correctly.  Bare-line regions normally pair with a `[[ DATA <line>` output sink (see *Output Sinks* below).

## Bounded Regions

Two annotation statements — `[[` and `]]` — bound the portion of the program the re-assembler considers.  They are useful when converting an existing program incrementally (process a few lines at a time, leaving the rest untouched), or as a master switch to disable re-assembly across the whole program.

- **`[[`** sets the active state to *on* (from that statement onward).
- **`]]`** sets the active state to *off* (from that statement onward).
- Both are **absolute state setters**, not counted open/close pairs.  `[[` after `[[` is a no-op; `]]` after `]]` is a no-op.  They may each appear any number of times, including multiple on the same annotation.
- Markers themselves emit no bytes and declare no symbols.  They are stripped before the annotation reaches the assembler.
- State tracking is **statement-level**: within a single annotation, `' [[:LDX #0:]]:LDY #5` activates, keeps `LDX #0`, deactivates, and drops `LDY #5`.

**Initial state rule.**  If the program contains at least one `[[` *or* at least one `]]` anywhere in an annotation, the initial state is **off** (nothing is processed until a `[[` activates it).  If the program contains neither marker, the initial state is **on** (the re-assembler processes everything, for full backward compatibility).

**Common patterns.**
- Mark a single conversion region: `[[` at the start line, `]]` at the end line.  Outside the region, the re-assembler does nothing.
- Disable everything: a single `]]` anywhere (typically as the only statement on a REM line near the top).  Initial state is off, `]]` keeps it off, the rest of the program is silently skipped.
- Multiple regions: alternate `[[` and `]]` markers to cover several non-contiguous ranges.

**Where markers may appear.**  Anywhere an annotation is accepted — i.e. `REM`, `DATA`, or `CALL`/`POKE`/`DOKE`/`PEEK`/`DEEK` lines per the Host Line Eligibility rules.  Markers may be combined with other valid annotation statements on the same line (`' [[:LDX #0`, `' .LOOPA:]]`, etc.).

### Parameters on `[[`

`[[` optionally accepts whitespace-separated parameters that configure tool behaviour, e.g. `[[ WORDS` or `[[ BYTES`.  Parameters are case-insensitive (matching mnemonic and `ORG` case handling).  Unknown parameters are errors.

- Parameters install **sticky settings** — they persist across annotations and across `]]` closes, changing only when another `[[ PARAM …` updates them.  A bare `[[` (no params) preserves the prevailing setting and only toggles the active region on.
- `]]` does not carry parameters and does not reset settings; it only toggles the active region off.

Currently defined parameters:

| Parameter        | Effect                                                                 |
|------------------|------------------------------------------------------------------------|
| `WORDS`          | 2-byte operands (ABS/ABX/ABY/IND) render as one 4-hex-digit word: `LDA $9800` → `DATA #AD,#9800`. |
| `BYTES`          | 2-byte operands render as two separate bytes: `LDA $9800` → `DATA #AD,#00,#98`.  **This is the default.** |
| `DATA <line>`    | **Output sink** (type-2 only). All assembled bytes from this `[[`-opened region are concatenated into a single BASIC `DATA` statement on the given line number, rendered byte-per-value as `#XX,#XX,…`.  Pairs with a pre-existing `DATA 0` (or similar placeholder) at the target line; the placeholder's value is overwritten in full.  See *Output Sinks* below. |
| `CSAVE "<name>" [AUTO]` | **Output sink** (type-2 only). Packages the region's assembled bytes as a standalone machine-code TAP block named `<name>`, surfaced in the UI as a new virtual tape (same treatment as a loaded `.tap`).  `AUTO` sets the TAP header's autorun flag.  Name is any non-empty byte string that doesn't contain a NUL (spaces and symbols like `&` are fine).  See *Output Sinks* below. |

Per-line granularity: the render mode applied to a given DATA line is the mode prevailing at the start of its first active statement.  Mid-annotation mode changes (`' LDA $9800:[[ BYTES`) take effect at the next line, not within the current annotation's emission.  In practice, mode changes are best placed on a dedicated REM line.

### Output Sinks

By default, the re-assembler writes assembled bytes back into the originating DATA host lines (per-line DATA mode, one-to-one with the source annotations).  An **output sink** declared on a `[[` marker overrides this for the region it opens, routing every byte the region assembles into a single target location instead.  Output sinks are valid only on line-start (type-2) `[[` markers — not on `[[` inside a `'` annotation (type-1 already has its output path via per-line DATA patching).

Two flavours are supported:

- **`[[ DATA <line>`** — collect the region's bytes into a single DATA statement on the given BASIC line number.  Values are rendered as `#XX,#XX,…` (byte-per-value hex), irrespective of the region's WORDS/BYTES setting; a blob of this form is typically read back by a `FOR I=NAME TO NAME_END : READ X : POKE I,X : NEXT` loop that requires one byte per `READ`.  Gaps between non-contiguous `ORG`s inside the region are zero-filled.  Error if the target line number is not found in the program, or if the target line falls inside the region itself.

- **`[[ CSAVE "<name>" [AUTO]`** — package the region's bytes as a machine-code TAP block named `<name>`.  The tool surfaces the result as a new virtual tape in the tape list, identical in treatment to a loaded `.tap` file — the user can click through to its program, inspect it, or include it via *Build TAP…* for emulator testing.  `AUTO` sets the TAP header's autorun flag, so CLOAD auto-executes from the start address.  Each `applyAssembler` run appends new tapes; existing tapes are never overwritten (close and re-run if you want a clean slate).  The TAP's start address defaults to `$501` if the region has no explicit `ORG`; an explicit `ORG $xxxx` (named or bare) at the region's top overrides this and sets the start address directly.  `endAddr` = last assembled byte + 1.  Gaps between non-contiguous `ORG`s are zero-filled.

**Common rules for output sinks:**

- Output-sink declarations scope to the `[[` that carries them: the region's end is the matching `]]` (or end of program if unclosed).
- Named assembler blocks (`ORG $xxxx .NAME`) and their `NAME` / `NAME_END` labels work normally inside an output-sink region.  For DATA sinks, this lets the user's POKE loop auto-patch its `FOR … TO …` bounds.  For CSAVE sinks, the labels may be referenced from BASIC code elsewhere (e.g. a `CALL NAME` after the TAP has been CLOADed into memory).
- A region that produced no assembled bytes is an error ("`[[ region produced no assembled bytes`").
- For CSAVE specifically, any assembler error **anywhere** in the program suppresses **all** TAP generation for that run — a half-correct machine-code binary is dangerous to run, so we take an all-or-nothing stance.  Per-line type-1 DATA patches are independent of this gate and still apply.

## Numeric Literals

| Form    | Syntax              | Example           |
|---------|---------------------|-------------------|
| Hex     | `$` prefix          | `$BB`, `$9800`    |
| Decimal | bare or signed      | `40`, `-10`, `+5` |
| Binary  | `%` prefix          | `%01111111`       |
| ASCII   | `'c` (one char)     | `'s`, `'A`        |

An explicit leading `+` on decimal literals is accepted (equivalent to the bare positive form) and is useful for branches where a signed literal like `+5` or `-7` reads as an explicit offset.

## Operand Syntax

| Addressing Mode   | Syntax          | Example                          |
|-------------------|-----------------|----------------------------------|
| Immediate         | `#` prefix      | `LDA #$BB`, `LDA #40`, `LDA #'s` |
| Zero-page / abs   | no prefix       | `LDA 4`, `STA $415`              |
| Indexed, X        | `,X` suffix     | `LDA $400,X`                     |
| Indexed, Y        | `,Y` suffix     | `STA $BB80,Y`                    |
| Indirect indexed  | `(zp),Y`        | `LDA (4),Y`                      |
| Indexed indirect  | `(zp,X)`        | `LDA ($80,X)`                    |
| Indirect (JMP)    | `(addr)`        | `JMP ($FFFC)`                    |
| Accumulator       | `A` or implicit | `ASL A` or `ASL`                 |

Zero-page vs. absolute is chosen automatically from operand size (fits in one byte → ZP) unless explicitly forced by writing the operand with a leading zero, e.g. `LDA $0004`.

## Labels

- **Declaration:** `.LABEL` at the start of a statement.
- **Reference** (in assembler code): bare `LABEL`.
- Characters: letters, digits, underscore. Must start with a letter.

## Equates

- **Declaration:** `.LABEL = value`, where `value` is any numeric literal.
- **Reference** (in assembler code): bare `LABEL`.

## Directives

- `ORG $xxxx` — set assembly address. May appear multiple times for non-contiguous code.
- `ORG $xxxx .NAME` — set assembly address **and** open a named assembler block.  Declares two labels: `NAME` (= start address = `$xxxx`) and `NAME_END` (= inclusive last byte emitted in the block).  The block closes — and `NAME_END` gets its value — when the next `ORG` (with or without a name), a zero-output DATA line, a `]]` close marker, or the end of the program is reached.  Useful for `FOR`-loop back-patching (`FOR I=NAME TO NAME_END`) so POKE/DOKE loops stay in sync with the assembled code.  The `.NAME` suffix is case-sensitive (labels are case-sensitive generally).
- `ORG` is required if any label is referenced in an absolute addressing context (`JMP LABEL`, `JSR LABEL`, `LDA LABEL` in ABS form, etc.) or by a back-patch directive. Programs that use only equates, relative branches, and REL-only label references may omit `ORG`.
- `DB <value>[,<value>...]` — define data bytes.  Emits one or more bytes inline at the current PC, advancing PC past them like an instruction would.  Useful for tables, strings, and pointer arrays alongside instruction code.  Value forms (mixable in one `DB`):
  - **Hex** `$XX` (1–2 digits) → 1 byte; `$XXX[X]` (3–4 digits) → 2 bytes little-endian.
  - **Decimal** unsigned (`123`): 1 byte if value ≤ 255 AND ≤ 3 digits; otherwise 2 bytes little-endian.  Leading zero (`0120`, `0001`) forces 2 bytes — matches the hex digit-count convention.
  - **Decimal** signed (`+5`, `-1`): 1 byte if value in `-128..127` AND ≤ 3 digits (excluding sign), encoded 2's-complement; otherwise 2 bytes little-endian, range `-32768..32767`.  Use `+255` to opt into "signed and therefore must be a word".
  - **Binary** `%01011` → 1 byte.  1–8 bits accepted (shorter just zero-pads); more than 8 bits is an error.
  - **String** `"hello"` → one byte per char.  Printable ASCII only (`0x20..0x7E`); non-printable characters are an error.  No escape sequences, no terminator.  Strings can contain `:`, `;`, `,`, `'`, `*` as ordinary chars (the splitter is string-aware).
  - **Identifier** `LABEL` → 2 bytes little-endian word, resolved at the second pass.  Same anchoring rule as ABS instruction operands — the label's block must have an `ORG`.

  The DATA-line renderer always emits each `DB` byte as its own `#XX` value regardless of the region's WORDS/BYTES setting (DB output is byte-oriented and one-POKE-per-value compatible).

## Assembler Blocks

The re-assembler treats the annotated lines of a program as one or more **assembler blocks** — contiguous runs of assembled instructions (and the labels/equates declared alongside them) that share a single program counter.  Every block is either **ORG-declared** (anchored to a specific memory address via an `ORG $xxxx`) or undeclared (useful only for relative-only uses — see below).

**What ends the current block.**  A DATA line whose annotation produces **no assembled output** — because the annotation is empty, consists only of a `*` comment, or declares labels/equates without any instruction — ends the current block.  Its raw DATA values still occupy memory somewhere, but the assembler has no information about which address, so the block cannot continue through that line.  The next annotated line after it belongs to a new block.

**ORG declarations.**  An `ORG $xxxx` anchors a block at the specified memory address.  If a block has no `ORG` (e.g. the program starts with assembly that never declares one, or the previous block ended and no `ORG` has appeared yet), the block is undeclared.

**ORG is required for.**  Any use of a block's labels in:

- An absolute addressing context — `JMP LABEL`, `JSR LABEL`, `LDA LABEL` (ABS form), etc.
- A back-patch directive — `.LABEL` on a `CALL` / `POKE` / `DOKE` / `PEEK` / `DEEK` line.

Using a label whose block has no `ORG` in either of these contexts is an error.  Blocks that use only equates, relative branches, and REL-only label references may omit `ORG` entirely.

**Relative branches stay within the block.**  `BNE LABEL`, `BEQ LABEL`, etc. must branch to a label in the **same block** as the branch.  A branch that would cross a block boundary is an error — the signed-byte offset would be meaningless.  REL to a label in the same block is valid whether the block has an `ORG` or not.

**Skipping non-code lines.**  A bounded-region skip (`]]` before the non-code line and `[[` after it) removes the line from the assembler's view entirely, so the current block continues across it.  This is how you tell the tool "these DATA values aren't assembly — please ignore them for assembly purposes".

**Strict vs lenient enforcement.**  The behaviour above is the *lenient* default and applies when the program contains no `[[` / `]]` markers anywhere (full backward compatibility).  When the program does contain markers, the tool switches to **strict mode**: a DATA line inside an active region that produces no assembled output is a **hard error** at that line, rather than silently ending the block.  The rationale: `[[` is the user declaring "everything in this region is assembler"; a no-output DATA line inside is almost certainly a mistake (forgotten annotation, typo'd mnemonic that parsed as a comment, or stray non-code DATA that should have been skipped).  The fix is one of: annotate with instructions, skip it with `]]` and `[[`, or move any pure directive (`ORG`, label, equate) onto a REM line.

## Branches

- Normally written by label; the assembler computes the signed byte offset from the label's address to the branch and errors if out of range (±127 bytes from PC+2).

- Numeric operands are interpreted by **input width**, not by value:
  - A **2-byte input** (hex with 3+ digits like `$9800` or `$0004`) is a **target address**.  The assembler computes the offset from the branch's PC+2 to the target, and errors if it doesn't fit in a signed byte.
  - A **1-byte input** is a **direct signed offset byte**, emitted as written with format preservation:
    - **Hex** 1-2 digits (`$EF`, `$04`): value range [0, 255].
    - **Decimal** (signed with `+`/`-` or bare positive): value range **[-128, +127]**.  Decimal values outside this range error — `BNE 249` must be written as `BNE -7` or `BNE $F9`; `BNE 300` must use a hex literal or a label.

## Comments

- **End-of-annotation comment:** `*` — everything from `*` to end of annotation is ignored.  (Chosen to match the convention used by pre-existing Oric assembler tooling, and to leave `;` free as a statement separator alongside `:`.)

## Statement Separator

- `:` **or** `;` separates multiple statements within a single annotation; both are accepted interchangeably.  Historical Oric assembler programs commonly use `;`; `:` mirrors Oric BASIC's own statement separator.  Pick whichever reads best for the context.
- Whitespace around the separator is free.
- One space between mnemonic and operand is required.

**Important runtime note for DATA-line annotations.**  Oric-1 BASIC interprets `:` inside a DATA-line annotation as a statement separator **at run time**, which generally produces `?SYNTAX ERROR` when the program is RUN (because the text after `'` then fails to parse as a valid BASIC statement).  `;` and `*` do not trigger this.  Two safe options for DATA-line annotations that need multiple statements or a comment:

- Prefer `;` as the statement separator and `*` for the comment on DATA-line annotations.
- Or structure the program so DATA statements aren't executed (e.g. `GOTO` past them from an entry point elsewhere).  DATA statements that are only read via `READ` from outside don't need to parse cleanly.

The tool accepts `:` on DATA-line annotations as input without complaint, and preserves user annotations verbatim on output — it's up to the program's author to avoid runtime issues.

## BASIC Back-Patch Directives

On a line containing one or more `CALL`, `POKE`, `DOKE`, `PEEK`, `DEEK`, `FOR`, or `TO` tokens (as statements or as function calls inside expressions), the annotation carries back-patch directives: `.LABEL` replaces the address literal at a patch site with the resolved label address; `-` is a placeholder meaning "don't patch this site".

- **Patch sites.**  Each occurrence of `CALL`, `POKE`, `DOKE`, `PEEK`, `DEEK`, `FOR`, or `TO` on the line is a patch site, in BASIC-source order.  The site's literal is the first numeric constant immediately following the verb token (after the opening `(` for `PEEK`/`DEEK`, or after the `=` for `FOR`), terminated by the first `,`, `)`, `:`, BASIC operator, or end-of-line.  A `FOR var=<start> TO <end>` loop therefore contributes **two** patch sites — one for the start address (paired with the FOR's literal) and one for the end address (paired with the TO's literal).
- **Positional pairing.**  Directives pair 1:1 with patch sites, using `:` as the separator (mirroring BASIC's `:`).  A count mismatch is an error — use `-` to skip positions.
- **Size.**  Every patch site holds a 16-bit address.
- **Non-literal sites.**  If a patch site's argument is a variable or expression (not a numeric constant), only `-` is valid; `.LABEL` on such a site is an error.
- **Format preservation.**  If the original literal was hex (e.g. `#04`, `#9800`), the patched value is written back as hex in `#XXXX` form (uppercase, 4 digits).  If the original literal was decimal, the patched value is written as decimal with no leading zeros.

**Typical `FOR` pattern.**  POKE loops that transfer machine code from DATA into memory pair neatly with named assembler blocks (see `ORG $xxxx .NAME`):

```basic
 10 REM ' ORG $9800 .BLOCKA
 20 DATA ... ' ...instructions...
...
 90 REM ' ORG $9900 .BLOCKB       * closes BLOCKA
 ...
500 FOR I=#9800 TO #9821 : READ X : POKE I,X : NEXT ' .BLOCKA:.BLOCKA_END:-
```

On the FOR line, the two patch sites are the `#9800` (after `=`) and the `#9821` (after `TO`); the three directives (`.BLOCKA`, `.BLOCKA_END`, `-`) pair with FOR-start, TO-end, and the POKE's address (skipped because `I` is a variable, not a literal).

## Identifier Rules

- Any identifier appearing at the start of an annotation-level statement is interpreted by the tool:
  - `.LABEL` (bare)  →  code-label declaration
  - `.LABEL = value` →  equate declaration
  - `.LABEL` on a BASIC statement line →  back-patch directive
- Bare identifiers inside assembler code are label/equate references.
- Annotations whose first non-whitespace token is none of the above (and not a mnemonic, `;`, `ORG`, `:`, or `-`) are treated as human comments and ignored.

## Deferred (if ever needed)

- Expressions with `+ - * /` between literals and labels.
- Low/high byte operators `<expr` and `>expr`.
- Label offset references, e.g. `.LABEL+3`.

## Worked Example

```basic
 95 REM ' .LIVES = $04;.SCRN = $BB80
 96 REM ' ORG $9800
100 DATA #86,01,#84,02       ' STX 1;STY 2          * save X, Y
105 DATA #A0,00              ' .LOOPA;LDY #0
110 DATA #B1,01              ' LDA (1),Y            * read from SCRN
120 DATA #85,03              ' STA 3
130 DATA #C6,04              ' DEC LIVES
140 DATA #D0,249             ' BNE LOOPA
150 DATA #60                 ' RTS
200 CALL #9800               ' .LOOPA
210 CALL #9800:CALL #F421    ' .LOOPA:-
220 POKE #04,3               ' .LIVES
```

DATA-line annotations in the worked example above use `;` as the statement separator and `*` for the inline comment — both runtime-safe on a DATA line.  The CALL line at 210 uses `:` because the `:` convention matches BASIC's own statement separator on that (non-DATA) line, and at runtime a CALL line doesn't choke on `:` the way DATA lines do.  Either separator is accepted by the tool on any line.
