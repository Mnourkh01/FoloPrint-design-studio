import { describe, expect, it } from 'vitest';
import { FONT_WHITELIST, isFontFamilyKey } from './fonts';
import {
  designObjectContentErrors,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  resolveTextDirection,
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
  it('contains the six bundled fonts with license metadata', () => {
    expect(FONT_WHITELIST.map((f) => f.key)).toEqual([
      'inter',
      'oswald',
      'playfair',
      'roboto-slab',
      'caveat',
      'noto-naskh-arabic',
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

  it('accepts valid direction and wrapMode values, including absent ones', () => {
    expect(errorsOf({})).toEqual([]); // both absent (pre-v1.6 object)
    expect(errorsOf({ direction: 'ltr' })).toEqual([]);
    expect(errorsOf({ direction: 'rtl' })).toEqual([]);
    expect(errorsOf({ direction: 'auto' })).toEqual([]);
    expect(errorsOf({ wrapMode: 'none' })).toEqual([]);
    expect(
      errorsOf({ wrapMode: 'box', text: 'Hello world', wrappedLines: ['Hello', 'world'] }),
    ).toEqual([]);
  });

  it('rejects unknown direction and wrapMode values', () => {
    expect(errorsOf({ direction: 'up' as TextDesignObject['direction'] })).toContainEqual(
      expect.stringMatching(/ltr, rtl, auto/),
    );
    expect(errorsOf({ wrapMode: 'char' as TextDesignObject['wrapMode'] })).toContainEqual(
      expect.stringMatching(/none, box/),
    );
  });

  it('rejects bidi control characters in text', () => {
    for (const char of ['؜', '‎', '‏', '‪', '‮', '⁦', '⁩']) {
      expect(errorsOf({ text: `bad${char}text` })).toContainEqual(
        expect.stringMatching(/bidirectional control/),
      );
    }
  });

  it('requires wrappedLines exactly when wrapMode is box', () => {
    expect(errorsOf({ wrapMode: 'box' })).toContainEqual(
      expect.stringMatching(/wrappedLines is required/),
    );
    expect(errorsOf({ wrapMode: 'box', wrappedLines: [] })).toContainEqual(
      expect.stringMatching(/wrappedLines is required/),
    );
    expect(errorsOf({ wrappedLines: ['Hello world'] })).toContainEqual(
      expect.stringMatching(/only allowed when wrapMode/),
    );
    expect(errorsOf({ wrapMode: 'none', wrappedLines: ['Hello world'] })).toContainEqual(
      expect.stringMatching(/only allowed when wrapMode/),
    );
  });

  it('rejects wrappedLines content violations', () => {
    const box = (lines: unknown): string[] =>
      errorsOf({ wrapMode: 'box', text: 'Hello world', wrappedLines: lines as string[] });
    expect(box(['Hello\nworld'])).toContainEqual(expect.stringMatching(/must not contain line breaks/));
    expect(box(['Hello\rworld'])).toContainEqual(expect.stringMatching(/control characters/));
    expect(box(['Hello‏world'])).toContainEqual(expect.stringMatching(/bidirectional control/));
    expect(box(['Hello', 42])).toContainEqual(expect.stringMatching(/must be strings/));
  });

  it('caps the visual line count: wrappedLines.length in box mode', () => {
    const words = Array(TEXT_MAX_LINES + 1).fill('x');
    expect(
      errorsOf({ wrapMode: 'box', text: words.join(' '), wrappedLines: words }),
    ).toContainEqual(expect.stringMatching(/at most 8 lines/));
    // At exactly the cap it passes.
    const atCap = Array(TEXT_MAX_LINES).fill('x');
    expect(
      errorsOf({ wrapMode: 'box', text: atCap.join(' '), wrappedLines: atCap }),
    ).toEqual([]);
  });

  it('rejects forged or stale wrappedLines via reconciliation', () => {
    expect(
      errorsOf({ wrapMode: 'box', text: 'Hello world', wrappedLines: ['Goodbye', 'world'] }),
    ).toContainEqual(expect.stringMatching(/does not reconcile/));
    expect(
      errorsOf({ wrapMode: 'box', text: 'Hello world', wrappedLines: ['Hello'] }),
    ).toContainEqual(expect.stringMatching(/does not reconcile/));
    // Whitespace moves are exactly what wrapping does; they must reconcile.
    expect(
      errorsOf({ wrapMode: 'box', text: 'a b c d', wrappedLines: ['a b', 'c d'] }),
    ).toEqual([]);
    // Explicit breaks flattened into visual lines reconcile too.
    expect(
      errorsOf({ wrapMode: 'box', text: 'a b\nc d', wrappedLines: ['a b', 'c d'] }),
    ).toEqual([]);
  });
});

describe('resolveTextDirection', () => {
  it('explicit direction short-circuits', () => {
    expect(resolveTextDirection('hello', 'rtl')).toBe('rtl');
    expect(resolveTextDirection('مرحبا', 'ltr')).toBe('ltr');
  });

  it('auto resolves rtl on Arabic-first text', () => {
    expect(resolveTextDirection('مرحبا بالعالم')).toBe('rtl');
    expect(resolveTextDirection('مرحبا ABC')).toBe('rtl');
  });

  it('auto resolves ltr on Latin-first text', () => {
    expect(resolveTextDirection('Hello')).toBe('ltr');
    expect(resolveTextDirection('ABC مرحبا')).toBe('ltr');
  });

  it('skips neutral characters before the first strong one', () => {
    expect(resolveTextDirection('123 ?! مرحبا')).toBe('rtl');
    expect(resolveTextDirection('123 ?! abc')).toBe('ltr');
  });

  it('all-neutral text defaults to ltr', () => {
    expect(resolveTextDirection('123 ?!')).toBe('ltr');
    expect(resolveTextDirection('')).toBe('ltr');
  });

  it('detects Hebrew and Arabic presentation forms as rtl', () => {
    expect(resolveTextDirection('שלום')).toBe('rtl');
    expect(resolveTextDirection('ﭐ')).toBe('rtl'); // presentation forms A
    expect(resolveTextDirection('ﹰ')).toBe('rtl'); // presentation forms B
  });

  it('auto defaults when the argument is omitted or auto', () => {
    expect(resolveTextDirection('مرحبا', 'auto')).toBe('rtl');
    expect(resolveTextDirection('hello', 'auto')).toBe('ltr');
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
