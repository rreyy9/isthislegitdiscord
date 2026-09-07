/**
 * The sound a tag makes.
 *
 * Synthesised rather than shipped as a file, and that is a deliberate trade:
 * two sine tones through a gain envelope is a dozen lines, where an audio
 * asset is a binary in the repo, a path that has to survive packaging, and a
 * decode that can fail at the moment it is needed. Nothing here can 404.
 *
 * It is also two tones rather than one because a single beep is what every
 * error dialog in the world sounds like. A rising pair reads as "someone said
 * your name", not as "something went wrong".
 */

let context: AudioContext | null = null;

/**
 * Made on the first ping, not on load.
 *
 * A context created before the window has been interacted with starts
 * suspended, and browsers only resume one from inside a gesture — so building
 * it eagerly produces a context that is silent for reasons nothing in this
 * file can see. By the time a tag arrives the app has been used.
 */
function audio(): AudioContext | null {
  try {
    context ??= new AudioContext();
    // A context can be suspended out from under us — the window was hidden, or
    // the machine slept. Resuming is asynchronous and the tones below are
    // scheduled against `currentTime`, which does not advance while suspended,
    // so this is a request and the next ping is the one that lands.
    if (context.state === 'suspended') void context.resume();
    return context;
  } catch {
    // No audio device at all. A missing sound must never take the rest of a
    // notification with it.
    return null;
  }
}

/** One tone: a sine, with an envelope so it does not click at either end. */
function tone(ctx: AudioContext, hz: number, at: number, length: number) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = hz;

  // Quiet on purpose. This plays over whatever is already making noise, and a
  // notification that is louder than the call it interrupts is a bad one.
  const peak = 0.09;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(peak, at + 0.012);
  // Exponential rather than linear, which is what a fading sound actually
  // does; ramping to zero is undefined, hence the small floor.
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length);

  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + length + 0.02);
}

/** Two rising notes, about a fifth apart. Roughly 200ms end to end. */
export function playPing() {
  const ctx = audio();
  if (!ctx) return;
  const now = ctx.currentTime;
  tone(ctx, 660, now, 0.11);
  tone(ctx, 990, now + 0.085, 0.16);
}
