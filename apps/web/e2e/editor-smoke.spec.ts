import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';

const FIXTURE = join(__dirname, 'fixtures', 'logo.png');

// Matches the seeded "classic-tee" print areas (apps/api/prisma/seed.ts).
const PRINT_AREAS = {
  front: { x: 361, y: 270, width: 533, height: 760 },
  back: { x: 361, y: 240, width: 533, height: 756 },
} as const;

type AreaKey = keyof typeof PRINT_AREAS;

interface ObjectState {
  left: number;
  top: number;
  angle: number;
  width: number;
  height: number;
  visible: boolean;
  box: { left: number; top: number; width: number; height: number };
  zoom: number;
}

/** State of the (single) design object belonging to the given print area. */
const getObjectState = (page: Page, areaKey: AreaKey): Promise<ObjectState> =>
  page.evaluate((key) => {
    const canvas = window.__studioCanvas as unknown as {
      getZoom(): number;
      getObjects(): Array<{
        assetId?: string;
        printAreaKey?: string;
        visible: boolean;
        left: number;
        top: number;
        angle: number;
        getScaledWidth(): number;
        getScaledHeight(): number;
        getBoundingRect(): { left: number; top: number; width: number; height: number };
      }>;
    };
    const obj = canvas.getObjects().find((o) => o.assetId && o.printAreaKey === key);
    if (!obj) throw new Error(`no design object for area "${key}" on canvas`);
    return {
      left: obj.left,
      top: obj.top,
      angle: obj.angle,
      width: obj.getScaledWidth(),
      height: obj.getScaledHeight(),
      visible: obj.visible,
      box: obj.getBoundingRect(),
      zoom: canvas.getZoom(),
    };
  }, areaKey);

const countObjects = (page: Page, areaKey: AreaKey): Promise<number> =>
  page.evaluate(
    (key) =>
      (window.__studioCanvas?.getObjects() ?? []).filter(
        (o) => (o as { assetId?: string; printAreaKey?: string }).assetId &&
          (o as { printAreaKey?: string }).printAreaKey === key,
      ).length,
    areaKey,
  );

const expectInsidePrintArea = (state: ObjectState, areaKey: AreaKey): void => {
  const area = PRINT_AREAS[areaKey];
  expect(state.box.left).toBeGreaterThanOrEqual(area.x - 1);
  expect(state.box.top).toBeGreaterThanOrEqual(area.y - 1);
  expect(state.box.left + state.box.width).toBeLessThanOrEqual(area.x + area.width + 1);
  expect(state.box.top + state.box.height).toBeLessThanOrEqual(area.y + area.height + 1);
};

const uploadToActiveArea = async (page: Page, areaKey: AreaKey): Promise<void> => {
  const before = await countObjects(page, areaKey);
  await page.setInputFiles('[data-testid=upload-input]', FIXTURE);
  await page.waitForFunction(
    ({ key, prev }) =>
      (window.__studioCanvas?.getObjects() ?? []).filter(
        (o) => (o as { assetId?: string }).assetId &&
          (o as { printAreaKey?: string }).printAreaKey === key,
      ).length > prev,
    { key: areaKey, prev: before },
  );
};

/** Waits until the area's object visibility settles (tab-switch effect ran). */
const waitForVisibility = (page: Page, areaKey: AreaKey, visible: boolean): Promise<unknown> =>
  page.waitForFunction(
    ({ key, want }) =>
      (window.__studioCanvas?.getObjects() ?? []).some(
        (o) =>
          (o as { assetId?: string }).assetId &&
          (o as { printAreaKey?: string }).printAreaKey === key &&
          (o as { visible?: boolean }).visible === want,
      ),
    { key: areaKey, want: visible },
  );

const dragObjectBy = async (page: Page, areaKey: AreaKey, dx: number, dy: number): Promise<void> => {
  const state = await getObjectState(page, areaKey);
  const stageBox = await page.getByTestId('editor-stage').boundingBox();
  if (!stageBox) throw new Error('editor stage not visible');
  const cx = stageBox.x + state.left * state.zoom;
  const cy = stageBox.y + state.top * state.zoom;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy + dy, { steps: 10 });
  await page.mouse.up();
};

