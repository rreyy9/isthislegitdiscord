/**
 * Level measurement, and the two things built on it: the input gate behind
 * "sensitivity", and the detector that decides who is speaking.
 *
 * The rule this whole file obeys: **nothing here goes in the audio path.**
 * Every analyser is a tap that connects to no destination, so if any of it
 * misbehaves the worst case is a wrong number, never a broken or degraded call.
 * The gate acts by toggling the same mute push-to-talk already uses. Nothing
 * here resamples, filters or re-encodes anything.
 */

/* --------------------------------------------------------------- context */

let ctx: AudioContext | null = null;

/**
 * One AudioContext for the whole app. 48 kHz because that is what Opus runs
 * at; letting the context default to a 44.1 kHz output device would put a
 * pointless resample in front of every measurement.
 */
export function audioContext(): AudioContext {
  if (!ctx || ctx.state === 'closed') {
    ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  }
  // Chromium starts contexts suspended until a gesture. Joining a call is one,
  // but resume() is cheap and idempotent, so it is not worth being clever.
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** Root-mean-square of a frame, as dBFS. Silence floors at -100, not -Infinity. */
export function rmsDb(buf: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length);
  return rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
}

/* ------------------------------------------------------------------ meter */

/**
 * Polls the loudness of one track.
 *
 * `clone` exists for exactly one reason, and it is a trap worth naming: the
 * gate mutes the microphone by setting `enabled = false` on the published
 * track, which makes that track read as digital silence. Metering the same
 * track would then see silence, keep the gate shut, and the mic would never
 * open again. A clone shares the underlying capture device but carries its own
 * `enabled` flag, so it keeps delivering audio while the published one is
 * muted. Remote tracks are never disabled, so they are metered directly.
 */
export class TrackMeter {
  private readonly source: MediaStreamAudioSourceNode;
  private readonly analyser: AnalyserNode;
  // Explicit ArrayBuffer: getFloatTimeDomainData will not take the
  // SharedArrayBuffer-capable default that Float32Array infers.
  private readonly buf: Float32Array<ArrayBuffer>;
  private readonly cloned: MediaStreamTrack | null;
  private timer: ReturnType<typeof setInterval> | null;

  constructor(
    track: MediaStreamTrack,
    intervalMs: number,
    onLevel: (db: number) => void,
    opts: { clone?: boolean } = {},
  ) {
    const context = audioContext();
    this.cloned = opts.clone ? track.clone() : null;
    this.source = context.createMediaStreamSource(
      new MediaStream([this.cloned ?? track]),
    );
    this.analyser = context.createAnalyser();
    // ~10ms at 48k. Long enough to be a stable reading, short enough that the
    // gate reacts within one poll.
    this.analyser.fftSize = 512;
    this.buf = new Float32Array(this.analyser.fftSize);
    // Note the deliberate absence of a connect() to context.destination.
    this.source.connect(this.analyser);

    this.timer = setInterval(() => {
      this.analyser.getFloatTimeDomainData(this.buf);
      onLevel(rmsDb(this.buf));
    }, intervalMs);
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.source.disconnect();
    this.analyser.disconnect();
    this.cloned?.stop();
  }
}

/* ------------------------------------------------------------------- gate */

export type GateMode = 'off' | 'auto' | 'manual';

/** How far above the measured noise floor counts as speech, in auto mode. */
const AUTO_MARGIN_DB = 12;
/** Once open, staying open needs less than opening did, so words do not chop. */
const HYSTERESIS_DB = 6;
/** Keep transmitting through the gaps between words. */
const HOLD_MS = 300;
const FLOOR_MIN_DB = -85;
const FLOOR_MAX_DB = -30;
/**
 * Ticks spent listening before the gate will open at all — 300ms at the 20ms
 * poll. Guessing a starting noise floor and creeping toward the truth means
 * guessing too low in a noisy room, and a floor that only climbs 0.02 dB a
 * tick takes the better part of ten seconds to catch up: ten seconds of
 * broadcasting someone's fan to the channel. Measuring the room first costs a
 * third of a second of not transmitting, which is both shorter than it takes
 * to click into a channel and start speaking, and the safe way to be wrong.
 */
