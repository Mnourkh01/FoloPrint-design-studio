import sharp from 'sharp';
import {
  ARC_SWEEP_MAX,
  ARC_SWEEP_MIN,
  HEX_COLOR_PATTERN,
  isObjectInsideRect,
  layoutArcGlyphs,
  LETTER_SPACING_MAX,
  LETTER_SPACING_MIN,
  OUTLINE_WIDTH_MAX,
  OUTLINE_WIDTH_MIN,
  OVERLAY_BLENDS,
  PATTERN_SPACING_MAX,
  PATTERN_SPACING_MIN,
  PATTERN_TYPES,
  SHADOW_OFFSET_MAX,
  type ImagePattern,
  type OverlayBlend,
  type Rect,
  type TextAlign,
  type TextOutline,
  type TextShadow,
} from '@foloprint/shared';
import { resolveFont, UnknownFontError } from './fonts';

export { resolveFont, UnknownFontError, type ResolvedFont } from './fonts';
export { OVERLAY_BLENDS, type OverlayBlend } from '@foloprint/shared';
export {
  FlatBackgroundError,
  removeFlatBackground,
  type RemoveBackgroundResult,
} from './remove-background';

/** Defensive cap against pixel bombs reaching libvips. */
const MAX_INPUT_PIXELS = 50_000_000;

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 } as const;

/** Pango raster density: at 72 dpi, 1 Pango point = 1 pixel, so fontSize maps 1:1. */
const TEXT_DPI = 72;

/** Pango fixed-point scale: 1024 units per point (= per pixel at TEXT_DPI). */
const PANGO_SCALE = 1024;

/**
 * Pango markup escape. libvips parses the text param as Pango MARKUP
 * unconditionally, so every user character must go through this; a raw '<'
 * would otherwise abort the whole render as malformed markup. Attribute values
 * we emit ourselves (letter_spacing) are validated numbers, never user input.
 */
const escapePangoMarkup = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface RenderObjectGeometry {
  /** Object center X in canvas px. */
  x: number;
  /** Object center Y in canvas px. */
  y: number;
  /** Target width in canvas px (before rotation). */
  width: number;
  /** Target height in canvas px (before rotation). */
  height: number;
  /** Rotation around the center, degrees clockwise. */
  rotation: number;
}

export interface RenderImageObject extends RenderObjectGeometry {
  type: 'image';
  /** Absolute path to the (already validated) asset image on disk. */
  imagePath: string;
  /**
   * Tiling fill (v1.9): the object's box becomes the base tile and copies fill
   * the WHOLE print area (clipped to it). Rotation must be 0.
   */
  pattern?: ImagePattern;
}

export interface RenderTextObject extends RenderObjectGeometry {
  type: 'text';
  /**
   * Final visual lines, in order: the caller maps `wrappedLines` for box-wrapped
   * text or `text.split('\n')` otherwise. The renderer renders them verbatim
   * (joined with `\n`, Pango wrap never used), so line breaks always match the
   * editor's. Never interpreted as markup.
   */
  lines: string[];
  /** Whitelist font key (resolved to a bundled file by the renderer). */
  fontFamily: string;
  /** Font size in canvas px. */
  fontSize: number;
  /** #RRGGBB. */
  color: string;
  align: TextAlign;
  /**
   * Resolved base direction ('auto' already resolved by the caller via the shared
   * resolveTextDirection; the renderer never guesses). Forced per line with a
   * zero-width directional mark, because sharp exposes no Pango direction option.
   */
  direction: 'ltr' | 'rtl';
  /**
   * Glyph outline (v1.8). The editor paints the stroke centered on the glyph edge
   * and measures the box stroke-inclusive, so the ring is built at width/2 BEFORE
   * the fit-to-box step; editor and server stay geometrically consistent.
   */
  outline?: TextOutline;
  /**
   * Hard drop shadow (v1.8), applied AFTER the fit at exact canvas px. Shadow
   * pixels may extend past the stored box (clamped by SHADOW_OFFSET_MAX); the
   * layer is padded symmetrically so the rotation pivot stays at the glyph center.
   */
  shadow?: TextShadow;
  /** Extra space between glyphs in canvas px (v1.8); 0/absent = font default. */
  letterSpacing?: number;
  /**
   * Arc sweep in degrees (v1.8); absent = straight. Single LTR line only, never
   * combined with outline/shadow (validated upstream and asserted here).
   */
  arc?: number;
}

