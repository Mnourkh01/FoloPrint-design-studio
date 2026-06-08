import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';

const FIXTURE = join(__dirname, 'fixtures', 'logo.png');

const objectCount = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      (window.__studioCanvas?.getObjects() ?? []).filter((o) => (o as { kind?: string }).kind)
        .length,
  );

const waitForObjectCount = (page: Page, count: number): Promise<unknown> =>
  page.waitForFunction(
    (want) =>
      (window.__studioCanvas?.getObjects() ?? []).filter((o) => (o as { kind?: string }).kind)
        .length === want,
    count,
  );

const imageState = (page: Page): Promise<{ left: number; top: number }> =>
  page.evaluate(() => {
    const obj = (window.__studioCanvas?.getObjects() ?? []).find(
      (o) => (o as { assetId?: string }).assetId,
    ) as { left: number; top: number } | undefined;
    if (!obj) throw new Error('no image object');
    return { left: obj.left, top: obj.top };
  });

const upload = async (page: Page): Promise<void> => {
  await page.setInputFiles('[data-testid=upload-input]', FIXTURE);
  await waitForObjectCount(page, 1);
};

test('undo/redo: add, move, and style steps via buttons and keyboard', async ({ page }) => {
  await page.goto('/editor/classic-tee');
  await page.waitForFunction(() => Boolean(window.__studioCanvas?.backgroundImage));

  // Empty history: both buttons disabled.
  await expect(page.getByTestId('undo-button')).toBeDisabled();
  await expect(page.getByTestId('redo-button')).toBeDisabled();

  // Step 1: upload (history step "add").
  await upload(page);
  await expect(page.getByTestId('undo-button')).toBeEnabled();
  const placed = await imageState(page);

  // Step 2: align left through the Position tool (history step "move").
  await page.getByTestId('context-tool-position').click();
  await page.getByTestId('align-left').click();
  const moved = await imageState(page);
  expect(moved.left).not.toBeCloseTo(placed.left, 0);

  // Undo the move: position returns to the drop point.
  await page.getByTestId('undo-button').click();
  await page.waitForFunction(
    (want) => {
      const obj = (window.__studioCanvas?.getObjects() ?? []).find(
        (o) => (o as { assetId?: string }).assetId,
      ) as { left: number } | undefined;
      return obj !== undefined && Math.abs(obj.left - want) < 1;
    },
    placed.left,
  );

  // Undo the add: canvas empties, undo exhausts, redo arms.
  await page.getByTestId('undo-button').click();
  await waitForObjectCount(page, 0);
  await expect(page.getByTestId('undo-button')).toBeDisabled();
  await expect(page.getByTestId('redo-button')).toBeEnabled();

  // Redo both steps via the keyboard (Ctrl+Y and Ctrl+Shift+Z).
  await page.keyboard.press('Control+y');
  await waitForObjectCount(page, 1);
  await page.keyboard.press('Control+Shift+z');
  await page.waitForFunction(
    (want) => {
      const obj = (window.__studioCanvas?.getObjects() ?? []).find(
        (o) => (o as { assetId?: string }).assetId,
      ) as { left: number } | undefined;
      return obj !== undefined && Math.abs(obj.left - want) < 1;
    },
    moved.left,
  );

  // Ctrl+Z works too, and a redone state can be saved.
  await page.keyboard.press('Control+z');
  await page.waitForFunction(
    (want) => {
      const obj = (window.__studioCanvas?.getObjects() ?? []).find(
        (o) => (o as { assetId?: string }).assetId,
      ) as { left: number } | undefined;
      return obj !== undefined && Math.abs(obj.left - want) < 1;
    },
    placed.left,
  );

  await page.getByTestId('save-design').click();
  await expect(page.getByTestId('editor-status')).toContainText('Design saved');
});

test('undo restores deleted text with its styling intact', async ({ page }) => {
  await page.goto('/editor/classic-tee');
  await page.waitForFunction(() => Boolean(window.__studioCanvas?.backgroundImage));

  await page.getByTestId('tool-text').click();
  await page.getByTestId('add-text-button').click();
  await waitForObjectCount(page, 1);

  // Style it (each panel change is one history step).
  await page.getByTestId('fx-outline-white').click();
  await page.getByTestId('delete-object').click();
  await waitForObjectCount(page, 0);

  // Undo the delete: text returns WITH the outline.
  await page.getByTestId('undo-button').click();
  await waitForObjectCount(page, 1);
  const stroke = await page.evaluate(() => {
    const obj = (window.__studioCanvas?.getObjects() ?? []).find(
      (o) => (o as { kind?: string }).kind === 'text',
    ) as { stroke?: unknown; strokeWidth?: number } | undefined;
    return { stroke: obj?.stroke, strokeWidth: obj?.strokeWidth };
  });
  expect(stroke.stroke).toBe('#ffffff');
  expect(stroke.strokeWidth).toBeGreaterThan(0);
});
