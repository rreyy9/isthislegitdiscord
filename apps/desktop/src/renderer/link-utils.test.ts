import { describe, expect, it } from 'vitest';
import {
  IMAGE_EXT_RE,
  URL_RE,
  VIDEO_EXT_RE,
  tiktokId,
  youtubeId,
  youtubeStart,
} from './link-utils';

/** URL_RE carries the /g flag, so lastIndex has to be reset between uses. */
function findUrls(text: string): string[] {
  return text.match(new RegExp(URL_RE.source, 'gi')) ?? [];
}

describe('URL_RE', () => {
  it('finds plain links', () => {
    expect(findUrls('see https://example.com/a for more')).toEqual([
      'https://example.com/a',
    ]);
  });

  it('does not swallow trailing punctuation', () => {
    // The bug this file was split out for: "see https://x.com/a." linked the
    // full stop, and the resulting URL 404s in a way that reads as our fault.
    expect(findUrls('see https://example.com/a.')).toEqual(['https://example.com/a']);
    expect(findUrls('https://example.com/a, and')).toEqual(['https://example.com/a']);
    expect(findUrls('really? https://example.com/a?')).toEqual(['https://example.com/a']);
    expect(findUrls('(https://example.com/a)')).toEqual(['https://example.com/a']);
  });

  it('keeps punctuation that is genuinely part of the URL', () => {
    expect(findUrls('https://example.com/a?b=1&c=2 next')).toEqual([
      'https://example.com/a?b=1&c=2',
    ]);
    expect(findUrls('https://en.wikipedia.org/wiki/Foo_(bar) x')).toEqual([
      'https://en.wikipedia.org/wiki/Foo_(bar',
    ]);
  });

  it('matches http and https only, so no scheme becomes an href by accident', () => {
    expect(findUrls('javascript:alert(1)')).toEqual([]);
    expect(findUrls('data:text/html,<script>')).toEqual([]);
    expect(findUrls('file:///C:/Windows')).toEqual([]);
    expect(findUrls('ftp://example.com/a')).toEqual([]);
  });

  it('finds several in one message', () => {
    expect(findUrls('http://a.example and https://b.example/x')).toEqual([
      'http://a.example',
      'https://b.example/x',
    ]);
  });
});

describe('extension matchers', () => {
  it('recognises images, including through a query string', () => {
    for (const u of ['a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.webp', 'a.PNG', 'a.png?v=2']) {
      expect(IMAGE_EXT_RE.test(u), u).toBe(true);
    }
    expect(IMAGE_EXT_RE.test('a.pngx')).toBe(false);
    expect(IMAGE_EXT_RE.test('a.svg')).toBe(false);
  });

  it('recognises the video formats Chromium plays without a codec question', () => {
    for (const u of ['a.mp4', 'a.m4v', 'a.webm', 'a.MP4?t=1']) {
      expect(VIDEO_EXT_RE.test(u), u).toBe(true);
    }
    expect(VIDEO_EXT_RE.test('a.mkv')).toBe(false);
    expect(VIDEO_EXT_RE.test('a.avi')).toBe(false);
  });
});

describe('youtubeId', () => {
  it('reads every shape a link arrives in', () => {
    const id = 'dQw4w9WgXcQ';
    for (const url of [
      `https://www.youtube.com/watch?v=${id}`,
      `https://youtube.com/watch?v=${id}&list=PL1`,
      `https://m.youtube.com/watch?v=${id}`,
      `https://music.youtube.com/watch?v=${id}`,
      `https://youtu.be/${id}`,
      `https://www.youtube.com/shorts/${id}`,
      `https://www.youtube.com/embed/${id}`,
      `https://www.youtube.com/live/${id}`,
      `https://www.youtube.com/v/${id}`,
    ]) {
      expect(youtubeId(url), url).toBe(id);
    }
  });

  it('refuses anything that is not an 11-character id', () => {
    expect(youtubeId('https://youtu.be/short')).toBeNull();
    expect(youtubeId('https://www.youtube.com/watch?v=')).toBeNull();
    expect(youtubeId('https://www.youtube.com/')).toBeNull();
  });

  it('is not fooled by a lookalike host', () => {
    // The id is interpolated into an embed URL, so the host check is load-bearing.
    expect(youtubeId('https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(youtubeId('https://notyoutube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
  });

  it('returns null rather than throwing on nonsense', () => {
    expect(youtubeId('not a url')).toBeNull();
    expect(youtubeId('')).toBeNull();
  });
});

describe('youtubeStart', () => {
  it('reads seconds, the h/m/s form, and ?start=', () => {
    expect(youtubeStart('https://youtu.be/x?t=90')).toBe(90);
    expect(youtubeStart('https://youtu.be/x?t=1m30s')).toBe(90);
    expect(youtubeStart('https://youtu.be/x?t=1h2m3s')).toBe(3723);
    expect(youtubeStart('https://youtu.be/x?t=2m')).toBe(120);
    expect(youtubeStart('https://youtu.be/x?start=45')).toBe(45);
  });

  it('is null when absent or unparseable', () => {
    expect(youtubeStart('https://youtu.be/x')).toBeNull();
    expect(youtubeStart('https://youtu.be/x?t=')).toBeNull();
    expect(youtubeStart('https://youtu.be/x?t=soon')).toBeNull();
    expect(youtubeStart('not a url')).toBeNull();
  });
});

describe('tiktokId', () => {
  it('reads the shapes that carry the id in the path', () => {
    expect(tiktokId('https://www.tiktok.com/@someone/video/1234567890123456789')).toBe(
      '1234567890123456789',
    );
    expect(tiktokId('https://tiktok.com/@someone/photo/1234567890123456789')).toBe(
      '1234567890123456789',
    );
    expect(tiktokId('https://www.tiktok.com/embed/v2/1234567890123456789')).toBe(
      '1234567890123456789',
    );
  });

  it('leaves share links alone rather than resolving them', () => {
    // Resolving these would mean a request to TikTok for every link that
    // scrolls past, before anyone has asked to watch anything.
    expect(tiktokId('https://vm.tiktok.com/ZMabcdef/')).toBeNull();
    expect(tiktokId('https://www.tiktok.com/t/ZMabcdef/')).toBeNull();
  });

  it('requires a numeric id, because it is pasted into an embed URL', () => {
    expect(tiktokId('https://www.tiktok.com/@someone/video/notanid')).toBeNull();
    expect(tiktokId('https://www.tiktok.com/@someone/video/../../evil')).toBeNull();
  });

  it('is not fooled by a lookalike host', () => {
    expect(tiktokId('https://tiktok.com.evil.example/@a/video/1234567890')).toBeNull();
  });
});
