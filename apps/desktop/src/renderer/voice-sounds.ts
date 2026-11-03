import type { SoundEvent } from '../sound-events';

/**
 * Which voice sounds a change of call state calls for.
 *
 * Worked out from two snapshots of the state rather than from LiveKit's
 * events, because the state is what the person sees: a sound for an event
 * that changed nothing on screen (a peer's track republishing, a reconnect
 * rebuilding the participant list) is a sound for nothing.
 *
 * Pure, so the rules can be tested -- see voice-sounds.test.ts.
 */
export interface VoiceSnapshot {
  channelId: string | null;
  status: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';
  muted: boolean;
  deafened: boolean;
  /** A push-to-talk key is held (or its release delay is running). */
  talking: boolean;
  pushToTalk: boolean;
  /** Everybody else in the call, by identity. */
  peers: readonly string[];
  /** Everybody sharing a screen, us included, by identity. */
  shares: readonly string[];
}

const inCall = (s: VoiceSnapshot['status']) =>
  s === 'connected' || s === 'reconnecting';

export function voiceCues(
  prev: VoiceSnapshot | null,
  next: VoiceSnapshot,
): SoundEvent[] {
  // The first look at the state is a baseline, not a change. Without this
  // the app would greet every launch with an unmute.
  if (!prev) return [];
  const out: SoundEvent[] = [];

  /* --- the call itself --- */
  const sameChannel = prev.channelId === next.channelId;
  if (next.status === 'connected' && !(prev.status === 'connected' && sameChannel)) {
    // Back from a dropped connection in the same room is not joining it.
    out.push(
      prev.status === 'reconnecting' && sameChannel ? 'voiceRestored' : 'selfJoin',
    );
  } else if (next.status === 'reconnecting' && prev.status === 'connected') {
    out.push('voiceLost');
  } else if (next.status === 'failed' && prev.status !== 'failed') {
    out.push('voiceLost');
  } else if (next.status === 'idle' && prev.status === 'connected') {
    // From `reconnecting` it has already said the connection went; saying
    // "left" on top would be two sounds for one thing nobody chose.
    out.push('selfLeave');
  }

  // Who else is here and what they are sharing, only while sitting in the
  // same call on both sides. A join or a channel switch sees the whole room
  // arrive at once, and that is the room, not a dozen people joining.
  if (next.status === 'connected' && prev.status === 'connected' && sameChannel) {
    const before = new Set(prev.peers);
    const after = new Set(next.peers);
    if (next.peers.some((p) => !before.has(p))) out.push('peerJoin');
    if (prev.peers.some((p) => !after.has(p))) out.push('peerLeave');

    const sharedBefore = new Set(prev.shares);
    const sharedAfter = new Set(next.shares);
    if (next.shares.some((p) => !sharedBefore.has(p))) out.push('shareStart');
    if (prev.shares.some((p) => !sharedAfter.has(p))) out.push('shareStop');
  }

  /* --- this person's own switches --- */
  // Deafen first and alone: deafening mutes, and undeafening by the mute
  // button unmutes, and one press should be one sound.
  if (next.deafened !== prev.deafened) {
    out.push(next.deafened ? 'deafen' : 'undeafen');
  } else if (next.muted !== prev.muted) {
    out.push(next.muted ? 'mute' : 'unmute');
  }

  if (
    next.pushToTalk &&
    inCall(next.status) &&
    next.talking !== prev.talking
  ) {
    out.push(next.talking ? 'pttOn' : 'pttOff');
  }

  return out;
}
