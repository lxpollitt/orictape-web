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
- `CALL` / `POKE` / `DOKE` / `PEEK` / `DEEK` — any line containing one or more of these tokens (as statements, or as function calls inside expressions).  The annotation is interpreted as back-patch directives only when its first non-whitespace token is `.` or `-:`.

Annotations on lines of any other kind (e.g. `PRINT`, `LET`, `GOTO`) — and REM/DATA lines that violate the single-statement rule above — are treated as human comments and ignored outright.

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
- `ORG` is required if any label is referenced in an absolute addressing context (`JMP LABEL`, `JSR LABEL`, `LDA LABEL` in ABS form, etc.) or by a back-patch directive. Programs that use only equates, relative branches, and REL-only label references may omit `ORG`.

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

On a line containing one or more `CALL`, `POKE`, `DOKE`, `PEEK`, or `DEEK` tokens (as statements or as function calls inside expressions), the annotation carries back-patch directives: `.LABEL` replaces the address literal at a patch site with the resolved label address; `-` is a placeholder meaning "don't patch this site".

- **Patch sites.**  Each occurrence of `CALL`, `POKE`, `DOKE`, `PEEK`, or `DEEK` on the line is a patch site, in BASIC-source order.  The site's literal is the first numeric constant immediately following the verb token (after an opening `(` in the function-call cases), terminated by the first `,`, `)`, `:`, BASIC operator, or end-of-line.
- **Positional pairing.**  Directives pair 1:1 with patch sites, using `:` as the separator (mirroring BASIC's `:`).  A count mismatch is an error — use `-` to skip positions.
- **Size.**  Every patch site holds a 16-bit address.
- **Non-literal sites.**  If a patch site's argument is a variable or expression (not a numeric constant), only `-` is valid; `.LABEL` on such a site is an error.
- **Format preservation.**  If the original literal was hex (e.g. `#04`, `#9800`), the patched value is written back as hex in `#XXXX` form (uppercase, 4 digits).  If the original literal was decimal, the patched value is written as decimal with no leading zeros.

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
