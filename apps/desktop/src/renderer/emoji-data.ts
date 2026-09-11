import shortcodes from './emoji/shortcodes.json';
import type { EmojiPair } from './emoji-utils';

/**
 * The generated emoji tables, and the one place that decides what is paid for
 * when.
 *
 * Both files come out of `scripts/build-emoji-data.mjs` and are committed, so
 * a checkout builds without emojibase-data installed. They are split because
 * they are wanted at different moments:
 *
 * - `shortcodes.json` (~39 KB) is consulted on every keystroke after a colon
 *   and on every send, so it is imported normally and rides in the bundle.
 * - `catalog.json` (~200 KB) is only ever wanted by the browse picker, so it
 *   arrives through a dynamic import the first time one is opened. Five times
 *   the size for something most messages never touch is exactly the trade the
 *   YouTube poster and `preload="none"` already make elsewhere in this app.
 */

// Through `unknown` because TypeScript reads the JSON as `string[][]` and
// cannot see that every row has exactly two entries. The generator is what
// guarantees it, and this is the seam where that guarantee is asserted.
export const EMOJI_PAIRS = shortcodes as unknown as EmojiPair[];

/**
 * Shortcode to emoji.
 *
 * Built once from the pairs rather than shipped as a second copy of them: the
 * array has to be an array because its order is the ranking, and two thousand
 * entries is nothing to walk once at startup.
 */
const byShortcode = new Map<string, string>(EMOJI_PAIRS);

export function emojiFor(shortcode: string): string | undefined {
  return byShortcode.get(shortcode);
}

/* ------------------------------------------------------------- catalog */

/** One emoji as the browse picker draws it. Keys are short because there are
 * two thousand of them and the names would be a third of the file. */
export interface CatalogEntry {
  /** The character, already canonical -- see the generator. */
  u: string;
  /** "grinning face". What the search box matches on, with the tags. */
  l: string;
  /** emojibase group, 0-9: smileys, people, nature, food, and so on. */
  g: number;
  t?: string[];
  /** The name to show under it, absent for the few GitHub never named. */
  s?: string;
}

/**
 * Group number to the name a picker puts above it.
 *
 * Sparse, and deliberately not an array: emojibase's group 2 is the component
 * group -- bare skin-tone and hair modifiers -- which the generator drops, so
 * the numbers the catalog actually carries run 0, 1, 3, 4 … 9 with a hole in
 * them. An array indexed by group would quietly label everything after the
 * hole with the name of the category before it.
 */
export const EMOJI_GROUPS: Record<number, string> = {
  0: 'Smileys & Emotion',
  1: 'People & Body',
  3: 'Animals & Nature',
  4: 'Food & Drink',
  5: 'Travel & Places',
  6: 'Activities',
  7: 'Objects',
  8: 'Symbols',
  9: 'Flags',
};

/** The order the picker walks them in, which is the order they are stored in. */
export const EMOJI_GROUP_ORDER = [0, 1, 3, 4, 5, 6, 7, 8, 9] as const;

let catalog: CatalogEntry[] | null = null;
let loading: Promise<CatalogEntry[]> | null = null;

/**
 * The full table, fetched once and kept.
 *
 * The in-flight promise is held as well as the result, so a picker opened
 * twice before the first load lands does not start a second one.
 */
export function loadEmojiCatalog(): Promise<CatalogEntry[]> {
  if (catalog) return Promise.resolve(catalog);
  loading ??= import('./emoji/catalog.json').then((mod) => {
    catalog = mod.default as CatalogEntry[];
    return catalog;
  });
  return loading;
}

/** What has already been loaded, for a first render that must not wait. */
export function loadedEmojiCatalog(): CatalogEntry[] | null {
  return catalog;
}
