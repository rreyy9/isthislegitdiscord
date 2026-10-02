import { describe, expect, it } from 'vitest';
import {
  BindingCapture,
  conflictsFor,
  matchesDown,
  matchesUp,
  MOD_ALT,
  MOD_CTRL,
  MOD_SHIFT,
  shadows,
  type Binding,
  type Keybind,
} from './keybinds';

const V = 47; // uiohook's keycode for V
const M = 50;

const key = (code: number, mods = 0): Binding => ({ type: 'key', code, mods });
const mouse = (code: number, mods = 0): Binding => ({
  type: 'mouse',
  code,
  mods,
});

const row = (id: string, action: Keybind['action'], binding: Binding): Keybind => ({
  id,
  action,
  binding,
  label: id,
  enabled: true,
});

describe('matchesDown', () => {
  it('matches a bare key pressed bare', () => {
    expect(matchesDown(key(V), { type: 'key', code: V, mods: 0 })).toBe(true);
  });

  it('does not match a different key, or the same code on the other device', () => {
    expect(matchesDown(key(V), { type: 'key', code: M, mods: 0 })).toBe(false);
    // The two code spaces overlap, which is why the kind travels with the
    // number: mouse button 3 and keycode 3 are unrelated.
    expect(matchesDown(mouse(3), { type: 'key', code: 3, mods: 0 })).toBe(false);
  });

  it('requires every modifier the binding asks for', () => {
    const binding = key(V, MOD_CTRL | MOD_SHIFT);
    expect(
      matchesDown(binding, { type: 'key', code: V, mods: MOD_CTRL | MOD_SHIFT }),
    ).toBe(true);
    expect(matchesDown(binding, { type: 'key', code: V, mods: MOD_CTRL })).toBe(
      false,
    );
    expect(matchesDown(binding, { type: 'key', code: V, mods: 0 })).toBe(false);
  });

  /**
   * The rule that exists for games. Shift is held to sprint for most of a
   * match, and a push-to-talk key bound bare has to keep working while it is.
   */
  it('ignores modifiers the binding did not ask for', () => {
    expect(
      matchesDown(key(V), { type: 'key', code: V, mods: MOD_SHIFT }),
    ).toBe(true);
    expect(
      matchesDown(key(V, MOD_CTRL), {
        type: 'key',
        code: V,
        mods: MOD_CTRL | MOD_ALT,
      }),
    ).toBe(true);
  });

  it('matches mouse buttons on the same terms', () => {
    expect(
      matchesDown(mouse(4, MOD_CTRL), {
        type: 'mouse',
        code: 4,
        mods: MOD_CTRL | MOD_SHIFT,
      }),
    ).toBe(true);
  });
});

describe('matchesUp', () => {
  /**
   * The stuck-microphone case. Ctrl+V is held, Ctrl is released a moment
   * before V, and the keyup for V arrives with ctrlKey already false. If that
   * release did not match, the binding would stay held for ever.
   */
  it('releases a combination whose modifiers have already come up', () => {
    expect(matchesUp(key(V, MOD_CTRL | MOD_SHIFT), 'key', V)).toBe(true);
  });

  it('still distinguishes the key and the device', () => {
    expect(matchesUp(key(V), 'key', M)).toBe(false);
    expect(matchesUp(key(V), 'mouse', V)).toBe(false);
  });
});

describe('shadows', () => {
  it('is directional: the barer binding is the one that also fires', () => {
    // Pressing Ctrl+M fires a binding on bare M...
    expect(shadows(key(M), key(M, MOD_CTRL))).toBe(true);
    // ...but pressing M alone does not fire one on Ctrl+M.
    expect(shadows(key(M, MOD_CTRL), key(M))).toBe(false);
  });

  it('sees nothing between unrelated modifier sets', () => {
    expect(shadows(key(M, MOD_CTRL), key(M, MOD_ALT))).toBe(false);
  });
});

