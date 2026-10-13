import type { AndroidManifest } from './android-updates.service';

/**
 * The page a phone lands on after scanning the desktop client's QR code.
 *
 * Plain server-rendered HTML with everything inline, because the visitor has
 * nothing yet: no app, no session, quite possibly no idea what this server is.
 * It has to say what this is, offer the download, and walk somebody through
 * Android's "install unknown apps" prompt -- the one step that loses people,
 * because the wording of it sounds like a warning that something is wrong.
 *
 * The download link is relative, so the page works through whichever address
 * the phone used to reach it -- the public domain, or a LAN address -- and the
 * server address it tells you to sign in to is read from the page's own
 * location by the browser for the same reason.
 *
 * Kept as a pure function of the manifest so it can be tested without a server.
 */

const escape = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function published(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function renderAndroidPage(manifest: AndroidManifest | null): string {
  const body = manifest ? available(manifest) : unavailable();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#1a1b1e">
<title>isthislegit for Android</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; background: #1a1b1e; color: #e9ecef;
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    display: flex; justify-content: center;
  }
  main { width: 100%; max-width: 440px; padding: 40px 20px 48px; }
  .mark {
    width: 64px; height: 64px; border-radius: 18px; background: #5865f2;
    display: flex; align-items: center; justify-content: center;
    font-size: 26px; font-weight: 700; color: #fff; margin-bottom: 20px;
  }
  h1 { font-size: 26px; line-height: 1.2; margin: 0 0 6px; }
  .meta { color: #909296; font-size: 14px; margin: 0 0 24px; }
  .download {
    display: flex; align-items: center; justify-content: center; gap: 10px;
    width: 100%; min-height: 52px; border-radius: 14px; background: #5865f2;
    color: #fff; font-size: 17px; font-weight: 600; text-decoration: none;
  }
  .download:active { opacity: .85; }
  .notes {
    margin: 16px 0 0; padding: 12px 14px; border-radius: 12px;
    background: #25262b; color: #c1c2c5; font-size: 14px; white-space: pre-line;
  }
  h2 { font-size: 15px; color: #909296; font-weight: 600; margin: 32px 0 12px; }
  ol { margin: 0; padding: 0; list-style: none; counter-reset: step; }
  li {
    counter-increment: step; position: relative; padding: 0 0 16px 40px;
    color: #c1c2c5; font-size: 15px;
  }
  li::before {
    content: counter(step); position: absolute; left: 0; top: 0;
    width: 26px; height: 26px; border-radius: 50%; background: #2c2e33;
    color: #e9ecef; font-size: 13px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
  }
  li b { color: #e9ecef; font-weight: 600; }
  .address {
    display: flex; gap: 8px; align-items: center; margin-top: 8px;
    padding: 10px 12px; border-radius: 12px; background: #25262b;
  }
  .address code {
    flex: 1; min-width: 0; overflow-wrap: anywhere; color: #e9ecef;
    font: 14px/1.4 ui-monospace, "Cascadia Mono", Consolas, monospace;
  }
  .address button {
    flex: none; border: 1px solid #373a40; background: #2c2e33; color: #e9ecef;
    border-radius: 8px; padding: 6px 12px; font: inherit; font-size: 13px;
  }
  .note { color: #5c5f66; font-size: 13px; margin-top: 28px; }
  .ios {
    display: none; margin: 0 0 20px; padding: 12px 14px; border-radius: 12px;
    background: #3a3115; color: #fab005; font-size: 14px;
  }
  .empty {
    padding: 16px; border-radius: 14px; background: #25262b; color: #c1c2c5;
  }
</style>
</head>
<body>
<main>
  <div class="mark">IL</div>
  <h1>isthislegit for Android</h1>
  <p class="ios" id="ios">This is an Android app. There is no iPhone version — open this page on an Android phone.</p>
${body}
</main>
<script>
  (function () {
    var origin = location.origin;
    var out = document.getElementById('origin');
    if (out) out.textContent = origin;
    var copy = document.getElementById('copy');
    if (copy) {
      copy.addEventListener('click', function () {
        // The clipboard API needs a secure context, which a LAN address over
        // plain http is not. Selecting the text is the fallback that works
        // everywhere: the phone's own copy bubble appears over it.
        var done = function () { copy.textContent = 'Copied'; };
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.writeText(origin).then(done, select);
        } else {
          select();
        }
        function select() {
          var range = document.createRange();
          range.selectNodeContents(out);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      });
    }
    if (/iPhone|iPad|iPod/.test(navigator.userAgent)) {
      document.getElementById('ios').style.display = 'block';
    }
  })();
</script>
</body>
</html>
`;
}

function available(m: AndroidManifest): string {
  const date = published(m.publishedAt);
  const href = `/updates/android/${encodeURIComponent(m.apk)}`;
  return `  <p class="meta">Version ${escape(m.version)} · ${megabytes(m.size)}${
    date ? ` · ${escape(date)}` : ''
  }</p>
  <a class="download" href="${escape(href)}" download="${escape(m.apk)}">Download for Android</a>
${m.notes ? `  <p class="notes">${escape(m.notes)}</p>\n` : ''}
  <h2>Installing it</h2>
  <ol>
    <li>Tap <b>Download for Android</b>, then open the file when it finishes.</li>
    <li>If Android says your browser isn't allowed to install apps, tap <b>Settings</b>, turn on <b>Allow from this source</b>, and go back. That is Android's normal prompt for any app that isn't from the Play Store.</li>
    <li>Tap <b>Install</b>, then <b>Open</b>.</li>
    <li>Sign in with the same username and password you use on the desktop app. The server address is:
      <div class="address"><code id="origin"></code><button id="copy" type="button">Copy</button></div>
    </li>
  </ol>
  <p class="note">The app updates itself from this server — it will tell you when a newer version is ready.</p>`;
}

function unavailable(): string {
  return `  <p class="meta">Not available yet</p>
  <p class="empty">No Android build has been published to this server yet. Ask whoever runs it to publish one, then scan the code again.</p>`;
}
