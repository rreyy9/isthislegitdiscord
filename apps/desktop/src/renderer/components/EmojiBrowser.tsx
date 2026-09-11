import { useEffect, useMemo, useRef, useState } from 'react';
import {
  EMOJI_GROUPS,
  EMOJI_GROUP_ORDER,
  loadEmojiCatalog,
  loadedEmojiCatalog,
  type CatalogEntry,
} from '../emoji-data';

/**
 * The grid you open when you do not know the name of the thing you want.
 *
 * The autocomplete in the composer is for people who do -- `:tada:` is faster
 * than any picker -- and this is the other half: nine categories, a search
 * box, and whatever you reached for last.
 *
 * Written to be opened from two places. The composer puts it above the text
 * box and inserts into the draft; a message's hover row puts it beside the
 * message and adds a reaction. Neither of those is this component's business:
 * it draws a panel, calls `onPick` with a character, and takes a class name
 * for wherever the caller wants it.
 */

/**
 * The two hundred kilobytes of labels and tags arrive the first time one of
 * these is opened, and never again -- which is the whole reason the data is
 * split in two. Until it lands the panel draws its frame and says so, rather
 * than appearing empty and looking broken.
 */
function useCatalog(): CatalogEntry[] | null {
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(loadedEmojiCatalog);

  useEffect(() => {
    if (catalog) return;
    let live = true;
    void loadEmojiCatalog().then((rows) => {
      if (live) setCatalog(rows);
    });
    return () => {
      live = false;
    };
  }, [catalog]);

  return catalog;
}

/* ------------------------------------------------------------- recents */

const RECENTS_KEY = 'emoji.recents';
const MAX_RECENTS = 24;

/**
 * What was picked lately, which for most people is most of what they will pick
 * next.
 *
 * In localStorage rather than on the server: it is a convenience belonging to
 * this machine, nobody else can see it, and losing it costs one scroll. Every
 * read is guarded because a corrupt value should cost the picker its top row,
 * not the app its render.
 */
function readRecents(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((e) => typeof e === 'string') : [];
  } catch {
    return [];
  }
}

function noteRecent(emoji: string) {
  try {
    const next = [emoji, ...readRecents().filter((e) => e !== emoji)];
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next.slice(0, MAX_RECENTS)));
  } catch {
    // A browser with storage turned off still gets a working picker.
  }
}

/** One emoji per category, for the row of tabs. */
const GROUP_ICON: Record<number, string> = {
  0: '😀',
  1: '👋',
  3: '🐻',
  4: '🍎',
  5: '✈️',
  6: '⚽',
  7: '💡',
  8: '❤️',
  9: '🏁',
};

/* --------------------------------------------------------------- panel */

export function EmojiBrowser({
  onPick,
  onClose,
  className,
}: {
  /** Called with the character itself. The caller decides what that means. */
  onPick: (emoji: string) => void;
  onClose: () => void;
  /** Where the caller wants the panel. Positioning is not decided here. */
  className?: string;
}) {
  const catalog = useCatalog();
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState<number>(EMOJI_GROUP_ORDER[0]);
  const [recents, setRecents] = useState<string[]>(readRecents);
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape closes, and so does a click anywhere else. `mousedown` rather than
  // `click`, so a press that starts outside closes the panel before whatever
  // is under it can be pressed a second time.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }
    function onDown(e: MouseEvent) {
      if (!panelRef.current?.contains(e.target as Node)) onClose();
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  /**
   * What the grid draws: a search across everything, or one category.
   *
   * One category at a time rather than all nine in a scroller, because the
   * whole set is nineteen hundred buttons and every one of them is a glyph the
   * font has to shape. The largest category is under four hundred, which
   * renders without anybody noticing.
   */
  const shown = useMemo(() => {
    if (!catalog) return [];
    const q = search.trim().toLowerCase();
    if (!q) return catalog.filter((e) => e.g === group);

    const starts: CatalogEntry[] = [];
    const rest: CatalogEntry[] = [];
    for (const entry of catalog) {
      // Shortcode first, then the label, then the tags -- roughly in order of
      // how deliberate the match is.
      if (entry.s?.startsWith(q) || entry.l.startsWith(q)) starts.push(entry);
      else if (entry.s?.includes(q) || entry.l.includes(q) || entry.t?.some((t) => t.includes(q))) {
        rest.push(entry);
      }
    }
    return [...starts, ...rest].slice(0, 120);
  }, [catalog, search, group]);

  function pick(emoji: string) {
    noteRecent(emoji);
    setRecents(readRecents());
    onPick(emoji);
  }

  return (
    <div className={'emoji-browser' + (className ? ' ' + className : '')} ref={panelRef}>
      <input
        className="emoji-search"
        autoFocus
        value={search}
        placeholder="Search emoji"
        onChange={(e) => setSearch(e.target.value)}
      />

      {!catalog ? (
        <div className="emoji-loading">Loading…</div>
      ) : (
        <>
          {/* Only without a search: the tabs choose a category, and a search
              already crosses all of them. Leaving them lit while a search is
              running would say the results came from one. */}
          {!search.trim() && (
            <div className="emoji-tabs">
              {EMOJI_GROUP_ORDER.map((g) => (
                <button
                  key={g}
                  className={'emoji-tab' + (g === group ? ' on' : '')}
                  title={EMOJI_GROUPS[g]}
                  onClick={() => setGroup(g)}
                >
                  {GROUP_ICON[g]}
                </button>
              ))}
            </div>
          )}

          <div className="emoji-scroll">
            {!search.trim() && recents.length > 0 && (
              <>
                <div className="emoji-group-head">Recent</div>
                <div className="emoji-grid">
                  {recents.map((emoji) => (
                    <button
                      key={'r' + emoji}
                      className="emoji-cell"
                      onClick={() => pick(emoji)}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </>
            )}

            <div className="emoji-group-head">
              {search.trim() ? 'Results' : EMOJI_GROUPS[group]}
            </div>
            {shown.length === 0 ? (
              <div className="emoji-loading">Nothing matches that.</div>
            ) : (
              <div className="emoji-grid">
                {shown.map((entry) => (
                  <button
                    key={entry.u}
                    className="emoji-cell"
                    // The name as well as the label, because the name is the
                    // thing worth learning -- next time it is four keystrokes
                    // in the composer instead of opening this.
                    title={entry.s ? `${entry.l} · :${entry.s}:` : entry.l}
                    onClick={() => pick(entry.u)}
                  >
                    {entry.u}
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
