import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { bridge } from '../bridge';

/**
 * Looking at an image properly, and getting one out of the app.
 *
 * Two things every chat client has and this one did not: click a picture to
 * see it at its own size, and right-click it to put it on the clipboard. They
 * live together because they ask the same question — which image, and where
 * did it come from — and the answer has to reach an `<img>` three components
 * down. A context rather than props: `MessageContent` is a pure function of a
 * message and has no business carrying viewer plumbing through it.
 */

export interface ImageRef {
  /** What the img is showing: a blob: URL for uploads, http(s) for links. */
  src: string;
  /** Shown under the picture, and what a failed copy can name. */
  name: string;
}

interface ImageActions {
  /** Spread onto an `<img>` to make it openable and copyable. */
  imageProps: (image: ImageRef) => {
    onClick: (e: React.MouseEvent) => void;
    onContextMenu: (e: React.MouseEvent) => void;
  };
}

const noop: ImageActions = {
  imageProps: () => ({ onClick: () => {}, onContextMenu: () => {} }),
};

const Ctx = createContext<ImageActions>(noop);

/** Outside a provider this is inert rather than a crash. */
export const useImageActions = () => useContext(Ctx);

/* ------------------------------------------------------------- clipboard */

/** Decode an image the way the page already does, rather than fetching it. */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not decode ${src}`));
    img.src = src;
  });
}

/**
 * Put one image on the system clipboard.
 *
 * An upload is a blob: URL this window owns, so it is drawn and encoded here
 * and only the finished PNG crosses to main. An image somebody linked to
 * belongs to another origin, where a canvas would be tainted and fetch is a
 * CORS failure — main is subject to neither and fetches that one itself.
 * Chromium's own clipboard API is not used at all: it takes PNG only, and
 * going through Electron gets JPEG and the rest for free.
 *
 * The local half deliberately does not `fetch` the blob: URL. `connect-src`
 * carries http, https, ws and wss because the server address is typed by the
 * user, but not blob: — and it should not, because nothing in this app needs
 * to make requests to one. An <img> reads it under `img-src`, which already
 * allows blob: for exactly this data, and the bytes are decoded once instead
 * of twice. Widening the CSP to make a redundant read legal would have been
 * the wrong way round.
 */
async function copyImage(image: ImageRef): Promise<boolean> {
  if (/^https?:/i.test(image.src)) {
    return bridge.copyImage({ url: image.src });
  }
  try {
    const img = await loadImage(image.src);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.drawImage(img, 0, 0);
    return await bridge.copyImage({ dataUrl: canvas.toDataURL('image/png') });
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------- lightbox */

/** The menu is drawn against the viewport, so its box has to be known up front. */
const MENU_WIDTH = 176;
const MENU_HEIGHT = 108;

function Lightbox({
  image,
  onCopy,
  onClose,
}: {
  image: ImageRef;
  onCopy: () => void;
  onClose: () => void;
}) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [actual, setActual] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /**
   * A picture smaller than the window is shown at its own size and left alone
   * — blowing a 200px screenshot up to fill the screen helps nobody. Only one
   * the window is actually shrinking is worth a zoom, and only then does
   * clicking it do anything.
   */
  const oversized = Boolean(
    size &&
      (size.w > window.innerWidth * 0.92 || size.h > window.innerHeight * 0.84),
  );

  return (
    <div className="lightbox" onClick={onClose}>
      <div
        className={'lb-frame' + (actual ? ' actual' : '')}
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={image.src}
          alt={image.name}
          className={oversized ? (actual ? 'zoom-out' : 'zoom-in') : ''}
          onLoad={(e) =>
            setSize({
              w: e.currentTarget.naturalWidth,
              h: e.currentTarget.naturalHeight,
            })
          }
          onClick={() => oversized && setActual((v) => !v)}
        />
      </div>
      <div className="lb-bar" onClick={(e) => e.stopPropagation()}>
        <span className="lb-name" title={image.name}>
          {image.name}
        </span>
        {size && (
          <span className="lb-dim">
            {size.w} × {size.h}
            {oversized && (actual ? ' · click to fit' : ' · click for full size')}
          </span>
        )}
        <button onClick={onCopy}>Copy</button>
        {/^https?:/i.test(image.src) && (
          <button onClick={() => window.open(image.src, '_blank')}>
            Open in browser
          </button>
        )}
        <button onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- provider */

export function ImageViewerProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [viewing, setViewing] = useState<ImageRef | null>(null);
  const [menu, setMenu] = useState<{
    image: ImageRef;
    x: number;
    y: number;
  } | null>(null);
  /** Copying is silent otherwise, and silence reads as "did that work?". */
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menu]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1800);
    return () => clearTimeout(t);
  }, [toast]);

  const copy = useCallback(async (image: ImageRef) => {
    setMenu(null);
    setToast(
      (await copyImage(image))
        ? 'Image copied'
        : 'That image could not be copied',
    );
  }, []);

  const value = useMemo<ImageActions>(
    () => ({
      imageProps: (image) => ({
        onClick: () => setViewing(image),
        onContextMenu: (e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ image, x: e.clientX, y: e.clientY });
        },
      }),
    }),
    [],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {menu && (
        <div
          className="menu"
          style={{
            // Flipped rather than drawn off the edge, both ways.
            left: Math.min(menu.x, window.innerWidth - MENU_WIDTH - 8),
            top: Math.min(menu.y, window.innerHeight - MENU_HEIGHT - 8),
            width: MENU_WIDTH,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button onClick={() => void copy(menu.image)}>Copy image</button>
          <button
            onClick={() => {
              setViewing(menu.image);
              setMenu(null);
            }}
          >
            View image
          </button>
          {/^https?:/i.test(menu.image.src) && (
            <button
              onClick={() => {
                window.open(menu.image.src, '_blank');
                setMenu(null);
              }}
            >
              Open in browser
            </button>
          )}
        </div>
      )}
      {viewing && (
        <Lightbox
          image={viewing}
          onCopy={() => void copy(viewing)}
          onClose={() => setViewing(null)}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </Ctx.Provider>
  );
}
