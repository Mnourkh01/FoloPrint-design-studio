import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderMockup, RenderValidationError } from './index';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let dir: string;
let basePath: string;
let overlayPath: string;
let logoPath: string;

const printArea = { x: 100, y: 100, width: 200, height: 200 };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'foloprint-renderer-'));

  basePath = join(dir, 'base.png');
  await writeFile(
    basePath,
    await sharp({
      create: { width: 400, height: 400, channels: 4, background: { r: 230, g: 230, b: 230, alpha: 1 } },
    })
      .png()
      .toBuffer(),
  );

  overlayPath = join(dir, 'overlay.png');
  await writeFile(
    overlayPath,
    await sharp({
      create: { width: 400, height: 400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.1 } },
    })
      .png()
      .toBuffer(),
  );

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

describe('renderMockup', () => {
  it('produces a PNG at canvas size with the design composited', async () => {
    const buffer = await renderMockup({
      baseImagePath: basePath,
      overlayImagePath: overlayPath,
      canvasWidth: 400,
      canvasHeight: 400,
      printArea,
      objects: [{ type: 'image' as const, imagePath: logoPath, x: 200, y: 200, width: 100, height: 100, rotation: 30 }],
    });

    expect(buffer.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);

    const meta = await sharp(buffer).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(400);

    // Center pixel must differ from the plain base (the red logo sits there).
    const { data } = await sharp(buffer)
      .extract({ left: 200, top: 200, width: 1, height: 1 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(150); // red channel
    expect(data[1]).toBeLessThan(120); // green channel clearly not the gray base
  });

  it('renders without an overlay', async () => {
    const buffer = await renderMockup({
      baseImagePath: basePath,
      canvasWidth: 400,
      canvasHeight: 400,
      printArea,
      objects: [{ type: 'image' as const, imagePath: logoPath, x: 150, y: 150, width: 80, height: 60, rotation: 0 }],
    });
    const meta = await sharp(buffer).metadata();
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(400);
  });

  it('refuses to render an object outside the print area', async () => {
    await expect(
      renderMockup({
        baseImagePath: basePath,
        canvasWidth: 400,
        canvasHeight: 400,
        printArea,
        objects: [{ type: 'image' as const, imagePath: logoPath, x: 350, y: 350, width: 100, height: 100, rotation: 0 }],
      }),
    ).rejects.toThrow(RenderValidationError);
  });

  it('refuses an empty design', async () => {
    await expect(
      renderMockup({
        baseImagePath: basePath,
        canvasWidth: 400,
        canvasHeight: 400,
        printArea,
        objects: [],
      }),
    ).rejects.toThrow(RenderValidationError);
  });
});

describe('renderMockup mask and overlay blend (photo templates)', () => {
  let maskPath: string;

  beforeAll(async () => {
    // Garment mask: opaque ONLY over the left half of the print area (x 100..200).
    // Ink right of x=200 must vanish, as if the garment edge ran down the middle.
    maskPath = join(dir, 'mask.png');
    const maskRect = await sharp({
      create: { width: 100, height: 200, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
    })
      .png()
      .toBuffer();
    await writeFile(
      maskPath,
      await sharp({
        create: { width: 400, height: 400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .composite([{ input: maskRect, left: 100, top: 100 }])
        .png()
        .toBuffer(),
    );
  });

  it('clips design ink to the mask alpha', async () => {
    const buffer = await renderMockup({
      baseImagePath: basePath,
      maskImagePath: maskPath,
      canvasWidth: 400,
      canvasHeight: 400,
      printArea,
      // Red logo spans x 150..250: half inside the mask, half outside.
      objects: [{ type: 'image' as const, imagePath: logoPath, x: 200, y: 200, width: 100, height: 100, rotation: 0 }],
    });

    const probe = async (left: number) =>
      (
        await sharp(buffer)
          .extract({ left, top: 200, width: 1, height: 1 })
          .raw()
          .toBuffer({ resolveWithObject: true })
      ).data;

    const inside = await probe(170); // masked-in: red ink stays
    expect(inside[0]).toBeGreaterThan(150);
    expect(inside[1]).toBeLessThan(120);

    const outside = await probe(230); // masked-out: plain gray base shows through
    expect(outside[0]).toBeGreaterThan(200);
    expect(outside[1]).toBeGreaterThan(200);
  });

  it('multiply overlay darkens the base instead of pasting over it', async () => {
    // 50% gray, fully opaque: multiply halves every channel; plain 'over' would
    // replace the canvas with flat gray instead.
    const grayOverlayPath = join(dir, 'gray-overlay.png');
    await writeFile(
      grayOverlayPath,
      await sharp({
        create: { width: 400, height: 400, channels: 4, background: { r: 128, g: 128, b: 128, alpha: 1 } },
      })
        .png()
        .toBuffer(),
    );

    const buffer = await renderMockup({
      baseImagePath: basePath, // gray 230
      overlayImagePath: grayOverlayPath,
      overlayBlend: 'multiply',
      canvasWidth: 400,
      canvasHeight: 400,
      printArea,
      objects: [{ type: 'image' as const, imagePath: logoPath, x: 200, y: 200, width: 100, height: 100, rotation: 0 }],
    });

    // Outside the design: base 230 * 128/255 ~ 115.
    const { data: corner } = await sharp(buffer)
      .extract({ left: 10, top: 10, width: 1, height: 1 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(corner[0]).toBeGreaterThan(95);
    expect(corner[0]).toBeLessThan(135);

    // The red ink darkens too (multiply re-applies shadows over the print).
    const { data: ink } = await sharp(buffer)
      .extract({ left: 200, top: 200, width: 1, height: 1 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(ink[0]).toBeGreaterThan(60);
    expect(ink[0]).toBeLessThan(140); // 200 * 128/255 ~ 100
  });

  it('rejects an unknown overlay blend', async () => {
    await expect(
      renderMockup({
        baseImagePath: basePath,
        overlayImagePath: overlayPath,
        overlayBlend: 'screen' as never,
        canvasWidth: 400,
        canvasHeight: 400,
        printArea,
        objects: [{ type: 'image' as const, imagePath: logoPath, x: 200, y: 200, width: 100, height: 100, rotation: 0 }],
      }),
    ).rejects.toThrow(RenderValidationError);
  });

  it('mask and multiply overlay combine into a canvas-sized PNG', async () => {
    const buffer = await renderMockup({
      baseImagePath: basePath,
      overlayImagePath: overlayPath,
      overlayBlend: 'multiply',
      maskImagePath: maskPath,
      canvasWidth: 400,
      canvasHeight: 400,
      printArea,
      objects: [{ type: 'image' as const, imagePath: logoPath, x: 180, y: 200, width: 60, height: 60, rotation: 15 }],
    });
    expect(buffer.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    const meta = await sharp(buffer).metadata();
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(400);
  });
});

describe('renderMockup per print area (multi-area designs)', () => {
  // The API renders one mockup per placement: each call gets that area's own base
  // (front photo vs back photo) and that area's rect. These tests prove the renderer
  // behaves correctly when invoked that way.
  let backBasePath: string;
  const backPrintArea = { x: 80, y: 60, width: 240, height: 260 };

  beforeAll(async () => {
    backBasePath = join(dir, 'back-base.png');
    await writeFile(
      backBasePath,
      await sharp({
        create: { width: 400, height: 400, channels: 4, background: { r: 120, g: 160, b: 130, alpha: 1 } },
      })
        .png()
        .toBuffer(),
    );
  });

  it('renders front and back previews as valid, distinct PNGs', async () => {
    const front = await renderMockup({
      baseImagePath: basePath, // area without own image -> caller passed the template base
      overlayImagePath: overlayPath,
      canvasWidth: 400,
      canvasHeight: 400,
      printArea,
      objects: [{ type: 'image' as const, imagePath: logoPath, x: 200, y: 200, width: 100, height: 100, rotation: 0 }],
    });
    const back = await renderMockup({
      baseImagePath: backBasePath, // area-specific view image
      overlayImagePath: null,
      canvasWidth: 400,
      canvasHeight: 400,
      printArea: backPrintArea,
      objects: [{ type: 'image' as const, imagePath: logoPath, x: 200, y: 180, width: 90, height: 90, rotation: 20 }],
    });

    for (const buffer of [front, back]) {
      expect(buffer.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
      const meta = await sharp(buffer).metadata();
      expect(meta.format).toBe('png');
      expect(meta.width).toBe(400);
      expect(meta.height).toBe(400);
    }

    // Different base images must yield different previews.
    expect(front.equals(back)).toBe(false);

    // Back preview shows the green back base outside the print area, not the gray front.
    const { data } = await sharp(back)
      .extract({ left: 10, top: 10, width: 1, height: 1 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(data[1]).toBeGreaterThan(140); // green channel of the back base
  });

  it('validates each call against ITS OWN print area, not another area', async () => {
    // Top-left corner region: inside the back area (starts at 80,60) but outside the
    // front area (starts at 100,100).
    const objectInsideBackOnly = {
      type: 'image' as const,
      imagePath: logoPath,
      x: 95,
      y: 75,
      width: 20,
      height: 20,
      rotation: 0,
    };
    // The back render accepts it...
    await expect(
      renderMockup({
        baseImagePath: backBasePath,
        canvasWidth: 400,
        canvasHeight: 400,
        printArea: backPrintArea,
        objects: [objectInsideBackOnly],
      }),
    ).resolves.toBeInstanceOf(Buffer);
    // ...but the front render must refuse the same object.
    await expect(
      renderMockup({
        baseImagePath: basePath,
        canvasWidth: 400,
        canvasHeight: 400,
        printArea,
        objects: [objectInsideBackOnly],
      }),
    ).rejects.toThrow(RenderValidationError);
  });
});
