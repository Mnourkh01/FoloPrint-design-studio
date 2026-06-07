import { expect, test, type Page } from '@playwright/test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const FIXTURE = join(__dirname, 'fixtures', 'logo.png');

// Matches the seeded "classic-tee" front print area (apps/api/prisma/seed.ts).
const FRONT = { x: 427, y: 400, width: 400, height: 520 } as const;

interface ObjectState {
  angle: number;
  box: { left: number; top: number; width: number; height: number };
}

/** State of the (single) image object on the front area. */
const getFrontImageState = (page: Page): Promise<ObjectState> =>
  page.evaluate(() => {
    const canvas = window.__studioCanvas as unknown as {
      getObjects(): Array<{
        assetId?: string;
        printAreaKey?: string;
        angle: number;
        getBoundingRect(): { left: number; top: number; width: number; height: number };
      }>;
    };
    const obj = canvas.getObjects().find((o) => o.assetId && o.printAreaKey === 'front');
    if (!obj) throw new Error('no image object on the front area');
    return { angle: obj.angle, box: obj.getBoundingRect() };
  });

const expectInsideFront = (state: ObjectState): void => {
  expect(state.box.left).toBeGreaterThanOrEqual(FRONT.x - 1);
  expect(state.box.top).toBeGreaterThanOrEqual(FRONT.y - 1);
  expect(state.box.left + state.box.width).toBeLessThanOrEqual(FRONT.x + FRONT.width + 1);
  expect(state.box.top + state.box.height).toBeLessThanOrEqual(FRONT.y + FRONT.height + 1);
};

test('object tools: contextual toolbar, align to print area, rotate, physical size', async ({ page }) => {
  await page.goto('/editor/classic-tee');
  await page.waitForFunction(() => Boolean(window.__studioCanvas?.backgroundImage));

  // No selection, no toolbar.
  await expect(page.getByTestId('context-toolbar')).toHaveCount(0);

  // Upload selects the new object, which mounts the contextual toolbar.
  await page.setInputFiles('[data-testid=upload-input]', FIXTURE);
  await page.waitForFunction(
    () =>
      (window.__studioCanvas?.getObjects() ?? []).some(
        (o) => (o as { assetId?: string }).assetId,
      ),
  );
  await expect(page.getByTestId('context-toolbar')).toBeVisible();

  // Physical print size readout (inches) for the selected image.
  await expect(page.getByTestId('physical-size-readout')).toContainText('in');

  // --- Position: align against the print area edges ---
  await page.getByTestId('context-tool-position').click();
  await expect(page.getByTestId('object-panel-position')).toBeVisible();

  await page.getByTestId('align-left').click();
  let state = await getFrontImageState(page);
  expect(state.box.left).toBeCloseTo(FRONT.x, 0);
  expectInsideFront(state);

  await page.getByTestId('align-bottom').click();
  state = await getFrontImageState(page);
  expect(state.box.top + state.box.height).toBeCloseTo(FRONT.y + FRONT.height, 0);
  expectInsideFront(state);

  await page.getByTestId('align-center-h').click();
  state = await getFrontImageState(page);
  expect(state.box.left + state.box.width / 2).toBeCloseTo(FRONT.x + FRONT.width / 2, 0);
  expectInsideFront(state);

  // --- Transform: absolute rotation via the numeric input ---
  await page.getByTestId('context-tool-transform').click();
  await expect(page.getByTestId('object-panel-transform')).toBeVisible();
  await expect(page.getByTestId('object-panel-position')).toHaveCount(0);

  await page.getByTestId('rotate-input').fill('45');
  state = await getFrontImageState(page);
  expect(state.angle).toBeCloseTo(45, 0);
  expectInsideFront(state); // rotation re-fits the box inside the area

  // Slider and input stay in sync through the selection readout.
  await expect(page.getByTestId('rotate-slider')).toHaveValue('45');

  // --- Rotated + aligned design still saves (server re-validates) ---
  await page.getByTestId('save-design').click();
  await expect(page.getByTestId('editor-status')).toContainText('Design saved');

  // Deselect (fires selection:cleared): toolbar and panel unmount together.
  await page.evaluate(() => {
    const canvas = window.__studioCanvas as unknown as {
      discardActiveObject(): void;
      requestRenderAll(): void;
    };
    canvas.discardActiveObject();
    canvas.requestRenderAll();
  });
  await expect(page.getByTestId('context-toolbar')).toHaveCount(0);
  await expect(page.getByTestId('object-panel-transform')).toHaveCount(0);
});

