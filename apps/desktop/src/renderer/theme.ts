/**
 * Colour themes: the four Catppuccin flavours, an accent, and a few colours a
 * person may override by hand.
 *
 * Everything in styles.css is drawn through a dozen-odd CSS variables, so a
 * theme is nothing more than a set of values for them, written onto <html> as
 * inline custom properties. No stylesheet is swapped and nothing re-renders:
 * changing the theme is a style recalculation, which is why the settings page
 * can apply every click live.
 *
 * Stored in localStorage, per computer, like emoji recents: a theme is how this
 * screen looks, and nobody else ever sees it. Both windows (the chat and the
 * watch party) share the origin and so the key, and the `storage` event keeps
 * the second window in step when the first one changes it.
 *
 * Palette values are Catppuccin's own (MIT, github.com/catppuccin/palette).
 */

import type { CSSProperties } from 'react';

export const ACCENTS = [
  'rosewater', 'flamingo', 'pink', 'mauve', 'red', 'maroon', 'peach',
  'yellow', 'green', 'teal', 'sky', 'sapphire', 'blue', 'lavender',
] as const;
export type AccentName = (typeof ACCENTS)[number];

type Neutral =
  | 'text' | 'subtext1' | 'subtext0' | 'overlay2' | 'overlay1' | 'overlay0'
  | 'surface2' | 'surface1' | 'surface0' | 'base' | 'mantle' | 'crust';

export type FlavourId = 'latte' | 'frappe' | 'macchiato' | 'mocha';
export type ThemeChoice = FlavourId | 'system';

export interface Flavour {
  name: string;
  dark: boolean;
  colors: Record<AccentName | Neutral, string>;
}

export const FLAVOURS: Record<FlavourId, Flavour> = {
  latte: {
    name: 'Latte',
    dark: false,
    colors: {
      rosewater: '#dc8a78', flamingo: '#dd7878', pink: '#ea76cb', mauve: '#8839ef',
      red: '#d20f39', maroon: '#e64553', peach: '#fe640b', yellow: '#df8e1d',
      green: '#40a02b', teal: '#179299', sky: '#04a5e5', sapphire: '#209fb5',
      blue: '#1e66f5', lavender: '#7287fd',
      text: '#4c4f69', subtext1: '#5c5f77', subtext0: '#6c6f85', overlay2: '#7c7f93',
      overlay1: '#8c8fa1', overlay0: '#9ca0b0', surface2: '#acb0be', surface1: '#bcc0cc',
      surface0: '#ccd0da', base: '#eff1f5', mantle: '#e6e9ef', crust: '#dce0e8',
    },
  },
  frappe: {
    name: 'Frappé',
    dark: true,
    colors: {
      rosewater: '#f2d5cf', flamingo: '#eebebe', pink: '#f4b8e4', mauve: '#ca9ee6',
      red: '#e78284', maroon: '#ea999c', peach: '#ef9f76', yellow: '#e5c890',
      green: '#a6d189', teal: '#81c8be', sky: '#99d1db', sapphire: '#85c1dc',
      blue: '#8caaee', lavender: '#babbf1',
      text: '#c6d0f5', subtext1: '#b5bfe2', subtext0: '#a5adce', overlay2: '#949cbb',
      overlay1: '#838ba7', overlay0: '#737994', surface2: '#626880', surface1: '#51576d',
      surface0: '#414559', base: '#303446', mantle: '#292c3c', crust: '#232634',
    },
  },
  macchiato: {
    name: 'Macchiato',
    dark: true,
    colors: {
      rosewater: '#f4dbd6', flamingo: '#f0c6c6', pink: '#f5bde6', mauve: '#c6a0f6',
      red: '#ed8796', maroon: '#ee99a0', peach: '#f5a97f', yellow: '#eed49f',
      green: '#a6da95', teal: '#8bd5ca', sky: '#91d7e3', sapphire: '#7dc4e4',
      blue: '#8aadf4', lavender: '#b7bdf8',
      text: '#cad3f5', subtext1: '#b8c0e0', subtext0: '#a5adcb', overlay2: '#939ab7',
      overlay1: '#8087a2', overlay0: '#6e738d', surface2: '#5b6078', surface1: '#494d64',
      surface0: '#363a4f', base: '#24273a', mantle: '#1e2030', crust: '#181926',
    },
  },
  mocha: {
    name: 'Mocha',
    dark: true,
    colors: {
      rosewater: '#f5e0dc', flamingo: '#f2cdcd', pink: '#f5c2e7', mauve: '#cba6f7',
      red: '#f38ba8', maroon: '#eba0ac', peach: '#fab387', yellow: '#f9e2af',
      green: '#a6e3a1', teal: '#94e2d5', sky: '#89dceb', sapphire: '#74c7ec',
      blue: '#89b4fa', lavender: '#b4befe',
      text: '#cdd6f4', subtext1: '#bac2de', subtext0: '#a6adc8', overlay2: '#9399b2',
      overlay1: '#7f849c', overlay0: '#6c7086', surface2: '#585b70', surface1: '#45475a',
      surface0: '#313244', base: '#1e1e2e', mantle: '#181825', crust: '#11111b',
    },
  },
};

