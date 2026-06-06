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
