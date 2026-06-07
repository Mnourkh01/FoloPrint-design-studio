import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderPrintFile, RenderValidationError } from './index';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let dir: string;
let logoPath: string;

const printArea = { x: 100, y: 100, width: 200, height: 250 };

const rgbaAt = async (png: Buffer, x: number, y: number): Promise<number[]> => {
  const { data } = await sharp(png)
    .extract({ left: x, top: y, width: 1, height: 1 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return [data[0]!, data[1]!, data[2]!, data[3]!];
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'foloprint-printfile-'));
  logoPath = join(dir, 'logo.png');
  await writeFile(
    logoPath,
    await sharp({
      create: { width: 120, height: 120, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } },
    })
      .png()
      .toBuffer(),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('renderPrintFile', () => {
  it('renders the ink alone on a transparent sheet at print scale with density metadata', async () => {
    const scale = 4;
    const buffer = await renderPrintFile({
      printArea,
      scale,
      objects: [
        // Centered in the area: canvas (200, 225) -> print (400, 500).
        { type: 'image', imagePath: logoPath, x: 200, y: 225, width: 100, height: 100, rotation: 0 },
      ],
    });

    expect(buffer.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    const meta = await sharp(buffer).metadata();
    expect(meta.width).toBe(printArea.width * scale);
    expect(meta.height).toBe(printArea.height * scale);
    // sharp reports density in DPI for PNG (pHYs chunk, converted from px/m).
    expect(Math.round(meta.density ?? 0)).toBe(300);

    // Logo center: opaque red, scaled into place.
    expect(await rgbaAt(buffer, 400, 500)).toEqual([200, 30, 30, 255]);
    // Inside the logo box edge (400 +- 200 print px wide).
    const [r] = await rgbaAt(buffer, 400 - 190, 500);
    expect(r).toBe(200);
    // Outside the logo, inside the sheet: fully transparent (no garment, no backdrop).
    expect((await rgbaAt(buffer, 30, 30))[3]).toBe(0);
  });

  it('keeps text crisp by scaling the font, not the raster', async () => {
    const scale = 5;
    const buffer = await renderPrintFile({
      printArea,
      scale,
      objects: [
        {
          type: 'text',
          lines: ['INK'],
          fontFamily: 'inter',
          fontSize: 40,
          color: '#102030',
          align: 'center',
          direction: 'ltr',
          x: 200,
          y: 200,
          width: 120,
          height: 50,
          rotation: 0,
        },
      ],
    });

    const meta = await sharp(buffer).metadata();
    expect(meta.width).toBe(printArea.width * scale);

    // Some text ink lands inside the scaled box; sample a horizontal strip
    // through the text center for any opaque pixel of the text color.
    const stripTop = (200 - printArea.y) * scale - 5;
    const { data, info } = await sharp(buffer)
      .extract({ left: (200 - printArea.x - 60) * scale, top: stripTop, width: 120 * scale, height: 10 })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let inked = 0;
    for (let i = 0; i < info.width * info.height; i++) {
      if (data[i * 4 + 3]! > 200 && data[i * 4]! < 60) inked++;
    }
    expect(inked).toBeGreaterThan(50);
  });

  it('survives a rotated object touching the area edge (padded compositing)', async () => {
    // Rotated 45deg, sized so the rotated corners stay inside but the layer's
    // bounding buffer rounds right up to the sheet edge.
    const buffer = await renderPrintFile({
      printArea,
      scale: 3,
      objects: [
        { type: 'image', imagePath: logoPath, x: 200, y: 225, width: 140, height: 140, rotation: 45 },
      ],
    });
    const meta = await sharp(buffer).metadata();
    expect(meta.width).toBe(printArea.width * 3);
  });

  it('rejects objects outside the area, empty designs, and bad scales', async () => {
    const inside = { type: 'image' as const, imagePath: logoPath, x: 200, y: 225, width: 100, height: 100, rotation: 0 };

    await expect(
      renderPrintFile({ printArea, scale: 2, objects: [{ ...inside, x: 90 }] }),
    ).rejects.toThrow(RenderValidationError);
    await expect(renderPrintFile({ printArea, scale: 2, objects: [] })).rejects.toThrow(
      /no objects/,
    );
    await expect(renderPrintFile({ printArea, scale: 0, objects: [inside] })).rejects.toThrow(
      /scale/,
    );
    await expect(
      renderPrintFile({ printArea, scale: 2, dpi: -1, objects: [inside] }),
    ).rejects.toThrow(/dpi/);
  });
});
