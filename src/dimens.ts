/**
 * One scale for the whole Manager, so it keeps the proportions of Supernote's
 * own apps on every device.
 *
 * Every token below is a dp value MEASURED on the native Digest screen of a
 * 1920x2560 @300dpi device, which Android reports as 1024 x 1365 dp. On any
 * other machine (A5X/A6X report 994 x 1325, smaller ones less) the tokens are
 * scaled by the ratio of the shortest edge, which is what Ratta's own demo
 * plugin does with its per-device table.
 *
 * Read once at import: StyleSheet.create() below runs once too, so a rotation
 * keeps the scale it started with. The Manager is a portrait-first panel and
 * the shortest edge does not change when the device turns, so this only matters
 * for a device we have never seen.
 */
import {Dimensions} from 'react-native';

/** dp width of the screen the tokens were measured on. */
const REF_WIDTH = 1024;

function currentScale(): number {
  try {
    const {width, height} = Dimensions.get('window');
    const shortest = Math.min(width, height);
    if (!shortest || !isFinite(shortest)) return 1;
    return shortest / REF_WIDTH;
  } catch {
    return 1;
  }
}

const k = currentScale();

/** A measured dp value, scaled to this device. */
export const dp = (n: number): number => Math.round(n * k * 10) / 10;

/**
 * The tokens. Frames are hairlines: the native chrome draws its borders at
 * ~1.25 dp, not the 2 dp we used everywhere, which is why our panel read twice
 * as heavy as the apps around it. 2 dp is kept for ONE job: marking a selection.
 */
export const T = {
  // Strokes
  hair: dp(1.25),
  sel: dp(2),
  // Radii: cards are soft, rows and rails are square, only chips are pills.
  radCard: dp(8),
  radCtl: dp(6),
  radPill: 999,
  // Frame
  pad: dp(22),
  header: dp(71),
  rail: dp(268),
  railRow: dp(71),
  actionBar: dp(76),
  pager: dp(64),
  tap: dp(44),
  // Cards
  cardPadV: dp(14),
  cardPadH: dp(16),
  gap: dp(15),
  // Type scale: seven sizes, and weight carries the emphasis, not size.
  fsTitle: dp(24),
  fsSection: dp(21),
  fsNote: dp(20),
  fsRail: dp(20),
  fsBody: dp(19),
  fsMeta: dp(16),
  fsChip: dp(15),
  lhBody: dp(26),
  // Rows inside a card, fixed so every card is the same height and a page of
  // them can be counted exactly instead of scrolled.
  cardTitleH: dp(30),
  // Tall enough for a label chip to keep its own height: at dp(22) the row
  // squeezed the chips flat and the text inside them was unreadable.
  cardMetaH: dp(32),
};

/**
 * Every card is this tall — title line, exactly two snippet lines, meta line.
 * A short note keeps the empty space rather than shrinking, so the pager can
 * divide the list by a constant instead of measuring each row.
 */
export const CARD_H =
  T.cardPadV * 2 +
  T.cardTitleH +
  dp(6) +
  T.lhBody * 2 +
  dp(8) +
  T.cardMetaH +
  T.hair * 2;

/**
 * The action row that unfolds under the SELECTED card. A page always reserves
 * this much room, so unfolding one card can never push the last one off the
 * bottom.
 */
export const ACTION_H = T.tap + dp(12);

export const BLACK = '#000000';
export const WHITE = '#FFFFFF';
/** The only non-black ink: the dotted rules between rows, as the native lists draw them. */
export const DOTTED = '#9A9A9A';
