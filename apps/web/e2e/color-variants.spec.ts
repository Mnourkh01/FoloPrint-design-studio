import { expect, test, type Page } from '@playwright/test';

const backgroundSrc = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const bg = window.__studioCanvas?.backgroundImage as { getSrc?: () => string } | undefined;
    return bg?.getSrc?.() ?? '';
  });

const waitForBackground = (page: Page, urlPart: string): Promise<unknown> =>
  page.waitForFunction((part) => {
    const bg = window.__studioCanvas?.backgroundImage as { getSrc?: () => string } | undefined;
    return (bg?.getSrc?.() ?? '').includes(part);
  }, urlPart);

test('garment color: live swap, save, render, and reopen round-trip', async ({ page }) => {
  await page.goto('/editor/classic-tee');
  await page.waitForFunction(() => Boolean(window.__studioCanvas?.backgroundImage));

  // Default color preselects white (the color route streams the same blank file
  // as the plain template image).
  expect(await backgroundSrc(page)).toContain('/templates/classic-tee/colors/white/image');

  // Swatches live in the Product panel; white preselected.
  await page.getByTestId('tool-product').click();
  await expect(page.getByTestId('color-swatch-white')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('active-color-name')).toHaveText('White');

  // Pick black: the garment swaps live on the canvas and on the side tabs.
  await page.getByTestId('color-swatch-black').click();
  await waitForBackground(page, '/templates/classic-tee/colors/black/image');
  await expect(page.getByTestId('active-color-name')).toHaveText('Black');
  await expect(page.locator('[data-testid=area-tab-back] img')).toHaveAttribute(
    'src',
    /\/colors\/black\/areas\/back\/thumb/,
  );

  // The back side uses the color's area-specific blank.
  await page.getByTestId('area-tab-back').click();
  await waitForBackground(page, '/templates/classic-tee/colors/black/areas/back/image');
  await page.getByTestId('area-tab-front').click();
  await waitForBackground(page, '/templates/classic-tee/colors/black/image');

  // Place a text object and save: the design persists the color.
  await page.getByTestId('tool-text').click();
  await page.getByTestId('add-text-button').click();
  await page.getByTestId('save-design').click();
  await expect(page.getByTestId('editor-status')).toContainText('Design saved');

  // Render lands on the mockup page with a preview.
  await page.getByTestId('generate-mockup').click();
  await page.waitForURL(/\/designs\//);
  await expect(page.locator('img[alt^="Rendered"]').first()).toBeVisible();

  // Reopen: the swatch restores to black and the canvas shows the black blank.
  await page.getByTestId('edit-design').click();
  await page.waitForFunction(() => Boolean(window.__studioCanvas?.backgroundImage));
  await waitForBackground(page, '/templates/classic-tee/colors/black/image');
  await page.getByTestId('tool-product').click();
  await expect(page.getByTestId('color-swatch-black')).toHaveAttribute('aria-checked', 'true');

  // A clean reopened design is not dirty; changing the color makes it saveable again.
  await expect(page.getByTestId('save-design')).toBeDisabled();
  await page.getByTestId('color-swatch-heather').click();
  await waitForBackground(page, '/templates/classic-tee/colors/heather/image');
  await expect(page.getByTestId('save-design')).toBeEnabled();
});
