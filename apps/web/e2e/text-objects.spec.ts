import { expect, test, type Page } from '@playwright/test';

// Matches the seeded "classic-tee" front print area (apps/api/prisma/seed.ts).
const FRONT_AREA = { x: 361, y: 270, width: 533, height: 760 } as const;

interface TextState {
  left: number;
  top: number;
  angle: number;
  text: string;
  fontKey: string;
  fill: string;
  textAlign: string;
  effectiveFontSize: number;
  visible: boolean;
  box: { left: number; top: number; width: number; height: number };
  zoom: number;
}

/** State of the first text object on the canvas. */
const getTextState = (page: Page): Promise<TextState> =>
  page.evaluate(() => {
    const canvas = window.__studioCanvas as unknown as {
      getZoom(): number;
      getObjects(): Array<{
        kind?: string;
        fontKey?: string;
        text?: string;
        fill?: string;
        textAlign?: string;
        fontSize?: number;
        scaleY?: number;
        visible: boolean;
        left: number;
        top: number;
        angle: number;
        getBoundingRect(): { left: number; top: number; width: number; height: number };
      }>;
    };
    const obj = canvas.getObjects().find((o) => o.kind === 'text');
    if (!obj) throw new Error('no text object on canvas');
    return {
      left: obj.left,
      top: obj.top,
      angle: obj.angle,
      text: obj.text ?? '',
      fontKey: obj.fontKey ?? '',
      fill: String(obj.fill ?? ''),
      textAlign: obj.textAlign ?? '',
      effectiveFontSize: (obj.fontSize ?? 0) * (obj.scaleY ?? 1),
      visible: obj.visible,
      box: obj.getBoundingRect(),
      zoom: canvas.getZoom(),
    };
  });

const expectInsideFrontArea = (state: TextState): void => {
  expect(state.box.left).toBeGreaterThanOrEqual(FRONT_AREA.x - 1);
  expect(state.box.top).toBeGreaterThanOrEqual(FRONT_AREA.y - 1);
  expect(state.box.left + state.box.width).toBeLessThanOrEqual(FRONT_AREA.x + FRONT_AREA.width + 1);
  expect(state.box.top + state.box.height).toBeLessThanOrEqual(FRONT_AREA.y + FRONT_AREA.height + 1);
};

test('text objects: add, style, move, resize, save, render, reopen', async ({ page }) => {
  await page.goto('/editor/classic-tee');
  await page.waitForFunction(() => Boolean(window.__studioCanvas?.backgroundImage));

  // --- Add: a text object lands centered in the front area, selected ---
  await page.getByTestId('tool-text').click(); // open the Text panel in the studio rail
  await page.getByTestId('add-text-button').click();
  await page.waitForFunction(
    () => (window.__studioCanvas?.getObjects() ?? []).some((o) => (o as { kind?: string }).kind === 'text'),
  );
  const initial = await getTextState(page);
  expect(initial.text).toBe('Your text');
  expect(initial.fontKey).toBe('inter');
  expectInsideFrontArea(initial);

  // The styling panel is shown for the selected text object.
  await expect(page.getByTestId('text-panel')).toBeVisible();

  // --- Style: font, color (swatch), size, align ---
  await page.getByTestId('text-font-select').selectOption('oswald');
  await page.getByTestId('text-swatch-cf3f22').click();
  await page.getByTestId('text-size-input').fill('36');
  await page.getByTestId('text-align-left').click();

  const styled = await getTextState(page);
  expect(styled.fontKey).toBe('oswald');
  expect(styled.fill).toBe('#cf3f22');
  expect(Math.round(styled.effectiveFontSize)).toBe(36);
  expect(styled.textAlign).toBe('left');
  expectInsideFrontArea(styled);

  // --- Move: drag the text from its center ---
  const stageBox = await page.getByTestId('editor-stage').boundingBox();
  if (!stageBox) throw new Error('editor stage not visible');
  const cx = stageBox.x + styled.left * styled.zoom;
  const cy = stageBox.y + styled.top * styled.zoom;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 20, cy + 35, { steps: 10 });
  await page.mouse.up();

  const moved = await getTextState(page);
  expect(moved.top).not.toBeCloseTo(styled.top, 0);
  expectInsideFrontArea(moved);

  // --- Resize: drag the bottom-right handle outward (uniform corner scale) ---
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
  await page.mouse.move(stageBox.x + corner.x + 20, stageBox.y + corner.y + 20, { steps: 10 });
  await page.mouse.up();

  const resized = await getTextState(page);
  expect(resized.effectiveFontSize).toBeGreaterThan(moved.effectiveFontSize + 1);
  expectInsideFrontArea(resized);

  // --- Save + render ---
  await page.getByTestId('save-design').click();
  await expect(page.getByTestId('editor-status')).toContainText('Design saved');

  await page.getByTestId('generate-mockup').click();
  await page.waitForURL(/\/designs\/[0-9a-f-]{36}/);
  const designId = page.url().match(/\/designs\/([0-9a-f-]{36})/)?.[1];
  expect(designId).toBeTruthy();

  const preview = page.getByTestId('preview-image-front');
  await expect(preview).toBeVisible();
  expect(await preview.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

  // --- Reopen: the text object restores with content, styling, and position ---
  await page.getByTestId('edit-design').click();
  await page.waitForURL(new RegExp(`/editor/classic-tee\\?design=${designId}`));
  await page.waitForFunction(
    () => (window.__studioCanvas?.getObjects() ?? []).some((o) => (o as { kind?: string }).kind === 'text'),
  );

  const reopened = await getTextState(page);
  expect(reopened.text).toBe('Your text');
  expect(reopened.fontKey).toBe('oswald');
  expect(reopened.fill).toBe('#cf3f22');
  expect(reopened.textAlign).toBe('left');
  expect(reopened.left).toBeCloseTo(resized.left, 0);
  expect(reopened.top).toBeCloseTo(resized.top, 0);
  expectInsideFrontArea(reopened);

  // --- Delete: removing the text empties the canvas again ---
  await page.evaluate(() => {
    const canvas = window.__studioCanvas as unknown as {
      getObjects(): Array<Record<string, unknown>>;
      setActiveObject(obj: unknown): void;
      requestRenderAll(): void;
    };
    const text = canvas.getObjects().find((o) => (o as { kind?: string }).kind === 'text');
    canvas.setActiveObject(text);
    canvas.requestRenderAll();
  });
  await page.getByTestId('delete-object').click();
  await page.waitForFunction(
    () => !(window.__studioCanvas?.getObjects() ?? []).some((o) => (o as { kind?: string }).kind === 'text'),
  );
});

