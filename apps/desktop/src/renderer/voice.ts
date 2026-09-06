import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ConnectionState,
  RemoteTrack,
  Room,
  RoomEvent,
  Track,
  type AudioCaptureOptions,
  type Participant,
  type RemoteParticipant,
  type RemoteTrackPublication,
  type TrackPublishOptions,
} from 'livekit-client';
import { api, type VoiceAudioDto } from './api';
import { bridge } from './bridge';
import type { PttBinding } from '../preload';
import { InputGate, SpeakingDetector, TrackMeter } from './audio-levels';

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
  isLocal: boolean;
  screenSharing: boolean;
}

export interface ScreenShare {
  identity: string;
  name: string;
  track: Track;
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

export function useVoice(settings: VoiceSettings) {
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
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const audioRef = useRef<VoiceAudioDto | null>(null);

  // Input gate. `gateOpenRef` is what applyMic reads; the React copy is only
  // for the "transmitting" light, which must not re-render at metering rate.
  const gateRef = useRef(new InputGate());
  const gateOpenRef = useRef(true);
  const micMeterRef = useRef<TrackMeter | null>(null);
  const micSourceRef = useRef<MediaStreamTrack | null>(null);
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

  /* ------------------------------------------------------ derived state */

  const sync = useCallback(() => {
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
  }, []);

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

  const applyVolumes = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    for (const p of room.remoteParticipants.values()) {
      p.setVolume(volumeFor(p.identity));
    }
  }, [volumeFor]);

  /* --------------------------------------------------------- mic policy */

  /**
   * One place decides whether the microphone is live, because four things now
   * fight over it. Manual mute wins over everything. With push-to-talk on, the
   * mic is open only while the key is held. Otherwise the gate has a say.
   *
   * `wantsTrack` is separate from `live` on purpose: it is exactly the old
   * rule, and it decides whether a microphone track should exist at all. The
   * gate then mutes and unmutes that existing track rather than publishing and
   * unpublishing one, which is both far faster and the only workable order —
   * the gate reads its level from the track, so the track has to come first.
   * With the gate off the two are identical and this behaves as it always did.
   */
  const applyMic = useCallback(async () => {
    const room = roomRef.current;
    if (!room || room.state !== ConnectionState.Connected) return;
    const s = settingsRef.current;

    const wantsTrack =
      !mutedRef.current && (!s.pushToTalk || talkingRef.current);
    const live =
      !mutedRef.current &&
      (s.pushToTalk
        ? talkingRef.current
        : s.gateMode === 'off' || gateOpenRef.current);

    if (!wantsTrack) {
      await room.localParticipant.setMicrophoneEnabled(false).catch(() => {});
      return;
    }

    let pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
    if (!pub?.track) {
      await room.localParticipant
        .setMicrophoneEnabled(
          true,
          captureOptions(s, audioRef.current),
          publishOptions(s, audioRef.current),
        )
        .catch(() => {});
      pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
      ensureMicMeter();
    }

    const track = pub?.track;
    if (!track) return;
    if (live && track.isMuted) await track.unmute().catch(() => {});
    else if (!live && !track.isMuted) await track.mute().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Attach the level meter to whatever microphone track is current.
   *
   * Keyed on the underlying MediaStreamTrack rather than the publication,
   * because switching input device swaps that out from under the same
   * LocalAudioTrack and the old meter would go quiet for ever.
   */
  const ensureMicMeter = useCallback(() => {
    const room = roomRef.current;
    const source =
      room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track
        ?.mediaStreamTrack ?? null;
    if (source === micSourceRef.current) return;

    micMeterRef.current?.close();
    micMeterRef.current = null;
    micSourceRef.current = source;
    gateRef.current.reset();
    if (!source) {
      // Muting unpublishes the track, which stops the meter — so if this is
      // not said now, nothing will ever say it, and the ring stays lit on
      // whatever the last reading before the mute happened to be.
      localSpeechRef.current.reset();
      setSpeaking(room?.localParticipant.identity, false);
      return;
    }

    micMeterRef.current = new TrackMeter(
      source,
      20,
      (db) => {
        const s = settingsRef.current;
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
        const live =
          !mutedRef.current &&
          (s.pushToTalk ? talkingRef.current : s.gateMode === 'off' || open);
        setSpeaking(roomRef.current?.localParticipant.identity, loud && live);
      },
      // Essential, not an optimisation: see TrackMeter.
      { clone: true },
    );
  }, [applyMic, setSpeaking]);

  /* --------------------------------------------------------- join/leave */

  const teardownAudio = useCallback(() => {
    micMeterRef.current?.close();
    micMeterRef.current = null;
    micSourceRef.current = null;
    gateRef.current.reset();
    gateOpenRef.current = true;
    localSpeechRef.current.reset();
    speakingRef.current.clear();
    for (const entry of remotesRef.current.values()) entry.meter?.close();
    remotesRef.current.clear();
  }, []);

  const leave = useCallback(async () => {
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
        token = res.token;
        url = res.livekitUrl;
        audioRef.current = res.audio ?? null;
        setState((s) => ({ ...s, audio: res.audio ?? null }));
      } catch (err) {
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

      room
        .on(RoomEvent.ParticipantConnected, () => {
          applyVolumes();
          sync();
        })
        .on(RoomEvent.ParticipantDisconnected, sync)
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
        .on(RoomEvent.MediaDevicesChanged, ensureMicMeter)
        .on(
          RoomEvent.TrackSubscribed,
          (
            track: RemoteTrack,
            _pub: RemoteTrackPublication,
            participant: RemoteParticipant,
          ) => {
            if (track.kind === Track.Kind.Audio) {
              const el = track.attach() as HTMLAudioElement;
              el.autoplay = true;
              audioBoxRef.current?.appendChild(el);
              watchRemote(participant, track);
              participant.setVolume(volumeFor(participant.identity));
            }
            sync();
          },
        )
        .on(
          RoomEvent.TrackUnsubscribed,
          (track: RemoteTrack, _pub, participant: RemoteParticipant) => {
            track.detach().forEach((el) => el.remove());
            if (track.kind === Track.Kind.Audio) {
              remotesRef.current.get(participant.identity)?.meter?.close();
              remotesRef.current.delete(participant.identity);
              speakingRef.current.delete(participant.identity);
            }
            sync();
          },
        )
        .on(RoomEvent.Reconnecting, () =>
          setState((st) => ({ ...st, status: 'reconnecting' })),
        )
        .on(RoomEvent.Reconnected, () => {
          setState((st) => ({ ...st, status: 'connected' }));
          void applyMic();
          applyVolumes();
          ensureMicMeter();
          sync();
        })
        .on(RoomEvent.Disconnected, () => {
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
          if (isPickerCancellation(e)) return;
          setState((st) => ({ ...st, error: e.message }));
        });

      try {
        await room.connect(url, token);

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
        ensureMicMeter();
        sync();
      } catch (err) {
        roomRef.current = null;
        teardownAudio();
        await room.disconnect().catch(() => {});
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

  const setMuted = useCallback(
    async (next: boolean) => {
      mutedRef.current = next;
      setState((s) => ({ ...s, muted: next }));
      await applyMic();
    },
    [applyMic],
  );

  const setDeafened = useCallback(
    async (next: boolean) => {
      deafenedRef.current = next;
      // Deafening implies muting; un-deafening does not un-mute, which matches
      // what people expect from every other client they have used.
      if (next) {
        mutedRef.current = true;
        setState((s) => ({ ...s, deafened: true, muted: true }));
      } else {
        setState((s) => ({ ...s, deafened: false }));
      }
      applyVolumes();
      await applyMic();
    },
    [applyVolumes, applyMic],
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
