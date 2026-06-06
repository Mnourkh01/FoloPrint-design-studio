import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  renderMockup,
  RenderValidationError,
  resolveFont,
  UnknownFontError,
  type RenderTextObject,
} from './index';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Gray flat base so colored text pixels are unambiguous. */
const BASE_GRAY = 230;

let dir: string;
let basePath: string;
let logoPath: string;

const printArea = { x: 100, y: 100, width: 200, height: 200 };

const textObject = (overrides: Partial<RenderTextObject> = {}): RenderTextObject => ({
  type: 'text',
  lines: ['FoloPrint'],
  fontFamily: 'inter',
  fontSize: 40,
  color: '#cc0033',
  align: 'center',
  direction: 'ltr',
  x: 200,
  y: 200,
  width: 160,
  height: 60,
  rotation: 0,
  ...overrides,
});

/** Natural-size Pango raster of one string with the bundled Arabic font (spike S1 path). */
async function arabicRasterWidth(text: string): Promise<number> {
  const font = resolveFont('noto-naskh-arabic');
  const buf = await sharp({
    text: { text, font: `${font.family} 48`, fontfile: font.filePath, rgba: true, dpi: 72 },
  })
    .png()
    .toBuffer();
  return (await sharp(buf).metadata()).width!;
}

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
      objects: [textObject({ lines: ['Line one', 'Line two'], height: 100, y: 200 })],
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
    for (const lines of [['   '], [], ['ok\nsmuggled']]) {
      await expect(
        renderMockup({
          baseImagePath: basePath,
          canvasWidth: 400,
          canvasHeight: 400,
          printArea,
          objects: [textObject({ lines })],
        }),
      ).rejects.toThrow(RenderValidationError);
    }
  });

  it('rejects an unresolved direction', async () => {
    await expect(
      renderMockup({
        baseImagePath: basePath,
        canvasWidth: 400,
        canvasHeight: 400,
        printArea,
        objects: [textObject({ direction: 'auto' as unknown as 'ltr' })],
      }),
    ).rejects.toThrow(/unresolved direction/);
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
    for (const key of ['inter', 'oswald', 'playfair', 'roboto-slab', 'caveat', 'noto-naskh-arabic']) {
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

describe('renderMockup RTL/Arabic (v1.6)', () => {
  it('shapes Arabic: joined word materially narrower than isolated letters (spike S1)', async () => {
    const joined = await arabicRasterWidth('مرحبا بالعالم');
    const isolated = await arabicRasterWidth('م ر ح ب ا  ب ا ل ع ا ل م');
    expect(joined).toBeLessThan(isolated * 0.8);
  });

  it('direction marks flip mixed-content word order (spike S2)', async () => {
    const render = (direction: 'ltr' | 'rtl') =>
      renderMockup({
        baseImagePath: basePath,
        canvasWidth: 400,
        canvasHeight: 400,
        printArea,
        objects: [
          textObject({
            lines: ['ABC مرحبا'],
            fontFamily: 'noto-naskh-arabic',
            direction,
            width: 180,
            height: 50,
          }),
        ],
      });
    const ltr = await render('ltr');
    const rtl = await render('rtl');
    expect(ltr.equals(rtl)).toBe(false);
  });

  it('renders Arabic text with glyph coverage in the box', async () => {
    const buffer = await renderMockup({
      baseImagePath: basePath,
      canvasWidth: 400,
      canvasHeight: 400,
      printArea,
      objects: [
        textObject({ lines: ['مرحبا بالعالم'], fontFamily: 'noto-naskh-arabic', direction: 'rtl' }),
      ],
    });
    const inside = await countRedPixels(buffer, { left: 120, top: 170, width: 160, height: 60 });
    expect(inside).toBeGreaterThan(50);
  });

  it('align is visual for RTL: left hugs the left edge, right the right edge (pinned)', async () => {
    // Long + short line: the short line's ink position reveals the effective alignment.
    const render = (align: 'left' | 'right') =>
      renderMockup({
        baseImagePath: basePath,
        canvasWidth: 400,
        canvasHeight: 400,
        printArea,
        objects: [
          textObject({
            lines: ['مرحبا بالعالم الواسع', 'قص'],
            fontFamily: 'noto-naskh-arabic',
            direction: 'rtl',
            align,
            width: 180,
            height: 90,
            x: 200,
            y: 200,
          }),
        ],
      });
    // Box: 110..290 x 155..245; bottom half holds the short line.
    const leftAligned = await render('left');
    const rightAligned = await render('right');
    const leftHalf = { left: 110, top: 200, width: 90, height: 45 };
    const rightHalf = { left: 200, top: 200, width: 90, height: 45 };
    // align 'left' => short line ink concentrates in the LEFT half (visual semantics).
    expect(await countRedPixels(leftAligned, leftHalf)).toBeGreaterThan(
      await countRedPixels(leftAligned, rightHalf),
    );
    // align 'right' => mirrored.
    expect(await countRedPixels(rightAligned, rightHalf)).toBeGreaterThan(
      await countRedPixels(rightAligned, leftHalf),
    );
  });

  it('renders wrapped lines verbatim: one band of glyphs per line', async () => {
    const buffer = await renderMockup({
      baseImagePath: basePath,
      canvasWidth: 400,
      canvasHeight: 400,
      printArea,
      objects: [
        textObject({ lines: ['One', 'Two', 'Three'], width: 140, height: 120, x: 200, y: 200 }),
      ],
    });
    // Box: 130..270 x 140..260; each 40px band carries one line's glyphs.
    for (const [i, band] of [140, 180, 220].entries()) {
      const ink = await countRedPixels(buffer, { left: 130, top: band, width: 140, height: 40 });
      expect(ink, `line band ${i} is empty`).toBeGreaterThan(20);
    }
  });
});
