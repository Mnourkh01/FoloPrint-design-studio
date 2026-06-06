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
