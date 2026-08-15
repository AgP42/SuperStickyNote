/**
 * Post-it glyphs. Stored verbatim on the note and rendered natively on the
 * card header, so any single glyph the device font can draw works.
 */
export const ICONS = [
  '❏', '★', '✎', '◷', '☐', '✦', '⚑', '☀', '✉', '❤',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
];

// '❏' (a page/sticky glyph) — the closest text glyph to the plugin's sticker icon.
export const DEFAULT_ICON = ICONS[0];
