import { describe, expect, it } from 'vitest';
import {
  GATE_SEED_TICKS,
  InputGate,
  SpeakingDetector,
  rmsDb,
} from './audio-levels';

/** A frame of constant amplitude, which makes its RMS exactly that amplitude. */
function frame(amplitude: number, n = 512): Float32Array {
  return new Float32Array(n).fill(amplitude);
}

/** Feed the gate the ticks it spends measuring the room before it will open. */
function seed(gate: InputGate, db: number, now: number) {
  for (let i = 0; i < GATE_SEED_TICKS; i++) {
    expect(gate.update(db, 'auto', -60, now + i * 20)).toBe(false);
  }
}

describe('rmsDb', () => {
  it('floors at -100 rather than -Infinity on digital silence', () => {
    // A muted track reads as exact zeroes, and -Infinity would poison every
    // comparison downstream instead of just being very quiet.
    expect(rmsDb(frame(0))).toBe(-100);
  });

  it('reads full scale as 0 dBFS', () => {
    expect(rmsDb(frame(1))).toBeCloseTo(0, 6);
  });

  it('halving the amplitude is about -6 dB', () => {
    expect(rmsDb(frame(0.5))).toBeCloseTo(-6.02, 1);
    expect(rmsDb(frame(0.25))).toBeCloseTo(-12.04, 1);
  });

  it('clamps a very quiet frame instead of running away', () => {
    expect(rmsDb(frame(1e-9))).toBe(-100);
  });
});

describe('InputGate', () => {
  it('is always open in off mode, with no seeding', () => {
    const g = new InputGate();
    expect(g.update(-100, 'off', -60, 0)).toBe(true);
  });

  it('stays shut while it measures the room', () => {
    // The alternative -- guessing a floor and creeping toward it -- broadcasts
    // somebody's fan to the channel for the better part of ten seconds.
    const g = new InputGate();
    for (let i = 0; i < GATE_SEED_TICKS; i++) {
      expect(g.update(-10, 'auto', -60, i * 20)).toBe(false);
    }
  });

  it('opens on speech above the measured floor', () => {
    const g = new InputGate();
    const t = 10_000;
    seed(g, -70, t);
    expect(g.update(-70, 'auto', -60, t + 400)).toBe(false);
    expect(g.update(-40, 'auto', -60, t + 420)).toBe(true);
  });

  it('sits a fixed margin above the floor, so a noisy room raises its own bar', () => {
    const quiet = new InputGate();
    seed(quiet, -70, 0);
    const noisy = new InputGate();
    seed(noisy, -45, 0);
    expect(noisy.thresholdDb).toBeGreaterThan(quiet.thresholdDb);
    // -70 + 12 dB of margin.
    expect(quiet.thresholdDb).toBeCloseTo(-58, 5);
  });

  it('holds through the gaps between words', () => {
    const g = new InputGate();
    const t = 10_000;
    seed(g, -70, t);
    expect(g.update(-30, 'auto', -60, t + 400)).toBe(true);
    // Silent, but inside the 300ms hold.
    expect(g.update(-90, 'auto', -60, t + 500)).toBe(true);
    // Past it.
    expect(g.update(-90, 'auto', -60, t + 800)).toBe(false);
  });

  it('takes less to stay open than to open, so words do not chop', () => {
    const g = new InputGate();
    const t = 10_000;
    seed(g, -70, t);
    const threshold = g.thresholdDb;
    // Below the bar for opening but within the 6 dB of hysteresis.
    const between = threshold - 3;

    expect(g.update(between, 'auto', -60, t + 400)).toBe(false);
    expect(g.update(threshold + 5, 'auto', -60, t + 420)).toBe(true);
    expect(g.update(between, 'auto', -60, t + 440)).toBe(true);
  });

  it('uses the number given in manual mode and ignores the floor', () => {
    const g = new InputGate();
    for (let i = 0; i < GATE_SEED_TICKS; i++) g.update(-70, 'manual', -50, i * 20);
    expect(g.thresholdDb).toBe(-50);
    expect(g.update(-55, 'manual', -50, 1000)).toBe(false);
    expect(g.update(-45, 'manual', -50, 1020)).toBe(true);
  });

  it('reset puts it back to measuring', () => {
    const g = new InputGate();
    seed(g, -70, 0);
    expect(g.update(-20, 'auto', -60, 400)).toBe(true);
    g.reset();
    expect(g.update(-20, 'auto', -60, 500)).toBe(false);
  });
});

describe('SpeakingDetector', () => {
  it('lights on a voice and not on a room', () => {
    const d = new SpeakingDetector();
    expect(d.update(-60, 0)).toBe(false);
    expect(d.update(-40, 20)).toBe(true);
  });

  it('carries the light through the gaps between words', () => {
    const d = new SpeakingDetector();
    expect(d.update(-40, 0)).toBe(true);
    expect(d.update(-90, 100)).toBe(true);
    expect(d.update(-90, 300)).toBe(false);
  });

  it('takes less to stay lit than to light', () => {
    const d = new SpeakingDetector();
    // Between the -50 on threshold and the -56 off threshold.
    expect(d.update(-53, 0)).toBe(false);
    expect(d.update(-45, 20)).toBe(true);
    expect(d.update(-53, 40)).toBe(true);
    expect(d.update(-60, 60)).toBe(true);
    expect(d.update(-60, 300)).toBe(false);
  });

  it('reset clears it', () => {
    const d = new SpeakingDetector();
    d.update(-30, 0);
    d.reset();
    expect(d.update(-90, 10)).toBe(false);
  });
});
