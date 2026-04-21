# Oric 6502 Annotation Syntax

Conventions for assembler annotations and tool directives embedded in Oric BASIC `'` (end-of-line comment) sections.

## Container

- All annotations follow Oric BASIC `'`.
- Assembler code annotations pair with a `DATA` statement on the same line — the DATA's values are what the annotation assembles to.
- Declarations (`ORG`, labels, equates) may live on `REM` lines with no DATA attached.
- BASIC back-patch directives live on `CALL` / `POKE` / `DOKE` / `PEEK` / `DEEK` lines.

## Host Line Eligibility

Annotations are only interpreted as assembler input when they appear on a line whose first statement (immediately after the line number) is one of:

- `REM` — single statement per line.  Annotation must consist of valid assembly fragments only (declarations like `ORG`, labels, and equates, separated by `:`).  Human comments are permitted only at the very end of the annotation via `;`.
- `DATA` — single statement per line.  The annotation's assembled bytes overwrite the DATA's values in full — any pre-existing values on the DATA (in any count or format) are replaced by the assembled output.  Annotation must consist of valid assembly fragments only (instructions, and/or `:`-separated local label declarations); trailing `;` comments are permitted.
- `CALL` / `POKE` / `DOKE` / `PEEK` / `DEEK` — any line containing one or more of these tokens (as statements, or as function calls inside expressions).  The annotation is interpreted as back-patch directives only when its first non-whitespace token is `.` or `-:`.

Annotations on lines of any other kind (e.g. `PRINT`, `LET`, `GOTO`) — and REM/DATA lines that violate the single-statement rule above — are treated as human comments and ignored outright.

## Numeric Literals

| Form    | Syntax          | Example       |
|---------|-----------------|---------------|
| Hex     | `$` prefix      | `$BB`, `$9800`|
| Decimal | bare            | `40`, `-10`   |
| Binary  | `%` prefix      | `%01111111`   |
| ASCII   | `'c` (one char) | `'s`, `'A`    |

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

- Always written by label, never as a raw numeric offset.
- Assembler computes the signed byte offset and errors if out of range.

## Comments

- **End-of-line comment:** `;` — everything from `;` to end of annotation is ignored.

## Statement Separator

- `:` separates multiple statements within a single annotation.
- Whitespace around `:` is free.
- One space between mnemonic and operand is required.

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
 95 REM ' .LIVES = $04:.SCRN = $BB80
 96 REM ' ORG $9800
100 DATA #86,01,#84,02       ' STX 1:STY 2          ; save X, Y
105 DATA #A0,00              ' .LOOPA:LDY #0
110 DATA #B1,01              ' LDA (1),Y            ; read from SCRN
120 DATA #85,03              ' STA 3
130 DATA #C6,04              ' DEC LIVES
140 DATA #D0,249             ' BNE LOOPA
150 DATA #60                 ' RTS
200 CALL #9800               ' .LOOPA
210 CALL #9800:CALL #F421    ' .LOOPA:-
220 POKE #04,3               ' .LIVES
```
