import { useEffect, useRef, useState } from 'react';
import { api, type GuildDto, type MessageDto } from '../api';

/**
 * The hooks the chat screen runs on, kept out of `Chat.tsx`.
 *
 * Everything here shares one property, and it is the property that made it
 * safe to move: none of it reads the chat closure. Each hook takes what it
 * needs as an argument and hands back what it owns, so lifting them out could
 * not change what any of them does -- which is the whole reason these were the
 * first things to leave.
 *
 * The rule for what belongs here: state with no other claim on it. `pins` does
 * not qualify -- the socket handler, the pin toggle and the channel switch all
 * write it -- and trying to force it in would mean handing four setters back
 * out, which is the closure again with extra steps.
 */

/**
 * A clock that ticks once a minute.
 *
 * The member list draws durations, and a duration that was rendered once is
 * wrong a minute later. A minute is also the resolution of the shortest label
 * it produces, so nothing finer would show.
 */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * Close on a click anywhere else -- the way a menu should.
 *
 * Written six times in `Chat.tsx`, identically, for the moderation menu, the
 * volume popup, the account menu, the channel menu, the pin board and the
 * search popover. Six copies of four lines is six places for one of them to
 * quietly stop matching the others.
 *
 * `dismiss` is held in a ref rather than listed as a dependency, so passing an
 * inline arrow does not tear the listener down and put it back on every
 * render, and the listener still calls the current one. The effect therefore
 * runs on `open` alone, which is the only thing that should decide whether a
 * global click handler exists at all.
 *
 * Each popover stops propagation on its own box; that is what stops a click
 * inside one closing it, and it stays where it is.
 */
export function useDismissOnOutsideClick(open: boolean, dismiss: () => void): void {
  const latest = useRef(dismiss);
  latest.current = dismiss;

  useEffect(() => {
    if (!open) return;
    const close = () => latest.current();
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);
}

/**
 * Clear a transient message after a while, if there is one to clear.
 *
 * The banner and the notice differ only in how long they sit there: an error
 * from a refused action is worth reading, and a note about something that has
 * already happened is not worth as much of the screen.
 *
 * `clear` goes through a ref for the same reason as above.
 */
export function useAutoDismiss(
  value: unknown,
  ms: number,
  clear: () => void,
): void {
  const latest = useRef(clear);
  latest.current = clear;

  useEffect(() => {
    if (!value) return;
    const t = setTimeout(() => latest.current(), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
}

export interface MessageSearch {
  text: string;
  setText: (text: string) => void;
  results: MessageDto[] | null;
  busy: boolean;
  error: string | null;
}

/**
 * The search box's own state: what was typed, what came back, and whether it
 * is still coming.
 *
 * A hook rather than four more `useState` calls in the chat closure because
 * nothing outside the box and the panel it feeds ever reads any of it. It owns
 * the debounce and the sequence number too, which is the part that would be
 * easy to get wrong twice.
 *
 * `open` is the caller's, not this hook's -- the button that toggles it lives
 * in the header, next to the pin board's, and the two are drawn together.
 */
export function useMessageSearch({
  open,
  activeChannel,
  guilds,
}: {
  open: boolean;
  activeChannel: string | null;
  guilds: GuildDto[];
}): MessageSearch {
  const [text, setText] = useState('');
  const [results, setResults] = useState<MessageDto[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** What the results on screen were a search for, so stale ones can be told. */
  const seqRef = useRef(0);

  /**
   * Search, debounced.
   *
   * Every keystroke is a query against a database on somebody's home box, so
   * it waits for a pause rather than firing per character. The sequence number
   * is what stops an earlier, slower query landing after a later one and
   * putting the wrong results on screen -- which is the failure people
   * actually see, in the form of results for a prefix of what they typed.
   */
  useEffect(() => {
    if (!open) return;
    const q = text.trim();
    if (q.length < 2) {
      setResults(null);
      setError(null);
      setBusy(false);
      return;
    }

    const seq = ++seqRef.current;
    setBusy(true);
    const timer = window.setTimeout(async () => {
      try {
        const guildId = guilds.find((g) =>
          g.channels.some((c) => c.id === activeChannel),
        )?.id;
        const page = await api.search({ q, guildId });
        if (seq !== seqRef.current) return;
        setResults(page.results);
        setError(null);
      } catch (e: any) {
        if (seq !== seqRef.current) return;
        setResults(null);
        setError(
          e?.status === 404
            ? 'This server is too old to search. Update the server to use this.'
            : (e?.message ?? 'That search did not work.'),
        );
      } finally {
        if (seq === seqRef.current) setBusy(false);
      }
    }, 250);

    return () => window.clearTimeout(timer);
  }, [open, text, activeChannel, guilds]);

  // Closing it clears it: reopening the box to last week's search, already
  // run, is never what somebody opening a search box wants.
  useEffect(() => {
    if (open) return;
    setText('');
    setResults(null);
    setError(null);
  }, [open]);

  return { text, setText, results, busy, error };
}