test('text effects: outline and shadow set in the panel survive save, render, reopen', async ({ page }) => {
  await page.goto('/editor/classic-tee');
  await page.waitForFunction(() => Boolean(window.__studioCanvas?.backgroundImage));

  await page.getByTestId('tool-text').click();
  await page.getByTestId('add-text-button').click();
  await page.waitForFunction(
    () => (window.__studioCanvas?.getObjects() ?? []).some((o) => (o as { kind?: string }).kind === 'text'),
  );

  // Enable both effects, set letter spacing, all through the panel controls.
  await page.getByTestId('text-outline-toggle').check();
  await page.getByTestId('text-outline-width').fill('6');
  await page.getByTestId('text-shadow-toggle').check();
  await page.getByTestId('text-shadow-x').fill('8');
  await page.getByTestId('text-letter-spacing-input').fill('10');

  const effectsState = () =>
    page.evaluate(() => {
      const obj = (window.__studioCanvas?.getObjects() ?? []).find(
        (o) => (o as { kind?: string }).kind === 'text',
      ) as
        | {
            stroke?: unknown;
            strokeWidth?: number;
            charSpacing?: number;
            fontSize?: number;
            scaleY?: number;
            shadow?: { color?: string; offsetX?: number; offsetY?: number } | null;
          }
        | undefined;
      if (!obj) throw new Error('no text object on canvas');
      return {
        stroke: obj.stroke,
        strokeWidth: obj.strokeWidth,
        shadow: obj.shadow ? { x: obj.shadow.offsetX, y: obj.shadow.offsetY } : null,
        spacingPx: ((obj.charSpacing ?? 0) / 1000) * (obj.fontSize ?? 0) * (obj.scaleY ?? 1),
        charSpacing: obj.charSpacing,
        fontSize: obj.fontSize,
        scaleY: obj.scaleY,
      };
    });

  const before = await effectsState();
  expect(before.stroke).toBe('#ffffff');
  expect(before.strokeWidth).toBe(6);
  expect(before.shadow).toEqual({ x: 8, y: 4 });
  expect(before.spacingPx).toBeCloseTo(10, 0);

  // Save, render, reopen: the effects round-trip through the stored document.
  await page.getByTestId('save-design').click();
  await expect(page.getByTestId('editor-status')).toContainText('Design saved');
  await page.getByTestId('generate-mockup').click();
  await page.waitForURL(/\/designs\/[0-9a-f-]{36}/);
  await page.getByTestId('edit-design').click();
  await page.waitForURL(/\/editor\/classic-tee\?design=/);
  await page.waitForFunction(
    () => (window.__studioCanvas?.getObjects() ?? []).some((o) => (o as { kind?: string }).kind === 'text'),
  );

  const after = await effectsState();
  expect(after.stroke).toBe('#ffffff');
  expect(after.strokeWidth).toBeCloseTo(6, 0);
  expect(after.shadow?.x).toBeCloseTo(8, 0);
  expect(after.shadow?.y).toBeCloseTo(4, 0);
  expect(after.spacingPx).toBeCloseTo(10, 0);
  // Reopen must not inflate outlined text (stroke-inclusive box math).
  expect(after.scaleY ?? 1).toBeCloseTo(1, 1);
});

