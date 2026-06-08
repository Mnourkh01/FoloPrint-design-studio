import { expect, test, type Page } from '@playwright/test';

// Matches the seeded "classic-tee" front print area (apps/api/prisma/seed.ts).
const FRONT_AREA = { x: 361, y: 270, width: 533, height: 760 } as const;

interface ShapeState {
  left: number;
  top: number;
  angle: number;
  kind: string;
  shapeKind: string;
  fill: string;
  stroke: string | null;
  strokeWidth: number;
  visible: boolean;
  box: { left: number; top: number; width: number; height: number };
  zoom: number;
}

/** State of the first shape object on the canvas. */
const getShapeState = (page: Page): Promise<ShapeState> =>
  page.evaluate(() => {
    const canvas = window.__studioCanvas as unknown as {
      getZoom(): number;
      getObjects(): Array<{
        kind?: string;
        shapeKind?: string;
        fill?: unknown;
        stroke?: unknown;
        strokeWidth?: number;
        visible: boolean;
        left: number;
        top: number;
        angle: number;
        getBoundingRect(): { left: number; top: number; width: number; height: number };
      }>;
    };
    const obj = canvas.getObjects().find((o) => o.kind === 'shape');
    if (!obj) throw new Error('no shape object on canvas');
    return {
      left: obj.left,
      top: obj.top,
      angle: obj.angle,
      kind: obj.kind ?? '',
      shapeKind: obj.shapeKind ?? '',
      fill: typeof obj.fill === 'string' ? obj.fill : '',
      stroke: typeof obj.stroke === 'string' ? obj.stroke : null,
      strokeWidth: obj.strokeWidth ?? 0,
      visible: obj.visible,
      box: obj.getBoundingRect(),
      zoom: canvas.getZoom(),
    };
  });

const expectInsideFrontArea = (box: ShapeState['box']): void => {
  expect(box.left).toBeGreaterThanOrEqual(FRONT_AREA.x - 1);
  expect(box.top).toBeGreaterThanOrEqual(FRONT_AREA.y - 1);
  expect(box.left + box.width).toBeLessThanOrEqual(FRONT_AREA.x + FRONT_AREA.width + 1);
  expect(box.top + box.height).toBeLessThanOrEqual(FRONT_AREA.y + FRONT_AREA.height + 1);
};

const hasShape = (page: Page): Promise<boolean> =>
  page.waitForFunction(() =>
    (window.__studioCanvas?.getObjects() ?? []).some((o) => (o as { kind?: string }).kind === 'shape'),
  ).then(() => true);

