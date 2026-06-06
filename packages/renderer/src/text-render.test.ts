import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderMockup, RenderValidationError, UnknownFontError, type RenderTextObject } from './index';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Gray flat base so colored text pixels are unambiguous. */
const BASE_GRAY = 230;

let dir: string;
let basePath: string;
let logoPath: string;

const printArea = { x: 100, y: 100, width: 200, height: 200 };

const textObject = (overrides: Partial<RenderTextObject> = {}): RenderTextObject => ({
  type: 'text',
  text: 'FoloPrint',
  fontFamily: 'inter',
  fontSize: 40,
  color: '#cc0033',
  align: 'center',
  x: 200,
  y: 200,
  width: 160,
  height: 60,
  rotation: 0,
  ...overrides,
});

/** Counts pixels inside a region that are clearly the text color (red, not gray base). */
async function countRedPixels(
  png: Buffer,
  region: { left: number; top: number; width: number; height: number },
): Promise<number> {
  const { data, info } = await sharp(png).extract(region).raw().toBuffer({ resolveWithObject: true });
  let count = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i]!;
    const g = data[i + 1]!;
    if (r > 150 && g < 100) count++;
  }
  return count;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'foloprint-text-render-'));

  basePath = join(dir, 'base.png');
  await writeFile(
    basePath,
    await sharp({
      create: {
        width: 400,
        height: 400,
        channels: 4,
        background: { r: BASE_GRAY, g: BASE_GRAY, b: BASE_GRAY, alpha: 1 },
      },
    })
      .png()
      .toBuffer(),
  );

  logoPath = join(dir, 'logo.png');
  await writeFile(
    logoPath,
    await sharp({
      create: { width: 120, height: 120, channels: 4, background: { r: 30, g: 30, b: 200, alpha: 1 } },
    })
      .png()
      .toBuffer(),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('renderMockup with text objects', () => {
  it('renders text as a valid PNG at canvas size with colored glyph pixels in the box', async () => {
    const buffer = await renderMockup({
      baseImagePath: basePath,
      canvasWidth: 400,
      canvasHeight: 400,
      printArea,
      objects: [textObject()],
    });

    expect(buffer.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);

    const meta = await sharp(buffer).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(400);

    // The text box is centered at (200,200), 160x60 -> 120..280 x 170..230.
    const inside = await countRedPixels(buffer, { left: 120, top: 170, width: 160, height: 60 });
    expect(inside).toBeGreaterThan(50); // real glyph coverage, not noise
  });

  it('fits the text into exactly the stored box (no pixels outside it)', async () => {
    const buffer = await renderMockup({
      baseImagePath: basePath,
      canvasWidth: 400,
      canvasHeight: 400,
      printArea,
      objects: [textObject()],
    });

    // Strips just outside the box (5px margin against antialias rounding) stay base-gray.
    const above = await countRedPixels(buffer, { left: 110, top: 155, width: 180, height: 10 });
    const below = await countRedPixels(buffer, { left: 110, top: 235, width: 180, height: 10 });
    const left = await countRedPixels(buffer, { left: 105, top: 160, width: 10, height: 80 });
    const right = await countRedPixels(buffer, { left: 285, top: 160, width: 10, height: 80 });
    expect(above + below + left + right).toBe(0);
  });

  it('renders multi-line text with explicit line breaks', async () => {
    const buffer = await renderMockup({
      baseImagePath: basePath,
      canvasWidth: 400,
      canvasHeight: 400,
      printArea,
      objects: [textObject({ text: 'Line one\nLine two', height: 100, y: 200 })],
    });
    // Box 160x100 centered at (200,200): both halves carry glyphs.
    const topHalf = await countRedPixels(buffer, { left: 120, top: 150, width: 160, height: 50 });
    const bottomHalf = await countRedPixels(buffer, { left: 120, top: 200, width: 160, height: 50 });
    expect(topHalf).toBeGreaterThan(20);
    expect(bottomHalf).toBeGreaterThan(20);
  });

  it('renders rotated text inside the print area', async () => {
    const buffer = await renderMockup({
      baseImagePath: basePath,
      canvasWidth: 400,
      canvasHeight: 400,
      printArea,
      objects: [textObject({ rotation: 30, width: 120, height: 50 })],
    });
    const meta = await sharp(buffer).metadata();
    expect(meta.width).toBe(400);
    const around = await countRedPixels(buffer, { left: 120, top: 120, width: 160, height: 160 });
    expect(around).toBeGreaterThan(50);
  });

  it('composites image and text objects together', async () => {
    const buffer = await renderMockup({
      baseImagePath: basePath,
      canvasWidth: 400,
      canvasHeight: 400,
      printArea,
      objects: [
        { type: 'image', imagePath: logoPath, x: 150, y: 150, width: 80, height: 80, rotation: 0 },
        textObject({ x: 200, y: 250, width: 140, height: 40 }),
      ],
    });
    // Blue logo region and red text region both present.
    const { data } = await sharp(buffer)
      .extract({ left: 150, top: 150, width: 1, height: 1 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(data[2]).toBeGreaterThan(150); // blue channel of the logo
    const red = await countRedPixels(buffer, { left: 130, top: 230, width: 140, height: 40 });
    expect(red).toBeGreaterThan(20);
  });

  it('rejects a font key outside the whitelist', async () => {
    await expect(
      renderMockup({
        baseImagePath: basePath,
        canvasWidth: 400,
        canvasHeight: 400,
        printArea,
        objects: [textObject({ fontFamily: 'comic-sans' })],
      }),
    ).rejects.toThrow(UnknownFontError);
  });

  it('rejects empty text', async () => {
    await expect(
      renderMockup({
        baseImagePath: basePath,
        canvasWidth: 400,
        canvasHeight: 400,
        printArea,
        objects: [textObject({ text: '   ' })],
      }),
    ).rejects.toThrow(RenderValidationError);
  });

  it('rejects text outside the print area', async () => {
    await expect(
      renderMockup({
        baseImagePath: basePath,
        canvasWidth: 400,
        canvasHeight: 400,
        printArea,
        objects: [textObject({ x: 350, y: 350 })],
      }),
    ).rejects.toThrow(RenderValidationError);
  });

  it('renders every whitelisted font', async () => {
    for (const key of ['inter', 'oswald', 'playfair', 'roboto-slab', 'caveat']) {
      const buffer = await renderMockup({
        baseImagePath: basePath,
        canvasWidth: 400,
        canvasHeight: 400,
        printArea,
        objects: [textObject({ fontFamily: key })],
      });
      const inside = await countRedPixels(buffer, { left: 120, top: 170, width: 160, height: 60 });
      expect(inside, `font ${key} drew no glyph pixels`).toBeGreaterThan(30);
    }
  });
});