export type RenderObject = RenderImageObject | RenderTextObject;

export interface RenderMockupOptions {
  /** Absolute path to the template base image. */
  baseImagePath: string;
  /** Absolute path to an overlay image composited above the artwork (shadows, fabric sheen). */
  overlayImagePath?: string | null;
  /** Overlay blend mode; defaults to 'over' (legacy alpha composite). */
  overlayBlend?: OverlayBlend;
  /**
   * Absolute path to a garment silhouette mask. The design ink is clipped to the
   * mask's alpha (opaque = printable garment, transparent = background), so artwork
   * near a garment edge never bleeds onto the backdrop of a photo-based template.
   */
  maskImagePath?: string | null;
  canvasWidth: number;
  canvasHeight: number;
  /** Print area in canvas px. Every object must be fully inside it. */
  printArea: Rect;
  objects: RenderObject[];
}

export class RenderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderValidationError';
  }
}

interface PreparedLayer {
  input: Buffer;
  left: number;
  top: number;
}

/** Pango's align keyword for our contract value (Pango spells it 'centre'). */
const PANGO_ALIGN: Record<TextAlign, 'left' | 'centre' | 'right'> = {
  left: 'left',
  center: 'centre',
  right: 'right',
};

/**
 * Pango interprets left/right alignment relative to the paragraph direction (its
 * 'left' means line-start, which is the RIGHT edge of an RTL paragraph), while the
 * contract's `align` always means visual left/right (canvas semantics). Pinned by
 * the rtl-alignment renderer test; for resolved-RTL text the values swap.
 */
const PANGO_ALIGN_RTL: Record<TextAlign, 'left' | 'centre' | 'right'> = {
  left: 'right',
  center: 'centre',
  right: 'left',
};

/**
 * Zero-width directional marks (LRM U+200E / RLM U+200F) injected at render time
 * only, never stored: Pango picks base direction per paragraph from its first
 * strong character, and the mark is that character. Stored text rejects all bidi
 * controls, so user content can never carry its own.
 */
const DIRECTION_MARK = { ltr: '\u200E', rtl: '\u200F' } as const;

/**
 * Rotate a prepared layer around its center on a transparent background and compute
 * the top-left placement so the rotation pivot stays at (x, y). Shared by image and
 * text layers: from a sized RGBA buffer onward the pipeline is identical.
 */
async function finalizeLayer(layer: Buffer, obj: RenderObjectGeometry): Promise<PreparedLayer> {
  let buffer = layer;
  if (obj.rotation % 360 !== 0) {
    buffer = await sharp(buffer)
      .rotate(obj.rotation, { background: TRANSPARENT })
      .png()
      .toBuffer();
  }

  // The rotated buffer is the bounding box of the rotated rect; its center is the object's center.
  const meta = await sharp(buffer).metadata();
  const layerWidth = meta.width ?? Math.round(obj.width);
  const layerHeight = meta.height ?? Math.round(obj.height);

  return {
    input: buffer,
    left: Math.round(obj.x - layerWidth / 2),
    top: Math.round(obj.y - layerHeight / 2),
  };
}

/**
 * Resize the asset to the object's target size, then rotate and position.
 *
 * Two separate sharp pipelines on purpose: sharp applies rotate before resize within a single
 * pipeline regardless of call order, which would distort the result.
 */
