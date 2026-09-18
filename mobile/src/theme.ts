/**
 * One dark palette, taken from the desktop client's styles.css so the two
 * applications look like the same product rather than two products talking to
 * one server.
 *
 * Dark only, and that is a decision rather than an omission. A light theme is
 * a second set of every colour below plus a rule for every component that
 * hardcodes one, and the desktop client has never had one either -- offering a
 * half-finished one on the phone would be the first place the two diverge.
 */
export const theme = {
  /** The window behind everything. */
  bg: '#1a1b1e',
  /** Panels that sit on it: the channel list, the composer bar. */
  surface: '#25262b',
  /** A pressed row, a hovered one, the input inside the composer. */
  surfaceAlt: '#2c2e33',
  border: '#373a40',

  text: '#e9ecef',
  textMuted: '#909296',
  textFaint: '#5c5f66',

  accent: '#5865f2',
  accentText: '#ffffff',

  danger: '#fa5252',
  warning: '#fab005',
  online: '#40c057',

  /** The tint behind a message that tagged you. */
  mention: '#3a3115',
  mentionBorder: '#fab005',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 16,
  pill: 999,
} as const;

/**
 * The minimum size of anything meant to be tapped.
 *
 * 44 rather than the 24-ish a desktop control gets away with: a pointer is
 * exact and a fingertip is not, and every control in this app is reached with
 * a thumb on a moving train. Applied through `hitSlop` where making the drawn
 * control this big would look wrong.
 */
export const TAP_TARGET = 44;
