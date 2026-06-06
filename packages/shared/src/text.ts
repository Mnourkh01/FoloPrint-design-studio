import { isFontFamilyKey } from './fonts';
import type { StoredDesignObject, TextAlign } from './types';

/**
 * Content rules for design objects (non-geometry). Pure functions: the editor
 * uses them for UX, the API uses them as the authority via validateDesignPlacements.
 *
 * Geometry rules (finite, positive size, inside print area) live in geometry.ts
 * and apply to every object kind identically.
 */

export const TEXT_MAX_LENGTH = 300;
export const TEXT_MAX_LINES = 8;
export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 500;
/** Exactly #RRGGBB. No alpha, no shorthand, no named colors, no CSS functions. */
export const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
export const TEXT_ALIGNMENTS: readonly TextAlign[] = ['left', 'center', 'right'];

/**
 * Control characters are rejected except `\n` (explicit line breaks).
 * `\r` is included: the editor normalizes CRLF to `\n` before save.
 */
const FORBIDDEN_CONTROL_CHARS = /[\u0000-\u0009\u000B-\u001F\u007F]/;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * Content errors of one stored design object, discriminated on `type`
 * (missing type = legacy image). Returns human-readable messages; empty = valid.
 *
 * Kind purity is enforced both ways: a text object must not carry an assetId and
 * an image object must not carry text fields, so a payload can never be half of each.
 */
export function designObjectContentErrors(obj: StoredDesignObject): string[] {
  if (obj.type === 'text') {
    return textObjectContentErrors(obj);
  }
  return imageObjectContentErrors(obj);
}

function imageObjectContentErrors(
  obj: Extract<StoredDesignObject, { type?: 'image' | undefined }>,
): string[] {
  const errors: string[] = [];
  if (typeof obj.assetId !== 'string' || obj.assetId.length === 0) {
    errors.push('Image object must reference an asset');
  }
  // Compare against undefined, not `in`: class instances (DTOs) may carry every
  // declared field as an own undefined property (useDefineForClassFields).
  const carried = obj as Record<string, unknown>;
  if (carried.text !== undefined || carried.fontFamily !== undefined || carried.fontSize !== undefined) {
    errors.push('Image object must not carry text fields');
  }
  return errors;
}

function textObjectContentErrors(obj: Extract<StoredDesignObject, { type: 'text' }>): string[] {
  const errors: string[] = [];

  if ((obj as unknown as Record<string, unknown>).assetId !== undefined) {
    errors.push('Text object must not carry an assetId');
  }

  if (typeof obj.text !== 'string' || obj.text.trim().length === 0) {
    errors.push('Text must not be empty');
  } else {
    if (obj.text.length > TEXT_MAX_LENGTH) {
      errors.push(`Text must be at most ${TEXT_MAX_LENGTH} characters`);
    }
    if (obj.text.split('\n').length > TEXT_MAX_LINES) {
      errors.push(`Text must have at most ${TEXT_MAX_LINES} lines`);
    }
    if (FORBIDDEN_CONTROL_CHARS.test(obj.text)) {
      errors.push('Text contains unsupported control characters');
    }
  }

  if (!isFontFamilyKey(obj.fontFamily)) {
    errors.push(`Font "${String(obj.fontFamily)}" is not in the font whitelist`);
  }

  if (!isFiniteNumber(obj.fontSize) || obj.fontSize < FONT_SIZE_MIN || obj.fontSize > FONT_SIZE_MAX) {
    errors.push(`Font size must be between ${FONT_SIZE_MIN} and ${FONT_SIZE_MAX}`);
  }

  if (typeof obj.color !== 'string' || !HEX_COLOR_PATTERN.test(obj.color)) {
    errors.push('Color must be a #RRGGBB hex value');
  }

  if (!TEXT_ALIGNMENTS.includes(obj.align as TextAlign)) {
    errors.push('Align must be one of left, center, right');
  }

  return errors;
}
