/**
 * Oric-1 / Oric Atmos character-set conversion.
 *
 * The Oric's text character set is standard 7-bit ASCII for codes
 * 0x20–0x7E with **two** semantic deviations (verified against the
 * Oric-1 manual's A.S.C.I.I. table):
 *
 *   - byte 0x5F → `£`  (ASCII would be `_` underscore)
 *   - byte 0x60 → `©`  (ASCII would be `` ` `` grave/backtick)
 *
 * Design principle: we model *semantic* character deviations, not
 * font/glyph-style differences.  Byte 0x5E is drawn as an up-arrow by
 * the Oric ROM, but it's the same logical character as ASCII `^`
 * (the caret key); reproducing the up-arrow would be chasing the
 * font, which we don't do (we don't reproduce the Oric pixel font
 * either).  Byte 0x7E is a hatched block in the ROM, but the Oric-1
 * and Atmos manuals disagree on it (unspecified vs "blank"), so it's
 * treated as the ASCII `~` font-bucket, not a stable semantic char.
 * 0x5B is confirmed standard `[`.  See oric-asm-syntax.md §Labels
 * "Character set".
 *
 * `£` is a real Oric keyboard key; `©` was not keyboard-typeable on
 * the Oric (it could only reach a program via POKE/CHR$).  We model
 * it anyway: this is a recovery/inspection tool, the cost is one map
 * entry, and on the rare occasion byte 0x60 lands in a PRINTed string
 * the BASIC view should show the truth (`©`) rather than mislead with
 * a backtick.  Modelling it also *adds* an authoring path the real
 * Oric lacked (`'©`, `DB "©"`), consistent with how we treat `£`.
 *
 * The point of the module is the *single source of truth*: five
 * conversion sites (BASIC line render, BASIC line-edit input,
 * program-name render, assembler `'c` literal, assembler `DB "..."`)
 * all route through here so they cannot drift apart and the
 * round-trip invariant (`byte → char → byte` is identity over the
 * printable range) is guaranteed.  A further deviation is a one-line
 * `ORIC_DEVIATIONS` addition rather than a five-site hunt.
 *
 * Consequence for the assembler annotation DSL: because byte 0x5F is
 * `£` (not `_`), the inline-assembler identifier alphabet excludes
 * underscore, and the auto-synthesised block-end label uses a `.`
 * member separator (`NAME.END`) — see oric-asm-syntax.md §Labels.
 */

/** Bytes whose Oric display glyph differs semantically from ASCII.
 *  Bidirectional source of truth; everything not listed is identity
 *  over 0x20–0x7E. */
const ORIC_DEVIATIONS: ReadonlyMap<number, string> = new Map([
  [0x5F, '£'],
  [0x60, '©'],
]);

/** Reverse map (glyph → byte).  Also tells us which ASCII codepoints
 *  are *displaced* (0x5F, 0x60): their ASCII glyphs (`_`, `` ` ``) have
 *  no Oric representation and must be rejected on input. */
const ORIC_GLYPH_TO_BYTE: ReadonlyMap<string, number> = new Map(
  [...ORIC_DEVIATIONS].map(([b, c]) => [c, b]),
);

/** Map an Oric byte (0x00–0xFF) to its display character.  Only the
 *  ORIC_DEVIATIONS bytes differ from `String.fromCharCode`; everything
 *  else (including control bytes — callers decide whether to escape
 *  those) passes through identically. */
export function oricByteToChar(b: number): string {
  return ORIC_DEVIATIONS.get(b) ?? String.fromCharCode(b);
}

/** Map a display character to its Oric byte, or `null` if the
 *  character has no representation in the Oric character set.
 *
 *  - An Oric deviation glyph (`£`, `©`) maps to its byte (0x5F, 0x60).
 *  - A character whose codepoint is a *displaced* ASCII slot (0x5F
 *    `_`, 0x60 `` ` ``) returns `null`: those glyphs aren't on the
 *    Oric — the slot holds `£` / `©`.  Accepting them would silently
 *    substitute the Oric glyph, more surprising than rejecting (and
 *    consistent with how the editor drops other non-representable
 *    input).  `«0xNN»` remains the universal byte-escape, including
 *    for 0x5F / 0x60.
 *  - Otherwise identity for 0x00–0x7E. */
export function oricCharToByte(ch: string): number | null {
  const dev = ORIC_GLYPH_TO_BYTE.get(ch);
  if (dev !== undefined) return dev;
  const code = ch.charCodeAt(0);
  if (ORIC_DEVIATIONS.has(code)) return null;  // displaced ASCII slot
  return code >= 0x00 && code <= 0x7E ? code : null;
}
