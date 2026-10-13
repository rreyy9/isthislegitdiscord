import { describe, expect, it } from 'vitest';
import {
  ACCENTS,
  DEFAULT_PREFS,
  FLAVOURS,
  FLAVOUR_IDS,
  contrast,
  nameSlot,
  parsePrefs,
  resolveFlavour,
  textOn,
  themeVars,
} from './theme';

describe('parsePrefs', () => {
  it('falls back to the defaults for nothing stored', () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('mocha')).toEqual(DEFAULT_PREFS);
  });

  it('keeps valid fields and drops bad ones one by one', () => {
    const p = parsePrefs({
      flavour: 'latte',
      accent: 'not-a-colour',
      customAccent: 'red',
      overrides: { base: '#101010', text: 'white', crust: '#000000' },
      nameColors: false,
    });
    expect(p.flavour).toBe('latte');
    expect(p.accent).toBe(DEFAULT_PREFS.accent);
    expect(p.customAccent).toBeNull();
    expect(p.overrides).toEqual({ base: '#101010' });
    expect(p.nameColors).toBe(false);
  });

  it('accepts system and a hex custom accent', () => {
    const p = parsePrefs({ flavour: 'system', customAccent: '#FF6AC1' });
    expect(p.flavour).toBe('system');
    expect(p.customAccent).toBe('#FF6AC1');
  });
});

describe('resolveFlavour', () => {
  it('maps system onto Latte and Mocha', () => {
    expect(resolveFlavour('system', true)).toBe('mocha');
    expect(resolveFlavour('system', false)).toBe('latte');
    expect(resolveFlavour('frappe', false)).toBe('frappe');
  });
});

describe('colour maths', () => {
  it('measures contrast the WCAG way', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrast('#777777', '#777777')).toBeCloseTo(1, 5);
  });

  it('picks readable text for every accent in every flavour', () => {
    for (const id of FLAVOUR_IDS) {
      for (const a of ACCENTS) {
        const fill = FLAVOURS[id].colors[a];
        expect(contrast(fill, textOn(fill))).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('keeps body text readable in every flavour as shipped', () => {
    for (const id of FLAVOUR_IDS) {
      const c = FLAVOURS[id].colors;
      expect(contrast(c.text, c.base)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('nameSlot', () => {
  it('is stable and in range', () => {
    expect(nameSlot('luka')).toBe(nameSlot('luka'));
    for (const n of ['a', 'kreso', 'Ana Marija', '', 'x'.repeat(200)]) {
      const s = nameSlot(n);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(10);
    }
  });
});

describe('themeVars', () => {
  it('lets overrides and a custom accent win over the flavour', () => {
    const v = themeVars(
      { ...DEFAULT_PREFS, customAccent: '#ff0000', overrides: { base: '#000000' } },
      true,
    );
    expect(v['--accent']).toBe('#ff0000');
    expect(v['--bg']).toBe('#000000');
    expect(v['--bg2']).toBe(FLAVOURS.mocha.colors.mantle);
  });

  it('defines every name slot', () => {
    const v = themeVars({ ...DEFAULT_PREFS, flavour: 'latte' }, true);
    for (let i = 0; i < 10; i++) expect(v[`--name-${i}`]).toMatch(/^#[0-9a-f]{6}$/);
  });
});
