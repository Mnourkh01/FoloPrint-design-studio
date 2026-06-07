import { ARC_SWEEP_MAX, ARC_SWEEP_MIN } from './arc';
import { isFontFamilyKey } from './fonts';
import { PATTERN_TYPES } from './types';
import type {
  ImagePattern,
  PatternType,
  StoredDesignObject,
  TextAlign,
  TextDirection,
  TextOutline,
  TextShadow,
  TextWrapMode,
} from './types';

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
export const TEXT_DIRECTIONS: readonly TextDirection[] = ['ltr', 'rtl', 'auto'];
export const TEXT_WRAP_MODES: readonly TextWrapMode[] = ['none', 'box'];
/** Outline stroke width bounds, canvas px (v1.8). */
export const OUTLINE_WIDTH_MIN = 1;
export const OUTLINE_WIDTH_MAX = 20;
/** Max absolute shadow offset per axis, canvas px (v1.8). */
export const SHADOW_OFFSET_MAX = 25;
/** Letter spacing bounds, canvas px between glyphs (v1.8). */
export const LETTER_SPACING_MIN = -20;
export const LETTER_SPACING_MAX = 100;
/** Pattern tile gap bounds, canvas px (v1.9). */
export const PATTERN_SPACING_MIN = 0;
export const PATTERN_SPACING_MAX = 100;

/**
 * Control characters are rejected except `\n` (explicit line breaks).
 * `\r` is included: the editor normalizes CRLF to `\n` before save.
 */
const FORBIDDEN_CONTROL_CHARS = /[\u0000-\u0009\u000B-\u001F\u007F]/;

/**
 * Bidi control characters are rejected in stored text: direction is contract data
 * (the `direction` field), never embedded characters. The renderer injects its own
 * marks at render time; a stored mark could override them or smuggle reordering.
 * Covers ALM (U+061C), LRM/RLM (U+200E/U+200F), embeddings/overrides + PDF
 * (U+202A-U+202E), and isolates (U+2066-U+2069).
 */
const FORBIDDEN_BIDI_CHARS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

/**
 * Strong-RTL detection for the first-strong scan: Hebrew through Arabic Extended-A
 * (U+0590-U+08FF) plus the Arabic presentation forms (U+FB50-U+FDFF, U+FE70-U+FEFF).
 */
