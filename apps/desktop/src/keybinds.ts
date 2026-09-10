/**
 * What a binding is, and when it fires.
 *
 * Outside main/, preload/ and renderer/ because all three need it and none of
 * them should own it. The rules below are the only place the matching is
 * decided: the global hook uses them to fire bindings, and the settings page
 * uses them to warn that two bindings overlap. Written twice they would drift,
 * and the drift would be a settings page confidently reporting no conflict
 * between two keys that both fire.
 *
 * Nothing here touches Electron or the native hook, which is what lets it be
 * tested — see keybinds.test.ts.
 */

/**
 * Modifiers, as a bitmask rather than four booleans: a binding is compared
 * against every key the machine presses, and one integer test beats four field
 * reads. It is also what gets written to settings.json, where a single number
 * is easier to eyeball than four flags.
 */
export const MOD_CTRL = 1;
export const MOD_ALT = 2;
export const MOD_SHIFT = 4;
export const MOD_META = 8;

/**
 * What has to be held. Keyboard keys are uiohook keycodes; mouse buttons are
 * uiohook's own numbering (1 left, 2 right, 3 middle, then whatever else the
 * mouse has). The two spaces overlap — keycode 2 is the "1" key — so the kind
 * has to travel with the number.
 */
export interface Binding {
  type: 'key' | 'mouse';
  code: number;
  /** MOD_* bitmask. Zero means the key binds bare. */
  mods: number;
}

/**
 * Everything a binding can be pointed at. Main does not know what any of these
 * mean — it matches keys and names the action on the way out — but the union
 * lives here because both sides are typed with it.
 */
export type KeybindAction =
  | 'ptt'
  | 'pushToMute'
  | 'toggleMute'
  | 'toggleDeafen'
  | 'disconnect';

/** Actions that read both edges of the key rather than firing once on press. */
export const HOLD_ACTIONS: ReadonlySet<KeybindAction> = new Set([
  'ptt',
  'pushToMute',
]);

export interface Keybind {
  /**
   * Identity, because the action cannot be it: two rows may carry the same
   * action on purpose. Somebody who wants push-to-talk on a thumb button and
   * on a keyboard key has two bindings for one action, and a table keyed by
   * action could not hold both.
   */
  id: string;
  action: KeybindAction;
  binding: Binding;
  /** What the binding is called on screen. Built by `labelFor` at bind time. */
  label: string;
  enabled: boolean;
}

/** A key or button going down, as the hook saw it. */
export interface InputEvent {
  type: 'key' | 'mouse';
  code: number;
  mods: number;
}

/**
 * Modifiers are matched as a subset, not an exact set: every modifier the
 * binding asks for must be down, but anything extra is ignored.
 *
 * This is for the sake of games, which are the whole reason these bindings are
 * global. Shift is held for most of a match — it is how you sprint — and under
 * exact matching a push-to-talk key bound bare would silently stop working the
 * moment somebody started running. Failing to transmit while holding the key
 * you bound is the worst outcome available here, so the looser rule wins.
 *
 * The cost is that Ctrl+M also fires a binding on bare M. That only bites
 * somebody who deliberately bound both, and `shadows` is how the settings page
 * warns them.
 */
export function matchesDown(binding: Binding, event: InputEvent): boolean {
  return (
    binding.type === event.type &&
    binding.code === event.code &&
    (binding.mods & event.mods) === binding.mods
  );
}

/**
 * Release ignores modifiers entirely, and must.
 *
 * Ctrl+V held for push-to-talk, then Ctrl let go a moment before V: the keyup
 * for V arrives with ctrlKey already false. Were modifiers compared here, that
 * release would match nothing, the binding would stay held, and the microphone
 * would stay open with no key down and no way to shut it but pressing the
 * combination again.
 */
export function matchesUp(
  binding: Binding,
  type: 'key' | 'mouse',
  code: number,
): boolean {
  return binding.type === type && binding.code === code;
}

/**
 * Would a press of `b` also fire `a`?
 *
 * Directional, and not an equality test, because `matchesDown` is: a binding
 * on bare M fires when Ctrl+M is pressed, but not the other way round.
 */
export function shadows(a: Binding, b: Binding): boolean {
  return matchesDown(a, b);
}

/**
 * The bindings that would also fire when this one is pressed, or that would
 * fire it — limited to other actions, because two bindings for one action is
 * the entire point of the table and not a conflict.
 *
 * Both really do fire; refusing the binding would be worse than saying so. So
 * this feeds a warning, not a block.
 */
export function conflictsFor(row: Keybind, rows: Keybind[]): Keybind[] {
  return rows.filter(
    (other) =>
      other.id !== row.id &&
      other.action !== row.action &&
      (shadows(other.binding, row.binding) ||
        shadows(row.binding, other.binding)),
  );
}