export const FLAVOUR_IDS: FlavourId[] = ['latte', 'frappe', 'macchiato', 'mocha'];

/**
 * The colours a person's name and avatar can take. Ten rather than all
 * fourteen: rosewater and flamingo are too close to each other and to pink to
 * tell two people apart by, and red and maroon read as an error.
 */
const NAME_SLOTS: AccentName[] = [
  'pink', 'peach', 'yellow', 'green', 'teal', 'sky', 'blue', 'lavender', 'mauve', 'flamingo',
];

/** The three colours the advanced section lets a person replace. */
export type OverrideKey = 'base' | 'mantle' | 'text';

export interface ThemePrefs {
  flavour: ThemeChoice;
  accent: AccentName;
  /** Overrides `accent` when set. `#rrggbb`. */
  customAccent: string | null;
  overrides: Partial<Record<OverrideKey, string>>;
  /** Draw each author's name in their colour, not the text colour. */
  nameColors: boolean;
}

export const DEFAULT_PREFS: ThemePrefs = {
  flavour: 'mocha',
  accent: 'mauve',
  customAccent: null,
  overrides: {},
  nameColors: true,
};

const KEY = 'theme';
const HEX = /^#[0-9a-f]{6}$/i;

/**
 * Whatever is stored, read back field by field: this is a value a person (or
 * an older build) wrote, and a bad one must cost them their theme, not the app.
 */
export function parsePrefs(raw: unknown): ThemePrefs {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const flavour =
    p.flavour === 'system' || FLAVOUR_IDS.includes(p.flavour as FlavourId)
      ? (p.flavour as ThemeChoice)
      : DEFAULT_PREFS.flavour;
  const accent = ACCENTS.includes(p.accent as AccentName)
    ? (p.accent as AccentName)
    : DEFAULT_PREFS.accent;
  const customAccent =
    typeof p.customAccent === 'string' && HEX.test(p.customAccent) ? p.customAccent : null;
  const overrides: ThemePrefs['overrides'] = {};
  const o = (p.overrides && typeof p.overrides === 'object' ? p.overrides : {}) as Record<string, unknown>;
  for (const k of ['base', 'mantle', 'text'] as OverrideKey[]) {
    if (typeof o[k] === 'string' && HEX.test(o[k] as string)) overrides[k] = o[k] as string;
  }
  const nameColors = typeof p.nameColors === 'boolean' ? p.nameColors : DEFAULT_PREFS.nameColors;
  return { flavour, accent, customAccent, overrides, nameColors };
}