const STRONG_RTL = /[\u0590-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

/** Any letter that is not strong-RTL counts as strong-LTR for the scan. */
const STRONG_LTR = /\p{L}/u;

/**
 * Resolves the base text direction with a first-strong-character scan (mirrors
 * Pango's and the browser's 'auto' heuristic). Explicit direction short-circuits;
 * all-neutral text (digits, punctuation) defaults to 'ltr'. Both the editor and
 * the renderer call this one function, so 'auto' can never resolve differently
 * on the two sides.
 */
export function resolveTextDirection(
  text: string,
  direction: TextDirection = 'auto',
): 'ltr' | 'rtl' {
  if (direction !== 'auto') {
    return direction;
  }
  for (const char of text) {
    if (STRONG_RTL.test(char)) return 'rtl';
    if (STRONG_LTR.test(char)) return 'ltr';
  }
  return 'ltr';
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Whitespace-insensitive equality: wrap may move breaks but never edit content. */
const stripWhitespace = (value: string): string => value.replace(/\s+/gu, '');

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
  errors.push(...patternErrors((obj as { pattern?: ImagePattern }).pattern, obj.rotation));
  // Compare against undefined, not `in`: class instances (DTOs) may carry every
  // declared field as an own undefined property (useDefineForClassFields).
  const carried = obj as Record<string, unknown>;
  if (
    carried.text !== undefined ||
    carried.fontFamily !== undefined ||
    carried.fontSize !== undefined ||
    carried.direction !== undefined ||
    carried.wrapMode !== undefined ||
    carried.wrappedLines !== undefined ||
    carried.outline !== undefined ||
    carried.shadow !== undefined ||
    carried.letterSpacing !== undefined ||
    carried.arc !== undefined
  ) {
    errors.push('Image object must not carry text fields');
  }
  return errors;
}

/** v1.9 pattern rules: known type, bounded spacing, axis-aligned tile only. */
function patternErrors(pattern: ImagePattern | undefined, rotation: unknown): string[] {
  if (pattern === undefined) return [];
  if (typeof pattern !== 'object' || pattern === null) {
    return ['Pattern must be an object with type and spacing'];
  }
  const errors: string[] = [];
  if (!PATTERN_TYPES.includes(pattern.type as PatternType)) {
    errors.push(`Pattern type must be one of ${PATTERN_TYPES.join(', ')}`);
  }
  if (
    !isFiniteNumber(pattern.spacing) ||
    pattern.spacing < PATTERN_SPACING_MIN ||
    pattern.spacing > PATTERN_SPACING_MAX
  ) {
    errors.push(
      `Pattern spacing must be between ${PATTERN_SPACING_MIN} and ${PATTERN_SPACING_MAX}`,
    );
  }
  if (isFiniteNumber(rotation) && rotation % 360 !== 0) {
    errors.push('Patterned images must not be rotated');
  }
  return errors;
}

function textObjectContentErrors(obj: Extract<StoredDesignObject, { type: 'text' }>): string[] {
  const errors: string[] = [];

  if ((obj as unknown as Record<string, unknown>).assetId !== undefined) {
    errors.push('Text object must not carry an assetId');
  }

  if ((obj as unknown as Record<string, unknown>).pattern !== undefined) {
    errors.push('Text object must not carry a pattern');
  }

  const wrapMode: TextWrapMode = obj.wrapMode ?? 'none';

  if (typeof obj.text !== 'string' || obj.text.trim().length === 0) {
    errors.push('Text must not be empty');
  } else {
    if (obj.text.length > TEXT_MAX_LENGTH) {
      errors.push(`Text must be at most ${TEXT_MAX_LENGTH} characters`);
    }
    // The 8-line cap applies to the VISUAL line count: explicit breaks for
    // wrapMode 'none' (unchanged from v1.5), wrappedLines.length for 'box'
    // (validated in wrappedLinesErrors below).
    if (wrapMode === 'none' && obj.text.split('\n').length > TEXT_MAX_LINES) {
      errors.push(`Text must have at most ${TEXT_MAX_LINES} lines`);
    }
    if (FORBIDDEN_CONTROL_CHARS.test(obj.text)) {
      errors.push('Text contains unsupported control characters');
    }
    if (FORBIDDEN_BIDI_CHARS.test(obj.text)) {
      errors.push('Text contains bidirectional control characters');
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

  if (obj.direction !== undefined && !TEXT_DIRECTIONS.includes(obj.direction)) {
    errors.push('Direction must be one of ltr, rtl, auto');
  }

  if (obj.wrapMode !== undefined && !TEXT_WRAP_MODES.includes(obj.wrapMode)) {
    errors.push('Wrap mode must be one of none, box');
  }

  errors.push(...wrappedLinesErrors(obj, wrapMode));
  errors.push(...outlineErrors(obj.outline));
  errors.push(...shadowErrors(obj.shadow));

  if (
    obj.letterSpacing !== undefined &&
    (!isFiniteNumber(obj.letterSpacing) ||
      obj.letterSpacing < LETTER_SPACING_MIN ||
      obj.letterSpacing > LETTER_SPACING_MAX)
  ) {
    errors.push(`Letter spacing must be between ${LETTER_SPACING_MIN} and ${LETTER_SPACING_MAX}`);
  }

  if (obj.arc !== undefined) {
    if (
      !isFiniteNumber(obj.arc) ||
      obj.arc === 0 ||
      obj.arc < ARC_SWEEP_MIN ||
      obj.arc > ARC_SWEEP_MAX
    ) {
      errors.push(
        `Arc must be a non-zero sweep between ${ARC_SWEEP_MIN} and ${ARC_SWEEP_MAX} degrees`,
      );
    }
    if (wrapMode === 'box') {
      errors.push('Arc cannot be combined with wrap-in-box');
    }
    if (typeof obj.text === 'string' && obj.text.includes('\n')) {
      errors.push('Arc text must be a single line');
    }
    if (typeof obj.text === 'string' && STRONG_RTL.test(obj.text)) {
      errors.push('Arc is not supported for right-to-left text');
    }
    if (obj.outline !== undefined || obj.shadow !== undefined) {
      errors.push('Arc cannot be combined with outline or shadow');
    }
  }

  return errors;
}

/** v1.8 outline rules: well-formed object, hex color, bounded width. */
function outlineErrors(outline: TextOutline | undefined): string[] {
  if (outline === undefined) return [];
  if (typeof outline !== 'object' || outline === null) {
    return ['Outline must be an object with color and width'];
  }
  const errors: string[] = [];
  if (typeof outline.color !== 'string' || !HEX_COLOR_PATTERN.test(outline.color)) {
    errors.push('Outline color must be a #RRGGBB hex value');
  }
  if (
    !isFiniteNumber(outline.width) ||
    outline.width < OUTLINE_WIDTH_MIN ||
    outline.width > OUTLINE_WIDTH_MAX
  ) {
    errors.push(`Outline width must be between ${OUTLINE_WIDTH_MIN} and ${OUTLINE_WIDTH_MAX}`);
  }
  return errors;
}

/** v1.8 shadow rules: hex color, bounded offsets, not invisibly zero. */
function shadowErrors(shadow: TextShadow | undefined): string[] {
  if (shadow === undefined) return [];
  if (typeof shadow !== 'object' || shadow === null) {
    return ['Shadow must be an object with color, offsetX, and offsetY'];
  }
  const errors: string[] = [];
  if (typeof shadow.color !== 'string' || !HEX_COLOR_PATTERN.test(shadow.color)) {
    errors.push('Shadow color must be a #RRGGBB hex value');
  }
  const validOffset = (v: unknown): v is number =>
    isFiniteNumber(v) && Math.abs(v) <= SHADOW_OFFSET_MAX;
  if (!validOffset(shadow.offsetX) || !validOffset(shadow.offsetY)) {
    errors.push(`Shadow offsets must be between -${SHADOW_OFFSET_MAX} and ${SHADOW_OFFSET_MAX}`);
  } else if (shadow.offsetX === 0 && shadow.offsetY === 0) {
    errors.push('Shadow offset must not be zero in both axes');
  }
  return errors;
}

/**
 * Rules for the derived wrappedLines cache: present iff wrapMode is 'box', entries
 * are single visual lines (no `\n`, no control or bidi chars), at most
 * TEXT_MAX_LINES of them, and joined-minus-whitespace they reconcile exactly with
 * the raw text. A mismatch means the cache is forged or stale and the server must
 * not render it.
 */
function wrappedLinesErrors(
  obj: Extract<StoredDesignObject, { type: 'text' }>,
  wrapMode: TextWrapMode,
): string[] {
  const lines = obj.wrappedLines;

  if (wrapMode !== 'box') {
    return lines === undefined ? [] : ['wrappedLines is only allowed when wrapMode is "box"'];
  }

  if (!Array.isArray(lines) || lines.length === 0) {
    return ['wrappedLines is required when wrapMode is "box"'];
  }

  const errors: string[] = [];
  if (lines.length > TEXT_MAX_LINES) {
    errors.push(`Text must have at most ${TEXT_MAX_LINES} lines`);
  }
  for (const line of lines) {
    if (typeof line !== 'string') {
      errors.push('wrappedLines entries must be strings');
      return errors; // content checks below assume strings
    }
    if (line.includes('\n')) {
      errors.push('wrappedLines entries must not contain line breaks');
    }
    if (FORBIDDEN_CONTROL_CHARS.test(line)) {
      errors.push('wrappedLines contains unsupported control characters');
    }
    if (FORBIDDEN_BIDI_CHARS.test(line)) {
      errors.push('wrappedLines contains bidirectional control characters');
    }
  }

  if (
    typeof obj.text === 'string' &&
    stripWhitespace(lines.join('')) !== stripWhitespace(obj.text)
  ) {
    errors.push('wrappedLines does not reconcile with the text content');
  }

  return errors;
}
