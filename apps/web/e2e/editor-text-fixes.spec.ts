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

  await page.getByTestId('font-pick-oswald').click();
  expect(await activeTextProp(page, 'fontFamily')).toContain('Oswald');
  expect(await activeTextProp(page, 'fontKey')).toBe('oswald');
});

test('expanded font library: categories render and new fonts apply + load', async ({ page }) => {
  await addText(page);

  // The picker is grouped by category (Sans, Display, Serif, Slab, Script, Fun, Arabic).
  await expect(page.locator('.font-picker__cat')).toHaveCount(7);
  await expect(page.locator('[data-testid^="font-pick-"]').first()).toBeVisible();
  expect(await page.locator('[data-testid^="font-pick-"]').count()).toBeGreaterThanOrEqual(20);

  // A new display font applies and its face is actually loaded (not a fallback).
  await page.getByTestId('font-pick-anton').click();
  expect(await activeTextProp(page, 'fontKey')).toBe('anton');
  expect(await activeTextProp(page, 'fontFamily')).toContain('Anton');
  await expect
    .poll(() => page.evaluate(() => [...document.fonts].some((f) => f.family === 'Anton' && f.status === 'loaded')))
    .toBe(true);

  // A new Arabic font applies too.
  await page.getByTestId('font-pick-cairo').click();
  expect(await activeTextProp(page, 'fontKey')).toBe('cairo');
});

test('starter template drops editable text lines onto the design', async ({ page }) => {
  await page.goto('/editor/classic-tee');
  await page.waitForFunction(() => Boolean(window.__studioCanvas?.backgroundImage));

  await page.getByTestId('tool-templates').click();
  await expect(page.getByTestId('template-gallery')).toBeVisible();
  await page.getByTestId('template-varsity-stack').click();

  // Three real, editable text objects land on the canvas.
  await page.waitForFunction(
    () => (window.__studioCanvas?.getObjects() ?? []).filter((o) => (o as { kind?: string }).kind === 'text').length >= 3,
  );
  const texts = await page.evaluate(() =>
    (window.__studioCanvas?.getObjects() ?? [])
      .filter((o) => (o as { kind?: string }).kind === 'text')
      .map((o) => (o as { text?: string }).text),
  );
  expect(texts).toContain('BROOKLYN');
  expect(texts).toContain('ATHLETIC CLUB');
});

test('text style presets apply a full look and color recents populate', async ({ page }) => {
  await addText(page);

  // One-tap "Varsity" look sets font + fill + outline together.
  await page.getByTestId('text-style-varsity').click();
  expect(await activeTextProp(page, 'fontKey')).toBe('archivo-black');
  expect(await activeTextProp(page, 'fill')).toBe('#1d4ed8');
  expect(await activeTextProp(page, 'stroke')).toBe('#ffffff');

  // Picking a swatch applies it and adds a reusable recent chip.
  await page.getByTestId('text-swatch-16a34a').click();
  expect(await activeTextProp(page, 'fill')).toBe('#16a34a');
  await expect(page.getByTestId('text-recent-16a34a')).toBeVisible();

  // Expanded outline + shadow preset sets exist.
  await expect(page.getByTestId('fx-outline-gold')).toBeVisible();
  await expect(page.getByTestId('fx-shadow-pop')).toBeVisible();
});

test('the wording field edits the text content live as you type', async ({ page }) => {
  await addText(page);

  // No apply/Enter/double-click: filling the field mirrors straight to the canvas.
  await page.getByTestId('text-wording-input').fill('FoloPrint Rocks');
  await expect.poll(() => activeTextProp(page, 'text')).toBe('FoloPrint Rocks');
});

test('Enter inserts a new line in the wording field', async ({ page }) => {
  await addText(page);

  const input = page.getByTestId('text-wording-input');
  await input.click();
  await input.fill('');
  await input.pressSequentially('Hi');
  await input.press('Enter');
  await input.pressSequentially('There');

  await expect.poll(() => activeTextProp(page, 'text')).toBe('Hi\nThere');
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
