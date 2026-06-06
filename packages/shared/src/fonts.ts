/**
 * Font whitelist for text design objects.
 *
 * Single source of truth for every layer: the editor offers exactly these fonts,
 * the API validates against them, and the renderer maps each key to its bundled
 * font file (packages/renderer/fonts/<key>/). Pure data, no runtime deps.
 *
 * Licensing rule: only SIL OFL 1.1 or Apache 2.0 fonts may be added, verified at
 * the source (the google/fonts repo carries the license per family). The license
 * file is checked in next to each font binary. "Free for personal use" fonts are
 * never acceptable: mockups are a commercial use.
 */

export interface FontDefinition {
  /** Stable whitelist key stored in design documents. */
  key: string;
  /** Font family name as declared inside the font file (Pango and CSS both use it). */
  family: string;
  /** Font file name inside the renderer's fonts/<key>/ directory. */
  fileName: string;
  /** License identifier, for the docs and the whitelist rule above. */
  license: 'OFL-1.1' | 'Apache-2.0';
}

export const FONT_WHITELIST = [
  { key: 'inter', family: 'Inter', fileName: 'inter.ttf', license: 'OFL-1.1' },
  { key: 'oswald', family: 'Oswald', fileName: 'oswald.ttf', license: 'OFL-1.1' },
  { key: 'playfair', family: 'Playfair Display', fileName: 'playfair.ttf', license: 'OFL-1.1' },
  { key: 'roboto-slab', family: 'Roboto Slab', fileName: 'roboto-slab.ttf', license: 'Apache-2.0' },
  { key: 'caveat', family: 'Caveat', fileName: 'caveat.ttf', license: 'OFL-1.1' },
  {
    key: 'noto-naskh-arabic',
    family: 'Noto Naskh Arabic',
    fileName: 'noto-naskh-arabic.ttf',
    license: 'OFL-1.1',
  },
] as const satisfies readonly FontDefinition[];

/** Union of valid whitelist keys ("inter" | "oswald" | ...). */
export type FontFamilyKey = (typeof FONT_WHITELIST)[number]['key'];

export const FONT_KEYS: readonly string[] = FONT_WHITELIST.map((f) => f.key);

export function isFontFamilyKey(value: unknown): value is FontFamilyKey {
  return typeof value === 'string' && FONT_KEYS.includes(value);
}

export function fontDefinitionOf(key: string): FontDefinition | undefined {
  return FONT_WHITELIST.find((f) => f.key === key);
}
