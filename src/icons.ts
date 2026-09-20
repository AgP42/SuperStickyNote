/**
 * Post-it glyphs. Stored verbatim on the note and rendered natively on the
 * card header, so any single glyph the device font can draw works.
 */
export const ICONS = [
  '❏', '★', '✎', '◷', '☐', '✦', '⚑', '☀', '✉', '❤',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
];

// The pencil: a new sticky is something you are about to write on. '❏' read as
// an empty checkbox on the device, which promised a to-do the plugin doesn't do.
export const DEFAULT_ICON = ICONS[2]; // '✎'
