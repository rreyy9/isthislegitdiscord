/**
 * Level measurement, and the two things built on it: the input gate behind
 * "sensitivity", and the leveller that stops one person being twice as loud as
 * everyone else.
 *
 * The rule this whole file obeys: **nothing here goes in the audio path.**
 * Every analyser is a tap that connects to no destination, so if any of it
 * misbehaves the worst case is a wrong number, never a broken or degraded call.
 * The gate acts by toggling the same mute push-to-talk already uses, and the
 * leveller acts on the volume of the audio element LiveKit already created.
 * Neither one resamples, filters or re-encodes anything.
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

export const dbToGain = (db: number) => Math.pow(10, db / 20);

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

/* ------------------------------------------------------------- normaliser */

/** Where a speaking voice should land. Ordinary speech sits near this already. */
const TARGET_DB = -22;
/** Below this is a gap between words, not a quiet talker; do not chase it. */
const SPEECH_FLOOR_DB = -50;
/** How far a single voice may be turned down. */
const MIN_GAIN_DB = -18;
/**
 * Per-tick share of the remaining correction, at 100ms a tick. Down in a few
 * seconds of speech, back up over roughly quarter of a minute of it — both
 * slow enough not to pump between sentences, and both measured in speech
 * rather than wall clock, since silence does not move either one.
 */
const DUCK_RATE = 0.12;
const RECOVER_RATE = 0.04;

/**
 * Evens out how loud each person is, by turning the loud ones down.
 *
 * It only ever attenuates, and that is a deliberate limit rather than an
 * oversight. Without `webAudioMix` a remote track's volume is the audio
 * element's own `volume`, which the HTML spec caps at 1.0 - there is no
 * headroom to boost with. Turning on `webAudioMix` would supply a gain node
 * that can exceed 1, at the cost of routing everyone's audio through Web Audio
 * and inheriting a known Chromium quirk about what the echo canceller uses as
 * its reference. Trading working echo cancellation for the ability to amplify
 * is a bad trade in a voice app.
 *
 * The quiet half of the problem is already handled at the other end anyway:
 * `autoGainControl` in each person's capture constraints is Chromium's AGC
 * normalising their microphone before it is ever encoded. Between that pushing
 * quiet people up and this pulling loud people down, the room lands in a band.
 *
 * Adaptation is asymmetric on purpose. Somebody suddenly shouting is a problem
 * to fix now; letting the gain drift back up is not urgent, and doing it slowly
 * avoids audibly pumping between sentences.
 */
export class VoiceNormalizer {
  private gainDb = 0;

  update(db: number): number {
    if (db > SPEECH_FLOOR_DB) {
      const wanted = Math.min(0, Math.max(MIN_GAIN_DB, TARGET_DB - db));
      const rate = wanted < this.gainDb ? DUCK_RATE : RECOVER_RATE;
      this.gainDb += (wanted - this.gainDb) * rate;
    }
    return dbToGain(this.gainDb);
  }
}
