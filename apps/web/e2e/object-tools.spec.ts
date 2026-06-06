import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';

const FIXTURE = join(__dirname, 'fixtures', 'logo.png');

// Matches the seeded "classic-tee" front print area (apps/api/prisma/seed.ts).
const FRONT = { x: 370, y: 300, width: 260, height: 340 } as const;

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
