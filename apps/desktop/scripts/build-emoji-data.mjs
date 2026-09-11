/**
 * Turns emojibase into the two files the renderer actually ships.
 *
 * Run with `npm run emoji:build --workspace @isthislegit/desktop`. The output is
 * committed, so a normal checkout builds without emojibase-data installed and
 * nothing derives 600 KB of JSON at app start. This is the same bargain Prisma's
 * generated client makes: a generator in the tree, its output in the tree, and
 * one command that puts them back in step.
 *
 * Two files rather than one, because they are paid for at different times:
 *
 * - `shortcodes.json` is needed on every keystroke after a `:` and on every
 *   send, so it is imported normally and lands in the main bundle.
 * - `catalog.json` is needed the first time somebody opens the browse picker,
 *   so it is behind a dynamic import and costs nothing until then. It is five
 *   times the size, which is the whole reason for the split.
 *
 * Regenerate after bumping emojibase-data. The Unicode version it carries has
 * to be one the *server* also understands -- see `canonicalEmoji` in
 * packages/shared, which validates against the runtime's own Unicode tables.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import compact from 'emojibase-data/en/compact.json' with { type: 'json' };
import githubShortcodes from 'emojibase-data/en/shortcodes/github.json' with { type: 'json' };

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../src/renderer/emoji');

/**
 * One spelling per emoji.
 *
 * A copy of `canonicalEmoji` from packages/shared, and it has to stay in step
 * with it: this decides how an emoji is spelled in message text, and that one
 * decides how it is spelled in a reaction key. Two spellings would mean a
 * message and a reaction carrying the same emoji as different strings.
 *
 * Duplicated rather than imported for the reason `compareVersions` is -- the
 * desktop app imports nothing from packages/shared -- and this script is the
 * one place on this side that needs it, because after it runs the data is
 * already canonical and the renderer never has to think about it again.
 *
 * emojibase hands out the fully-qualified form, so roughly two thirds of these
 * arrive carrying a U+FE0F that RGI does not want. See the shared copy for why
 * that matters and what it breaks.
 */
const RGI = /^\p{RGI_Emoji}$/v;
function canonicalEmoji(input) {
  const bare = input.replace(/️/g, '');
  if (RGI.test(bare)) return bare;
  if (RGI.test(input)) return input;
  const qualified = bare + '️';
  return RGI.test(qualified) ? qualified : null;
}

/**
 * The groups a picker draws, which is emojibase's 0-9 with two holes in it.
 *
 * An entry with no group at all is a regional indicator letter -- the halves
 * flags are built from. Group 2 is emojibase's *component* group: the five
 * bare skin-tone modifiers and the four hair ones. Both are pieces of emoji
 * rather than emoji, and a grid offering U+1F3FD on its own is offering
 * somebody half a gesture.
 *
 * Numbered 2 and sitting between "People & Body" and "Animals & Nature", which
 * is the trap -- read as a run from 0 to 9 it looks like a category and draws
 * as nine meaningless swatches.
 */
const COMPONENT_GROUP = 2;
const LAST_GROUP = 9;

/**
 * A flag built out of regional indicator letters, or out of tag characters.
 *
 * Windows has no glyphs for these. Segoe UI Emoji ships no country flags at
 * all -- deliberately, and it has been that way for a decade -- so Chromium
 * falls back to drawing the indicator letters themselves and 🇬🇧 comes out as
 * "GB". That is 262 of the 270 entries in the Flags group, and a category
 * where every tile is a pair of capital letters reads as a broken picker.
 *
 * So they are kept out of the grid and left in the shortcode table. Browsing
 * is where the letters would be a surprise; typing `:gb:` is deliberate, and
 * the character that goes into the message is correct whatever this machine
 * can draw. The eight real flags in that group -- chequered, pirate, rainbow
 * and the rest -- are ordinary glyphs and stay.
 *
 * If this app ever runs somewhere with a font that has them, deleting this is
 * the whole change.
 */