async function prepareImageLayer(obj: RenderImageObject): Promise<PreparedLayer> {
  const resized = await sharp(obj.imagePath, { limitInputPixels: MAX_INPUT_PIXELS })
    .resize(Math.round(obj.width), Math.round(obj.height), { fit: 'fill' })
    .ensureAlpha()
    .png()
    .toBuffer();

  return finalizeLayer(resized, obj);
}

/**
 * Tiles the object's box across the print area (v1.9). The user's tile placement
 * sets the pattern phase; the fill is built on a margin-padded sheet (sharp
 * composite rejects negative offsets) and then clipped to exactly the area rect.
 */
async function preparePatternLayer(
  obj: RenderImageObject,
  printArea: Rect,
): Promise<PreparedLayer> {
  const pattern = obj.pattern!;
  const tileW = Math.max(1, Math.round(obj.width));
  const tileH = Math.max(1, Math.round(obj.height));
  const spacing = Math.round(pattern.spacing);
  const stepX = tileW + spacing;
  const stepY = tileH + spacing;

  const base = await sharp(obj.imagePath, { limitInputPixels: MAX_INPUT_PIXELS })
    .resize(tileW, tileH, { fit: 'fill' })
    .ensureAlpha()
    .png()
    .toBuffer();
  // Mirror variants are built once and reused across the grid.
  const flop = pattern.type === 'mirror' ? await sharp(base).flop().png().toBuffer() : base;
  const flip = pattern.type === 'mirror' ? await sharp(base).flip().png().toBuffer() : base;
  const flopFlip = pattern.type === 'mirror' ? await sharp(flop).flip().png().toBuffer() : base;

  const areaW = Math.round(printArea.width);
  const areaH = Math.round(printArea.height);
  // Margin so every composite offset is non-negative even for tiles that
  // straddle the area edge (incl. the half-drop shift).
  const margin = stepX + stepY;

  // Base tile's top-left in area-local coords = the pattern phase.
  const originX = Math.round(obj.x - obj.width / 2 - printArea.x);
  const originY = Math.round(obj.y - obj.height / 2 - printArea.y);

  const colMin = Math.floor((-tileW - originX) / stepX) - 1;
  const colMax = Math.ceil((areaW - originX) / stepX) + 1;
  const rowMin = Math.floor((-tileH - originY) / stepY) - 1;
  const rowMax = Math.ceil((areaH - originY) / stepY) + 1;

  const even = (n: number) => ((n % 2) + 2) % 2 === 0;
  const layers: sharp.OverlayOptions[] = [];
  for (let col = colMin; col <= colMax; col++) {
    for (let row = rowMin; row <= rowMax; row++) {
      const x = originX + col * stepX;
      let y = originY + row * stepY;
      let input = base;
      if (pattern.type === 'mirror') {
        input = even(col) ? (even(row) ? base : flip) : even(row) ? flop : flopFlip;
      } else if (pattern.type === 'half-drop' && !even(col)) {
        y += Math.round(stepY / 2);
      }
      if (x + tileW <= -margin || y + tileH <= -margin || x >= areaW + margin || y >= areaH + margin) {
        continue;
      }
      layers.push({ input, left: x + margin, top: y + margin });
    }
  }

  const sheet = await sharp({
    create: {
      width: areaW + 2 * margin,
      height: areaH + 2 * margin,
      channels: 4,
      background: TRANSPARENT,
    },
  })
    .composite(layers)
    .png()
    .toBuffer();

  const clipped = await sharp(sheet)
    .extract({ left: margin, top: margin, width: areaW, height: areaH })
    .png()
    .toBuffer();

  return { input: clipped, left: Math.round(printArea.x), top: Math.round(printArea.y) };
}

/**
 * Silhouette tint: the source's alpha over a flat color (dest-in). Keeps
 * antialiasing and never touches markup; shared by the text fill, the outline
 * ring, and the shadow.
 */