test('editor flow (front only): open, upload, move, resize, save, render, preview', async ({ page }) => {
  // 1. Home shows the seeded template; open the editor.
  await page.goto('/');
  await page.getByTestId('template-classic-tee').click();
  await expect(page).toHaveURL(/\/editor\/classic-tee/);

  // 2. Canvas booted with the template base image; front tab is active by default.
  await page.waitForFunction(() => Boolean(window.__studioCanvas?.backgroundImage));
  await expect(page.getByTestId('area-tab-front')).toHaveAttribute('aria-selected', 'true');

  // 3. Upload the fixture logo onto the front.
  await uploadToActiveArea(page, 'front');

  const initial = await getObjectState(page, 'front');
  expectInsidePrintArea(initial, 'front');

  const stageBox = await page.getByTestId('editor-stage').boundingBox();
  if (!stageBox) throw new Error('editor stage not visible');
  const zoom = initial.zoom;

  // 4. MOVE: drag the object from its center by +30/+30 display px.
  await dragObjectBy(page, 'front', 30, 30);
  const afterMove = await getObjectState(page, 'front');
  expect(afterMove.left).not.toBeCloseTo(initial.left, 0);
  expectInsidePrintArea(afterMove, 'front');

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

  const afterResize = await getObjectState(page, 'front');
  expect(afterResize.width).toBeGreaterThan(afterMove.width + 5);
  expectInsidePrintArea(afterResize, 'front');
  void zoom;

  // 6. Save the design; server validates and persists it.
  await page.getByTestId('save-design').click();
  await expect(page.getByTestId('editor-status')).toContainText('Design saved');

  // 7. Generate the mockups; lands on the preview page with a real front image and no back.
  await page.getByTestId('generate-mockup').click();
  await page.waitForURL(/\/designs\/[0-9a-f-]{36}/);

  const preview = page.getByTestId('preview-image-front');
  await expect(preview).toBeVisible();
  const naturalWidth = await preview.evaluate((el) => (el as HTMLImageElement).naturalWidth);
  expect(naturalWidth).toBeGreaterThan(0);
  await expect(page.getByTestId('preview-image-back')).toHaveCount(0);
});

