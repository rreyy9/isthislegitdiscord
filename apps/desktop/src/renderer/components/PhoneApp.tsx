import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { api, getServerUrl } from '../api';

/**
 * The phone app, as a QR code.
 *
 * The Android build is not in the Play Store -- it is published to this
 * server, beside the desktop installer -- so the hard part of getting it onto
 * a phone was always "type this address into the phone's browser and find the
 * file". The code points the phone's camera at the server's `/android` page,
 * which shows the current version, a download button, and the install steps,
 * and the server address to sign in to once it is installed.
 *
 * The code is drawn here rather than fetched from the server: it encodes an
 * address the *phone* has to be able to reach, and only this window knows
 * which address that is likely to be. Usually it is the one this app is
 * connected to; when that is `localhost` -- the desktop running on the server
 * machine itself -- it is not, and the field below is where the right one goes.
 */

/** Where an edited address is kept between openings of this page. */
const ADDRESS_KEY = 'isthislegit.phoneAppAddress';

/** An address no phone can reach, because it means "this computer". */
function isLoopback(address: string): boolean {
  try {
    const host = new URL(address).hostname;
    return (
      host === 'localhost' ||
      host === '[::1]' ||
      host === '::1' ||
      host.startsWith('127.') ||
      host.endsWith('.localhost')
    );
  } catch {
    return false;
  }
}

/** Trailing slashes off, and a scheme on if somebody left it out. */
function normalise(address: string): string {
  const trimmed = address.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

function readSaved(): string | null {
  try {
    return localStorage.getItem(ADDRESS_KEY);
  } catch {
    return null;
  }
}

function save(address: string | null) {
  try {
    if (address) localStorage.setItem(ADDRESS_KEY, address);
    else localStorage.removeItem(ADDRESS_KEY);
  } catch {
    // Only a convenience. The field still works for this opening.
  }
}

export function PhoneAppSettings() {
  const connected = getServerUrl();
  const [address, setAddress] = useState(() => readSaved() ?? connected);
  const [svg, setSvg] = useState<string | null>(null);
  const [androidVersion, setAndroidVersion] = useState<string | null | undefined>(
    undefined,
  );
  const [copied, setCopied] = useState(false);

  const base = normalise(address);
  const pageUrl = base ? `${base}/android` : '';
  const loopback = isLoopback(base);

  useEffect(() => {
    let alive = true;
    void api
      .config()
      .then((cfg) => alive && setAndroidVersion(cfg.latestAndroidVersion ?? null))
      .catch(() => alive && setAndroidVersion(null));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!pageUrl) {
      setSvg(null);
      return;
    }
    let alive = true;
    // Medium error correction: enough to survive a phone camera at an angle
    // on a glossy screen, without making the code so dense that a short
    // address needs a magnifying glass.
    void QRCode.toString(pageUrl, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    })
      .then((out) => alive && setSvg(out))
      .catch(() => alive && setSvg(null));
    return () => {
      alive = false;
    };
  }, [pageUrl]);

  // An `<img>` of a data URL rather than the SVG markup injected into the
  // page: nothing here is ever parsed as this window's own DOM, and the CSP
  // already allows data: images for exactly this kind of thing.
  const src = useMemo(
    () => (svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : null),
    [svg],
  );

  function edit(next: string) {
    setAddress(next);
    setCopied(false);
    // Remembered only when it differs from the connected server -- otherwise
    // a later move to a new server address would be shadowed by a stale copy
    // of the old one that nobody chose.
    save(normalise(next) === connected ? null : next);
  }

  return (
    <>
      <section className="set-group">
        <h4>Scan with your phone</h4>
        <div className="phone-app">
          <div className="phone-qr">
            {src ? (
              <img src={src} alt={`QR code for ${pageUrl}`} />
            ) : (
              <div className="phone-qr-empty">Enter an address below</div>
            )}
          </div>
          <ol className="phone-steps">
            <li>Open the camera on your Android phone and point it at the code.</li>
            <li>
              Tap the link, then <b>Download</b>. If Android asks, allow your
              browser to install apps.
            </li>
            <li>
              Open isthislegit and sign in to <b className="phone-url">{base || '—'}</b>{' '}
              with the same username and password you use here.
            </li>
          </ol>
        </div>
        <div className="hint">
          {androidVersion === undefined
            ? 'Checking which version the server has…'
            : androidVersion
              ? `The server has version ${androidVersion} of the Android app ready.`
              : 'No Android build has been published to this server yet, so the page will say so until one is.'}{' '}
          Android only — there is no iPhone version.
        </div>
      </section>

      <section className="set-group">
        <h4>Server address for the phone</h4>
        <div className="profile-name">
          <input
            value={address}
            spellCheck={false}
            placeholder="https://chat.example.com"
            onChange={(e) => edit(e.target.value)}
          />
          {normalise(address) !== connected && (
            <button className="profile-save" onClick={() => edit(connected)}>
              Reset
            </button>
          )}
          <button
            className="profile-save"
            disabled={!pageUrl}
            onClick={() => {
              void navigator.clipboard.writeText(pageUrl).then(() => setCopied(true));
            }}
          >
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
        {loopback ? (
          <div className="hint phone-warn">
            This app is connected through <b>{base}</b>, which only works on this
            computer. Put the address a phone would use instead — this
            computer&apos;s network address, like <b>http://192.168.1.20:3000</b>,
            or the server&apos;s public domain.
          </div>
        ) : (
          <div className="hint">
            The address the phone opens. It is the server this app is connected
            to unless you change it — for example, to the public address when
            this computer uses a local one the phone cannot reach.
          </div>
        )}
      </section>
    </>
  );
}
