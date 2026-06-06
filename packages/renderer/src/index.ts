import sharp from 'sharp';
import { isObjectInsideRect, type Rect } from '@foloprint/shared';

/** Defensive cap against pixel bombs reaching libvips. */
const MAX_INPUT_PIXELS = 50_000_000;

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 } as const;

export interface RenderObject {
  /** Absolute path to the (already validated) asset image on disk. */
  imagePath: string;
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

export interface RenderMockupOptions {
  /** Absolute path to the template base image. */
  baseImagePath: string;
  /** Absolute path to an overlay image composited above the artwork (shadows, fabric sheen). */
  overlayImagePath?: string | null;
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

/**
 * Resize the asset to the object's target size, rotate it around its center on a transparent
 * background, and compute the top-left placement so the rotation pivot stays at (x, y).
 *
 * Two separate sharp pipelines on purpose: sharp applies rotate before resize within a single
 * pipeline regardless of call order, which would distort the result.
 */
async function prepareObjectLayer(obj: RenderObject): Promise<PreparedLayer> {
  const resized = await sharp(obj.imagePath, { limitInputPixels: MAX_INPUT_PIXELS })
    .resize(Math.round(obj.width), Math.round(obj.height), { fit: 'fill' })
    .ensureAlpha()
    .png()
    .toBuffer();

  let layer = resized;
  if (obj.rotation % 360 !== 0) {
    layer = await sharp(resized)
      .rotate(obj.rotation, { background: TRANSPARENT })
      .png()
      .toBuffer();
  }

  // The rotated buffer is the bounding box of the rotated rect; its center is the object's center.
  const meta = await sharp(layer).metadata();
  const layerWidth = meta.width ?? Math.round(obj.width);
  const layerHeight = meta.height ?? Math.round(obj.height);

  return {
    input: layer,
    left: Math.round(obj.x - layerWidth / 2),
    top: Math.round(obj.y - layerHeight / 2),
  };
}

/**
 * Compose a 2D product mockup PNG:
 * base image (resized to canvas) -> design objects (resized, rotated, positioned) -> overlay.
 *
 * Throws RenderValidationError when an object lies outside the print area; the renderer refuses
 * to draw unvalidated geometry even if a caller forgot to validate.
 */
export async function renderMockup(options: RenderMockupOptions): Promise<Buffer> {
  const { canvasWidth, canvasHeight, printArea, objects } = options;

  if (!Number.isInteger(canvasWidth) || !Number.isInteger(canvasHeight) || canvasWidth <= 0 || canvasHeight <= 0) {
    throw new RenderValidationError('Canvas dimensions must be positive integers');
  }
  if (objects.length === 0) {
    throw new RenderValidationError('Design has no objects to render');
  }
  for (const [index, obj] of objects.entries()) {
    if (!isObjectInsideRect(obj, printArea)) {
      throw new RenderValidationError(`Design object ${index} is outside the print area`);
    }
  }

  const base = sharp(options.baseImagePath, { limitInputPixels: MAX_INPUT_PIXELS })
    .resize(canvasWidth, canvasHeight, { fit: 'fill' })
    .ensureAlpha();

  const layers: sharp.OverlayOptions[] = [];

  for (const obj of objects) {
    const prepared = await prepareObjectLayer(obj);
    layers.push({ input: prepared.input, left: prepared.left, top: prepared.top });
  }

  if (options.overlayImagePath) {
    const overlay = await sharp(options.overlayImagePath, { limitInputPixels: MAX_INPUT_PIXELS })
      .resize(canvasWidth, canvasHeight, { fit: 'fill' })
      .ensureAlpha()
      .png()
      .toBuffer();
    layers.push({ input: overlay, left: 0, top: 0 });
  }

  return base.composite(layers).png().toBuffer();
}
