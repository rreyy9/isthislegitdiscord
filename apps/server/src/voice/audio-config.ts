import { Logger } from '@nestjs/common';
import { VoiceQuality, type VoiceAudioConfig } from '@isthislegit/shared';

/**
 * What each quality level actually means, in one table.
 *
 * The bitrates match LiveKit's own `AudioPresets` so the numbers are familiar,
 * but the DTX and RED flags are ours and are the interesting part:
 *
 *  - **RED stays on everywhere except studio.** Redundant audio data resends
 *    recent frames alongside new ones, so a dropped packet is usually repaired
 *    without a retransmit. It is the difference between "choppy on hotel wifi"
 *    and "fine on hotel wifi", and it costs far less than the bitrate step it
 *    saves you from needing. LiveKit only offers it on mono, hence the gap.
 *  - **DTX is on only for `voice`.** Stopping transmission during silence is a
 *    real bandwidth saving, but the encoder needs a moment to spin back up and
 *    that moment lands on the first consonant of a sentence. Worth it when the
 *    point is to survive a bad connection; not worth it otherwise.
 *  - **`studio` is the odd one out** and is a headphones-only mode: stereo
 *    means Chromium will not run echo cancellation, so on speakers it will
 *    feed back. That is a property of every echo canceller, not of this app.
 */
const PRESETS: Record<VoiceQuality, Omit<VoiceAudioConfig, 'quality'>> = {
  voice: { maxBitrate: 24_000, stereo: false, dtx: true, red: true },
  balanced: { maxBitrate: 48_000, stereo: false, dtx: false, red: true },
  high: { maxBitrate: 96_000, stereo: false, dtx: false, red: true },
  studio: { maxBitrate: 128_000, stereo: true, dtx: false, red: false },
};

const DEFAULT_QUALITY: VoiceQuality = 'balanced';
const log = new Logger('VoiceAudio');
let warned = '';

/**
 * The server's voice quality, from `VOICE_QUALITY` in the environment.
 *
 * Read per call rather than cached at boot so that the value cannot drift from
 * what the process actually has; changing it still means restarting the server,
 * which the operator console does in one click.
 *
 * An unrecognised value falls back to the default and says so once. Voice
 * quality is not worth refusing to start over, but it is worth being loud
 * about — a typo here is otherwise completely silent.
 */
export function voiceAudioConfig(): VoiceAudioConfig {
  const raw = process.env.VOICE_QUALITY?.trim().toLowerCase();
  const parsed = VoiceQuality.safeParse(raw || DEFAULT_QUALITY);

  if (!parsed.success) {
    if (warned !== raw) {
      warned = raw ?? '';
      log.warn(
        `VOICE_QUALITY="${raw}" is not one of ${VoiceQuality.options.join(', ')}; ` +
          `using "${DEFAULT_QUALITY}".`,
      );
    }
    return { quality: DEFAULT_QUALITY, ...PRESETS[DEFAULT_QUALITY] };
  }

  return { quality: parsed.data, ...PRESETS[parsed.data] };
}