test('multi-area flow: front + back artwork, switch preserves state, both previews render, edit reloads both', async ({ page }) => {
  await page.goto('/editor/classic-tee');
  await page.waitForFunction(() => Boolean(window.__studioCanvas?.backgroundImage));

  // --- Front artwork ---
  await uploadToActiveArea(page, 'front');
  const frontState = await getObjectState(page, 'front');
  expectInsidePrintArea(frontState, 'front');

  // --- Switch to back: front object stays on canvas but goes hidden ---
  await page.getByTestId('area-tab-back').click();
  await expect(page.getByTestId('area-tab-back')).toHaveAttribute('aria-selected', 'true');
  await waitForVisibility(page, 'front', false);
  const frontHidden = await getObjectState(page, 'front');
  expect(frontHidden.visible).toBe(false);
  expect(frontHidden.left).toBeCloseTo(frontState.left, 0); // geometry untouched

  // --- Back artwork ---
  await uploadToActiveArea(page, 'back');
  const backState = await getObjectState(page, 'back');
  expect(backState.visible).toBe(true);
  expectInsidePrintArea(backState, 'back');

  // Move the back object near the TOP of the back area: inside back (y >= 240) but
  // OUTSIDE the front area (y < 270). If hidden objects were validated against the
  // active area, the save below would fail; per-area validation must accept it.
  const targetBoxTop = PRINT_AREAS.back.y + 5;
  const dyCanvas = targetBoxTop - backState.box.top;
  await dragObjectBy(page, 'back', 0, dyCanvas * backState.zoom);
  const backMoved = await getObjectState(page, 'back');
  expectInsidePrintArea(backMoved, 'back');
  expect(backMoved.box.top).toBeLessThan(PRINT_AREAS.front.y); // proves it violates FRONT bounds

  // --- Switch back to front: front artwork remains, back goes hidden but keeps geometry ---
  await page.getByTestId('area-tab-front').click();
  await waitForVisibility(page, 'front', true);
  const frontAgain = await getObjectState(page, 'front');
  expect(frontAgain.visible).toBe(true);
  expect(frontAgain.left).toBeCloseTo(frontState.left, 0);
  const backHidden = await getObjectState(page, 'back');
  expect(backHidden.visible).toBe(false);
  expect(backHidden.top).toBeCloseTo(backMoved.top, 0);

  // Tab badges: one object on each side.
  await expect(page.getByTestId('area-tab-front')).toContainText('1');
  await expect(page.getByTestId('area-tab-back')).toContainText('1');

  // --- Save with the front tab active; hidden back object must save correctly ---
  await page.getByTestId('save-design').click();
  await expect(page.getByTestId('editor-status')).toContainText('Design saved');

  // --- Render: preview page shows BOTH sides ---
  await page.getByTestId('generate-mockup').click();
  await page.waitForURL(/\/designs\/[0-9a-f-]{36}/);
  const designId = page.url().match(/\/designs\/([0-9a-f-]{36})/)?.[1];
  expect(designId).toBeTruthy();

  for (const key of ['front', 'back'] as const) {
    const img = page.getByTestId(`preview-image-${key}`);
    await expect(img).toBeVisible();
    const naturalWidth = await img.evaluate((el) => (el as HTMLImageElement).naturalWidth);
    expect(naturalWidth).toBeGreaterThan(0);
  }

  // --- Re-open: both areas reload with their objects ---
  await page.getByTestId('edit-design').click();
  await page.waitForURL(new RegExp(`/editor/classic-tee\\?design=${designId}`));
  await page.waitForFunction(
    () =>
      (window.__studioCanvas?.getObjects() ?? []).filter(
        (o) => (o as { assetId?: string }).assetId,
      ).length === 2,
  );
  await expect(page.getByTestId('editing-badge')).toContainText('Editing saved design');

  const reloadedFront = await getObjectState(page, 'front');
  const reloadedBack = await getObjectState(page, 'back');
  expectInsidePrintArea(reloadedFront, 'front');
  expectInsidePrintArea(reloadedBack, 'back');
  expect(reloadedBack.top).toBeCloseTo(backMoved.top, 0); // back position persisted
  // First placement (front) is the initially active tab; back stays hidden.
  expect(reloadedFront.visible).toBe(true);
  expect(reloadedBack.visible).toBe(false);

  // Mockup button enabled (design saved and clean), Save disabled until something changes.
  await expect(page.getByTestId('generate-mockup')).toBeEnabled();
  await expect(page.getByTestId('save-design')).toBeDisabled();

  // --- Update ONE area (move the front object), save, re-render ---
  await dragObjectBy(page, 'front', -25, -30);
  const afterEdit = await getObjectState(page, 'front');
  expect(afterEdit.left).not.toBeCloseTo(reloadedFront.left, 0);
  expectInsidePrintArea(afterEdit, 'front');

  // Dirty state: mockups blocked until the change is saved.
  await expect(page.getByTestId('generate-mockup')).toBeDisabled();

  await page.getByTestId('save-design').click();
  await expect(page.getByTestId('editor-status')).toContainText('Design updated');

  await page.getByTestId('generate-mockup').click();
  await page.waitForURL(new RegExp(`/designs/${designId}`));

  // Preview updated: both sides render again.
  for (const key of ['front', 'back'] as const) {
    const img = page.getByTestId(`preview-image-${key}`);
    await expect(img).toBeVisible();
    const naturalWidth = await img.evaluate((el) => (el as HTMLImageElement).naturalWidth);
    expect(naturalWidth).toBeGreaterThan(0);
  }
});
