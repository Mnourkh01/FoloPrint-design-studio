import { expect, test, type Page } from '@playwright/test';

/**
 * v1.6: RTL/Arabic text + wrap-in-box. Drives the real editor: types Arabic through
 * Fabric's hidden textarea (the browser input path), watches Auto direction resolve,
 * wraps in a box, narrows it by dragging the side handle, saves, renders, reopens.
 */

interface RtlTextState {
  text: string;
  fontKey: string;
  direction: string;
  textDirection: string;
  isTextbox: boolean;
  width: number;
  lines: string[];
  zoom: number;
}

const getTextState = (page: Page): Promise<RtlTextState> =>
  page.evaluate(() => {
    const canvas = window.__studioCanvas as unknown as {
      getZoom(): number;
      getObjects(): Array<{
        kind?: string;
        fontKey?: string;
        text?: string;
        direction?: string;
        textDirection?: string;
        width: number;
        textLines: string[];
        dynamicMinWidth?: number;
      }>;
    };
    const obj = canvas.getObjects().find((o) => o.kind === 'text');
    if (!obj) throw new Error('no text object on canvas');
    return {
      text: obj.text ?? '',
      fontKey: obj.fontKey ?? '',
      direction: obj.direction ?? '',
      textDirection: obj.textDirection ?? '',
      isTextbox: obj.dynamicMinWidth !== undefined, // Textbox-only field
      width: obj.width,
      lines: [...obj.textLines],
      zoom: canvas.getZoom(),
    };
  });

/** Types into the selected text object through Fabric's hidden textarea. */
const typeIntoText = async (page: Page, value: string): Promise<void> => {
  await page.evaluate((next) => {
    const canvas = window.__studioCanvas as unknown as {
      getActiveObject(): {
        enterEditing(): void;
        exitEditing(): void;
        hiddenTextarea: HTMLTextAreaElement | null;
      } | null;
      requestRenderAll(): void;
    };
    const obj = canvas.getActiveObject();
    if (!obj) throw new Error('no active object');
    obj.enterEditing();
    const ta = obj.hiddenTextarea;
    if (!ta) throw new Error('no hidden textarea');
    ta.value = next;
    ta.setSelectionRange(next.length, next.length);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    obj.exitEditing();
    canvas.requestRenderAll();
  }, value);
};