function isCodepointFlag(emoji) {
  for (const ch of emoji) {
    const cp = ch.codePointAt(0);
    // Regional indicators A-Z, and the tag characters subdivision flags use.
    if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return true;
    if (cp >= 0xe0060 && cp <= 0xe007f) return true;
  }
  return false;
}

const byHexcode = new Map(compact.map((entry) => [entry.hexcode, entry]));

/* ------------------------------------------------------------ shortcodes */

/**
 * `[shortcode, emoji]`, in the order a picker should offer them.
 *
 * An array rather than an object because the order is load-bearing: two
 * shortcodes can prefix-match the same query, and emojibase's `order` is CLDR
 * presentation order, which is the one that puts the common face first. An
 * object would carry the same pairs and quietly lose the ranking.
 *
 * The renderer builds its own lookup Map from this once, which is cheaper than
 * shipping the pairs twice.
 */
const pairs = [];
for (const [hexcode, shortcodes] of Object.entries(githubShortcodes)) {
  const entry = byHexcode.get(hexcode);
  // A shortcode for something not in `compact` at all. Nothing to point at.
  if (!entry) continue;

  const emoji = canonicalEmoji(entry.unicode);
  if (!emoji) {
    // Loud rather than skipped: emojibase handing over something RGI refuses
    // means the two disagree about what an emoji is, and that is worth knowing
    // before it becomes a reaction the server rejects.
    console.warn(`skipped ${hexcode}: ${JSON.stringify(entry.unicode)} is not RGI`);
    continue;
  }

  for (const shortcode of [].concat(shortcodes)) {
    pairs.push({ shortcode, emoji, order: entry.order ?? Number.MAX_SAFE_INTEGER });
  }
}

pairs.sort((a, b) => a.order - b.order || a.shortcode.localeCompare(b.shortcode));

/* --------------------------------------------------------------- catalog */

/**
 * What the browse picker draws: one row per emoji, no skin-tone variants.
 *
 * Dropping the variants is most of the difference in size between this file
 * and the one above, and it is a decision about the picker rather than about
 * what may be stored -- `canonicalEmoji` still accepts a skin-tone sequence,
 * because one arriving by some other route is a perfectly good emoji.
 *
 * Keys are one letter because there are two thousand of these and the names
 * would be a third of the file.
 */
const primaryShortcode = new Map();
for (const { shortcode, emoji } of pairs) {
  if (!primaryShortcode.has(emoji)) primaryShortcode.set(emoji, shortcode);
}

const catalog = [];
for (const entry of compact) {
  if (entry.group === undefined || entry.group > LAST_GROUP) continue;
  if (entry.group === COMPONENT_GROUP) continue;
  const emoji = canonicalEmoji(entry.unicode);
  if (!emoji) continue;
  if (isCodepointFlag(emoji)) continue;

  catalog.push({
    u: emoji,
    l: entry.label,
    g: entry.group,
    // What the picker searches on besides the label. Absent rather than empty
    // for the handful with no tags at all.
    ...(entry.tags?.length ? { t: entry.tags } : {}),
    // So the grid can show `:thumbsup:` under the emoji it would insert.
    // Absent for the few emoji GitHub never named.
    ...(primaryShortcode.has(emoji) ? { s: primaryShortcode.get(emoji) } : {}),
  });
}

catalog.sort((a, b) => a.g - b.g || 0);

/* ----------------------------------------------------------------- write */

mkdirSync(outDir, { recursive: true });

const shortcodesJson = JSON.stringify(pairs.map((p) => [p.shortcode, p.emoji]));
const catalogJson = JSON.stringify(catalog);

writeFileSync(resolve(outDir, 'shortcodes.json'), shortcodesJson + '\n');
writeFileSync(resolve(outDir, 'catalog.json'), catalogJson + '\n');

const kb = (s) => `${Math.round(s / 102.4) / 10} KB`;
console.log(`shortcodes.json  ${pairs.length} pairs    ${kb(shortcodesJson.length)}`);
console.log(`catalog.json     ${catalog.length} emoji    ${kb(catalogJson.length)}`);
