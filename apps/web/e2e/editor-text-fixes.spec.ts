import { expect, test, type Page } from '@playwright/test';

const addText = async (page: Page): Promise<void> => {
  await page.goto('/editor/classic-tee');
  await page.waitForFunction(() => Boolean(window.__studioCanvas?.backgroundImage));
  await page.getByTestId('tool-text').click();
  await page.getByTestId('add-text-button').click();
  await page.waitForFunction(
    () => (window.__studioCanvas?.getObjects() ?? []).some((o) => (o as { kind?: string }).kind === 'text'),
  );
};

const activeTextProp = (page: Page, prop: string): Promise<unknown> =>
  page.evaluate((p) => {
    const t = (window.__studioCanvas?.getObjects() ?? []).find(
      (o) => (o as { kind?: string }).kind === 'text',
    ) as Record<string, unknown> | undefined;
    return t?.[p];
  }, prop);

test('whitelist fonts actually load and the font picker changes the rendered font', async ({ page }) => {
  await addText(page);

  // Regression: the loader used document.fonts.check() which returns true for any
  // unknown family, so it skipped loading every whitelist font and text fell back.
  await page.waitForFunction(() => {
    const loaded = [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family);
    return loaded.some((f) => f.includes('Oswald')) && loaded.some((f) => f.includes('Caveat'));
  });

  await page.getByTestId('text-font-select').selectOption('oswald');
  expect(await activeTextProp(page, 'fontFamily')).toContain('Oswald');
  expect(await activeTextProp(page, 'fontKey')).toBe('oswald');
});

test('the wording field edits the text content from the panel', async ({ page }) => {
  await addText(page);

  await page.getByTestId('text-wording-input').fill('FoloPrint Rocks');
  await page.getByTestId('text-wording-input').press('Enter');

  await expect.poll(() => activeTextProp(page, 'text')).toBe('FoloPrint Rocks');
});

test('the Mockups tab renders and shows the preview (save then view)', async ({ page }) => {
  await addText(page);
  await page.getByTestId('save-design').click();
  await expect(page.getByTestId('editor-status')).toContainText('Design saved');

  await page.getByTestId('mode-mockups').click();
  await page.waitForURL(/\/designs\/[0-9a-f-]{36}/);
  // The page must show a real preview, not the "no current previews" empty state.
  await expect(page.getByTestId('preview-image-front')).toBeVisible();
  await expect(page.getByTestId('preview-empty')).toHaveCount(0);
});

test('Ctrl+wheel over the stage zooms the viewport', async ({ page }) => {
  await page.goto('/editor/classic-tee');
  await page.waitForFunction(() => Boolean(window.__studioCanvas?.backgroundImage));

  const read = () => page.getByTestId('zoom-value').textContent();
  const before = await read();
  const zoomBy = (deltaY: number) =>
    page.evaluate((dy) => {
      const stage = document.querySelector('[data-testid="editor-stage"]')!;
      const r = stage.getBoundingClientRect();
      stage.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: dy,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2,
        }),
      );
    }, deltaY);

  await zoomBy(-300); // zoom in
  await expect.poll(read).not.toBe(before);
  const zoomedIn = Number((await read())!.replace('%', ''));
  expect(zoomedIn).toBeGreaterThan(Number(before!.replace('%', '')));
});