test('arc text: bend a line, edit wording, save, render, reopen', async ({ page }) => {
  await page.goto('/editor/classic-tee');
  await page.waitForFunction(() => Boolean(window.__studioCanvas?.backgroundImage));

  await page.getByTestId('tool-text').click();
  await page.getByTestId('add-text-button').click();
  await page.waitForFunction(
    () => (window.__studioCanvas?.getObjects() ?? []).some((o) => (o as { kind?: string }).kind === 'text'),
  );

  // Bend it: the IText becomes a tagged arc-image (kind text, arcProps set).
  await page.getByTestId('text-arc-toggle').click();
  const arcState = () =>
    page.evaluate(() => {
      const obj = (window.__studioCanvas?.getObjects() ?? []).find(
        (o) => (o as { kind?: string }).kind === 'text',
      ) as { arcProps?: { arc: number; text: string } } | undefined;
      return obj?.arcProps ?? null;
    });
  const bent = await arcState();
  expect(bent?.arc).toBe(90);

  // Change the bend and the wording through the panel.
  await page.getByTestId('text-arc-slider').fill('140');
  await page.getByTestId('arc-text-input').fill('CURVED');
  await page.getByTestId('arc-text-input').blur();
  const edited = await arcState();
  expect(edited?.arc).toBe(140);
  expect(edited?.text).toBe('CURVED');

  // Save, render, reopen: the arc persists as a text object with arc.
  await page.getByTestId('save-design').click();
  await expect(page.getByTestId('editor-status')).toContainText('Design saved');
  await page.getByTestId('generate-mockup').click();
  await page.waitForURL(/\/designs\/[0-9a-f-]{36}/);
  await page.getByTestId('edit-design').click();
  await page.waitForURL(/\/editor\/classic-tee\?design=/);
  await page.waitForFunction(
    () => (window.__studioCanvas?.getObjects() ?? []).some((o) => (o as { kind?: string }).kind === 'text'),
  );
  const reopened = await arcState();
  expect(reopened?.arc).toBe(140);
  expect(reopened?.text).toBe('CURVED');

  // Straighten it back to a normal IText.
  await page.evaluate(() => {
    const canvas = window.__studioCanvas as unknown as {
      getObjects(): Array<Record<string, unknown>>;
      setActiveObject(o: unknown): void;
      requestRenderAll(): void;
    };
    const obj = canvas.getObjects().find((o) => (o as { kind?: string }).kind === 'text');
    canvas.setActiveObject(obj);
    canvas.requestRenderAll();
  });
  await page.getByTestId('text-arc-none').click();
  expect(await arcState()).toBeNull();
});

test('mixed design: image and text on the same area save and render together', async ({ page }) => {
  await page.goto('/editor/classic-tee');
  await page.waitForFunction(() => Boolean(window.__studioCanvas?.backgroundImage));

  // Image first.
  const fixture = `${__dirname}/fixtures/logo.png`;
  await page.setInputFiles('[data-testid=upload-input]', fixture);
  await page.waitForFunction(
    () => (window.__studioCanvas?.getObjects() ?? []).some((o) => (o as { kind?: string }).kind === 'image'),
  );

  // Then text on the same area.
  await page.getByTestId('tool-text').click(); // open the Text panel in the studio rail
  await page.getByTestId('add-text-button').click();
  await page.waitForFunction(
    () => (window.__studioCanvas?.getObjects() ?? []).some((o) => (o as { kind?: string }).kind === 'text'),
  );

  // Both count toward the front tab badge.
  await expect(page.getByTestId('area-tab-front')).toContainText('2');

  await page.getByTestId('save-design').click();
  await expect(page.getByTestId('editor-status')).toContainText('Design saved');

  await page.getByTestId('generate-mockup').click();
  await page.waitForURL(/\/designs\/[0-9a-f-]{36}/);
  const preview = page.getByTestId('preview-image-front');
  await expect(preview).toBeVisible();
  expect(await preview.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
});