test('arabic text: auto RTL, wrap in box, reflow, save, render, reopen', async ({ page }) => {
  await page.goto('/editor/classic-tee');
  await page.waitForFunction(() => Boolean(window.__studioCanvas?.backgroundImage));

  // --- Add text, replace the content with Arabic through the editing path ---
  await page.getByTestId('tool-text').click(); // open the Text panel in the studio rail
  await page.getByTestId('add-text-button').click();
  await page.waitForFunction(
    () => (window.__studioCanvas?.getObjects() ?? []).some((o) => (o as { kind?: string }).kind === 'text'),
  );
  await typeIntoText(page, 'مرحبا بالعالم الواسع');

  // Direction + wrap now live under the panel's Advanced disclosure.
  await page.getByTestId('text-advanced-toggle').click();

  // Auto resolved to RTL: canvas direction flips, panel hints the resolution.
  const arabic = await getTextState(page);
  expect(arabic.text).toBe('مرحبا بالعالم الواسع');
  expect(arabic.textDirection).toBe('auto');
  expect(arabic.direction).toBe('rtl');
  await expect(page.getByTestId('text-direction-auto')).toHaveAttribute('data-resolved', 'rtl');
  await expect(page.getByTestId('text-direction-auto')).toHaveClass(/btn--active/);

  // --- Arabic font ---
  await page.getByTestId('font-pick-noto-naskh-arabic').click();
  expect((await getTextState(page)).fontKey).toBe('noto-naskh-arabic');

  // --- Wrap on: IText swaps to Textbox, content and direction preserved ---
  await page.getByTestId('text-wrap-toggle').check();
  const wrapped = await getTextState(page);
  expect(wrapped.isTextbox).toBe(true);
  expect(wrapped.text).toBe('مرحبا بالعالم الواسع');
  expect(wrapped.direction).toBe('rtl');

  // --- Narrow the box with the LEFT side handle: text reflows to more lines ---
  // Drag all the way to the Textbox minimum width (the longest word): Fabric floors
  // the resize there, and a min-width box lays out one word per line on EVERY
  // platform. A fixed-distance drag is a platform lottery instead: Linux and
  // Windows measure Naskh metrics slightly differently, so the same 60px can land
  // on either side of a wrap threshold (seen as 2 -> 2 lines on CI).
  const stageBox = await page.getByTestId('editor-stage').boundingBox();
  if (!stageBox) throw new Error('editor stage not visible');
  const handle = await page.evaluate(() => {
    const obj = window.__studioCanvas?.getActiveObject() as unknown as {
      setCoords(): void;
      oCoords: { ml: { x: number; y: number } };
      dynamicMinWidth: number;
    };
    obj.setCoords();
    return { x: obj.oCoords.ml.x, y: obj.oCoords.ml.y, minWidth: obj.dynamicMinWidth };
  });
  const dragDx = Math.ceil((wrapped.width - handle.minWidth) * wrapped.zoom) + 30;
  await page.mouse.move(stageBox.x + handle.x, stageBox.y + handle.y);
  await page.mouse.down();
  await page.mouse.move(stageBox.x + handle.x + dragDx, stageBox.y + handle.y, { steps: 10 });
  await page.mouse.up();

  const narrowed = await getTextState(page);
  // Sanity: a box starting at the full single-line width never wraps to one word per
  // line on its own, so the reflow below is guaranteed to ADD lines.
  expect(wrapped.lines.length).toBeLessThan(3);
  expect(narrowed.width).toBeLessThan(wrapped.width - 20);
  expect(narrowed.lines.length).toBe(3); // one word per line at the minimum box width
  expect(narrowed.lines.length).toBeGreaterThan(wrapped.lines.length);
  expect(narrowed.lines.join(' ').replace(/\s+/g, ' ')).toBe('مرحبا بالعالم الواسع');

  // --- Save + render: the server accepts the wrapped document and draws a preview ---
  await page.getByTestId('save-design').click();
  await expect(page.getByTestId('editor-status')).toContainText('Design saved');

  await page.getByTestId('generate-mockup').click();
  await page.waitForURL(/\/designs\/[0-9a-f-]{36}/);
  const designId = page.url().match(/\/designs\/([0-9a-f-]{36})/)?.[1];
  expect(designId).toBeTruthy();
  const preview = page.getByTestId('preview-image-front');
  await expect(preview).toBeVisible();
  expect(await preview.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

  // --- Reopen: Textbox restores with text, direction, wrap mode, width, and lines ---
  await page.getByTestId('edit-design').click();
  await page.waitForURL(new RegExp(`/editor/classic-tee\\?design=${designId}`));
  await page.waitForFunction(
    () => (window.__studioCanvas?.getObjects() ?? []).some((o) => (o as { kind?: string }).kind === 'text'),
  );

  const reopened = await getTextState(page);
  expect(reopened.text).toBe('مرحبا بالعالم الواسع');
  expect(reopened.fontKey).toBe('noto-naskh-arabic');
  expect(reopened.textDirection).toBe('auto');
  expect(reopened.direction).toBe('rtl');
  expect(reopened.isTextbox).toBe(true);
  expect(reopened.width).toBeCloseTo(narrowed.width, 0);
  expect(reopened.lines).toEqual(narrowed.lines);

  // The panel reflects the restored wrap state once the object is selected.
  await page.evaluate(() => {
    const canvas = window.__studioCanvas as unknown as {
      getObjects(): Array<Record<string, unknown>>;
      setActiveObject(obj: unknown): void;
      fire(event: string, payload: unknown): void;
      requestRenderAll(): void;
    };
    const text = canvas.getObjects().find((o) => (o as { kind?: string }).kind === 'text');
    canvas.setActiveObject(text);
    canvas.fire('selection:created', { selected: [text] });
    canvas.requestRenderAll();
  });
  await page.getByTestId('text-advanced-toggle').click(); // wrap lives under Advanced
  await expect(page.getByTestId('text-wrap-toggle')).toBeChecked();
});

test('overflow warning: more than 8 wrapped lines blocks saving', async ({ page }) => {
  await page.goto('/editor/classic-tee');
  await page.waitForFunction(() => Boolean(window.__studioCanvas?.backgroundImage));

  await page.getByTestId('tool-text').click(); // open the Text panel in the studio rail
  await page.getByTestId('add-text-button').click();
  await page.waitForFunction(
    () => (window.__studioCanvas?.getObjects() ?? []).some((o) => (o as { kind?: string }).kind === 'text'),
  );

  // Nine explicit lines wrap to nine visual lines in any box.
  await typeIntoText(page, Array(9).fill('سطر').join('\n'));
  await page.getByTestId('text-advanced-toggle').click(); // wrap lives under Advanced
  await page.getByTestId('text-wrap-toggle').check();

  await expect(page.getByTestId('text-overflow-warning')).toBeVisible();

  await page.getByTestId('save-design').click();
  await expect(page.getByTestId('editor-status')).toContainText('more than 8 lines');

  // Trimming back to 8 lines clears the warning and save goes through.
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
  await typeIntoText(page, Array(8).fill('سطر').join('\n'));
  await expect(page.getByTestId('text-overflow-warning')).not.toBeVisible();

  await page.getByTestId('save-design').click();
  await expect(page.getByTestId('editor-status')).toContainText('Design saved');
});
