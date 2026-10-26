/**
 * Post-it glyphs. Stored verbatim on the note and rendered natively on the
 * card header, so any single glyph the device font can draw works.
 */
/**
 * The plugin's own glyph — a note with a folded corner, like its icon. Not a
 * character: the card and the Manager draw it (no font has it).
 */
export const STICKY_ICON = 'sticky';

export const ICONS = [
  STICKY_ICON, '★', '◷', '☐', '✦', '⚑', '☀', '✉', '❤', '♪',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
];

// The plugin's sticky note. Not the pencil any more: ✎ is now the card's
// "write with the pen" button, and a pencil icon beside it read as a second
// one. ('❏' read as an empty checkbox on the device.)
export const DEFAULT_ICON = STICKY_ICON;

/** Before 3.0.2 the default was the pencil: those notes get the sticky icon. */
export const OLD_DEFAULT_ICON = '✎';
