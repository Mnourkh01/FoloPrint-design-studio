import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderMockup, renderPrintFile, RenderValidationError, type RenderShapeObject } from './index';

let dir: string;
let basePath: string;

const printArea = { x: 100, y: 100, width: 200, height: 200 };

/** RGBA of one pixel of a rendered PNG. */
const pixelAt = async (buffer: Buffer, x: number, y: number): Promise<number[]> => {
  const { data } = await sharp(buffer)
    .extract({ left: x, top: y, width: 1, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return [data[0]!, data[1]!, data[2]!, data[3]!];
};

const shape = (overrides: Partial<RenderShapeObject> = {}): RenderShapeObject => ({
  type: 'shape',
  shape: 'rect',
  fill: '#cf3f22', // red-orange (207, 63, 34)
  x: 200,
  y: 200,
  width: 100,
  height: 100,
  rotation: 0,
  ...overrides,
});

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'foloprint-shapes-'));
  basePath = join(dir, 'base.png');
  await writeFile(
    basePath,
    await sharp({
      create: { width: 400, height: 400, channels: 4, background: { r: 230, g: 230, b: 230, alpha: 1 } },
    })
      .png()
      .toBuffer(),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('renderMockup with shapes', () => {
  it('fills a rect with its fill color', async () => {
    const buffer = await renderMockup({
      baseImagePath: basePath,
      canvasWidth: 400,
      canvasHeight: 400,
      printArea,
      objects: [shape({ shape: 'rect' })],
    });
    const meta = await sharp(buffer).metadata();
    expect(meta.width).toBe(400);

    const [r, g, b] = await pixelAt(buffer, 200, 200);
    expect(r).toBeGreaterThan(150); // red-orange fill, clearly not the gray base
    expect(g).toBeLessThan(130);
    expect(b!).toBeLessThan(110);
  });

  it('leaves the box corners empty for a circle (ellipse silhouette)', async () => {
    const buffer = await renderMockup({
      baseImagePath: basePath,
      canvasWidth: 400,
      canvasHeight: 400,
      printArea,
      objects: [shape({ shape: 'circle' })],
    });
    // Center is filled, a box corner well outside the ellipse stays the gray base.
    const [cr, cg] = await pixelAt(buffer, 200, 200);
    expect(cr).toBeGreaterThan(150);
    expect(cg).toBeLessThan(130);
    const [corner] = await pixelAt(buffer, 156, 156); // dist from center > rx
    expect(corner).toBeGreaterThan(200); // still the gray base
  });

  it('fills a star at its center', async () => {
    const buffer = await renderMockup({
      baseImagePath: basePath,
      canvasWidth: 400,
      canvasHeight: 400,
      printArea,
      objects: [shape({ shape: 'star' })],
    });
    const [r, g] = await pixelAt(buffer, 200, 200);
    expect(r).toBeGreaterThan(150);
    expect(g).toBeLessThan(130);
  });

  it('paints a stroke band around the fill', async () => {
    const buffer = await renderMockup({
      baseImagePath: basePath,
      canvasWidth: 400,
      canvasHeight: 400,
      printArea,
      // Blue fill (34,51,204), yellow stroke (255,204,0), 12px wide.
      objects: [shape({ shape: 'rect', fill: '#2233cc', stroke: { color: '#ffcc00', width: 12 } })],
    });
    // 4px in from the box's left edge sits inside the stroke band: yellow.
    const [sr, sg, sb] = await pixelAt(buffer, 154, 200);
    expect(sr).toBeGreaterThan(180);
    expect(sg).toBeGreaterThan(140);
    expect(sb!).toBeLessThan(120);
    // Center is the blue fill.
    const [cr, cg, cb] = await pixelAt(buffer, 200, 200);
    expect(cb).toBeGreaterThan(140);
    expect(cr).toBeLessThan(120);
    expect(cg!).toBeLessThan(120);
  });

  it('rejects an invalid shape fill', async () => {
    await expect(
      renderMockup({
        baseImagePath: basePath,
        canvasWidth: 400,
        canvasHeight: 400,
        printArea,
        objects: [shape({ fill: 'red' as string })],
      }),
    ).rejects.toThrow(RenderValidationError);
  });

  it('rejects an unknown shape kind', async () => {
    await expect(
      renderMockup({
        baseImagePath: basePath,
        canvasWidth: 400,
        canvasHeight: 400,
        printArea,
        objects: [shape({ shape: 'triangle' as RenderShapeObject['shape'] })],
      }),
    ).rejects.toThrow(RenderValidationError);
  });
});

describe('renderPrintFile with shapes', () => {
  it('renders the shape alone at print scale on a transparent sheet', async () => {
    const buffer = await renderPrintFile({
      printArea,
      objects: [shape({ shape: 'rect' })],
      scale: 2,
      dpi: 300,
    });
    const meta = await sharp(buffer).metadata();
    expect(meta.width).toBe(400); // 200 area px * 2
    expect(meta.height).toBe(400);
    expect(meta.density).toBe(300);

    // The shape center maps to (200-100)*2 = 200 in print space; opaque fill there.
    const [r, g, , a] = await pixelAt(buffer, 200, 200);
    expect(a).toBeGreaterThan(200);
    expect(r).toBeGreaterThan(150);
    expect(g).toBeLessThan(130);
    // A sheet corner is transparent (no garment, ink only).
    const [, , , cornerAlpha] = await pixelAt(buffer, 5, 5);
    expect(cornerAlpha).toBe(0);
  });
});
