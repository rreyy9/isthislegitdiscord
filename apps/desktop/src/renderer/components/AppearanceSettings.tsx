import { useEffect, useState } from 'react';
import {
  ACCENTS,
  FLAVOURS,
  FLAVOUR_IDS,
  contrast,
  loadPrefs,
  onPrefsChange,
  resolveFlavour,
  savePrefs,
  type AccentName,
  type Flavour,
  type OverrideKey,
  type ThemeChoice,
  type ThemePrefs,
} from '../theme';

/**
 * Settings → Appearance: flavour, accent, and the three colours a person may
 * override by hand.
 *
 * Every control saves as it changes, the way the rest of the settings screen
 * does -- there is no Apply button because the change is visible behind the
 * dialog the moment it is made, and that is the preview.
 */

/** The minimum WCAG AA asks of body text. */
const READABLE = 4.5;

const OVERRIDES: { key: OverrideKey; label: string }[] = [
  { key: 'base', label: 'Background' },
  { key: 'mantle', label: 'Sidebar' },
  { key: 'text', label: 'Text' },
];

function capital(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A small drawing of the app in a flavour: sidebar, then three lines of chat. */
function Swatch({ f }: { f: Flavour }) {
  const c = f.colors;
  return (
    <span className="flv-swatch" style={{ background: c.base }}>
      <i style={{ background: c.mantle }} />
      <b>
        <u style={{ background: c.mauve, width: '70%' }} />
        <u style={{ background: c.text, width: '90%', opacity: 0.5 }} />
        <u style={{ background: c.green, width: '45%' }} />
      </b>
    </span>
  );
}

export function AppearanceSettings() {
  const [prefs, setPrefs] = useState<ThemePrefs>(loadPrefs);

  // The watch-party window can change the theme too; keep this page honest.
  useEffect(() => onPrefsChange(setPrefs), []);

  const update = (patch: Partial<ThemePrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    savePrefs(next);
  };

  const flavour = FLAVOURS[resolveFlavour(prefs.flavour)];
  const base = prefs.overrides.base ?? flavour.colors.base;
  const text = prefs.overrides.text ?? flavour.colors.text;
  const ratio = contrast(text, base);
  const customised = Object.keys(prefs.overrides).length > 0;
  const darkNow = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;

  const choose = (choice: ThemeChoice) =>
    // Overrides were picked against the old flavour's colours and would be
    // wrong against the new one, so a new flavour starts clean.
    update({ flavour: choice, overrides: {} });

  return (
    <>
      <section className="set-group">
        <h4>Theme</h4>
        <div className="flv-grid">
          <button
            className={'flv' + (prefs.flavour === 'system' ? ' on' : '')}
            aria-pressed={prefs.flavour === 'system'}
            onClick={() => choose('system')}
          >
            <span className="flv-swatch split">
              <i style={{ background: FLAVOURS.latte.colors.base }} />
              <i style={{ background: FLAVOURS.mocha.colors.base }} />
            </span>
            <span className="flv-name">
              System<small>auto</small>
            </span>
          </button>
          {FLAVOUR_IDS.map((id) => (
            <button
              key={id}
              className={'flv' + (prefs.flavour === id ? ' on' : '')}
              aria-pressed={prefs.flavour === id}
              onClick={() => choose(id)}
            >
              <Swatch f={FLAVOURS[id]} />
              <span className="flv-name">
                {FLAVOURS[id].name}
                <small>{FLAVOURS[id].dark ? 'dark' : 'light'}</small>
              </span>
            </button>
          ))}
        </div>
        <div className="hint">
          {prefs.flavour === 'system'
            ? `Following Windows, which is ${darkNow ? 'dark' : 'light'} right now, so this is ${
                darkNow ? 'Mocha' : 'Latte'
              }.`
            : 'Latte is the light theme. Frappé, Macchiato and Mocha are dark, from softest to deepest.'}
        </div>
      </section>

      <section className="set-group">
        <h4>Accent colour</h4>
        <div className="acc-row">
          {ACCENTS.map((name: AccentName) => {
            const on = !prefs.customAccent && prefs.accent === name;
            return (
              <button
                key={name}
                className={'acc' + (on ? ' on' : '')}
                style={{ background: flavour.colors[name] }}
                title={capital(name)}
                aria-label={capital(name)}
                aria-pressed={on}
                onClick={() => update({ accent: name, customAccent: null })}
              />
            );
          })}
          <label className={'acc-custom' + (prefs.customAccent ? ' on' : '')}>
            <input
              type="color"
              value={prefs.customAccent ?? flavour.colors[prefs.accent]}
              onChange={(e) => update({ customAccent: e.target.value })}
            />
            Custom
          </label>
        </div>
        <div className="hint">
          {prefs.customAccent
            ? `Custom ${prefs.customAccent.toUpperCase()}. Text on it switches between dark and light by itself so it stays readable.`
            : `${capital(prefs.accent)}. Every theme has the same fourteen accents, each tuned to its background.`}
        </div>
      </section>

      <section className="set-group">
        <h4>Custom colours</h4>
        <div className="ovr-grid">
          {OVERRIDES.map(({ key, label }) => (
            <label key={key} className={'ovr' + (prefs.overrides[key] ? ' on' : '')}>
              <input
                type="color"
                value={prefs.overrides[key] ?? flavour.colors[key]}
                onChange={(e) =>
                  update({ overrides: { ...prefs.overrides, [key]: e.target.value } })
                }
              />
              {label}
            </label>
          ))}
        </div>
        <div className="ovr-foot">
          <span>Text contrast</span>
          <span className={'contrast' + (ratio < READABLE ? ' bad' : '')}>
            {ratio.toFixed(1)}:1 · {ratio < READABLE ? 'hard to read' : 'readable'}
          </span>
          <button
            className="link"
            disabled={!customised}
            onClick={() => update({ overrides: {} })}
          >
            Reset to {flavour.name}
          </button>
        </div>
        <div className="hint">
          Online, speaking and error colours stay as they are, so green always means online.
        </div>
      </section>

      <section className="set-group">
        <h4>Names</h4>
        <label className="row-label">
          <input
            type="checkbox"
            checked={prefs.nameColors}
            onChange={(e) => update({ nameColors: e.target.checked })}
          />
          Colour each person's name
        </label>
        <div className="hint">
          In the colour of their avatar. Everyone gets the same colour on every screen.
        </div>
      </section>
    </>
  );
}
