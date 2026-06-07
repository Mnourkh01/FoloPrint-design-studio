import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { FlatBackgroundError, removeFlatBackground } from './remove-background';

/** Red square logo centered on a flat near-white background. */
const logoOnWhite = (bg = { r: 250, g: 250, b: 248 }): Promise<Buffer> =>
  sharp({ create: { width: 200, height: 200, channels: 4, background: { ...bg, alpha: 1 } } })
    .composite([
      {
        input: {
          create: { width: 80, height: 80, channels: 4, background: { r: 190, g: 30, b: 40, alpha: 1 } },
        },
        left: 60,
        top: 60,
      },
    ])
    .png()
    .toBuffer();

const alphaAt = async (png: Buffer, x: number, y: number): Promise<number> => {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return data[(y * info.width + x) * 4 + 3];
};

describe('removeFlatBackground', () => {
  it('turns the border-connected background transparent and keeps the artwork', async () => {
    const { png, removedFraction } = await removeFlatBackground(await logoOnWhite());

    expect(await alphaAt(png, 5, 5)).toBe(0); // corner background gone
    expect(await alphaAt(png, 100, 30)).toBe(0); // background above the logo gone
    expect(await alphaAt(png, 100, 100)).toBe(255); // logo center intact

    // 200x200 minus the 80x80 square ~ 0.84 removed.
    expect(removedFraction).toBeGreaterThan(0.8);
    expect(removedFraction).toBeLessThan(0.9);
  });

  it('keeps enclosed background-colored regions (they are not border-connected)', async () => {
    // A ring: background-colored hole in the middle of the logo must survive.
    const holed = await sharp({
      create: { width: 200, height: 200, channels: 4, background: { r: 250, g: 250, b: 248, alpha: 1 } },
    })
      .composite([
        {
          input: { create: { width: 120, height: 120, channels: 4, background: { r: 20, g: 60, b: 160, alpha: 1 } } },
          left: 40,
          top: 40,
        },
        {
          input: { create: { width: 30, height: 30, channels: 4, background: { r: 250, g: 250, b: 248, alpha: 1 } } },
          left: 85,
          top: 85,
        },
      ])
      .png()
      .toBuffer();

    const { png } = await removeFlatBackground(holed);
    expect(await alphaAt(png, 5, 5)).toBe(0); // outer background removed
    expect(await alphaAt(png, 100, 100)).toBe(255); // enclosed hole kept
  });

  it('rejects a busy border (no flat background)', async () => {
    const noise = Buffer.alloc(200 * 200 * 4);
    // Deterministic pseudo-noise; no Math.random in tests.
    for (let i = 0; i < 200 * 200; i++) {
      noise[i * 4] = (i * 73) % 256;
      noise[i * 4 + 1] = (i * 151) % 256;
      noise[i * 4 + 2] = (i * 211) % 256;
      noise[i * 4 + 3] = 255;
    }
    const busy = await sharp(noise, { raw: { width: 200, height: 200, channels: 4 } }).png().toBuffer();

    await expect(removeFlatBackground(busy)).rejects.toThrow(FlatBackgroundError);
  });

  it('rejects an image that is entirely background', async () => {
    const flat = await sharp({
      create: { width: 200, height: 200, channels: 4, background: { r: 250, g: 250, b: 248, alpha: 1 } },
    })
      .png()
      .toBuffer();

    await expect(removeFlatBackground(flat)).rejects.toThrow(FlatBackgroundError);
  });

  it('rejects artwork with no surrounding background to remove', async () => {
    // Logo fills the frame except a 1px border ring: 796/40000 ~ 1.99% removable,
    // just under the 2% floor.
    const fullBleed = await sharp({
      create: { width: 200, height: 200, channels: 4, background: { r: 250, g: 250, b: 248, alpha: 1 } },
    })
      .composite([
        {
          input: { create: { width: 198, height: 198, channels: 4, background: { r: 190, g: 30, b: 40, alpha: 1 } } },
          left: 1,
          top: 1,
        },
      ])
      .png()
      .toBuffer();

    await expect(removeFlatBackground(fullBleed)).rejects.toThrow(FlatBackgroundError);
  });
});
