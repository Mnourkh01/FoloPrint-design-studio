import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fontDefinitionOf } from '@foloprint/shared';

/**
 * Maps a whitelist font key to its bundled font file. The renderer is the only
 * layer that touches font files (mirrors StorageService owning the storage layout);
 * everything else passes whitelist keys around.
 *
 * Resolves relative to this module so it works from dist/ (built, ../fonts) and
 * from src/ (vitest, ../fonts) alike: both sit one level below the package root.
 */
const FONTS_DIR = join(__dirname, '..', 'fonts');

export interface ResolvedFont {
  /** Family name as declared inside the font file (what Pango selects by). */
  family: string;
  /** Absolute path to the bundled TTF. */
  filePath: string;
}

export class UnknownFontError extends Error {
  constructor(key: string) {
    super(`Font "${key}" is not in the font whitelist`);
    this.name = 'UnknownFontError';
  }
}

/** Resolves a whitelist key to its family + bundled file; throws on unknown keys. */
export function resolveFont(key: string): ResolvedFont {
  const definition = fontDefinitionOf(key);
  if (!definition) {
    throw new UnknownFontError(key);
  }
  const filePath = join(FONTS_DIR, definition.key, definition.fileName);
  if (!existsSync(filePath)) {
    // A whitelisted font whose binary is missing is a packaging bug, not user input.
    throw new Error(`Bundled font file missing for "${key}": ${filePath}`);
  }
  return { family: definition.family, filePath };
}
