import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { recolorGarment } from './recolor-garment';

const W = 120;
const H = 120;
/** Garment rect inside the synthetic blank. */
const GARMENT = { left: 20, top: 20, width: 80, height: 80 };

/** Backdrop gray (mid, like the studio photos: clearly darker than lit fabric). */
const BACKDROP = 150;

/**
 * Synthetic white-garment blank: mid-gray backdrop, garment rect with a
 * vertical shading gradient (250 at the top fading to 100 at the bottom,
 * like fabric falling into shadow), plus a 3px bright fabric SLIVER just right
 * of the mask rect (models the shadowed edge the real masks undershoot).
 */
const blank = (): Promise<Buffer> => {
  const raw = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const inGarment =
        x >= GARMENT.left &&
        x < GARMENT.left + GARMENT.width &&
        y >= GARMENT.top &&
        y < GARMENT.top + GARMENT.height;
      const inSliver =
        x >= GARMENT.left + GARMENT.width &&
        x < GARMENT.left + GARMENT.width + 3 &&
        y >= GARMENT.top &&
        y < GARMENT.top + GARMENT.height;
      const v = inGarment
        ? Math.round(250 - (150 * (y - GARMENT.top)) / GARMENT.height)
        : inSliver
          ? 240
          : BACKDROP;
      raw[i] = v;
      raw[i + 1] = v;
      raw[i + 2] = v;
      raw[i + 3] = 255;
    }
  }
  return sharp(raw, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
};

/** Hard-edged garment mask (alpha 255 inside the garment rect, 0 outside). */
const garmentMask = (): Promise<Buffer> => {
  const raw = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const inGarment =
        x >= GARMENT.left &&
        x < GARMENT.left + GARMENT.width &&
        y >= GARMENT.top &&
        y < GARMENT.top + GARMENT.height;
      raw[i] = 255;
      raw[i + 1] = 255;
      raw[i + 2] = 255;
      raw[i + 3] = inGarment ? 255 : 0;
    }
  }
  return sharp(raw, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
};

const rgbAt = async (png: Buffer, x: number, y: number): Promise<[number, number, number]> => {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * 4;
  return [data[i]!, data[i + 1]!, data[i + 2]!];
};

describe('recolorGarment', () => {
  it('tints garment pixels toward the target color and leaves the backdrop untouched', async () => {
    const png = await recolorGarment({ source: await blank(), mask: await garmentMask(), hex: '#1f2a44' });

    // Backdrop corner: byte-identical to the source.
    expect(await rgbAt(png, 5, 5)).toEqual([BACKDROP, BACKDROP, BACKDROP]);

    // Bright fabric (top of garment): near the target navy, blue channel dominant.
    const [r, g, b] = await rgbAt(png, 60, 25);
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(g);
    expect(r).toBeLessThan(80); // nothing like the white source remains
  });

  it('preserves fabric shading: shadowed fabric stays darker than lit fabric', async () => {
    const png = await recolorGarment({ source: await blank(), mask: await garmentMask(), hex: '#b0b7bc' });

    const [topR] = await rgbAt(png, 60, 25); // lit (source 250-ish)
    const [bottomR] = await rgbAt(png, 60, 95); // shadowed (source ~100)
    expect(topR).toBeGreaterThan(bottomR + 20);
  });

  it('keeps fold detail on a near-black target (shade floor + sheen)', async () => {
    const png = await recolorGarment({ source: await blank(), mask: await garmentMask(), hex: '#191a1c' });

    const [topR] = await rgbAt(png, 60, 25);
    const [bottomR] = await rgbAt(png, 60, 95);
    // Dark, but the lit/shadow separation survives (no detail-free silhouette).
    expect(topR).toBeGreaterThan(bottomR);
    expect(topR).toBeLessThan(90); // still reads as a black garment
  });

  it('heather noise speckles the fabric deterministically', async () => {
    const opts = { source: await blank(), mask: await garmentMask(), hex: '#9aa0a6', noise: 0.08 };
    const a = await recolorGarment(opts);
    const b = await recolorGarment(opts);

    // Byte-stable across runs (seed idempotency depends on it).
    expect(a.equals(b)).toBe(true);

    // Same-shade row shows per-pixel variation that the smooth version lacks.
    const smooth = await recolorGarment({ ...opts, noise: 0 });
    const [n1] = await rgbAt(a, 40, 30);
    const [n2] = await rgbAt(a, 41, 30);
    const [s1] = await rgbAt(smooth, 40, 30);
    const [s2] = await rgbAt(smooth, 41, 30);
    expect(s1).toBe(s2); // smooth fabric: neighbors identical on a same-shade row
    expect(n1).not.toBe(n2); // heather: neighbors differ
  });

  it('keeps the target hue exact on saturated colors (no highlight wash)', async () => {
    const png = await recolorGarment({ source: await blank(), mask: await garmentMask(), hex: '#b3202c' });

    // Brightest fabric: strongly red-dominant, not washed toward pink/white.
    const [r, g, b] = await rgbAt(png, 60, 25);
    expect(r).toBeGreaterThan(g * 3);
    expect(r).toBeGreaterThan(b * 3);
  });

  it('tints the bright sliver past the mask edge but never halos the backdrop', async () => {
    const png = await recolorGarment({ source: await blank(), mask: await garmentMask(), hex: '#1f2a44' });

    // The fabric sliver the mask missed: tinted (blue-dominant), not left white.
    const [r, , b] = await rgbAt(png, GARMENT.left + GARMENT.width + 1, 60);
    expect(b).toBeGreaterThan(r);
    expect(b).toBeLessThan(200); // genuinely tinted, nothing like the 240 source
    // Backdrop inside the dilation reach but darker than fabric: untouched.
    expect(await rgbAt(png, GARMENT.left + GARMENT.width + 6, 60)).toEqual([
      BACKDROP,
      BACKDROP,
      BACKDROP,
    ]);
    // Well outside: backdrop byte-identical.
    expect(await rgbAt(png, GARMENT.left + GARMENT.width + 15, 60)).toEqual([
      BACKDROP,
      BACKDROP,
      BACKDROP,
    ]);
  });

  it('rejects a malformed hex color', async () => {
    await expect(
      recolorGarment({ source: await blank(), mask: await garmentMask(), hex: 'navy' }),
    ).rejects.toThrow(/invalid hex color/);
  });

  it('rejects a mask whose dimensions do not match the source', async () => {
    const smallMask = await sharp({
      create: { width: 50, height: 50, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
    })
      .png()
      .toBuffer();
    await expect(
      recolorGarment({ source: await blank(), mask: smallMask, hex: '#112233' }),
    ).rejects.toThrow(/does not match/);
  });
});
