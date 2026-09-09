import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ConnectionState,
  createLocalAudioTrack,
  RemoteTrack,
  Room,
  RoomEvent,
  Track,
  type AudioCaptureOptions,
  type LocalAudioTrack,
  type Participant,
  type RemoteParticipant,
  type RemoteTrackPublication,
  type TrackPublishOptions,
} from 'livekit-client';
import { api, type VoiceAudioDto } from './api';
import { bridge } from './bridge';
import type { PttBinding } from '../preload';
import {
  GATE_SEED_TICKS,
  InputGate,
  SpeakingDetector,
  TrackMeter,
} from './audio-levels';

/**
 * Everything voice, in one hook.
 *
 * The heavy lifting — SFU routing, echo cancellation, jitter buffering, TURN
 * fallback, reconnection, device switching — belongs to LiveKit. What is left
 * for us is the join/leave lifecycle, the mute/deafen/push-to-talk rules, and
 * turning LiveKit's events into React state.
 *
 * Deliberately built on the core `livekit-client` rather than
 * `@livekit/components-react`: the prebuilt components carry their own theme,
 * and this client is 120 lines of hand-written CSS. Swapping the component
 * library in later would be a UI change, not an architectural one.
 *
 * The audio work added on top of that (input gate, incoming leveller) never
 * touches the media itself — see audio-levels.ts for why that matters.
 */

export interface VoicePeer {
  identity: string;
  name: string;
  speaking: boolean;
  muted: boolean;
  /**
   * Not something the SFU knows. Deafen is what somebody is doing with the
   * audio they receive, and nothing about that reaches the wire on its own, so
   * it is carried as a participant attribute — see `setDeafened`.
   */
  deafened: boolean;
  isLocal: boolean;
  screenSharing: boolean;
}

export interface ScreenShare {
  identity: string;
  name: string;
  track: Track;
}

/**
 * What the call itself is doing on the wire, read straight from WebRTC.
 *
 * Separate from the socket figures in net-stats.ts and not comparable to them:
 * this is UDP to the SFU, where loss is real loss -- audio that was dropped and
 * is never coming back -- rather than a probe that went unanswered.
 */
export interface VoiceNetStats {
  /** LiveKit's own verdict on the local connection. */
  quality: 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';
  /** Round trip to the SFU, as the sending peer connection measures it. */
  rttMs: number | null;
  /** Our microphone going out. `lost` is what the SFU reports it never got. */
  send: { packets: number; bytes: number; lost: number; jitterMs: number | null };
  /** Everyone else's audio coming in, summed. */
  recv: { packets: number; bytes: number; lost: number; jitterMs: number | null };
  codec: string | null;
}

export type VoiceStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed';

export interface VoiceState {
  channelId: string | null;
  status: VoiceStatus;
  error: string | null;
  peers: VoicePeer[];
  screenShares: ScreenShare[];
  muted: boolean;
  deafened: boolean;
  screenSharing: boolean;
  /** True while a push-to-talk key is physically held down. */
  talking: boolean;
  /** True while the input gate is letting sound through. Meaningless if off. */
  gateOpen: boolean;
  /** The quality the server picked, learned when a token is minted. */
  audio: VoiceAudioDto | null;
}

export interface VoiceSettings {
  inputDeviceId: string | null;
  outputDeviceId: string | null;
  pushToTalk: boolean;
  /** The key or mouse button to hold, in uiohook codes. */
  pttBinding: PttBinding | null;
  pttLabel: string | null;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  gateMode: 'off' | 'auto' | 'manual';
  gateThreshold: number;
  /** Playback level per person, 0..1, keyed by user id. Missing means 1. */
  userVolumes: Record<string, number>;
  rejoinLastChannel: boolean;
}

/**
 * Set when somebody closes the screen picker without choosing anything.
 *
 * The picker is a component and the request is made by this hook, so the one
 * fact that explains the rejection lives in neither. A module flag rather than
 * a round trip through main: it is set synchronously as the picker closes,
 * which is strictly before the getDisplayMedia rejection it accounts for can
 * arrive.
 */
let pickerCancelled = false;

export function noteScreenPickerCancelled() {
  pickerCancelled = true;
}

/**
 * Was this failure just somebody closing the picker?
 *
 * The flag is the reliable half: it is set by the picker itself, so it does
 * not depend on which of several messages Chromium picked this time. The
 * pattern is a second line for the cancels that never reach our picker at all
 * — a macOS screen-recording permission that was never granted, say.
 */
function isPickerCancellation(err: Error): boolean {
  return (
    pickerCancelled ||
    /permission denied|not allowed|cancel|invalid capture constraints/i.test(
      err.message ?? '',
    )
  );
}

/** A live reading of the local microphone, for the meter in settings. */
export interface InputLevel {
  db: number;
  thresholdDb: number;
  open: boolean;
}

const nameOf = (p: Participant) => p.name || p.identity;

/**
 * Stereo is a request, not a promise. Chromium refuses to run its echo
 * canceller on a two-channel capture, so asking for both gives you a mono
 * track and a confusing settings screen. Echo cancellation wins.
 */
const stereoWanted = (s: VoiceSettings, audio: VoiceAudioDto | null) =>
  Boolean(audio?.stereo) && !s.echoCancellation;

function captureOptions(
  s: VoiceSettings,
  audio: VoiceAudioDto | null,
): AudioCaptureOptions {
  return {
    deviceId: s.inputDeviceId ?? undefined,
    echoCancellation: s.echoCancellation,
    noiseSuppression: s.noiseSuppression,
    autoGainControl: s.autoGainControl,
    ...(stereoWanted(s, audio) ? { channelCount: 2 } : {}),
  };
}

/**
 * The codec half, all of it decided by the server. Passed explicitly at publish
 * time as well as being the room's defaults, so that a quality change picked up
 * from a later token applies to the track we are about to create.
 */
function publishOptions(
  s: VoiceSettings,
  audio: VoiceAudioDto | null,
): TrackPublishOptions {
  if (!audio) return {};
  return {
    audioPreset: { maxBitrate: audio.maxBitrate },
    dtx: audio.dtx,
    red: audio.red,
    forceStereo: stereoWanted(s, audio),
  };
}