export function loadPrefs(): ThemePrefs {
  try {
    return parsePrefs(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function systemDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
}

/** "System" means Latte in a light Windows and Mocha in a dark one. */
export function resolveFlavour(choice: ThemeChoice, dark = systemDark()): FlavourId {
  if (choice !== 'system') return choice;
  return dark ? 'mocha' : 'latte';
}

/* ------------------------------------------------------------ colour maths */

function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * Text to draw on a filled colour: whichever of near-black and white reads
 * better. Decided per colour rather than per flavour, because Latte's yellow
 * wants dark text and its mauve wants light, and a custom accent can be
 * anything at all.
 */
export function textOn(fill: string): string {
  const dark = '#11111b';
  return contrast(fill, dark) >= contrast(fill, '#ffffff') ? dark : '#ffffff';
}

/** Which NAME_SLOTS colour a name gets. Stable across sessions and machines. */
export function nameSlot(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h) % NAME_SLOTS.length;
}

/** For a `style` prop: the colour this name is drawn in, as a CSS variable. */
export function nameColorVar(name: string): CSSProperties {
  return { '--c': `var(--name-${nameSlot(name)})` } as CSSProperties;
}

/* ---------------------------------------------------------------- applying */

/** The values written onto <html>, in the variable names styles.css reads. */
export function themeVars(prefs: ThemePrefs, dark = systemDark()): Record<string, string> {
  const f = FLAVOURS[resolveFlavour(prefs.flavour, dark)];
  const c = f.colors;
  const base = prefs.overrides.base ?? c.base;
  const mantle = prefs.overrides.mantle ?? c.mantle;
  const text = prefs.overrides.text ?? c.text;
  const accent = prefs.customAccent ?? c[prefs.accent];
  const vars: Record<string, string> = {
    '--crust': c.crust,
    '--bg': base,
    '--bg2': mantle,
    '--panel': mantle,
    '--panel2': c.surface0,
    '--panel3': c.surface1,
    '--line': c.surface0,
    '--text': text,
    '--dim': c.subtext0,
    '--faint': c.overlay1,
    '--accent': accent,
    '--on-accent': textOn(accent),
    '--ok': c.green,
    '--bad': c.red,
    '--on-bad': textOn(c.red),
    '--warn': c.yellow,
    '--self-mention': c.peach,
    // Black shadows on Latte look like smudges; its own text colour, faint,
    // reads as a shadow on a light ground.
    '--shadow': f.dark ? 'rgba(0, 0, 0, .45)' : 'rgba(76, 79, 105, .2)',
    '--scrim': f.dark ? 'rgba(0, 0, 0, .55)' : 'rgba(76, 79, 105, .35)',
  };
  NAME_SLOTS.forEach((n, i) => {
    vars[`--name-${i}`] = c[n];
  });
  vars['--on-name'] = f.dark ? c.crust : c.base;
  return vars;
}

export function applyTheme(prefs: ThemePrefs): void {
  const root = document.documentElement;
  const dark = systemDark();
  for (const [k, v] of Object.entries(themeVars(prefs, dark))) root.style.setProperty(k, v);
  const id = resolveFlavour(prefs.flavour, dark);
  root.dataset.flavour = id;
  root.style.colorScheme = FLAVOURS[id].dark ? 'dark' : 'light';
  root.classList.toggle('name-colors', prefs.nameColors);
}

const listeners = new Set<(p: ThemePrefs) => void>();

export function savePrefs(prefs: ThemePrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Storage full or refused: the theme still applies for this session.
  }
  applyTheme(prefs);
  listeners.forEach((fn) => fn(prefs));
}

export function onPrefsChange(fn: (p: ThemePrefs) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Called once, before the first render, so the first frame is already themed. */
export function initTheme(): void {
  applyTheme(loadPrefs());
  // Windows flipping between light and dark only matters to "System", but
  // re-applying is cheap and reading the stored choice keeps this stateless.
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
    applyTheme(loadPrefs());
  });
  // The other window changed it.
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    const p = loadPrefs();
    applyTheme(p);
    listeners.forEach((fn) => fn(p));
  });
}
