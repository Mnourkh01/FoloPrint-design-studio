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
  SHAPE_KINDS,
  SHAPE_STROKE_WIDTH_MAX,
  SHAPE_STROKE_WIDTH_MIN,
  starPolygonPoints,
  type ImagePattern,
  type OverlayBlend,
  type Rect,
  type ShapeKind,
  type ShapeStroke,
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
export { recolorGarment, type RecolorGarmentOptions } from './recolor-garment';

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

export interface RenderShapeObject extends RenderObjectGeometry {
  type: 'shape';
  /** Silhouette: rect, circle (ellipse in a non-square box), or star. */
  shape: ShapeKind;
  /** Fill color, #RRGGBB. */
  fill: string;
  /**
   * Outline stroke (v2.7). Painted centered on the shape edge; the silhouette is
   * inset by width/2 so the stroke's outer edge aligns to the stored box, the same
   * edge-inclusive convention text outline uses.
   */
  stroke?: ShapeStroke;
}

export type RenderObject = RenderImageObject | RenderTextObject | RenderShapeObject;

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

/**
 * SVG for one vector shape (v2.7) sized exactly to the stored box. The silhouette
 * is inset by stroke/2 so the stroke's outer edge aligns to the box edge (the same
 * edge-inclusive convention text outline uses). Only validated hex colors and our
 * own computed numbers ever enter the markup, so there is no injection surface;
 * the star vertices come from the SHARED starPolygonPoints so editor and server
 * draw the identical silhouette.
 */
