import { describe, expect, it } from 'vitest';
import { voiceCues, type VoiceSnapshot } from './voice-sounds';

const idle: VoiceSnapshot = {
  channelId: null,
  status: 'idle',
  muted: false,
  deafened: false,
  talking: false,
  pushToTalk: false,
  peers: [],
  shares: [],
};
const inA: VoiceSnapshot = { ...idle, channelId: 'a', status: 'connected', peers: ['p1'] };

describe('voiceCues', () => {
  it('says nothing on the first look', () => {
    expect(voiceCues(null, inA)).toEqual([]);
  });

  it('joins without announcing everybody already there', () => {
    const connecting = { ...idle, channelId: 'a', status: 'connecting' as const };
    expect(voiceCues(idle, connecting)).toEqual([]);
    expect(voiceCues(connecting, { ...inA, peers: ['p1', 'p2', 'p3'] })).toEqual([
      'selfJoin',
    ]);
  });

  it('leaves', () => {
    expect(voiceCues(inA, idle)).toEqual(['selfLeave']);
  });

  it('plays only the join when switching channel', () => {
    const switching = { ...inA, channelId: 'b', status: 'connecting' as const, peers: [] };
    expect(voiceCues(inA, switching)).toEqual([]);
    expect(voiceCues(switching, { ...inA, channelId: 'b', peers: ['p9'] })).toEqual([
      'selfJoin',
    ]);
  });

  it('tells a dropped connection from a deliberate leave', () => {
    const lost = { ...inA, status: 'reconnecting' as const };
    expect(voiceCues(inA, lost)).toEqual(['voiceLost']);
    expect(voiceCues(lost, inA)).toEqual(['voiceRestored']);
    expect(voiceCues(lost, idle)).toEqual([]);
  });

  it('reports a failed join', () => {
    const connecting = { ...idle, channelId: 'a', status: 'connecting' as const };
    expect(voiceCues(connecting, { ...connecting, status: 'failed' })).toEqual([
      'voiceLost',
    ]);
  });

  it('hears people come and go', () => {
    expect(voiceCues(inA, { ...inA, peers: ['p1', 'p2'] })).toEqual(['peerJoin']);
    expect(voiceCues(inA, { ...inA, peers: [] })).toEqual(['peerLeave']);
    expect(voiceCues(inA, { ...inA, peers: ['p2'] })).toEqual(['peerJoin', 'peerLeave']);
  });

  it('hears screen shares start and stop', () => {
    const sharing = { ...inA, shares: ['p1'] };
    expect(voiceCues(inA, sharing)).toEqual(['shareStart']);
    expect(voiceCues(sharing, inA)).toEqual(['shareStop']);
  });

  it('plays one sound for deafen, even though it also mutes', () => {
    const deaf = { ...inA, muted: true, deafened: true };
    expect(voiceCues(inA, deaf)).toEqual(['deafen']);
    expect(voiceCues(deaf, inA)).toEqual(['undeafen']);
    expect(voiceCues(deaf, { ...deaf, deafened: false })).toEqual(['undeafen']);
  });

  it('mutes and unmutes', () => {
    const muted = { ...inA, muted: true };
    expect(voiceCues(inA, muted)).toEqual(['mute']);
    expect(voiceCues(muted, inA)).toEqual(['unmute']);
  });

  it('clicks for push-to-talk only when it is on and in a call', () => {
    const ptt = { ...inA, pushToTalk: true };
    expect(voiceCues(ptt, { ...ptt, talking: true })).toEqual(['pttOn']);
    expect(voiceCues({ ...ptt, talking: true }, ptt)).toEqual(['pttOff']);
    expect(voiceCues(inA, { ...inA, talking: true })).toEqual([]);
    const idlePtt = { ...idle, pushToTalk: true };
    expect(voiceCues(idlePtt, { ...idlePtt, talking: true })).toEqual([]);
  });
});