const SEED_TICKS = 15;

/**
 * Decides whether the microphone should be transmitting.
 *
 * Auto mode is the interesting half: rather than asking someone to find a
 * number in dBFS that means "my keyboard but not my voice", it watches the
 * quietest thing the mic hears and sits a fixed margin above it. A noisy room
 * therefore raises its own bar. The floor falls quickly (a fan switching off
 * should be believed at once) and rises slowly (a sentence must not be able to
 * drag the threshold up behind itself and cut you off mid-word).
 */
export class InputGate {
  private floorDb = -60;
  private openUntil = 0;
  private open = false;
  private seeded = 0;
  /** Last threshold used, so the settings meter can draw where the line is. */
  thresholdDb = -60;

  update(
    db: number,
    mode: GateMode,
    manualThresholdDb: number,
    now = Date.now(),
  ): boolean {
    if (mode === 'off') {
      this.open = true;
      this.thresholdDb = FLOOR_MIN_DB;
      return true;
    }

    if (this.seeded < SEED_TICKS) {
      this.seeded++;
      this.floorDb =
        this.seeded === 1
          ? Math.max(FLOOR_MIN_DB, Math.min(FLOOR_MAX_DB, db))
          : Math.min(this.floorDb, Math.max(FLOOR_MIN_DB, db));
      this.thresholdDb =
        mode === 'manual' ? manualThresholdDb : this.floorDb + AUTO_MARGIN_DB;
      this.open = false;
      return false;
    }

    if (db < this.floorDb) {
      this.floorDb = Math.max(
        FLOOR_MIN_DB,
        this.floorDb + (db - this.floorDb) * 0.3,
      );
    } else {
      this.floorDb = Math.min(FLOOR_MAX_DB, this.floorDb + 0.02);
    }

    this.thresholdDb =
      mode === 'manual' ? manualThresholdDb : this.floorDb + AUTO_MARGIN_DB;

    const bar = this.open ? this.thresholdDb - HYSTERESIS_DB : this.thresholdDb;
    if (db > bar) this.openUntil = now + HOLD_MS;
    this.open = now < this.openUntil;
    return this.open;
  }

  reset() {
    this.floorDb = -60;
    this.openUntil = 0;
    this.open = false;
    this.seeded = 0;
  }
}

/* ------------------------------------------------------- speaking detector */

/** Loud enough to be a voice rather than a room. */
const SPEECH_ON_DB = -50;
/** Once someone is speaking it takes less to keep them speaking. */
const SPEECH_OFF_DB = -56;
/** Carries the light through the gaps between words. */
const SPEECH_HOLD_MS = 220;

/**
 * Whether one person is talking right now.
 *
 * This exists because LiveKit's answer arrives too late to be useful for a
 * light on a portrait. `ActiveSpeakersChanged` is computed by the SFU from the
 * audio it is forwarding and broadcast on its own clock, so it lags a beat at
 * both ends: the ring lights up after someone has started and stays lit after
 * they have stopped. Every track already has a meter on it here for the gate
 * and the leveller, and that reading is a few milliseconds old, so the honest
 * answer was already in the room.
 *
 * The thresholds are fixed rather than adaptive on purpose. This decides what
 * a light does; the gate, which decides what is transmitted, is the one that
 * has to be careful.
 */
export class SpeakingDetector {
  private openUntil = 0;
  private on = false;

  update(db: number, now = Date.now()): boolean {
    const bar = this.on ? SPEECH_OFF_DB : SPEECH_ON_DB;
    if (db > bar) this.openUntil = now + SPEECH_HOLD_MS;
    this.on = now < this.openUntil;
    return this.on;
  }

  reset() {
    this.openUntil = 0;
    this.on = false;
  }
}