function buildShapeSvg(
  shape: ShapeKind,
  width: number,
  height: number,
  fill: string,
  stroke: ShapeStroke | undefined,
): string {
  const sw = stroke ? Math.max(0, Math.min(stroke.width, Math.min(width, height) - 1)) : 0;
  const half = sw / 2;
  const innerW = width - sw;
  const innerH = height - sw;
  const strokeAttrs = sw > 0 ? ` stroke="${stroke!.color}" stroke-width="${sw.toFixed(2)}"` : '';
  const f = (n: number): string => n.toFixed(2);

  let body: string;
  if (shape === 'rect') {
    body = `<rect x="${f(half)}" y="${f(half)}" width="${f(innerW)}" height="${f(
      innerH,
    )}" fill="${fill}"${strokeAttrs} />`;
  } else if (shape === 'circle') {
    body = `<ellipse cx="${f(width / 2)}" cy="${f(height / 2)}" rx="${f(innerW / 2)}" ry="${f(
      innerH / 2,
    )}" fill="${fill}"${strokeAttrs} />`;
  } else {
    const points = starPolygonPoints(innerW, innerH)
      .map((p) => `${f(p.x + half)},${f(p.y + half)}`)
      .join(' ');
    body = `<polygon points="${points}" fill="${fill}"${strokeAttrs} stroke-linejoin="round" />`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}

/**
 * Rasterize a vector shape with sharp's SVG path, then rotate and position. The
 * SVG is already box-sized so no fit-to-box step is needed; from the sized RGBA
 * buffer onward it joins the shared finalizeLayer pipeline like every other layer.
 */
async function prepareShapeLayer(obj: RenderShapeObject): Promise<PreparedLayer> {
  const width = Math.max(1, Math.round(obj.width));
  const height = Math.max(1, Math.round(obj.height));
  const svg = buildShapeSvg(obj.shape, width, height, obj.fill, obj.stroke);
  const raster = await sharp(Buffer.from(svg)).ensureAlpha().png().toBuffer();
  return finalizeLayer(raster, obj);
}

/** Per-object sanity checks the renderer enforces even if a caller forgot to validate. */
function assertRenderableObject(obj: RenderObject, index: number, printArea: Rect): void {
  if (!isObjectInsideRect(obj, printArea)) {
    throw new RenderValidationError(`Design object ${index} is outside the print area`);
  }
  if (obj.type === 'image' && obj.pattern) {
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
  if (obj.type === 'shape') {
    if (!SHAPE_KINDS.includes(obj.shape)) {
      throw new RenderValidationError(`Design object ${index} has an unknown shape`);
    }
    if (!HEX_COLOR_PATTERN.test(obj.fill)) {
      throw new RenderValidationError(`Design object ${index} has an invalid shape fill`);
    }
    if (obj.stroke) {
      if (
        !HEX_COLOR_PATTERN.test(obj.stroke.color) ||
        !Number.isFinite(obj.stroke.width) ||
        obj.stroke.width < SHAPE_STROKE_WIDTH_MIN ||
        obj.stroke.width > SHAPE_STROKE_WIDTH_MAX
      ) {
        throw new RenderValidationError(`Design object ${index} has an invalid shape stroke`);
      }
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
 * Fabric realism (v2.4). DARKEN is how hard broad folds/shadows multiply into
 * the ink, FLOOR caps the deepest darkening (a crease never blacks the ink
 * out), GAMMA shapes the falloff. LIFT screens local fold RIDGES back toward
 * the fabric highlight so dark ink shows light streaks where the cloth catches
 * light (multiply alone can only darken, which leaves black print looking
 * pasted on a pale garment). RIDGE_GAIN maps the high-pass detail into that
 * lift, capped by LIFT. Tuned so a flat print reads as "in the cloth" without
 * looking dirty or washed.
 */
const LIGHTMAP_DARKEN = 0.6;
const LIGHTMAP_FLOOR = 0.42;
const LIGHTMAP_GAMMA = 1.15;
const LIGHTMAP_LIFT = 0.4;
const LIGHTMAP_RIDGE_GAIN = 3.5;
const LIGHTMAP_BLUR_R = 10;

/** Per-pixel ink shading: a multiply factor (folds darken) plus a screen factor
 * (ridges lift toward white). Both 0..1; the caller does ink*mul then lifts the
 * result toward 255 by lift. Derived from the base garment luminance normalized
 * to its own highlight, so it works on any garment color. */
interface InkLightMap {
  mul: Float32Array;
  lift: Float32Array;
}

function buildInkLightMap(
  baseRaw: Buffer,
  maskRaw: Buffer | null,
  w: number,
  h: number,
): InkLightMap {
  const n = w * h;
  const luma = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    luma[i] = 0.2126 * baseRaw[i * 4]! + 0.7152 * baseRaw[i * 4 + 1]! + 0.0722 * baseRaw[i * 4 + 2]!;
  }

  // Highlight reference: 97th percentile luma over the garment (mask if present,
  // else the whole image), the same definition the recolor/overlay use.
  const samples: number[] = [];
  for (let i = 0; i < n; i += 7) {
    if (!maskRaw || maskRaw[i * 4 + 3]! > 200) samples.push(luma[i]!);
  }
  samples.sort((a, b) => a - b);
  const whitePoint = Math.max(1, samples[Math.floor(samples.length * 0.97)] ?? 255);

  // Low-frequency shading (broad folds) vs the high-pass (sharp ridges/weave).
  const lf = boxBlurGray(luma, w, h, LIGHTMAP_BLUR_R);

  const mul = new Float32Array(n);
  const lift = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const vLow = Math.min(1, lf[i]! / whitePoint);
    const shade = LIGHTMAP_FLOOR + (1 - LIGHTMAP_FLOOR) * Math.pow(vLow, LIGHTMAP_GAMMA);
    const hp = (luma[i]! - lf[i]!) / whitePoint; // local ridge (+) / valley (-)
    // Broad folds darken; local valleys add a touch more darkening.
    mul[i] = (1 - LIGHTMAP_DARKEN * (1 - shade)) * (1 + Math.min(0, hp) * LIGHTMAP_RIDGE_GAIN * 0.5);
    // Local ridges lift the ink toward the fabric highlight.
    lift[i] = Math.max(0, Math.min(LIGHTMAP_LIFT, hp * LIGHTMAP_RIDGE_GAIN * LIGHTMAP_LIFT));
  }
  return { mul, lift };
}

/** Separable box blur over a single-channel float field; used for the grain high-pass. */
function boxBlurGray(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const win = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[y * w + Math.max(0, Math.min(w - 1, x))]!;
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / win;
      const add = src[y * w + Math.min(w - 1, x + r + 1)]!;
      const sub = src[y * w + Math.max(0, x - r)]!;
      sum += add - sub;
    }
  }
  const dst = new Float32Array(w * h);
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.max(0, Math.min(h - 1, y)) * w + x]!;
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum / win;
      const add = tmp[Math.min(h - 1, y + r + 1) * w + x]!;
      const sub = tmp[Math.max(0, y - r) * w + x]!;
      sum += add - sub;
    }
  }
  return dst;
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

  // Materialize the base once: needed both as the luminance source for the
  // fabric light-map and as the composite background.
  const baseRaw = await sharp(options.baseImagePath, { limitInputPixels: MAX_INPUT_PIXELS })
    .resize(canvasWidth, canvasHeight, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer();

  const designLayers: sharp.OverlayOptions[] = [];

  for (const obj of objects) {
    const prepared =
      obj.type === 'text'
        ? await prepareTextLayer(obj)
        : obj.type === 'shape'
          ? await prepareShapeLayer(obj)
          : obj.pattern
            ? await preparePatternLayer(obj, printArea)
            : await prepareImageLayer(obj);
    designLayers.push({ input: prepared.input, left: prepared.left, top: prepared.top });
  }

  // Flatten the design onto a transparent canvas-sized sheet so the ink can be
  // shaded as one layer (its relative stacking is already baked in).
  const sheetRaw = await sharp({
    create: { width: canvasWidth, height: canvasHeight, channels: 4, background: TRANSPARENT },
  })
    .composite(designLayers)
    .raw()
    .toBuffer();

  // Fabric realism: multiply the garment's own folds/shadows into the ink so the
  // print sits in the cloth instead of floating on top. Alpha is left untouched
  // (transparent stays transparent), so this only ever touches placed ink.
  const maskRaw = options.maskImagePath
    ? await sharp(options.maskImagePath, { limitInputPixels: MAX_INPUT_PIXELS })
        .resize(canvasWidth, canvasHeight, { fit: 'fill' })
        .ensureAlpha()
        .raw()
        .toBuffer()
    : null;
  const { mul, lift } = buildInkLightMap(baseRaw, maskRaw, canvasWidth, canvasHeight);
  for (let i = 0; i < canvasWidth * canvasHeight; i++) {
    if (sheetRaw[i * 4 + 3] === 0) continue; // no ink here
    const m = mul[i]!;
    const l = lift[i]!;
    for (let c = 0; c < 3; c++) {
      const darkened = sheetRaw[i * 4 + c]! * m;
      sheetRaw[i * 4 + c] = Math.max(0, Math.min(255, Math.round(darkened + (255 - darkened) * l)));
    }
  }

  // Sub-pixel feather: real ink bleeds a hair into the weave, so the razor-crisp
  // vector edge is the strongest "sticker" tell. A 0.6px blur softens the glyph/
  // image edge into the fabric without visibly softening the artwork itself.
  let sheet = await sharp(sheetRaw, { raw: { width: canvasWidth, height: canvasHeight, channels: 4 } })
    .blur(0.6)
    .png()
    .toBuffer();

  // Clip the shaded ink to the garment silhouette (photo templates) so artwork
  // near an edge never bleeds onto the backdrop.
  if (options.maskImagePath) {
    const mask = await loadCanvasSizedImage(options.maskImagePath, canvasWidth, canvasHeight);
    sheet = await sharp(sheet)
      .composite([{ input: mask, left: 0, top: 0, blend: 'dest-in' }])
      .png()
      .toBuffer();
  }

  const layers: sharp.OverlayOptions[] = [{ input: sheet, left: 0, top: 0 }];

  if (options.overlayImagePath) {
    const overlay = await loadCanvasSizedImage(options.overlayImagePath, canvasWidth, canvasHeight);
    layers.push({ input: overlay, left: 0, top: 0, blend: overlayBlend });
  }

  return sharp(baseRaw, { raw: { width: canvasWidth, height: canvasHeight, channels: 4 } })
    .composite(layers)
    .png()
    .toBuffer();
}