describe('conflictsFor', () => {
  it('does not report two bindings for the same action', () => {
    // The entire point of the table: push-to-talk on a key and on a thumb
    // button, and even the same key twice, is a choice and not a clash.
    const rows = [
      row('a', 'ptt', key(V)),
      row('b', 'ptt', mouse(4)),
      row('c', 'ptt', key(V)),
    ];
    expect(conflictsFor(rows[0], rows)).toEqual([]);
  });

  it('reports the same key pointed at two different actions', () => {
    const rows = [row('a', 'toggleMute', key(M)), row('b', 'toggleDeafen', key(M))];
    expect(conflictsFor(rows[0], rows).map((r) => r.id)).toEqual(['b']);
  });

  it('reports an overlap in either direction', () => {
    const bare = row('bare', 'toggleMute', key(M));
    const combo = row('combo', 'toggleDeafen', key(M, MOD_CTRL));
    const rows = [bare, combo];
    // Ctrl+M fires both, so each has to hear about the other -- the one that
    // gets fired unexpectedly and the one doing the firing.
    expect(conflictsFor(bare, rows).map((r) => r.id)).toEqual(['combo']);
    expect(conflictsFor(combo, rows).map((r) => r.id)).toEqual(['bare']);
  });

  it('leaves genuinely separate bindings alone', () => {
    const rows = [
      row('a', 'toggleMute', key(M, MOD_CTRL)),
      row('b', 'toggleDeafen', key(M, MOD_ALT)),
      row('c', 'disconnect', mouse(5)),
    ];
    for (const r of rows) expect(conflictsFor(r, rows)).toEqual([]);
  });
});

describe('BindingCapture', () => {
  const ALT = 56;
  const CTRL = 29;
  const press = (code: number, mods = 0) => ({ type: 'key' as const, code, mods });

  it('binds an ordinary key on its press', () => {
    const c = new BindingCapture();
    expect(c.down(press(V))).toEqual(key(V));
  });

  it('binds bare Alt when it is released alone', () => {
    const c = new BindingCapture();
    // uiohook may report Alt's own bit on its own keydown; it is not a modifier
    // of itself.
    expect(c.down(press(ALT, MOD_ALT))).toBeNull();
    expect(c.up('key', ALT)).toEqual(key(ALT));
  });

  it('binds the combination when a key follows the modifier', () => {
    const c = new BindingCapture();
    expect(c.down(press(ALT, MOD_ALT))).toBeNull();
    expect(c.down(press(V, MOD_ALT))).toEqual(key(V, MOD_ALT));
    expect(c.up('key', ALT)).toBeNull();
  });

  it('binds a modifier pair on the release of the second', () => {
    const c = new BindingCapture();
    c.down(press(CTRL, MOD_CTRL));
    expect(c.down(press(ALT, MOD_CTRL | MOD_ALT))).toBeNull();
    expect(c.up('key', CTRL)).toBeNull();
    expect(c.up('key', ALT)).toEqual(key(ALT, MOD_CTRL));
  });

  it('binds a mouse button with the modifiers held', () => {
    const c = new BindingCapture();
    c.down(press(ALT, MOD_ALT));
    expect(c.down({ type: 'mouse', code: 4, mods: MOD_ALT })).toEqual(
      mouse(4, MOD_ALT),
    );
  });
});

describe('bare modifier bindings', () => {
  const ALT = 56;

  it('fire on their own keydown', () => {
    expect(matchesDown(key(ALT), { type: 'key', code: ALT, mods: MOD_ALT })).toBe(
      true,
    );
  });

  it('are reported as shadowing every combination that holds them', () => {
    expect(shadows(key(ALT), key(V, MOD_ALT))).toBe(true);
    expect(shadows(key(ALT), key(V, MOD_CTRL))).toBe(false);
    expect(shadows(key(ALT), key(V))).toBe(false);
  });
});
