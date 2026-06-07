import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderMockup } from './index';

let dir: string;
let basePath: string;
let maskPath: string;
let inkPath: string;

const W = 400;
const H = 400;
const printArea = { x: 100, y: 100, width: 200, height: 200 };

/** Mean luma of a small patch of the rendered output. */
const patchLuma = async (png: Buffer, left: number, top: number): Promise<number> => {
  const { data, info } = await sharp(png)
    .extract({ left, top, width: 20, height: 20 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const px = info.width * info.height;
  let sum = 0;
  for (let i = 0; i < px; i++) {
    sum += 0.2126 * data[i * 4]! + 0.7152 * data[i * 4 + 1]! + 0.0722 * data[i * 4 + 2]!;
  }
  return sum / px;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'foloprint-realism-'));

  // Base garment with a strong left->right luma gradient (dark left, light right):
  // the "folds" the ink should pick up.
  const baseRaw = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = Math.round(40 + (200 * x) / W);
      const i = (y * W + x) * 4;
      baseRaw[i] = v;
      baseRaw[i + 1] = v;
      baseRaw[i + 2] = v;
      baseRaw[i + 3] = 255;
    }
  }
  basePath = join(dir, 'base.png');
  await writeFile(basePath, await sharp(baseRaw, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer());

  // Full-coverage opaque mask (the whole canvas is garment).
  maskPath = join(dir, 'mask.png');
  await writeFile(
    maskPath,
    await sharp({ create: { width: W, height: H, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
      .png()
      .toBuffer(),
  );

  // A flat mid-gray ink rectangle: uniform before shading, so any horizontal
  // variation in the output comes from the fabric light-map.
  inkPath = join(dir, 'ink.png');
  await writeFile(
    inkPath,
    await sharp({ create: { width: 180, height: 180, channels: 4, background: { r: 128, g: 128, b: 128, alpha: 1 } } })
      .png()
      .toBuffer(),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('fabric realism (renderMockup ink light-map)', () => {
  it('bakes the garment shading into flat ink: darker where the fabric is darker', async () => {
    const png = await renderMockup({
      baseImagePath: basePath,
      maskImagePath: maskPath,
      canvasWidth: W,
      canvasHeight: H,
      printArea,
      objects: [
        { type: 'image', imagePath: inkPath, x: 200, y: 200, width: 180, height: 180, rotation: 0 },
      ],
    });

    // The ink spans the print area; sample its left (dark fabric) vs right (light fabric).
    const left = await patchLuma(png, 120, 195);
    const right = await patchLuma(png, 260, 195);

    // Flat ink would read equal on both sides (delta 0); the light-map makes the
    // left (shadowed fabric) clearly darker than the right (lit fabric).
    expect(right - left).toBeGreaterThan(10);
  });

  it('leaves the bare fabric (no ink) untouched outside the artwork', async () => {
    const png = await renderMockup({
      baseImagePath: basePath,
      maskImagePath: maskPath,
      canvasWidth: W,
      canvasHeight: H,
      printArea,
      objects: [
        { type: 'image', imagePath: inkPath, x: 200, y: 200, width: 120, height: 120, rotation: 0 },
      ],
    });

    // A corner far from the ink equals the base gradient there (light-map only
    // ever touches placed ink; bare fabric is the photo).
    const corner = await patchLuma(png, 10, 10);
    expect(corner).toBeGreaterThan(30);
    expect(corner).toBeLessThan(90); // the dark-left gradient value, unmodified
  });
});
