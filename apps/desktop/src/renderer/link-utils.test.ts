import { describe, expect, it } from 'vitest';
import {
  IMAGE_EXT_RE,
  URL_RE,
  VIDEO_EXT_RE,
  parseRedditManifest,
  redditVideoBase,
  redditVideoId,
  tiktokErrorLabel,
  tiktokId,
  tiktokPlayerError,
  tiktokPlayerUrl,
  tiktokShareUrl,
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
    // The player URL this app now builds, which somebody may equally well
    // paste back in.
    expect(tiktokId('https://www.tiktok.com/player/v1/1234567890123456789')).toBe(
      '1234567890123456789',
    );
  });

  it('has no id to give for a share link', () => {
    // There is genuinely nothing in these to read; `tiktokShareUrl` picks them
    // up instead, and the redirect is followed on click rather than on sight.
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

describe('tiktokShareUrl', () => {
  it('recognises the links the app itself hands out', () => {
    expect(tiktokShareUrl('https://vm.tiktok.com/ZN86VL7xy/')).toBe(
      'https://vm.tiktok.com/ZN86VL7xy/',
    );
    expect(tiktokShareUrl('https://vt.tiktok.com/ZSabc123')).toBe(
      'https://vt.tiktok.com/ZSabc123/',
    );
    expect(tiktokShareUrl('https://www.tiktok.com/t/ZMabcdef/')).toBe(
      'https://www.tiktok.com/t/ZMabcdef/',
    );
    expect(tiktokShareUrl('https://tiktok.com/t/ZMabcdef')).toBe(
      'https://www.tiktok.com/t/ZMabcdef/',
    );
  });

  it('keeps the token and drops everything hung off it', () => {
    // Share links arrive with tracking parameters on them. They are no use to
    // the redirect and no business of ours, so the rebuilt URL leaves them
    // behind rather than passing them on to TikTok.
    expect(tiktokShareUrl('https://vm.tiktok.com/ZMabcdef/?_t=abc&_r=1')).toBe(
      'https://vm.tiktok.com/ZMabcdef/',
    );
    expect(tiktokShareUrl('https://vm.tiktok.com/ZMabcdef#x')).toBe(
      'https://vm.tiktok.com/ZMabcdef/',
    );
  });

  it('upgrades the first hop to https', () => {
    expect(tiktokShareUrl('http://vm.tiktok.com/ZMabcdef/')).toBe(
      'https://vm.tiktok.com/ZMabcdef/',
    );
  });

  it('is null for a link that already carries an id', () => {
    // Otherwise a full link would cost a redirect it does not need.
    expect(
      tiktokShareUrl('https://www.tiktok.com/@someone/video/1234567890123456789'),
    ).toBeNull();
  });

  it('refuses anything that is not a bare token', () => {
    // What comes out of here is a URL the main process will request, so the
    // path is rebuilt from a checked token rather than passed through.
    expect(tiktokShareUrl('https://vm.tiktok.com/')).toBeNull();
    expect(tiktokShareUrl('https://vm.tiktok.com/ZMabc/def')).toBeNull();
    expect(tiktokShareUrl('https://vm.tiktok.com/ZMab.cd')).toBeNull();
    expect(tiktokShareUrl('https://www.tiktok.com/t/')).toBeNull();
  });

  it('cannot carry a traversal through into the URL it hands back', () => {
    // `new URL` resolves the `..` away before the pattern ever sees it, and
    // the pattern then only matches one segment -- so what comes out is a
    // single token either way, never a path somebody steered.
    expect(tiktokShareUrl('https://vm.tiktok.com/ZM/../evil')).toBe(
      'https://vm.tiktok.com/evil/',
    );
    expect(tiktokShareUrl('https://vm.tiktok.com/ZM/../../../etc/passwd')).toBeNull();
  });

  it('is not fooled by a lookalike host', () => {
    expect(tiktokShareUrl('https://vm.tiktok.com.evil.example/ZMabcdef/')).toBeNull();
    expect(tiktokShareUrl('https://notvm.tiktok.com/ZMabcdef/')).toBeNull();
  });

  it('returns null rather than throwing on nonsense', () => {
    expect(tiktokShareUrl('not a url')).toBeNull();
    expect(tiktokShareUrl('')).toBeNull();
  });
});


describe('tiktokPlayerUrl', () => {
  it('builds the documented player URL, with the parameters the frame needs', () => {
    expect(tiktokPlayerUrl('1234567890123456789')).toBe(
      'https://www.tiktok.com/player/v1/1234567890123456789' +
        '?autoplay=1&rel=0&music_info=0&description=0',
    );
  });

  it('checks the id again rather than trusting its caller', () => {
    // This is the last thing standing between a path segment out of somebody's
    // message and a URL the app loads in a frame, so it asks even though
    // `tiktokId` already did.
    expect(tiktokPlayerUrl('notanid')).toBeNull();
    expect(tiktokPlayerUrl('123')).toBeNull();
    expect(tiktokPlayerUrl('1234567890?x=1')).toBeNull();
    expect(tiktokPlayerUrl('../../evil')).toBeNull();
    expect(tiktokPlayerUrl('')).toBeNull();
  });
});

describe('tiktokPlayerError', () => {
  const error = (value: unknown) => ({
    'x-tiktok-player': true,
    type: 'onPlayerError',
    value,
  });

  it('reads the code out of a player error', () => {
    expect(tiktokPlayerError(error({ errorCode: 1001, errorType: 'INVALID_VIDEO' })))
      .toBe(1001);
    expect(tiktokPlayerError(error({ errorCode: 2001 }))).toBe(2001);
  });

  it('says nothing about autoplay being refused', () => {
    // 3002 is the browser declining to start the video by itself, which is
    // what `autoplay=1` asks for and what browsers routinely decline. The post
    // plays on the next tap, so there is nothing to put a card in front of.
    expect(tiktokPlayerError(error({ errorCode: 3002 }))).toBeNull();
  });

  it('ignores every other message the window receives', () => {
    // This runs on every `message` event, most of which are nobody's business
    // here -- and a page that framed us could send anything at all.
    // The right shape without the flag that says whose it is.
    expect(
      tiktokPlayerError({ type: 'onPlayerError', value: { errorCode: 1001 } }),
    ).toBeNull();
    expect(
      tiktokPlayerError({ 'x-tiktok-player': true, type: 'onStateChange', value: 1 }),
    ).toBeNull();
    expect(tiktokPlayerError(error(undefined))).toBeNull();
    expect(tiktokPlayerError(error({ errorCode: 'lots' }))).toBeNull();
    expect(tiktokPlayerError(error({}))).toBeNull();
    expect(tiktokPlayerError('onPlayerError')).toBeNull();
    expect(tiktokPlayerError(null)).toBeNull();
    expect(tiktokPlayerError(undefined)).toBeNull();
  });
});

describe('tiktokErrorLabel', () => {
  it('has words for the codes that say something worth knowing', () => {
    expect(tiktokErrorLabel(1001)).toMatch(/any more/);
    expect(tiktokErrorLabel(2001)).toMatch(/TikTok/);
    expect(tiktokErrorLabel(3001)).toMatch(/play/);
  });

  it('falls back rather than showing somebody a number', () => {
    // Including for codes TikTok has not published yet.
    expect(tiktokErrorLabel(9999)).toBe('Couldn’t load this one');
  });
});

describe('redditVideoId', () => {
  it('reads the share link', () => {
    expect(redditVideoId('https://v.redd.it/hhae5v10soxh1')).toBe('hhae5v10soxh1');
    expect(redditVideoId('https://v.redd.it/hhae5v10soxh1/')).toBe('hhae5v10soxh1');
  });

  it('reads a link to one of the clip’s own files', () => {
    expect(redditVideoId('https://v.redd.it/hhae5v10soxh1/CMAF_720.mp4')).toBe(
      'hhae5v10soxh1',
    );
    expect(redditVideoId('https://v.redd.it/hhae5v10soxh1/HLSPlaylist.m3u8')).toBe(
      'hhae5v10soxh1',
    );
  });

  it('ignores other hosts and odd shapes', () => {
    expect(redditVideoId('https://www.reddit.com/video/hhae5v10soxh1')).toBeNull();
    expect(redditVideoId('https://v.redd.it.example.com/hhae5v10soxh1')).toBeNull();
    expect(redditVideoId('https://v.redd.it/')).toBeNull();
    expect(redditVideoId('https://v.redd.it/HHAE5V10SOXH1')).toBeNull();
    expect(redditVideoId('https://v.redd.it/abc/def/ghi')).toBeNull();
    expect(redditVideoId('not a url')).toBeNull();
  });
});

describe('redditVideoBase', () => {
  it('builds from a checked id only', () => {
    expect(redditVideoBase('hhae5v10soxh1')).toBe('https://v.redd.it/hhae5v10soxh1');
    expect(redditVideoBase('../evil')).toBeNull();
  });
});

/** The shape v.redd.it serves today, trimmed to what the parser reads. */
const CMAF_MPD = `<MPD>
  <Period duration="PT15S" id="0">
    <AdaptationSet contentType="video" id="1" maxHeight="720" maxWidth="720">
      <Representation bandwidth="63418" height="220" id="5" mimeType="video/mp4" width="220">
        <BaseURL>CMAF_220.mp4</BaseURL>
      </Representation>
      <Representation bandwidth="467073" height="720" id="9" mimeType="video/mp4" width="720">
        <BaseURL>CMAF_720.mp4</BaseURL>
      </Representation>
      <Representation bandwidth="267214" height="480" id="8" mimeType="video/mp4" width="480">
        <BaseURL>CMAF_480.mp4</BaseURL>
      </Representation>
    </AdaptationSet>
    <AdaptationSet contentType="audio" id="2">
      <Representation audioSamplingRate="48000" codecs="mp4a.40.2" id="10" mimeType="audio/mp4">
        <BaseURL>CMAF_AUDIO_128.mp4</BaseURL>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

describe('parseRedditManifest', () => {
  it('picks the tallest rendition up to 720 and sees the sound', () => {
    expect(parseRedditManifest(CMAF_MPD)).toEqual({
      video: 'CMAF_720.mp4',
      width: 720,
      height: 720,
      audio: true,
    });
  });

  it('reads an older, soundless manifest with the mime type on the set', () => {
    const xml = `<MPD><Period>
      <AdaptationSet mimeType="video/mp4">
        <Representation height="1080" width="1920"><BaseURL>DASH_1080</BaseURL></Representation>
        <Representation height="720" width="1280"><BaseURL>DASH_720</BaseURL></Representation>
      </AdaptationSet>
    </Period></MPD>`;
    expect(parseRedditManifest(xml)).toEqual({
      video: 'DASH_720',
      width: 1280,
      height: 720,
      audio: false,
    });
  });

  it('falls back to the shortest when everything is over the cap', () => {
    const xml = `<AdaptationSet contentType="video">
      <Representation height="1440" width="1440"><BaseURL>CMAF_1440.mp4</BaseURL></Representation>
      <Representation height="1080" width="1080"><BaseURL>CMAF_1080.mp4</BaseURL></Representation>
    </AdaptationSet>`;
    expect(parseRedditManifest(xml)?.video).toBe('CMAF_1080.mp4');
  });

  it('refuses file names that could leave the clip’s directory', () => {
    const xml = `<AdaptationSet contentType="video">
      <Representation height="720" width="720"><BaseURL>../x.mp4</BaseURL></Representation>
      <Representation height="480" width="480"><BaseURL>https://evil.example/a.mp4</BaseURL></Representation>
    </AdaptationSet>`;
    expect(parseRedditManifest(xml)).toBeNull();
  });

  it('returns null for something that is not a manifest', () => {
    expect(parseRedditManifest('<Error>AccessDenied</Error>')).toBeNull();
    expect(parseRedditManifest('')).toBeNull();
  });
});
