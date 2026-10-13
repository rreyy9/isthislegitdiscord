import { describe, expect, it } from 'vitest';
import { renderAndroidPage } from './android-page';
import type { AndroidManifest } from './android-updates.service';

const manifest = (patch: Partial<AndroidManifest> = {}): AndroidManifest => ({
  version: '0.5.0',
  versionCode: 500,
  apk: 'isthislegit-0.5.0.apk',
  sha256: 'a'.repeat(64),
  size: 62_914_560,
  publishedAt: '2026-10-13T12:00:00.000Z',
  ...patch,
});

describe('renderAndroidPage', () => {
  it('links the published APK through the feed, relative to whatever host served the page', () => {
    const html = renderAndroidPage(manifest());
    expect(html).toContain('href="/updates/android/isthislegit-0.5.0.apk"');
    expect(html).toContain('Version 0.5.0 · 60.0 MB · 13 October 2026');
  });

  it('says so, and offers no download, when nothing is published', () => {
    const html = renderAndroidPage(null);
    expect(html).toContain('No Android build has been published');
    expect(html).not.toContain('/updates/android/');
  });

  // The manifest arrives through an admin upload, but the page is served to
  // anybody. A release note is free text and the file name is whatever the
  // publish script was handed; neither may become markup.
  it('escapes everything that comes from the manifest', () => {
    const html = renderAndroidPage(
      manifest({
        version: '1.0.0"><script>x()</script>',
        apk: 'a"b<c>.apk',
        notes: '<img src=x onerror=alert(1)> & more',
      }),
    );
    expect(html).not.toContain('<script>x()');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; more');
    expect(html).toContain('href="/updates/android/a%22b%3Cc%3E.apk"');
  });

  it('leaves the date out rather than printing "Invalid Date"', () => {
    const html = renderAndroidPage(manifest({ publishedAt: 'not a date' }));
    expect(html).toContain('Version 0.5.0 · 60.0 MB</p>');
    expect(html).not.toContain('Invalid');
  });
});