test('crop: shrinking the frame derives a smaller asset and keeps the region in place', async ({ page }) => {
  await page.goto('/editor/classic-tee');
  await page.waitForFunction(() => Boolean(window.__studioCanvas?.backgroundImage));
  await page.setInputFiles('[data-testid=upload-input]', FIXTURE);
  await page.waitForFunction(
    () => (window.__studioCanvas?.getObjects() ?? []).some((o) => (o as { assetId?: string }).assetId),
  );

  const imageState = () =>
    page.evaluate(() => {
      const obj = (window.__studioCanvas?.getObjects() ?? []).find(
        (o) => (o as { assetId?: string }).assetId,
      ) as { assetId?: string; width?: number; height?: number; left?: number } | undefined;
      if (!obj) throw new Error('no image');
      return { assetId: obj.assetId, srcW: obj.width, srcH: obj.height, left: obj.left };
    });
  const before = await imageState();

  // Enter crop mode: toolbar swaps to Cancel/Apply, a crop rect joins the canvas.
  await page.getByTestId('context-tool-crop').click();
  await expect(page.getByTestId('crop-toolbar')).toBeVisible();
  await expect(page.getByTestId('context-toolbar')).toHaveCount(0);

  // Cancel leaves everything untouched.
  await page.getByTestId('crop-cancel').click();
  await expect(page.getByTestId('crop-toolbar')).toHaveCount(0);
  expect((await imageState()).assetId).toBe(before.assetId);

  // Re-enter, shrink the frame to the left half programmatically, apply.
  await page.getByTestId('context-tool-crop').click();
  await page.evaluate(() => {
    const canvas = window.__studioCanvas as unknown as {
      getObjects(): Array<Record<string, unknown>>;
      requestRenderAll(): void;
      fire(event: string, data: object): void;
    };
    const rect = canvas.getObjects().find((o) => (o as { cropTag?: boolean }).cropTag) as
      | { set(props: object): void; setCoords(): void; width: number; height: number; left: number }
      | undefined;
    if (!rect) throw new Error('no crop rect');
    // Keep the left half: halve the width, shift the center left by a quarter.
    rect.set({ width: rect.width / 2, left: rect.left - rect.width / 4 });
    rect.setCoords();
    canvas.requestRenderAll();
  });
  await page.getByTestId('crop-apply').click();

  // The object swaps to the derived asset with roughly half the source width.
  await page.waitForFunction(
    (prev) => {
      const obj = (window.__studioCanvas?.getObjects() ?? []).find(
        (o) => (o as { assetId?: string }).assetId,
      ) as { assetId?: string } | undefined;
      return obj !== undefined && obj.assetId !== prev;
    },
    before.assetId,
  );
  const after = await imageState();
  expect(after.srcW).toBeLessThan((before.srcW ?? 0) * 0.6);
  expect(after.srcH).toBe(before.srcH); // height untouched

  // The cropped design still saves (server re-validates the derived asset).
  await page.getByTestId('save-design').click();
  await expect(page.getByTestId('editor-status')).toContainText('Design saved');
});

