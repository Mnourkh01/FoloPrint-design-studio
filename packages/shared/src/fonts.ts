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
 *
 * `category` groups the fonts in the editor's font picker so a non-designer can
 * browse by feel (Sans, Display, Serif, ...) instead of scanning a flat list.
 */

export type FontCategory = 'Sans' | 'Display' | 'Serif' | 'Slab' | 'Script' | 'Fun' | 'Arabic';

/** Display order of the categories in the picker. */
export const FONT_CATEGORY_ORDER: readonly FontCategory[] = [
  'Sans',
  'Display',
  'Serif',
  'Slab',
  'Script',
  'Fun',
  'Arabic',
];

export interface FontDefinition {
  /** Stable whitelist key stored in design documents. */
  key: string;
  /** Font family name as declared inside the font file (Pango and CSS both use it). */
  family: string;
  /** Font file name inside the renderer's fonts/<key>/ directory. */
  fileName: string;
  /** License identifier, for the docs and the whitelist rule above. */
  license: 'OFL-1.1' | 'Apache-2.0';
  /** Picker grouping. */
  category: FontCategory;
}

export const FONT_WHITELIST = [
  // --- Sans: clean, everyday ---
  { key: 'inter', family: 'Inter', fileName: 'inter.ttf', license: 'OFL-1.1', category: 'Sans' },
  { key: 'montserrat', family: 'Montserrat', fileName: 'Montserrat.ttf', license: 'OFL-1.1', category: 'Sans' },
  { key: 'poppins', family: 'Poppins', fileName: 'Poppins-SemiBold.ttf', license: 'OFL-1.1', category: 'Sans' },
  // --- Display: bold, attention-grabbing ---
  { key: 'oswald', family: 'Oswald', fileName: 'oswald.ttf', license: 'OFL-1.1', category: 'Display' },
  { key: 'anton', family: 'Anton', fileName: 'Anton-Regular.ttf', license: 'OFL-1.1', category: 'Display' },
  { key: 'bebas-neue', family: 'Bebas Neue', fileName: 'BebasNeue-Regular.ttf', license: 'OFL-1.1', category: 'Display' },
  { key: 'archivo-black', family: 'Archivo Black', fileName: 'ArchivoBlack-Regular.ttf', license: 'OFL-1.1', category: 'Display' },
  // --- Serif: classic, elegant ---
  { key: 'playfair', family: 'Playfair Display', fileName: 'playfair.ttf', license: 'OFL-1.1', category: 'Serif' },
  { key: 'lora', family: 'Lora', fileName: 'Lora.ttf', license: 'OFL-1.1', category: 'Serif' },
  { key: 'dm-serif-display', family: 'DM Serif Display', fileName: 'DMSerifDisplay-Regular.ttf', license: 'OFL-1.1', category: 'Serif' },
  // --- Slab: chunky serif ---
  { key: 'roboto-slab', family: 'Roboto Slab', fileName: 'roboto-slab.ttf', license: 'Apache-2.0', category: 'Slab' },
  { key: 'alfa-slab-one', family: 'Alfa Slab One', fileName: 'AlfaSlabOne-Regular.ttf', license: 'OFL-1.1', category: 'Slab' },
  // --- Script: handwritten, flowing ---
  { key: 'caveat', family: 'Caveat', fileName: 'caveat.ttf', license: 'OFL-1.1', category: 'Script' },
  { key: 'pacifico', family: 'Pacifico', fileName: 'Pacifico-Regular.ttf', license: 'OFL-1.1', category: 'Script' },
  { key: 'lobster', family: 'Lobster', fileName: 'Lobster-Regular.ttf', license: 'OFL-1.1', category: 'Script' },
  { key: 'dancing-script', family: 'Dancing Script', fileName: 'DancingScript.ttf', license: 'OFL-1.1', category: 'Script' },
  { key: 'permanent-marker', family: 'Permanent Marker', fileName: 'PermanentMarker-Regular.ttf', license: 'Apache-2.0', category: 'Script' },
  // --- Fun: playful, novelty ---
  { key: 'bangers', family: 'Bangers', fileName: 'Bangers-Regular.ttf', license: 'OFL-1.1', category: 'Fun' },
  { key: 'luckiest-guy', family: 'Luckiest Guy', fileName: 'LuckiestGuy-Regular.ttf', license: 'Apache-2.0', category: 'Fun' },
  { key: 'righteous', family: 'Righteous', fileName: 'Righteous-Regular.ttf', license: 'OFL-1.1', category: 'Fun' },
  { key: 'bungee', family: 'Bungee', fileName: 'Bungee-Regular.ttf', license: 'OFL-1.1', category: 'Fun' },
  // --- Arabic ---
  { key: 'noto-naskh-arabic', family: 'Noto Naskh Arabic', fileName: 'noto-naskh-arabic.ttf', license: 'OFL-1.1', category: 'Arabic' },
  { key: 'cairo', family: 'Cairo', fileName: 'Cairo.ttf', license: 'OFL-1.1', category: 'Arabic' },
  { key: 'tajawal', family: 'Tajawal', fileName: 'Tajawal-Bold.ttf', license: 'OFL-1.1', category: 'Arabic' },
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
