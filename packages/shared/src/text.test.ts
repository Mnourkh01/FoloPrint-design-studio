import { describe, expect, it } from 'vitest';
import { FONT_WHITELIST, isFontFamilyKey } from './fonts';
import {
  designObjectContentErrors,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  TEXT_MAX_LENGTH,
  TEXT_MAX_LINES,
} from './text';
import type { StoredDesignObject, TextDesignObject } from './types';

const validText = (overrides: Partial<TextDesignObject> = {}): TextDesignObject => ({
  type: 'text',
  text: 'Hello world',
  fontFamily: 'inter',
  fontSize: 48,
  color: '#1a1a1a',
  align: 'center',
  x: 200,
  y: 200,
  width: 120,
  height: 50,
  rotation: 0,
  ...overrides,
});

const errorsOf = (overrides: Partial<TextDesignObject>): string[] =>
  designObjectContentErrors(validText(overrides));

describe('font whitelist', () => {
  it('contains the five bundled fonts with license metadata', () => {
    expect(FONT_WHITELIST.map((f) => f.key)).toEqual([
      'inter',
      'oswald',
      'playfair',
      'roboto-slab',
      'caveat',
    ]);
    for (const font of FONT_WHITELIST) {
      expect(['OFL-1.1', 'Apache-2.0']).toContain(font.license);
    }
  });

  it('isFontFamilyKey accepts whitelist keys only', () => {
    expect(isFontFamilyKey('inter')).toBe(true);
    expect(isFontFamilyKey('Inter')).toBe(false); // keys, not family names
    expect(isFontFamilyKey('comic-sans')).toBe(false);
    expect(isFontFamilyKey(42)).toBe(false);
    expect(isFontFamilyKey(undefined)).toBe(false);
  });
});

describe('designObjectContentErrors for text objects', () => {
  it('accepts a fully valid text object', () => {
    expect(designObjectContentErrors(validText())).toEqual([]);
  });

  it('accepts boundary values', () => {
    expect(errorsOf({ text: 'a'.repeat(TEXT_MAX_LENGTH) })).toEqual([]);
    expect(errorsOf({ text: Array(TEXT_MAX_LINES).fill('x').join('\n') })).toEqual([]);
    expect(errorsOf({ fontSize: FONT_SIZE_MIN })).toEqual([]);
    expect(errorsOf({ fontSize: FONT_SIZE_MAX })).toEqual([]);
    expect(errorsOf({ color: '#AbCdEf' })).toEqual([]);
  });

  it('rejects empty or whitespace-only text', () => {
    expect(errorsOf({ text: '' })).toContainEqual(expect.stringMatching(/not be empty/));
    expect(errorsOf({ text: '   \n  ' })).toContainEqual(expect.stringMatching(/not be empty/));
  });

  it('rejects text over the length and line limits', () => {
    expect(errorsOf({ text: 'a'.repeat(TEXT_MAX_LENGTH + 1) })).toContainEqual(
      expect.stringMatching(/at most 300 characters/),
    );
    expect(errorsOf({ text: Array(TEXT_MAX_LINES + 1).fill('x').join('\n') })).toContainEqual(
      expect.stringMatching(/at most 8 lines/),
    );
  });

  it('rejects control characters but allows newlines', () => {
    expect(errorsOf({ text: 'ok\nline' })).toEqual([]);
    expect(errorsOf({ text: 'bad\rline' })).toContainEqual(
      expect.stringMatching(/control characters/),
    );
    expect(errorsOf({ text: 'bad\tline' })).toContainEqual(
      expect.stringMatching(/control characters/),
    );
    expect(errorsOf({ text: 'bad\u0000line' })).toContainEqual(
      expect.stringMatching(/control characters/),
    );
  });

  it('rejects fonts outside the whitelist', () => {
    expect(errorsOf({ fontFamily: 'comic-sans' })).toContainEqual(
      expect.stringMatching(/not in the font whitelist/),
    );
    expect(errorsOf({ fontFamily: 'Inter' })).toContainEqual(
      expect.stringMatching(/not in the font whitelist/),
    );
  });

  it('rejects font sizes outside 12..500 and non-finite sizes', () => {
    for (const fontSize of [FONT_SIZE_MIN - 1, FONT_SIZE_MAX + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(errorsOf({ fontSize })).toContainEqual(expect.stringMatching(/between 12 and 500/));
    }
  });

  it('rejects every non-#RRGGBB color form', () => {
    for (const color of ['red', '#fff', '#12345', '#1234567', 'rgb(0,0,0)', '#GGGGGG', '1a1a1a']) {
      expect(errorsOf({ color })).toContainEqual(expect.stringMatching(/#RRGGBB/));
    }
  });

  it('rejects unknown align values', () => {
    expect(errorsOf({ align: 'justify' as TextDesignObject['align'] })).toContainEqual(
      expect.stringMatching(/left, center, right/),
    );
  });
});

describe('designObjectContentErrors for image objects', () => {
  it('accepts typed and legacy (typeless) image objects', () => {
    const typed: StoredDesignObject = {
      type: 'image',
      assetId: 'a',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      rotation: 0,
    };
    const legacy: StoredDesignObject = {
      assetId: 'a',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      rotation: 0,
    };
    expect(designObjectContentErrors(typed)).toEqual([]);
    expect(designObjectContentErrors(legacy)).toEqual([]);
  });

  it('rejects an image object without an asset reference', () => {
    const missing = { type: 'image', x: 0, y: 0, width: 10, height: 10, rotation: 0 };
    expect(designObjectContentErrors(missing as unknown as StoredDesignObject)).toContainEqual(
      expect.stringMatching(/reference an asset/),
    );
  });
});