test('shapes: add, fill, outline, move, save, render, reopen, delete', async ({ page }) => {
  await page.goto('/editor/classic-tee');
  await page.waitForFunction(() => Boolean(window.__studioCanvas?.backgroundImage));

  // --- Add: a rect lands centered in the front area, selected ---
  await page.getByTestId('tool-shapes').click();
  await page.getByTestId('shape-add-rect').click();
  await hasShape(page);
  const initial = await getShapeState(page);
  expect(initial.kind).toBe('shape');
  expect(initial.shapeKind).toBe('rect');
  expectInsideFrontArea(initial.box);

  // The shape styling panel is shown for the selected shape.
  await expect(page.getByTestId('shape-panel')).toBeVisible();

  // --- Style: fill swatch + a one-tap white outline ---
  await page.getByTestId('shape-fill-cf3f22').click();
  await page.getByTestId('fx-shape-stroke-white').click();
  const styled = await getShapeState(page);
  expect(styled.fill.toLowerCase()).toBe('#cf3f22');
  expect(styled.stroke?.toLowerCase()).toBe('#ffffff');
  expect(Math.round(styled.strokeWidth)).toBe(6);
  expectInsideFrontArea(styled.box);

  // --- Move: drag the shape from its center ---
  const stageBox = await page.getByTestId('editor-stage').boundingBox();
  if (!stageBox) throw new Error('editor stage not visible');
  const cx = stageBox.x + styled.left * styled.zoom;
  const cy = stageBox.y + styled.top * styled.zoom;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 30, cy - 25, { steps: 10 });
  await page.mouse.up();
  const moved = await getShapeState(page);
  expect(moved.left).not.toBeCloseTo(styled.left, 0);
  expectInsideFrontArea(moved.box);

  // --- Save + render ---
  await page.getByTestId('save-design').click();
  await expect(page.getByTestId('editor-status')).toContainText('Design saved');

  await page.getByTestId('generate-mockup').click();
  await page.waitForURL(/\/designs\/[0-9a-f-]{36}/);
  const preview = page.getByTestId('preview-image-front');
  await expect(preview).toBeVisible();
  expect(await preview.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

  // --- Reopen: the shape restores with kind, fill, outline, position ---
  await page.getByTestId('edit-design').click();
  await page.waitForURL(/\/editor\/classic-tee\?design=/);
  await hasShape(page);
  const reopened = await getShapeState(page);
  expect(reopened.shapeKind).toBe('rect');
  expect(reopened.fill.toLowerCase()).toBe('#cf3f22');
  expect(reopened.stroke?.toLowerCase()).toBe('#ffffff');
  expect(Math.round(reopened.strokeWidth)).toBe(6);
  expect(reopened.left).toBeCloseTo(moved.left, 0);
  expect(reopened.top).toBeCloseTo(moved.top, 0);
  expectInsideFrontArea(reopened.box);

  // --- Delete: removing the shape empties the canvas again ---
  await page.evaluate(() => {
    const canvas = window.__studioCanvas as unknown as {
      getObjects(): Array<Record<string, unknown>>;
      setActiveObject(obj: unknown): void;
      requestRenderAll(): void;
    };
    const shape = canvas.getObjects().find((o) => (o as { kind?: string }).kind === 'shape');
    canvas.setActiveObject(shape);
    canvas.requestRenderAll();
  });
  await page.getByTestId('delete-object').click();
  await page.waitForFunction(
    () => !(window.__studioCanvas?.getObjects() ?? []).some((o) => (o as { kind?: string }).kind === 'shape'),
  );
});

test('shapes: circle and star save and render', async ({ page }) => {
  for (const shape of ['circle', 'star'] as const) {
    await page.goto('/editor/classic-tee');
    await page.waitForFunction(() => Boolean(window.__studioCanvas?.backgroundImage));
    await page.getByTestId('tool-shapes').click();
    await page.getByTestId(`shape-add-${shape}`).click();
    await hasShape(page);
    const state = await getShapeState(page);
    expect(state.shapeKind).toBe(shape);
    expectInsideFrontArea(state.box);

    await page.getByTestId('save-design').click();
    await expect(page.getByTestId('editor-status')).toContainText('Design saved');
    await page.getByTestId('generate-mockup').click();
    await page.waitForURL(/\/designs\/[0-9a-f-]{36}/);
    const preview = page.getByTestId('preview-image-front');
    await expect(preview).toBeVisible();
    expect(await preview.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  }
});

test('mixed design: image, text, and shape on one area render together', async ({ page }) => {
  await page.goto('/editor/classic-tee');
  await page.waitForFunction(() => Boolean(window.__studioCanvas?.backgroundImage));

  // Image.
  await page.setInputFiles('[data-testid=upload-input]', `${__dirname}/fixtures/logo.png`);
  await page.waitForFunction(
    () => (window.__studioCanvas?.getObjects() ?? []).some((o) => (o as { kind?: string }).kind === 'image'),
  );

  // Text.
  await page.getByTestId('tool-text').click();
  await page.getByTestId('add-text-button').click();
  await page.waitForFunction(
    () => (window.__studioCanvas?.getObjects() ?? []).some((o) => (o as { kind?: string }).kind === 'text'),
  );

  // Shape.
  await page.getByTestId('tool-shapes').click();
  await page.getByTestId('shape-add-star').click();
  await hasShape(page);

  // All three count toward the front tab badge.
  await expect(page.getByTestId('area-tab-front')).toContainText('3');

  await page.getByTestId('save-design').click();
  await expect(page.getByTestId('editor-status')).toContainText('Design saved');
  await page.getByTestId('generate-mockup').click();
  await page.waitForURL(/\/designs\/[0-9a-f-]{36}/);
  const preview = page.getByTestId('preview-image-front');
  await expect(preview).toBeVisible();
  expect(await preview.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
});