/**
 * How often the level meters poll. 20ms is short enough that the gate reacts
 * within a poll and long enough that the reading is stable.
 */
const METER_INTERVAL_MS = 20;

/**
 * How long a freshly opened microphone is held silent before it may transmit.
 *
 * A capture device does not start clean. The first fraction of a second out of
 * one carries the step of the input being switched on and whatever the
 * browser's gain control and noise suppression make of a signal they have not
 * measured yet -- and published as-is, that is the click or burst of static
 * everyone already in the channel hears the moment somebody joins.
 *
 * The settling happens *before the track is published*, which is the whole
 * point and was got wrong once already. Publishing a muted track and unmuting
 * it a beat later does keep the noise off the wire, but it is not free: with
 * DTX on, a muted sender stops sending, the SFU stops forwarding, and every
 * listener's decoder has to resynchronise when the packets come back. That
 * resynchronisation is itself heard as a short burst of static -- so the fix
 * for the join noise was producing a join noise of its own. Holding the track
 * back instead means listeners see one event, a track that is already settled
 * and already in the state it belongs in, and there is no transition at all.
 *
 * A quarter of a second: longer than the device and the processing chain need
 * to settle, and shorter than it takes anyone to click into a channel and get
 * a word out. Never shorter than the gate's own seeding, because the meter is
 * running through this window and a gate still measuring the room would
 * publish shut and then open a moment later -- which is the mute-unmute step
 * this is here to avoid.
 */
const MIC_SETTLE_MS = 250;
const MIC_SETTLE_TICKS = Math.max(
  Math.ceil(MIC_SETTLE_MS / METER_INTERVAL_MS),
  GATE_SEED_TICKS,
);

/**
 * @param serverMuted An admin has taken this person's microphone away. The
 *   server already refuses the track, so this is not what enforces it — it is
 *   what stops the client from opening the capture device to publish something
 *   that would be rejected, and what makes the microphone come back on its own
 *   the moment the mute expires or is lifted.
 */
