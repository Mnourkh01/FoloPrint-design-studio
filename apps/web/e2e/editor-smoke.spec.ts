import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';

const FIXTURE = join(__dirname, 'fixtures', 'logo.png');

// Matches the seeded "classic-tee" front print area (apps/api/prisma/seed.ts).
const PRINT_AREA = { x: 370, y: 300, width: 260, height: 340 };

interface ObjectState {
  left: number;
  top: number;
  angle: number;
  width: number;
  height: number;
  box: { left: number; top: number; width: number; height: number };
  zoom: number;
}

declare global {
  interface Window {
    __studioCanvas?: {
      backgroundImage?: unknown;
      getZoom(): number;
      getObjects(): Array<Record<string, unknown>>;
      getActiveObject(): Record<string, unknown> | undefined;
    };
  }
}

const getObjectState = (page: Page): Promise<ObjectState> =>
  page.evaluate(() => {
    const canvas = window.__studioCanvas as unknown as {
      getZoom(): number;
      getObjects(): Array<{
        assetId?: string;
        left: number;
        top: number;
        angle: number;
        getScaledWidth(): number;
        getScaledHeight(): number;
        getBoundingRect(): { left: number; top: number; width: number; height: number };
      }>;
    };
    const obj = canvas.getObjects().find((o) => o.assetId);
    if (!obj) throw new Error('no design object on canvas');
    return {
      left: obj.left,
      top: obj.top,
      angle: obj.angle,
      width: obj.getScaledWidth(),
      height: obj.getScaledHeight(),
      box: obj.getBoundingRect(),
      zoom: canvas.getZoom(),
    };
  });

const expectInsidePrintArea = (state: ObjectState): void => {
  expect(state.box.left).toBeGreaterThanOrEqual(PRINT_AREA.x - 1);
  expect(state.box.top).toBeGreaterThanOrEqual(PRINT_AREA.y - 1);
  expect(state.box.left + state.box.width).toBeLessThanOrEqual(PRINT_AREA.x + PRINT_AREA.width + 1);
  expect(state.box.top + state.box.height).toBeLessThanOrEqual(PRINT_AREA.y + PRINT_AREA.height + 1);
};

test('editor flow: open, upload, move, resize, save, render, preview', async ({ page }) => {
  // 1. Home shows the seeded template; open the editor.
  await page.goto('/');
  await page.getByTestId('template-classic-tee').click();
  await expect(page).toHaveURL(/\/editor\/classic-tee/);

  // 2. Canvas booted with the template base image.
  await page.waitForFunction(() => Boolean(window.__studioCanvas?.backgroundImage));

  // 3. Upload the fixture logo.
  await page.setInputFiles('[data-testid=upload-input]', FIXTURE);
  await page.waitForFunction(() =>
    window.__studioCanvas?.getObjects().some((o) => (o as { assetId?: string }).assetId),
  );

  const initial = await getObjectState(page);
  expectInsidePrintArea(initial);

  const stageBox = await page.getByTestId('editor-stage').boundingBox();
  if (!stageBox) throw new Error('editor stage not visible');
  const zoom = initial.zoom;

  // 4. MOVE: drag the object from its center by +30/+30 display px.
  const centerX = stageBox.x + initial.left * zoom;
  const centerY = stageBox.y + initial.top * zoom;
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + 30, centerY + 30, { steps: 10 });
  await page.mouse.up();

  const afterMove = await getObjectState(page);
  expect(afterMove.left).not.toBeCloseTo(initial.left, 0);
  expectInsidePrintArea(afterMove);

  // 5. RESIZE: drag the bottom-right control handle outward.
  const corner = await page.evaluate(() => {
    const obj = window.__studioCanvas?.getActiveObject() as unknown as {
      setCoords(): void;
      oCoords: { br: { x: number; y: number } };
    };
    obj.setCoords();
    return { x: obj.oCoords.br.x, y: obj.oCoords.br.y };
  });
  await page.mouse.move(stageBox.x + corner.x, stageBox.y + corner.y);
  await page.mouse.down();
  await page.mouse.move(stageBox.x + corner.x + 25, stageBox.y + corner.y + 25, { steps: 10 });
  await page.mouse.up();

  const afterResize = await getObjectState(page);
  expect(afterResize.width).toBeGreaterThan(afterMove.width + 5);
  expectInsidePrintArea(afterResize);

  // 6. Save the design; server validates and persists it.
  await page.getByTestId('save-design').click();
  await expect(page.getByTestId('editor-status')).toContainText('Design saved');

  // 7. Generate the mockup; lands on the preview page with a real image.
  await page.getByTestId('generate-mockup').click();
  await page.waitForURL(/\/designs\/[0-9a-f-]{36}/);

  const preview = page.getByTestId('preview-image');
  await expect(preview).toBeVisible();
  const naturalWidth = await preview.evaluate((el) => (el as HTMLImageElement).naturalWidth);
  expect(naturalWidth).toBeGreaterThan(0);
});
