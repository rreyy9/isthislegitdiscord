import { describe, expect, it } from 'vitest';
import { TrackSource } from 'livekit-server-sdk';
import { publishableSources } from './voice.service';

/**
 * The grant, as a function of the two things that can narrow it.
 *
 * The join token and the thirty-second sweep both ask this, so it is the one
 * place the rule can be wrong -- and a wrong answer is either somebody heard in
 * a room that promised silence, or somebody silenced who was not.
 */
describe('publishableSources', () => {
  it('gives everything to somebody neither muted nor in an AFK room', () => {
    const sources = publishableSources({ muted: false, listenOnly: false });
    expect(sources).toHaveLength(4);
    expect(sources).toEqual(
      expect.arrayContaining([
        TrackSource.CAMERA,
        TrackSource.MICROPHONE,
        TrackSource.SCREEN_SHARE,
        TrackSource.SCREEN_SHARE_AUDIO,
      ]),
    );
  });

  it('takes only the microphone from a muted person', () => {
    // The mute's own rule: it is aimed at the microphone, and a shared game
    // keeps its sound.
    const sources = publishableSources({ muted: true, listenOnly: false });
    expect(sources).not.toContain(TrackSource.MICROPHONE);
    expect(sources).toContain(TrackSource.SCREEN_SHARE);
    expect(sources).toContain(TrackSource.SCREEN_SHARE_AUDIO);
  });

  it("takes a shared screen's sound as well in an AFK room", () => {
    // Otherwise the system mix is a second microphone into a room that
    // promised nobody could talk in it.
    const sources = publishableSources({ muted: false, listenOnly: true });
    expect(sources).not.toContain(TrackSource.MICROPHONE);
    expect(sources).not.toContain(TrackSource.SCREEN_SHARE_AUDIO);
    // The picture stays: a silent screen breaks no promise.
    expect(sources).toContain(TrackSource.SCREEN_SHARE);
  });

  it('lets the room decide when both are true', () => {
    // The room's rule is the wider one, so a mute adds nothing to it.
    expect(publishableSources({ muted: true, listenOnly: true })).toEqual(
      publishableSources({ muted: false, listenOnly: true }),
    );
  });

  it('hands back a copy, so no caller can edit the rule for the next', () => {
    publishableSources({ muted: false, listenOnly: false }).pop();
    expect(publishableSources({ muted: false, listenOnly: false })).toHaveLength(4);
  });
});