async function tintAlpha(
  alphaSource: Buffer,
  width: number,
  height: number,
  color: string,
): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: color } })
    .composite([{ input: alphaSource, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

/**
 * Per-glyph arc rendering (v1.8). Each character is rastered alone with Pango,
 * tinted, rotated to its tangent, and composited at the position the SHARED
 * layoutArcGlyphs computed from this side's own measured advances. The sheet is
 * clipped to the layout bounds (the editor's raster has the same bounds), then
 * joins the normal fit-to-stored-box + finalize pipeline, so whole-block
 * rotation and metric-drift absorption work exactly like straight text.
 */
async function prepareArcTextLayer(obj: RenderTextObject): Promise<PreparedLayer> {
  const font = resolveFont(obj.fontFamily);
  const chars = [...obj.lines[0]!];

  const rasterChar = async (
    char: string,
  ): Promise<{ buf: Buffer; width: number; height: number } | null> => {
    try {
      const buf = await sharp({
        text: {
          text: escapePangoMarkup(char),
          font: `${font.family} ${obj.fontSize}`,
          fontfile: font.filePath,
          rgba: true,
          dpi: TEXT_DPI,
        },
      })
        .png()
        .toBuffer();
      const meta = await sharp(buf).metadata();
      if (!meta.width || !meta.height) return null;
      return { buf, width: meta.width, height: meta.height };
    } catch {
      return null; // whitespace and zero-ink chars advance without drawing
    }
  };

  // Space advance: Pango cannot raster lone whitespace; derive it from the
  // width difference of "a a" vs "aa" once per call.
  const spaceAdvance = async (): Promise<number> => {
    const [spaced, joined] = await Promise.all([rasterChar('a a'), rasterChar('aa')]);
    if (!spaced || !joined) return obj.fontSize * 0.3;
    return Math.max(2, spaced.width - joined.width);
  };

  const cache = new Map<string, { buf: Buffer; width: number; height: number } | null>();
  let spaceWidth: number | null = null;
  const glyphs: ({ buf: Buffer; width: number; height: number } | null)[] = [];
  const advances: number[] = [];
  for (const char of chars) {
    if (/\s/.test(char)) {
      spaceWidth ??= await spaceAdvance();
      glyphs.push(null);
      advances.push(spaceWidth);
      continue;
    }
    if (!cache.has(char)) cache.set(char, await rasterChar(char));
    const glyph = cache.get(char)!;
    glyphs.push(glyph);
    advances.push(glyph ? glyph.width : obj.fontSize * 0.3);
  }

  const layout = layoutArcGlyphs(advances, obj.fontSize, obj.arc!, obj.letterSpacing ?? 0);
  if (layout.positions.length === 0 || layout.width <= 0 || layout.height <= 0) {
    throw new RenderValidationError('Arc text rendered to an empty layout');
  }

  // Rotated glyph corners can poke past the bounds proxy; pad, composite, clip back.
  const margin = Math.ceil(obj.fontSize);
  const sheetW = Math.ceil(layout.width) + 2 * margin;
  const sheetH = Math.ceil(layout.height) + 2 * margin;

  const layers: sharp.OverlayOptions[] = [];
  for (let i = 0; i < glyphs.length; i++) {
    const glyph = glyphs[i];
    if (!glyph) continue;
    const placement = layout.positions[i]!;
    let buf = await tintAlpha(glyph.buf, glyph.width, glyph.height, obj.color);
    let w = glyph.width;
    let h = glyph.height;
    if (Math.round(placement.rotationDeg) % 360 !== 0) {
      buf = await sharp(buf).rotate(placement.rotationDeg, { background: TRANSPARENT }).png().toBuffer();
      const meta = await sharp(buf).metadata();
      w = meta.width ?? w;
      h = meta.height ?? h;
    }
    layers.push({
      input: buf,
      left: Math.round(placement.x + margin - w / 2),
      top: Math.round(placement.y + margin - h / 2),
    });
  }

  const sheet = await sharp({
    create: { width: sheetW, height: sheetH, channels: 4, background: TRANSPARENT },
  })
    .composite(layers)
    .png()
    .toBuffer();
  const clipped = await sharp(sheet)
    .extract({
      left: margin,
      top: margin,
      width: Math.ceil(layout.width),
      height: Math.ceil(layout.height),
    })
    .png()
    .toBuffer();

  const fitted = await sharp(clipped)
    .resize(Math.round(obj.width), Math.round(obj.height), { fit: 'fill' })
    .png()
    .toBuffer();

  return finalizeLayer(fitted, obj);
}

/**
 * Rasterize text with Pango, apply v1.8 effects, fit it into the stored box, then
 * rotate and position.
 *
 * Render-then-fit: the text is rastered at its natural Pango size (same bundled font
 * file the editor used) and then resized to exactly the stored width x height. Metric
 * drift between browser and Pango becomes a sub-percent glyph stretch instead of an
 * overflow or a moved line break.
 *
 * Effects order matters: the outline joins BEFORE the fit (the editor's measured box
 * includes the stroke), the shadow joins AFTER the fit (exact canvas px offsets,
 * symmetric padding so the rotation pivot stays at the glyph center).
 *
 * Injection safety: the text goes through Pango's plain-text path (no markup), and the
 * colors never enter any markup either; they are applied by compositing the glyph
 * alpha over a flat color (dest-in). Nothing user-controlled is ever concatenated
 * into a markup or SVG string.
 */
async function prepareTextLayer(obj: RenderTextObject): Promise<PreparedLayer> {
  if (obj.arc) return prepareArcTextLayer(obj);
  const font = resolveFont(obj.fontFamily); // throws UnknownFontError on non-whitelist keys

  // Each line gets the resolved direction mark so every Pango paragraph shares the
  // object's base direction (a line starting with an opposite-direction strong char
  // would otherwise flip on the server but not in the editor). Wrap is never used:
  // the lines were finalized by the editor. Every line is markup-escaped (vips
  // always parses markup); the optional letter_spacing span wraps the whole text
  // with an attribute value we computed ourselves.
  const mark = DIRECTION_MARK[obj.direction];
  const escaped = obj.lines.map((line) => mark + escapePangoMarkup(line)).join('\n');
  const pangoText = obj.letterSpacing
    ? `<span letter_spacing="${Math.round(obj.letterSpacing * PANGO_SCALE)}">${escaped}</span>`
    : escaped;
  const align = obj.direction === 'rtl' ? PANGO_ALIGN_RTL[obj.align] : PANGO_ALIGN[obj.align];

  const raster = await sharp({
    text: {
      text: pangoText,
      font: `${font.family} ${obj.fontSize}`,
      fontfile: font.filePath,
      rgba: true,
      dpi: TEXT_DPI,
      align,
    },
  })
    .png()
    .toBuffer();

  const meta = await sharp(raster).metadata();
  if (!meta.width || !meta.height) {
    throw new RenderValidationError('Text rendered to an empty raster');
  }

  let combined = await tintAlpha(raster, meta.width, meta.height, obj.color);

  if (obj.outline) {
    // The editor paints the stroke centered on the glyph edge (half outward), so
    // the visible ring is width/2; map it from canvas px to natural raster px.
    const radius = Math.max(1, Math.round((obj.outline.width / 2) * (meta.height / obj.height)));
    const ring = await tintAlpha(raster, meta.width, meta.height, obj.outline.color);
    const ringLayers: sharp.OverlayOptions[] = [];
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * 2 * Math.PI;
      ringLayers.push({
        input: ring,
        left: Math.round(radius + Math.cos(angle) * radius),
        top: Math.round(radius + Math.sin(angle) * radius),
      });
    }
    ringLayers.push({ input: combined, left: radius, top: radius });
    combined = await sharp({
      create: {
        width: meta.width + 2 * radius,
        height: meta.height + 2 * radius,
        channels: 4,
        background: TRANSPARENT,
      },
    })
      .composite(ringLayers)
      .png()
      .toBuffer();
  }

  const boxWidth = Math.round(obj.width);
  const boxHeight = Math.round(obj.height);
  let fitted = await sharp(combined)
    .resize(boxWidth, boxHeight, { fit: 'fill' })
    .png()
    .toBuffer();

  if (obj.shadow) {
    const pad = Math.ceil(Math.max(Math.abs(obj.shadow.offsetX), Math.abs(obj.shadow.offsetY)));
    const silhouette = await tintAlpha(fitted, boxWidth, boxHeight, obj.shadow.color);
    fitted = await sharp({
      create: {
        width: boxWidth + 2 * pad,
        height: boxHeight + 2 * pad,
        channels: 4,
        background: TRANSPARENT,
      },
    })
      .composite([
        {
          input: silhouette,
          left: pad + Math.round(obj.shadow.offsetX),
          top: pad + Math.round(obj.shadow.offsetY),
        },
        { input: fitted, left: pad, top: pad },
      ])
      .png()
      .toBuffer();
  }

  return finalizeLayer(fitted, obj);
}

/** Per-object sanity checks the renderer enforces even if a caller forgot to validate. */
function assertRenderableObject(obj: RenderObject, index: number, printArea: Rect): void {
  if (!isObjectInsideRect(obj, printArea)) {
    throw new RenderValidationError(`Design object ${index} is outside the print area`);
  }
  if (obj.type !== 'text' && obj.pattern) {
    if (
      !PATTERN_TYPES.includes(obj.pattern.type) ||
      !Number.isFinite(obj.pattern.spacing) ||
      obj.pattern.spacing < PATTERN_SPACING_MIN ||
      obj.pattern.spacing > PATTERN_SPACING_MAX
    ) {
      throw new RenderValidationError(`Design object ${index} has an invalid pattern`);
    }
    if (obj.rotation % 360 !== 0) {
      throw new RenderValidationError(`Design object ${index} is patterned and must not be rotated`);
    }
  }
  if (obj.type === 'text') {
    if (
      !Array.isArray(obj.lines) ||
      obj.lines.length === 0 ||
      obj.lines.some((line) => typeof line !== 'string' || line.includes('\n')) ||
      obj.lines.join('').trim().length === 0
    ) {
      throw new RenderValidationError(`Design object ${index} has empty text`);
    }
    if (obj.direction !== 'ltr' && obj.direction !== 'rtl') {
      throw new RenderValidationError(`Design object ${index} has an unresolved direction`);
    }
    if (!HEX_COLOR_PATTERN.test(obj.color)) {
      throw new RenderValidationError(`Design object ${index} has an invalid color`);
    }
    if (!Number.isFinite(obj.fontSize) || obj.fontSize <= 0) {
      throw new RenderValidationError(`Design object ${index} has an invalid font size`);
    }
    if (obj.outline) {
      if (
        !HEX_COLOR_PATTERN.test(obj.outline.color) ||
        !Number.isFinite(obj.outline.width) ||
        obj.outline.width < OUTLINE_WIDTH_MIN ||
        obj.outline.width > OUTLINE_WIDTH_MAX
      ) {
        throw new RenderValidationError(`Design object ${index} has an invalid outline`);
      }
    }
    if (obj.shadow) {
      if (
        !HEX_COLOR_PATTERN.test(obj.shadow.color) ||
        !Number.isFinite(obj.shadow.offsetX) ||
        !Number.isFinite(obj.shadow.offsetY) ||
        Math.abs(obj.shadow.offsetX) > SHADOW_OFFSET_MAX ||
        Math.abs(obj.shadow.offsetY) > SHADOW_OFFSET_MAX
      ) {
        throw new RenderValidationError(`Design object ${index} has an invalid shadow`);
      }
    }
    if (obj.letterSpacing !== undefined) {
      if (
        !Number.isFinite(obj.letterSpacing) ||
        obj.letterSpacing < LETTER_SPACING_MIN ||
        obj.letterSpacing > LETTER_SPACING_MAX
      ) {
        throw new RenderValidationError(`Design object ${index} has an invalid letter spacing`);
      }
    }
    if (obj.arc !== undefined) {
      if (
        !Number.isFinite(obj.arc) ||
        obj.arc === 0 ||
        obj.arc < ARC_SWEEP_MIN ||
        obj.arc > ARC_SWEEP_MAX
      ) {
        throw new RenderValidationError(`Design object ${index} has an invalid arc`);
      }
      if (obj.lines.length !== 1 || obj.direction !== 'ltr' || obj.outline || obj.shadow) {
        throw new RenderValidationError(
          `Design object ${index} combines arc with an unsupported option`,
        );
      }
    }
  }
}

/** Loads a canvas-sized RGBA buffer from a template asset path (base, overlay, mask). */
async function loadCanvasSizedImage(path: string, width: number, height: number): Promise<Buffer> {
  return sharp(path, { limitInputPixels: MAX_INPUT_PIXELS })
    .resize(width, height, { fit: 'fill' })
    .ensureAlpha()
    .png()
    .toBuffer();
}

/**
 * Compose a 2D product mockup PNG:
 * base image (resized to canvas) -> design objects (image or text, resized, rotated,
 * positioned, optionally clipped to the garment mask) -> overlay (blend mode per
 * template; multiply re-applies photographic shadows over the ink).
 *
 * Throws RenderValidationError when an object lies outside the print area; the renderer refuses
 * to draw unvalidated geometry even if a caller forgot to validate.
 */
export async function renderMockup(options: RenderMockupOptions): Promise<Buffer> {
  const { canvasWidth, canvasHeight, printArea, objects } = options;
  const overlayBlend = options.overlayBlend ?? 'over';

  if (!Number.isInteger(canvasWidth) || !Number.isInteger(canvasHeight) || canvasWidth <= 0 || canvasHeight <= 0) {
    throw new RenderValidationError('Canvas dimensions must be positive integers');
  }
  if (!OVERLAY_BLENDS.includes(overlayBlend)) {
    throw new RenderValidationError(`Unknown overlay blend "${String(overlayBlend)}"`);
  }
  if (objects.length === 0) {
    throw new RenderValidationError('Design has no objects to render');
  }
  for (const [index, obj] of objects.entries()) {
    assertRenderableObject(obj, index, printArea);
  }

  const base = sharp(options.baseImagePath, { limitInputPixels: MAX_INPUT_PIXELS })
    .resize(canvasWidth, canvasHeight, { fit: 'fill' })
    .ensureAlpha();

  const designLayers: sharp.OverlayOptions[] = [];

  for (const obj of objects) {
    const prepared =
      obj.type === 'text'
        ? await prepareTextLayer(obj)
        : obj.pattern
          ? await preparePatternLayer(obj, printArea)
          : await prepareImageLayer(obj);
    designLayers.push({ input: prepared.input, left: prepared.left, top: prepared.top });
  }

  const layers: sharp.OverlayOptions[] = [];

  if (options.maskImagePath) {
    // Flatten the design onto a transparent canvas-sized sheet, then keep only the
    // pixels where the mask is opaque (dest-in). One masked sheet replaces the
    // individual layers; their relative stacking is already baked in.
    const mask = await loadCanvasSizedImage(options.maskImagePath, canvasWidth, canvasHeight);
    const sheet = await sharp({
      create: { width: canvasWidth, height: canvasHeight, channels: 4, background: TRANSPARENT },
    })
      .composite([...designLayers, { input: mask, left: 0, top: 0, blend: 'dest-in' }])
      .png()
      .toBuffer();
    layers.push({ input: sheet, left: 0, top: 0 });
  } else {
    layers.push(...designLayers);
  }

  if (options.overlayImagePath) {
    const overlay = await loadCanvasSizedImage(options.overlayImagePath, canvasWidth, canvasHeight);
    layers.push({ input: overlay, left: 0, top: 0, blend: overlayBlend });
  }

  return base.composite(layers).png().toBuffer();
}