export function useVoice(settings: VoiceSettings, serverMuted = false) {
  const [state, setState] = useState<VoiceState>({
    channelId: null,
    status: 'idle',
    error: null,
    peers: [],
    screenShares: [],
    muted: false,
    deafened: false,
    screenSharing: false,
    talking: false,
    gateOpen: true,
    audio: null,
  });

  const roomRef = useRef<Room | null>(null);
  const audioBoxRef = useRef<HTMLDivElement | null>(null);
  // Read inside LiveKit callbacks, which React does not re-render, so the
  // current values have to be reachable without closing over stale state.
  const mutedRef = useRef(false);
  const deafenedRef = useRef(false);
  const talkingRef = useRef(false);
  /** Same reason as the others: applyMic runs outside React's knowledge. */
  const serverMutedRef = useRef(serverMuted);
  serverMutedRef.current = serverMuted;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const audioRef = useRef<VoiceAudioDto | null>(null);

  // Input gate. `gateOpenRef` is what applyMic reads; the React copy is only
  // for the "transmitting" light, which must not re-render at metering rate.
  const gateRef = useRef(new InputGate());
  const gateOpenRef = useRef(true);
  const micMeterRef = useRef<TrackMeter | null>(null);
  const micSourceRef = useRef<MediaStreamTrack | null>(null);
  /**
   * Meter ticks still owed before the microphone may transmit. Counted down by
   * the meter, so it measures audio actually arriving from the device rather
   * than wall-clock time since the request for it. See MIC_SETTLE_MS.
   */
  const micSettleRef = useRef(0);
  /**
   * Waiting to be told the settle window is over.
   *
   * The countdown is driven by the meter, and the open now has to wait for it
   * rather than publish and be called back, so somebody has to be able to
   * await it. Everything that zeroes the counter releases these, including
   * teardown -- an open abandoned mid-settle must not be left hanging.
   */
  const micSettleWaitersRef = useRef<(() => void)[]>([]);
  /**
   * The open currently in flight, or null.
   *
   * Opening the microphone stopped being quick when the settle moved in front
   * of the publish, and several things ask for one: the join, a mute being
   * lifted, the push-to-talk key, a settings change. Without this each of them
   * would open the capture device again and publish a second track.
   *
   * The room is held alongside it because leaving during an open abandons that
   * open without finishing it. Waiting on it would then be waiting for a
   * microphone that was never going to arrive, and the new channel would sit
   * there with nothing published until something else happened to ask again.
   */
  const micOpeningRef = useRef<{ room: Room; done: Promise<void> } | null>(
    null,
  );
  const inputLevelRef = useRef<InputLevel>({
    db: -100,
    thresholdDb: -60,
    open: false,
  });

  /** One meter and speech detector per remote person. */
  const remotesRef = useRef(
    new Map<
      string,
      {
        meter: TrackMeter | null;
        speak: SpeakingDetector;
      }
    >(),
  );

  /**
   * Every remote audio element this hook has made, by identity.
   *
   * The volume rules are applied to these rather than through LiveKit's
   * `setVolume`, because that one only ever reaches a participant's
   * *microphone* — its `source` argument defaults to it and nothing here was
   * passing another. Screen shares are published with the desktop audio
   * alongside them, and on Windows that is the whole system mix, so a deafen
   * pressed while somebody was sharing silenced every microphone in the
   * channel and left that one person playing at full volume. These elements
   * are where the sound actually comes out, and they are all of it.
   */
  const audioElsRef = useRef(new Map<string, Set<HTMLAudioElement>>());

  /**
   * Who is talking, measured here rather than taken from LiveKit.
   *
   * The SFU works out its active speakers from the audio it is forwarding and
   * broadcasts the answer on its own clock, so the light lagged at both ends —
   * on after someone had started, off after they had stopped. Every track
   * already carries a meter for the gate and the leveller, and that reading is
   * milliseconds old, so the timely answer was in the room all along.
   * `isSpeaking` stays the fallback for anyone not yet metered.
   */
  const speakingRef = useRef(new Map<string, boolean>());
  const localSpeechRef = useRef(new SpeakingDetector());

  /* -------------------------------------------------- hidden audio sink */

  useEffect(() => {
    // Remote audio elements have to be in the document to play. Nobody ever
    // sees them, so they live in one hidden box outside the React tree.
    const box = document.createElement('div');
    box.style.display = 'none';
    document.body.appendChild(box);
    audioBoxRef.current = box;
    return () => box.remove();
  }, []);

  /* ---------------------------------------------------- how loud is who */

  /**
   * One place works out how loud a remote person should be, because two things
   * have an opinion: deafen (silences everything) and the slider set for that
   * person.
   *
   * Capped at 1, which is also why the per-person slider only turns people
   * down. Without `webAudioMix` this ends up as an HTMLMediaElement `volume`,
   * and the spec caps that at 1.0 — anything above it throws. Boosting would
   * mean routing every remote track through Web Audio, and being able to
   * amplify is not worth putting a question mark over echo cancellation in a
   * voice app.
   */
  const volumeFor = useCallback((identity: string) => {
    if (deafenedRef.current) return 0;
    const wanted = settingsRef.current.userVolumes[identity] ?? 1;
    return Math.max(0, Math.min(1, wanted));
  }, []);

  /**
   * Put the current answer on every remote audio element there is.
   *
   * Called from `sync`, which is to say after every room event there is,
   * rather than only when something known to matter has changed. That is
   * deliberate and it is the fix for deafen letting one person through.
   *
   * The old arrangement decided an element's volume once, when its track was
   * subscribed, and revisited it only when somebody pressed deafen — and the
   * revisit went through LiveKit, which only reaches a participant's
   * microphone and only while it is the publication it is currently holding.
   * Every ordering that put a new element in front of a stale reading, or a
   * new participant object in front of a `setVolume` that had already been
   * spent, left exactly one person audible in a deafened channel, and pressing
   * deafen twice was the only way back. Rather than chase which ordering it
   * was, this takes the orderings away: whatever happens, the event it
   * happened on puts every element right, and somebody joining is an event.
   *
   * It costs a float assignment per remote person per event, on a handful of
   * elements. Writing the value it already had is free.
   */
  const enforceVolumes = useCallback(() => {
    for (const [identity, els] of audioElsRef.current) {
      const v = volumeFor(identity);
      for (const el of els) {
        if (el.volume !== v) el.volume = v;
        // A second lock on the same door. Volume is a number, and a number is
        // the sort of thing something else can plausibly write; `muted` is
        // not, and silence is the state that has to be right.
        if (el.muted !== (v === 0)) el.muted = v === 0;
      }
    }
  }, [volumeFor]);

  /* ------------------------------------------------------ derived state */

  const sync = useCallback(() => {
    // First, and above the room check: this is the half that has to be true,
    // and an element left over from a room that has gone is exactly the kind
    // of thing it is here to silence.
    enforceVolumes();

    const room = roomRef.current;
    if (!room) return;

    const all: Participant[] = [
      room.localParticipant,
      ...room.remoteParticipants.values(),
    ];

    const peers: VoicePeer[] = all.map((p) => ({
      identity: p.identity,
      name: nameOf(p),
      speaking: speakingRef.current.get(p.identity) ?? p.isSpeaking,
      muted: !p.isMicrophoneEnabled,
      // Ours is read from the ref rather than the attribute we just published,
      // so the icon does not wait on a round trip to the server.
      deafened:
        p === room.localParticipant
          ? deafenedRef.current
          : p.attributes?.deafened === '1',
      isLocal: p === room.localParticipant,
      screenSharing: p.isScreenShareEnabled,
    }));

    const screenShares: ScreenShare[] = [];
    for (const p of all) {
      for (const pub of p.trackPublications.values()) {
        if (pub.source === Track.Source.ScreenShare && pub.track) {
          screenShares.push({
            identity: p.identity,
            name: nameOf(p),
            track: pub.track,
          });
        }
      }
    }

    setState((s) => ({
      ...s,
      peers,
      screenShares,
      screenSharing: room.localParticipant.isScreenShareEnabled,
    }));
  }, [enforceVolumes]);

  /** Record who is talking, and re-render only when the answer changes. */
  const setSpeaking = useCallback(
    (identity: string | undefined, speaking: boolean) => {
      if (!identity) return;
      if (speakingRef.current.get(identity) === speaking) return;
      speakingRef.current.set(identity, speaking);
      sync();
    },
    [sync],
  );

  /* ------------------------------------------------------------ volumes */

  /**
   * Say it to LiveKit as well, so it holds the right value for anything it
   * attaches to these people later.
   *
   * Named per source. `RemoteParticipant.setVolume` takes one and defaults it
   * to the microphone, which is why this used to have no opinion at all about
   * the screen-share audio track sitting next to it.
   *
   * The elements are the ones that matter and `enforceVolumes` has already
   * done them; this is only bookkeeping, which is why it is not on the path
   * that runs constantly.
   */
  const applyVolumes = useCallback(() => {
    enforceVolumes();
    const room = roomRef.current;
    if (!room) return;
    for (const p of room.remoteParticipants.values()) {
      const v = volumeFor(p.identity);
      p.setVolume(v, Track.Source.Microphone);
      p.setVolume(v, Track.Source.ScreenShareAudio);
    }
  }, [enforceVolumes, volumeFor]);

  /**
   * Tell the channel whether we can hear it.
   *
   * An attribute rather than anything of LiveKit's own, because deafen is a
   * listener state and the SFU replicates what people send. The server holds
   * it and puts it in the participant info everyone gets, so somebody joining
   * an hour later sees it without anyone having to answer them — which is the
   * whole reason this is not a data message.
   *
   * Never rejects: an indicator that did not update is not worth failing a
   * join over, and the room may be gone by the time the request lands.
   */
  const publishDeafened = useCallback(async (room: Room | null) => {
    if (!room) return;
    await room.localParticipant
      .setAttributes({ deafened: deafenedRef.current ? '1' : '' })
      .catch(() => {});
  }, []);

  /* --------------------------------------------------------- mic policy */

  /**
   * Should a microphone track exist at all?
   *
   * Read as a function rather than computed once, because opening the device
   * now spans a settle window and every one of these can change during it.
   *
   * Deafen is a term here in its own right, not something inherited from the
   * mute it also sets. It used to be the latter, and that was the whole bug:
   * anything that cleared `muted` without knowing about deafen -- the mute
   * button, which reads "Unmute" precisely because deafening muted you --
   * put the microphone back on the air while every incoming track was still
   * silenced. Stated here it holds for push-to-talk and the gate alike,
   * because both of them come through this function and `liveNow`.
   */
  const wantsTrackNow = useCallback(
    () =>
      !serverMutedRef.current &&
      !mutedRef.current &&
      !deafenedRef.current &&
      (!settingsRef.current.pushToTalk || talkingRef.current),
    [],
  );

  /** Should that track be transmitting this instant? Same reason, same rules. */
  const liveNow = useCallback(() => {
    const s = settingsRef.current;
    return (
      !serverMutedRef.current &&
      !mutedRef.current &&
      !deafenedRef.current &&
      (s.pushToTalk
        ? talkingRef.current
        : s.gateMode === 'off' || gateOpenRef.current)
    );
  }, []);

  /** The settle window is over. Zeroes the count and releases anyone waiting. */
  const finishSettle = useCallback(() => {
    micSettleRef.current = 0;
    const waiting = micSettleWaitersRef.current;
    micSettleWaitersRef.current = [];
    for (const resolve of waiting) resolve();
  }, []);

  const micSettled = useCallback(
    () =>
      micSettleRef.current === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            micSettleWaitersRef.current.push(resolve);
          }),
    [],
  );

  /**
   * Open the capture device, let it settle, and publish it already correct.
   *
   * Never rejects: it is awaited by a caller that has its own answer for a
   * microphone which did not appear, and a rejection here would only turn that
   * into an unhandled one.
   */
  const openMic = useCallback(
    async (room: Room) => {
      let fresh: LocalAudioTrack;
      try {
        fresh = await createLocalAudioTrack(
          captureOptions(settingsRef.current, audioRef.current),
        );
      } catch (e) {
        // setMicrophoneEnabled routed this through RoomEvent.MediaDevicesError;
        // opening the device by hand means saying it here instead.
        if (roomRef.current === room) {
          setState((st) => ({ ...st, error: (e as Error).message }));
        }
        return;
      }
      // The device is open now, so a join that has been superseded while it
      // opened has to give it back rather than leave the indicator lit.
      if (roomRef.current !== room) {
        fresh.stop();
        return;
      }

      // The meter goes on before the publish and before any mute, which is
      // both halves of the point. It measures audio the device is actually
      // delivering, so the settle is counted in real samples rather than wall
      // clock; and a clone inherits `enabled`, so one taken from a track that
      // had already been muted would read silence for the rest of the call.
      ensureMicMeter(fresh.mediaStreamTrack);
      await micSettled();
      if (roomRef.current !== room) {
        fresh.stop();
        ensureMicMeter();
        return;
      }

      // Published in the state it belongs in, so there is no transition for
      // anybody to hear. See MIC_SETTLE_MS.
      if (!liveNow()) await fresh.mute().catch(() => {});
      try {
        await room.localParticipant.publishTrack(
          fresh,
          publishOptions(settingsRef.current, audioRef.current),
        );
      } catch {
        fresh.stop();
        // The meter is pointing at a track nobody holds any more.
        ensureMicMeter();
      }
      // ensureMicMeter is deliberately not a dependency: it depends on
      // applyMic, which depends on this, and the cycle has to be cut
      // somewhere. Every one of them is stable across renders.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [liveNow, micSettled],
  );

  /**
   * One place decides whether the microphone is live, because five things now
   * fight over it. An admin's mute wins outright — the server will not accept
   * the track anyway, so there is no reason to hold the capture device open
   * and light somebody's microphone indicator for audio that goes nowhere.
   * Then manual mute. With push-to-talk on, the mic is open only while the key
   * is held. Otherwise the gate has a say.
   *
   * `wantsTrackNow` is separate from `liveNow` on purpose: it is exactly the
   * old rule, and it decides whether a microphone track should exist at all.
   * The gate then mutes and unmutes that existing track rather than publishing
   * and unpublishing one, which is both far faster and the only workable order
   * — the gate reads its level from the track, so the track has to come first.
   * With the gate off the two are identical and this behaves as it always did.
   */
  const applyMic = useCallback(async () => {
    const room = roomRef.current;
    if (!room || room.state !== ConnectionState.Connected) return;

    if (!wantsTrackNow()) {
      // Mutes rather than unpublishes -- that is what setMicrophoneEnabled(false)
      // does, and it is the behaviour worth having: the device stays open, so
      // coming off mute has nothing to settle and makes no noise.
      await room.localParticipant.setMicrophoneEnabled(false).catch(() => {});
      return;
    }

    let pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (!pub?.track) {
      // One open at a time per room, and a caller that arrives during one
      // waits for it rather than starting a second. Every rule is re-read
      // below once it lands, so waiting still gives the right answer -- which
      // matters more now that an open spans a settle window rather than
      // returning at once.
      let opening = micOpeningRef.current;
      if (!opening || opening.room !== room) {
        opening = { room, done: openMic(room) };
        micOpeningRef.current = opening;
      }
      await opening.done;
      if (micOpeningRef.current === opening) micOpeningRef.current = null;
      if (roomRef.current !== room) return;
      pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    }

    const track = pub?.track;
    if (!track) return;
    // A microphone that has only just been opened stays silent whatever the
    // mute rules say; the meter calls this back when it has settled.
    const transmit = liveNow() && micSettleRef.current === 0;
    if (transmit && track.isMuted) await track.unmute().catch(() => {});
    else if (!transmit && !track.isMuted) await track.mute().catch(() => {});
  }, [liveNow, openMic, wantsTrackNow]);

  /**
   * Attach the level meter to whatever microphone track is current.
   *
   * Keyed on the underlying MediaStreamTrack rather than the publication,
   * because switching input device swaps that out from under the same
   * LocalAudioTrack and the old meter would go quiet for ever.
   *
   * `track` is for the one caller that has a microphone the publication cannot
   * yet see: the open, which meters and settles the device before publishing
   * it. Everybody else asks the publication, as before.
   */
  const ensureMicMeter = useCallback((track?: MediaStreamTrack | null) => {
    const room = roomRef.current;
    const source =
      track ??
      room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track
        ?.mediaStreamTrack ??
      null;
    if (source === micSourceRef.current) return;

    micMeterRef.current?.close();
    micMeterRef.current = null;
    micSourceRef.current = source;
    gateRef.current.reset();
    // Any new source is a cold one -- a fresh join, or the input device having
    // been switched under the same track -- so both start from silence.
    if (source) micSettleRef.current = MIC_SETTLE_TICKS;
    else finishSettle();
    if (!source) {
      // Losing the track stops the meter — so if this is not said now,
      // nothing will ever say it, and the ring stays lit on whatever the last
      // reading before it went happened to be.
      localSpeechRef.current.reset();
      setSpeaking(room?.localParticipant.identity, false);
      return;
    }

    micMeterRef.current = new TrackMeter(
      source,
      METER_INTERVAL_MS,
      (db) => {
        const s = settingsRef.current;
        // Counted here rather than on a timer so it measures audio the device
        // has actually delivered. The tick that finishes it is the one that
        // may open the microphone, so it asks for the decision again.
        if (micSettleRef.current > 0) {
          micSettleRef.current -= 1;
          if (micSettleRef.current === 0) {
            // Releases the open that is waiting to publish. The second call is
            // for the other way in -- an input device switched under a track
            // that is already published, which nothing is awaiting.
            finishSettle();
            void applyMic();
          }
        }
        const open = gateRef.current.update(db, s.gateMode, s.gateThreshold);
        inputLevelRef.current = {
          db,
          thresholdDb: gateRef.current.thresholdDb,
          open,
        };
        if (open !== gateOpenRef.current) {
          gateOpenRef.current = open;
          setState((prev) => ({ ...prev, gateOpen: open }));
          if (!s.pushToTalk && s.gateMode !== 'off') void applyMic();
        }
        // Updated every tick and never short-circuited: the detector holds a
        // timer, and skipping readings while muted would leave it stale. Being
        // loud while muted is still not talking, so the two combine after.
        const loud = localSpeechRef.current.update(db);
        // The same rule the microphone itself is under, and it has to stay
        // that way: this decides whether your own portrait lights up, and a
        // portrait that lights while nothing is going out is the client
        // telling you that you are being heard when you are not.
        const live =
          !serverMutedRef.current &&
          !mutedRef.current &&
          !deafenedRef.current &&
          micSettleRef.current === 0 &&
          (s.pushToTalk ? talkingRef.current : s.gateMode === 'off' || open);
        setSpeaking(roomRef.current?.localParticipant.identity, loud && live);
      },
      // Essential, not an optimisation: see TrackMeter.
      { clone: true },
    );
  }, [applyMic, finishSettle, setSpeaking]);

  /* --------------------------------------------------------- join/leave */

  const teardownAudio = useCallback(() => {
    micMeterRef.current?.close();
    micMeterRef.current = null;
    micSourceRef.current = null;
    // Releases an open abandoned mid-settle. Nothing else will ever tick the
    // countdown down now that its meter is closed, so without this the open
    // waits for a window that has already gone.
    finishSettle();
    micOpeningRef.current = null;
    gateRef.current.reset();
    gateOpenRef.current = true;
    localSpeechRef.current.reset();
    speakingRef.current.clear();
    for (const entry of remotesRef.current.values()) entry.meter?.close();
    remotesRef.current.clear();
    // The unsubscribe events clear these one at a time in the ordinary case,
    // but a room that is going away does not always get to send them, and an
    // element left in the sink is an element nothing is applying deafen to.
    for (const els of audioElsRef.current.values()) {
      for (const el of els) el.remove();
    }
    audioElsRef.current.clear();
  }, [finishSettle]);

  /**
   * Which join attempt is the live one.
   *
   * Two can be in flight at once — a second click on a channel, or the
   * rejoin-on-start landing at the same moment as a manual join — and both
   * have `await` points before they finish. Without this the loser's
   * continuations still ran: the abandoned attempt's `connect` rejects with
   * "client initiated disconnect", its catch clears `roomRef` and the status,
   * and the room that actually connected is left with nothing pointing at it.
   * LiveKit keeps that participant in the channel, but leave, mute and the
   * disconnect on window close all read `roomRef` and so do nothing at all.
   */
  const joinSeqRef = useRef(0);

  const leave = useCallback(async () => {
    joinSeqRef.current += 1;
    const room = roomRef.current;
    roomRef.current = null;
    teardownAudio();
    if (room) await room.disconnect().catch(() => {});
    setState((s) => ({
      ...s,
      channelId: null,
      status: 'idle',
      peers: [],
      screenShares: [],
      screenSharing: false,
    }));
  }, [teardownAudio]);

  const join = useCallback(
    async (channelId: string) => {
      await leave();

      // `leave` has just bumped the counter, so this claims the attempt.
      const mine = joinSeqRef.current;
      const superseded = () => joinSeqRef.current !== mine;

      setState((s) => ({
        ...s,
        channelId,
        status: 'connecting',
        error: null,
        peers: [],
        screenShares: [],
      }));

      // The token comes first now, because it carries the server's audio
      // quality and the room has to be built with it. Kept outside the try so
      // a failure can name the address that did not answer, which is the whole
      // diagnosis most of the time.
      let url = '';
      let token = '';
      try {
        // The token is minted per join and lives ten minutes — long enough to
        // connect, short enough that a sniffed one is not worth much.
        const res = await api.voiceToken(channelId);
        if (superseded()) return;
        token = res.token;
        url = res.livekitUrl;
        audioRef.current = res.audio ?? null;
        setState((s) => ({ ...s, audio: res.audio ?? null }));
      } catch (err) {
        if (superseded()) return;
        setState((s) => ({
          ...s,
          channelId: null,
          status: 'failed',
          error: joinErrorMessage(err as Error, url),
        }));
        return;
      }

      const s = settingsRef.current;
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: captureOptions(s, audioRef.current),
        publishDefaults: publishOptions(s, audioRef.current),
      });
      roomRef.current = room;

      /**
       * Is this still the room the app is in?
       *
       * LiveKit events are not always delivered before the call that provoked
       * them returns — an aborted connection attempt in particular emits its
       * `Disconnected` late. Handlers that write shared state check this first
       * so a dead room cannot reset the live one.
       */
      const isCurrent = () => roomRef.current === room;

      room
        .on(RoomEvent.ParticipantConnected, () => {
          applyVolumes();
          sync();
        })
        .on(RoomEvent.ParticipantDisconnected, sync)
        // How somebody else's deafen reaches this client. Nothing else is
        // carried this way, so there is no need to look at what changed.
        .on(RoomEvent.ParticipantAttributesChanged, sync)
        .on(RoomEvent.TrackMuted, sync)
        .on(RoomEvent.TrackUnmuted, sync)
        .on(RoomEvent.LocalTrackPublished, () => {
          ensureMicMeter();
          sync();
        })
        .on(RoomEvent.LocalTrackUnpublished, () => {
          ensureMicMeter();
          sync();
        })
        .on(RoomEvent.TrackPublished, sync)
        .on(RoomEvent.TrackUnpublished, sync)
        .on(RoomEvent.ActiveSpeakersChanged, sync)
        .on(RoomEvent.MediaDevicesChanged, () => ensureMicMeter())
        .on(
          RoomEvent.TrackSubscribed,
          (
            track: RemoteTrack,
            _pub: RemoteTrackPublication,
            participant: RemoteParticipant,
          ) => {
            if (track.kind === Track.Kind.Audio) {
              // The element is built here, with the volume already on it,
              // rather than taken from a bare `attach()`. `attach()` sets the
              // source and starts playing at once, so setting the volume
              // after it -- which is what this did -- let a moment of audio
              // out at full volume before deafen or this person's slider had
              // been applied. Joining a channel subscribes to everyone in it
              // at the same time, so that moment was every one of them.
              const v = volumeFor(participant.identity);
              const el = document.createElement('audio');
              el.autoplay = true;
              el.volume = v;
              track.attach(el);
              // After the attach, not before: attaching sets `muted` itself,
              // from whether the stream carries any audio at all.
              el.muted = v === 0;
              audioBoxRef.current?.appendChild(el);
              // Kept so a later deafen or slider can reach it. Without this
              // the only thing that ever set this element's volume was the
              // line above, which is the state of the world one instant ago.
              let els = audioElsRef.current.get(participant.identity);
              if (!els) {
                els = new Set();
                audioElsRef.current.set(participant.identity, els);
              }
              els.add(el);
              // The microphone only. There is one meter per person and it is
              // what lights their portrait, so metering a screen-share audio
              // track here replaced it — and the ring then followed whatever
              // was coming out of the game they were sharing rather than
              // whether they were speaking.
              if (track.source === Track.Source.Microphone) {
                watchRemote(participant, track);
              }
              // Still said to LiveKit, so it holds the volume for any element
              // it attaches to this participant later. Named for this track's
              // own source rather than defaulting to the microphone, which is
              // what left screen-share audio out of every later change. Those
              // two are the only sources it accepts; an audio track of any
              // other source is one this app does not publish, and the element
              // above is already carrying the right volume for it.
              if (
                track.source === Track.Source.Microphone ||
                track.source === Track.Source.ScreenShareAudio
              ) {
                participant.setVolume(v, track.source);
              }
            }
            sync();
          },
        )
        .on(
          RoomEvent.TrackUnsubscribed,
          (track: RemoteTrack, _pub, participant: RemoteParticipant) => {
            const els = audioElsRef.current.get(participant.identity);
            track.detach().forEach((el) => {
              els?.delete(el as HTMLAudioElement);
              el.remove();
            });
            if (els?.size === 0) {
              audioElsRef.current.delete(participant.identity);
            }
            // Only the microphone takes the meter away with it, for the same
            // reason only the microphone sets one up: somebody stopping a
            // screen share used to close the meter that was watching them
            // speak, and their portrait stayed dark for the rest of the call.
            if (track.source === Track.Source.Microphone) {
              remotesRef.current.get(participant.identity)?.meter?.close();
              remotesRef.current.delete(participant.identity);
              speakingRef.current.delete(participant.identity);
            }
            sync();
          },
        )
        .on(RoomEvent.Reconnecting, () => {
          if (!isCurrent()) return;
          setState((st) => ({ ...st, status: 'reconnecting' }));
        })
        .on(RoomEvent.Reconnected, () => {
          if (!isCurrent()) return;
          setState((st) => ({ ...st, status: 'connected' }));
          void applyMic();
          applyVolumes();
          // A full reconnect rebuilds the participant from the join response,
          // so anything said before it has to be said again.
          void publishDeafened(room);
          ensureMicMeter();
          sync();
        })
        .on(RoomEvent.Disconnected, () => {
          if (!isCurrent()) return;
          roomRef.current = null;
          teardownAudio();
          setState((st) => ({
            ...st,
            channelId: null,
            status: 'idle',
            peers: [],
            screenShares: [],
            screenSharing: false,
          }));
        })
        // Screen-share failures arrive here as well as rejecting the call that
        // started them, and this fires first — so cancelling the picker put a
        // red banner up through this path no matter what the caller did with
        // the rejection. Microphone failures are still worth saying out loud.
        .on(RoomEvent.MediaDevicesError, (e: Error) => {
          if (!isCurrent() || isPickerCancellation(e)) return;
          setState((st) => ({ ...st, error: e.message }));
        });

      try {
        await room.connect(url, token);

        // Somebody joined elsewhere while this was connecting. Hang this room
        // up rather than leaving it in the call with nothing pointing at it.
        if (!isCurrent()) {
          await room.disconnect().catch(() => {});
          return;
        }

        if (settingsRef.current.outputDeviceId) {
          await room
            .switchActiveDevice(
              'audiooutput',
              settingsRef.current.outputDeviceId,
            )
            .catch(() => {});
        }

        setState((st) => ({ ...st, status: 'connected' }));
        await applyMic();
        applyVolumes();
        // A fresh room starts with no attributes on it, so somebody who was
        // already deafened when they moved channel would arrive looking like
        // they could hear. Sent every join rather than only when deafened,
        // because the same is true of the state having been turned off.
        void publishDeafened(room);
        ensureMicMeter();
        sync();
      } catch (err) {
        // A join that has already been replaced fails with "client initiated
        // disconnect" precisely because it was replaced. Clean up its own room
        // and say nothing: the state belongs to whoever superseded it.
        const stale = !isCurrent();
        if (!stale) {
          roomRef.current = null;
          teardownAudio();
        }
        await room.disconnect().catch(() => {});
        if (stale) return;
        setState((st) => ({
          ...st,
          channelId: null,
          status: 'failed',
          error: joinErrorMessage(err as Error, url),
        }));
      }
    },
    [
      applyMic,
      applyVolumes,
      ensureMicMeter,
      leave,
      publishDeafened,
      sync,
      teardownAudio,
      volumeFor,
    ],
  );

  /**
   * Start metering one remote person, which is how their portrait knows to
   * light up. The meter is a tap on their track and connects to nothing, so
   * the audio path is exactly what it would have been.
   */
  const watchRemote = useCallback(
    (participant: RemoteParticipant, track: RemoteTrack) => {
      remotesRef.current.get(participant.identity)?.meter?.close();
      const entry = {
        meter: null as TrackMeter | null,
        speak: new SpeakingDetector(),
      };
      remotesRef.current.set(participant.identity, entry);
      // 50ms rather than 100, because this reading decides whether someone's
      // portrait is lit, and that is a thing people watch.
      entry.meter = new TrackMeter(track.mediaStreamTrack, 50, (db) => {
        setSpeaking(participant.identity, entry.speak.update(db));
      });
    },
    [setSpeaking],
  );

  /* ------------------------------------------------------------ controls */

  /**
   * Mute and unmute, and the one place the two states are tied together.
   *
   * Unmuting while deafened un-deafens. Muting is left alone -- being able to
   * go quiet without giving up hearing everyone is the point of having two
   * buttons. Asking to talk while deaf is the case with no coherent answer,
   * and this is the one people expect: the only reason the button says
   * "Unmute" in the first place is that deafening muted you, so the click
   * that undoes the mute undoes what caused it.
   */
  const setMuted = useCallback(
    async (next: boolean) => {
      const undeafening = !next && deafenedRef.current;
      mutedRef.current = next;
      if (undeafening) deafenedRef.current = false;
      setState((s) => ({
        ...s,
        muted: next,
        deafened: undeafening ? false : s.deafened,
      }));
      if (undeafening) {
        // Everything setDeafened(false) would have done, because this is that
        // -- the volumes have to come back up and the channel has to be told.
        applyVolumes();
        void publishDeafened(roomRef.current);
        sync();
      }
      await applyMic();
    },
    [applyMic, applyVolumes, publishDeafened, sync],
  );

  const setDeafened = useCallback(
    async (next: boolean) => {
      deafenedRef.current = next;
      // Deafening implies muting; un-deafening does not un-mute, which matches
      // what people expect from every other client they have used. The mute is
      // for what happens after: it is what leaves somebody who un-deafens able
      // to hear and still silent. It is no longer what keeps them silent while
      // deafened -- the mic policy reads `deafened` itself now.
      if (next) {
        mutedRef.current = true;
        setState((s) => ({ ...s, deafened: true, muted: true }));
      } else {
        setState((s) => ({ ...s, deafened: false }));
      }
      applyVolumes();
      // Nobody else can work this out for themselves, so it has to be said.
      void publishDeafened(roomRef.current);
      // The local half of the same fact. `sync` reads the ref rather than the
      // attribute, so this does not wait on the round trip.
      sync();
      await applyMic();
    },
    [applyVolumes, applyMic, publishDeafened, sync],
  );

  const toggleScreenShare = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const on = room.localParticipant.isScreenShareEnabled;
    pickerCancelled = false;
    // Whatever went wrong last time is not this attempt's problem, and the
    // banner has no dismiss of its own.
    setState((s) => ({ ...s, error: null }));
    try {
      // Screen audio on Windows is the system mix, which is the whole point
      // when sharing a game; LiveKit publishes it as a second track.
      await room.localParticipant.setScreenShareEnabled(!on, { audio: true });
    } catch (err) {
      // Cancelling always rejects, and what it rejects with is Chromium's
      // business — it has been a permission error and an "invalid capture
      // constraints" at different times. Ours is the only account of it worth
      // trusting, so the flag decides, not the message.
      if (!isPickerCancellation(err as Error)) {
        setState((s) => ({ ...s, error: (err as Error).message }));
      }
    }
    pickerCancelled = false;
    sync();
  }, [sync]);

  /** The banner sits there until something replaces it; this is its dismiss. */
  const clearError = useCallback(() => {
    setState((s) => (s.error === null ? s : { ...s, error: null }));
  }, []);

  const setInputDevice = useCallback(
    async (deviceId: string) => {
      await roomRef.current
        ?.switchActiveDevice('audioinput', deviceId)
        .catch(() => {});
      ensureMicMeter();
    },
    [ensureMicMeter],
  );

  const setOutputDevice = useCallback(async (deviceId: string) => {
    await roomRef.current
      ?.switchActiveDevice('audiooutput', deviceId)
      .catch(() => {});
  }, []);

  /**
   * Throw the microphone track away and make a new one. Capture constraints
   * are fixed when getUserMedia is called, so changing echo cancellation or
   * noise suppression means starting over — there is no way to talk a live
   * track into a different constraint set.
   */
  const republishMic = useCallback(async () => {
    const room = roomRef.current;
    if (!room || room.state !== ConnectionState.Connected) return;
    const pub = room.localParticipant.getTrackPublication(
      Track.Source.Microphone,
    );
    if (pub?.track) {
      await room.localParticipant.unpublishTrack(pub.track, true).catch(() => {});
    }
    ensureMicMeter();
    await applyMic();
  }, [applyMic, ensureMicMeter]);

  /**
   * WebRTC counters for the network panel, gathered on demand.
   *
   * On demand rather than in state: getStats is a real query against the peer
   * connection, and nothing outside the panel wants the answer. Every field is
   * read defensively — which stats a browser reports varies with the codec and
   * with how long the call has been up, and a missing counter must read as
   * "not measured" rather than as zero, which would look like total loss.
   */
  const getNetStats = useCallback(async (): Promise<VoiceNetStats | null> => {
    const room = roomRef.current;
    if (!room || room.state !== ConnectionState.Connected) return null;

    const stats: VoiceNetStats = {
      // The enum's values are exactly this union, 'unknown' included.
      quality: room.localParticipant.connectionQuality as VoiceNetStats['quality'],
      rttMs: null,
      send: { packets: 0, bytes: 0, lost: 0, jitterMs: null },
      recv: { packets: 0, bytes: 0, lost: 0, jitterMs: null },
      codec: null,
    };
    const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : 0);

    // Outgoing. Loss and round trip are only known from the SFU's report back
    // to us (remote-inbound-rtp); the sender itself cannot see either.
    const mic = room.localParticipant.getTrackPublication(
      Track.Source.Microphone,
    )?.track;
    const sendReport = await mic?.getRTCStatsReport().catch(() => undefined);
    sendReport?.forEach((r: any) => {
      if (r.type === 'outbound-rtp') {
        stats.send.packets += num(r.packetsSent);
        stats.send.bytes += num(r.bytesSent);
      } else if (r.type === 'remote-inbound-rtp') {
        stats.send.lost += num(r.packetsLost);
        if (typeof r.jitter === 'number') {
          stats.send.jitterMs = r.jitter * 1000;
        }
        if (typeof r.roundTripTime === 'number') {
          stats.rttMs = r.roundTripTime * 1000;
        }
      } else if (r.type === 'codec' && typeof r.mimeType === 'string') {
        stats.codec = r.mimeType.replace(/^audio\//, '');
      }
    });

    // Incoming, summed over everyone. Jitter is averaged rather than added:
    // it is a property of each stream, and a total would say nothing.
    const jitters: number[] = [];
    for (const peer of room.remoteParticipants.values()) {
      for (const pub of peer.getTrackPublications()) {
        if (pub.kind !== Track.Kind.Audio || !pub.track) continue;
        const report = await pub.track.getRTCStatsReport().catch(() => undefined);
        report?.forEach((r: any) => {
          if (r.type !== 'inbound-rtp') return;
          stats.recv.packets += num(r.packetsReceived);
          stats.recv.bytes += num(r.bytesReceived);
          stats.recv.lost += num(r.packetsLost);
          if (typeof r.jitter === 'number') jitters.push(r.jitter * 1000);
        });
      }
    }
    if (jitters.length) {
      stats.recv.jitterMs = jitters.reduce((a, b) => a + b, 0) / jitters.length;
    }

    return stats;
  }, []);

  /** A snapshot for the settings meter, read on its own clock — see above. */
  const getInputLevel = useCallback(() => inputLevelRef.current, []);

  /* -------------------------------------------------------- push-to-talk */

  useEffect(() => {
    const off = bridge.onPttChange((held) => {
      talkingRef.current = held;
      setState((s) => ({ ...s, talking: held }));
      void applyMic();
    });
    return off;
  }, [applyMic]);

  // Hand the key to the global hook whenever the setting changes.
  useEffect(() => {
    void bridge.setPtt({
      enabled: settings.pushToTalk,
      binding: settings.pttBinding,
    });
    if (!settings.pushToTalk) {
      talkingRef.current = false;
      setState((s) => ({ ...s, talking: false }));
    }
    void applyMic();
  }, [settings.pushToTalk, settings.pttBinding, applyMic]);

  /* --------------------------------------------- react to settings changes */

  useEffect(() => {
    applyVolumes();
  }, [settings.userVolumes, applyVolumes]);

  useEffect(() => {
    gateRef.current.reset();
    void applyMic();
  }, [settings.gateMode, applyMic]);

  /**
   * An admin muted or unmuted us while we were sitting in a call.
   *
   * Both directions matter. On the way in, the microphone has to stop being
   * captured. On the way out it has to start again by itself — the server took
   * the published track away when the mute landed, and without this the person
   * would sit there apparently unmuted, with the button showing a live
   * microphone, until they toggled it or rejoined the channel.
   */
  useEffect(() => {
    void applyMic();
  }, [serverMuted, applyMic]);

  // Constraint changes need a new capture, which is disruptive, so this must
  // not fire on mount — the track was just created with these very values.
  const constraints = `${settings.echoCancellation}|${settings.noiseSuppression}|${settings.autoGainControl}`;
  const firstConstraintRun = useRef(true);
  useEffect(() => {
    if (firstConstraintRun.current) {
      firstConstraintRun.current = false;
      return;
    }
    void republishMic();
  }, [constraints, republishMic]);

  // A window closed mid-call should not leave a ghost sitting in the channel.
  useEffect(() => {
    const bye = () => {
      void roomRef.current?.disconnect();
    };
    window.addEventListener('beforeunload', bye);
    return () => {
      window.removeEventListener('beforeunload', bye);
      teardownAudio();
      void roomRef.current?.disconnect();
    };
  }, [teardownAudio]);

  return {
    ...state,
    join,
    leave,
    setMuted,
    setDeafened,
    toggleScreenShare,
    clearError,
    setInputDevice,
    setOutputDevice,
    getInputLevel,
    getNetStats,
  };
}

/**
 * LiveKit reports a server that is simply not running as "could not establish
 * signal connection: Failed to fetch", which sends people looking for a bug in
 * the app. Nothing is wrong with the app; the voice server is not there.
 */
function joinErrorMessage(err: Error, url: string): string {
  const raw = err.message ?? '';
  const unreachable =
    /failed to fetch|connection refused|econnrefused|signal connection|networkerror|load failed/i.test(
      raw,
    );
  if (unreachable) {
    return `No voice server at ${url || 'the configured address'}. Start LiveKit (infra/livekit/start.ps1), then try again.`;
  }
  if (/permission|notallowed|notfound/i.test(raw)) {
    return `No microphone available: ${raw}`;
  }
  return raw || 'Could not join voice.';
}

export type Voice = ReturnType<typeof useVoice>;

/**
 * Device labels are blank until the page has held a microphone permission at
 * least once, so this is worth re-running after the first join.
 */
export async function listAudioDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return {
    inputs: devices.filter((d) => d.kind === 'audioinput'),
    outputs: devices.filter((d) => d.kind === 'audiooutput'),
  };
}