export interface RenderPrintFileOptions {
  /** Print area in canvas px; every object must be fully inside it. */
  printArea: Rect;
  objects: RenderObject[];
  /** Output scale in print px per canvas px (e.g. 300dpi / canvas ppi). */
  scale: number;
  /** PNG density metadata in dots per inch; defaults to 300. */
  dpi?: number;
}

/**
 * Maps one render object from canvas space into print-file space: translated to
 * the print-area origin and uniformly scaled. Pixel-valued text attributes
 * (fontSize, letterSpacing, outline width, shadow offsets, pattern spacing)
 * scale with the geometry so the artwork keeps its exact proportions; angles
 * (rotation, arc sweep) are scale-invariant. Validation ALWAYS runs against the
 * original canvas-space values; scaled values intentionally exceed the stored
 * contract ranges.
 */
function scaleRenderObject(obj: RenderObject, printArea: Rect, scale: number): RenderObject {
  const base = {
    x: (obj.x - printArea.x) * scale,
    y: (obj.y - printArea.y) * scale,
    width: obj.width * scale,
    height: obj.height * scale,
    rotation: obj.rotation,
  };
  if (obj.type === 'text') {
    return {
      ...obj,
      ...base,
      fontSize: obj.fontSize * scale,
      ...(obj.letterSpacing !== undefined ? { letterSpacing: obj.letterSpacing * scale } : {}),
      ...(obj.outline ? { outline: { ...obj.outline, width: obj.outline.width * scale } } : {}),
      ...(obj.shadow
        ? {
            shadow: {
              ...obj.shadow,
              offsetX: obj.shadow.offsetX * scale,
              offsetY: obj.shadow.offsetY * scale,
            },
          }
        : {}),
    };
  }
  if (obj.type === 'shape') {
    return {
      ...obj,
      ...base,
      ...(obj.stroke ? { stroke: { ...obj.stroke, width: obj.stroke.width * scale } } : {}),
    };
  }
  return {
    ...obj,
    ...base,
    ...(obj.pattern ? { pattern: { ...obj.pattern, spacing: obj.pattern.spacing * scale } } : {}),
  };
}

