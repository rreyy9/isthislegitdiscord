import { useEffect, useState } from 'react';
import { avatarUrl } from '../api';

/**
 * The picture beside a name.
 *
 * One component rather than an `<img>` at each of the half-dozen places a user
 * is drawn, because the interesting part is not the markup: an avatar lives
 * behind the bearer token, so it cannot go in an `<img src>` directly and has
 * to be fetched and handed over as an object URL. That is an effect, and an
 * effect copied six times is an effect that gets fixed in five of them.
 *
 * Initials are the resting state, not the error state. They are what shows
 * while the bytes are in flight, for somebody who has never set a picture, and
 * for a picture that fails to load — so a slow or broken avatar looks like an
 * account without one rather than like a hole in the list.
 */

export function initials(name: string) {
  return name.slice(0, 2).toUpperCase();
}

export function Avatar({
  name,
  image,
  className = '',
  size,
}: {
  /** Display name or username — whatever is actually on screen beside this. */
  name: string;
  /** The `image` path off a user, or null for an account without one. */
  image: string | null | undefined;
  /** Extra classes, e.g. `tiny`. `avatar` is always present. */
  className?: string;
  /** Overrides the class's size, for the one or two places that need to. */
  size?: number;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!image) {
      setUrl(null);
      return;
    }
    // Guarded, because the object URL arrives after an await and the row it
    // belongs to may have been replaced by then — a member list re-sorting
    // while three avatars are in flight is the normal case, not an edge one.
    let live = true;
    setUrl(null);
    avatarUrl(image)
      .then((u) => {
        if (live) setUrl(u);
      })
      .catch(() => {
        // Falls through to initials, which is a fine thing to look at.
      });
    return () => {
      live = false;
    };
  }, [image]);

  const style = size
    ? { width: size, height: size, fontSize: Math.round(size * 0.4) }
    : undefined;

  return (
    <div className={('avatar ' + className).trim()} style={style}>
      {url ? (
        <img className="avatar-img" src={url} alt="" draggable={false} />
      ) : (
        initials(name)
      )}
    </div>
  );
}