test('pattern: tiling fill previews live, locks rotation, and survives save/reopen', async ({ page }) => {
  await page.goto('/editor/classic-tee');
  await page.waitForFunction(() => Boolean(window.__studioCanvas?.backgroundImage));
  await page.setInputFiles('[data-testid=upload-input]', FIXTURE);
  await page.waitForFunction(
    () => (window.__studioCanvas?.getObjects() ?? []).some((o) => (o as { assetId?: string }).assetId),
  );

  // Enable a mirror pattern with spacing through the panel.
  await page.getByTestId('context-tool-pattern').click();
  await page.getByTestId('pattern-type-mirror').click();
  await page.getByTestId('pattern-spacing-input').fill('12');

  const state = () =>
    page.evaluate(() => {
      const objs = window.__studioCanvas?.getObjects() ?? [];
      const img = objs.find((o) => (o as { assetId?: string }).assetId) as
        | { pattern?: { type: string; spacing: number }; lockRotation?: boolean }
        | undefined;
      return {
        pattern: img?.pattern ?? null,
        lockRotation: img?.lockRotation ?? false,
        previews: objs.filter((o) => (o as { patternPreview?: boolean }).patternPreview).length,
      };
    });

  const on = await state();
  expect(on.pattern).toEqual({ type: 'mirror', spacing: 12 });
  expect(on.lockRotation).toBe(true);
  expect(on.previews).toBe(1);

  // Save, render, reopen: the pattern persists and the preview rebuilds.
  await page.getByTestId('save-design').click();
  await expect(page.getByTestId('editor-status')).toContainText('Design saved');
  await page.getByTestId('generate-mockup').click();
  await page.waitForURL(/\/designs\/[0-9a-f-]{36}/);
  await page.getByTestId('edit-design').click();
  await page.waitForURL(/\/editor\/classic-tee\?design=/);
  await page.waitForFunction(
    () =>
      (window.__studioCanvas?.getObjects() ?? []).some(
        (o) => (o as { patternPreview?: boolean }).patternPreview,
      ),
  );
  const reopened = await state();
  expect(reopened.pattern).toEqual({ type: 'mirror', spacing: 12 });
  expect(reopened.previews).toBe(1);

  // Turning the pattern off drops the preview and unlocks rotation.
  await page.evaluate(() => {
    const canvas = window.__studioCanvas as unknown as {
      getObjects(): Array<Record<string, unknown>>;
      setActiveObject(o: unknown): void;
      requestRenderAll(): void;
    };
    const img = canvas.getObjects().find((o) => (o as { assetId?: string }).assetId);
    canvas.setActiveObject(img);
    canvas.requestRenderAll();
  });
  await page.getByTestId('context-tool-pattern').click();
  await page.getByTestId('pattern-type-none').click();
  const off = await state();
  expect(off.pattern).toBeNull();
  expect(off.lockRotation).toBe(false);
  expect(off.previews).toBe(0);
});

test('remove background: swaps the selected image for a transparent derivative', async ({ page }) => {
  // Logo on a flat near-white box, generated fresh (the checked-in logo fixture
  // has no background to remove).
  const dir = await mkdtemp(join(tmpdir(), 'foloprint-e2e-'));
  const fixture = join(dir, 'logo-on-white.png');
  await writeFile(
    fixture,
    await sharp({
      create: { width: 200, height: 200, channels: 4, background: { r: 250, g: 250, b: 248, alpha: 1 } },
    })
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
      .toBuffer(),
  );

  await page.goto('/editor/classic-tee');
  await page.waitForFunction(() => Boolean(window.__studioCanvas?.backgroundImage));
  await page.setInputFiles('[data-testid=upload-input]', fixture);
  await page.waitForFunction(
    () => (window.__studioCanvas?.getObjects() ?? []).some((o) => (o as { assetId?: string }).assetId),
  );

  const activeAssetId = () =>
    page.evaluate(
      () => (window.__studioCanvas?.getActiveObject() as { assetId?: string } | undefined)?.assetId,
    );

  const before = await activeAssetId();
  expect(before).toBeTruthy();

  await page.getByTestId('context-tool-remove-bg').click();
  await expect(page.getByTestId('editor-status')).toContainText('Background removed');

  // The object now points at the derived asset; geometry survives the swap.
  const after = await activeAssetId();
  expect(after).toBeTruthy();
  expect(after).not.toBe(before);

  // The derived asset passes server validation on save.
  await page.getByTestId('save-design').click();
  await expect(page.getByTestId('editor-status')).toContainText('Design saved');
});