/**
 * Compose the production print file for ONE print area: the design ink alone on
 * a transparent sheet at print resolution (no garment photo, no mask clipping,
 * no overlay). The sheet covers exactly the print area; geometry is validated
 * in canvas space (the stored contract), then uniformly scaled so Pango text
 * re-rasters crisp at print size and images resample from their source once.
 * The PNG carries its physical density so print software reads the real size.
 */
export async function renderPrintFile(options: RenderPrintFileOptions): Promise<Buffer> {
  const { printArea, objects, scale } = options;
  const dpi = options.dpi ?? 300;

  if (!Number.isFinite(scale) || scale <= 0) {
    throw new RenderValidationError('Print scale must be a positive number');
  }
  if (!Number.isFinite(dpi) || dpi <= 0) {
    throw new RenderValidationError('Print dpi must be a positive number');
  }
  if (objects.length === 0) {
    throw new RenderValidationError('Design has no objects to render');
  }
  for (const [index, obj] of objects.entries()) {
    assertRenderableObject(obj, index, printArea);
  }

  const sheetWidth = Math.max(1, Math.round(printArea.width * scale));
  const sheetHeight = Math.max(1, Math.round(printArea.height * scale));
  const printSpaceArea: Rect = { x: 0, y: 0, width: sheetWidth, height: sheetHeight };

  // Shadow pixels may extend past the stored box (by contract) and a rotated
  // layer's bounding buffer can round a pixel past the area edge; sharp rejects
  // negative composite offsets, so compose on a margin-padded sheet and extract
  // the exact area rect (the preparePatternLayer trick).
  const margin = Math.ceil((SHADOW_OFFSET_MAX + 5) * scale);

  const designLayers: sharp.OverlayOptions[] = [];
  for (const original of objects) {
    const obj = scaleRenderObject(original, printArea, scale);
    const prepared =
      obj.type === 'text'
        ? await prepareTextLayer(obj)
        : obj.type === 'shape'
          ? await prepareShapeLayer(obj)
          : obj.pattern
            ? await preparePatternLayer(obj, printSpaceArea)
            : await prepareImageLayer(obj);
    designLayers.push({ input: prepared.input, left: prepared.left + margin, top: prepared.top + margin });
  }

  const padded = await sharp({
    create: {
      width: sheetWidth + 2 * margin,
      height: sheetHeight + 2 * margin,
      channels: 4,
      background: TRANSPARENT,
    },
  })
    .composite(designLayers)
    .png()
    .toBuffer();

  return sharp(padded)
    .extract({ left: margin, top: margin, width: sheetWidth, height: sheetHeight })
    .withMetadata({ density: dpi })
    .png()
    .toBuffer();
}
