import { expect, test, type Page } from '@playwright/test';

const waitForObjectCount = (page: Page, count: number): Promise<unknown> =>
  page.waitForFunction(
    (want) =>
      (window.__studioCanvas?.getObjects() ?? []).filter((o) => (o as { kind?: string }).kind)
        .length === want,
    count,
  );

/** True once the tile's canvas has non-uniform pixels (something was drawn). */
const tilePainted = (page: Page, areaKey: string): Promise<unknown> =>
  page.waitForFunction((key) => {
    const el = document.querySelector(
      `[data-testid="overview-tile-${key}"] canvas`,
    ) as HTMLCanvasElement | null;
    if (!el) return false;
    const ctx = el.getContext('2d');
    if (!ctx) return false;
    const { data } = ctx.getImageData(0, 0, el.width, el.height);
    for (let i = 4; i < data.length; i += 16) {
      if (data[i] !== data[0] || data[i + 3] !== data[3]) return true;
    }
    return false;
  }, areaKey);

test('placement overview: tiles show every side, click jumps, escape closes', async ({ page }) => {
  await page.goto('/editor/classic-tee');
  await page.waitForFunction(() => Boolean(window.__studioCanvas?.backgroundImage));

  // One text object per side.
  await page.getByTestId('tool-text').click();
  await page.getByTestId('add-text-button').click();
  await waitForObjectCount(page, 1);
  await page.getByTestId('area-tab-back').click();
  await page.getByTestId('add-text-button').click();
  await waitForObjectCount(page, 2);

  // Open the overview: one tile per print side, both actually painted.
  await page.getByTestId('overview-button').click();
  await expect(page.getByTestId('overview-modal')).toBeVisible();
  await expect(page.getByTestId('overview-tile-front')).toBeVisible();
  await expect(page.getByTestId('overview-tile-back')).toBeVisible();
  await tilePainted(page, 'front');
  await tilePainted(page, 'back');

  // Both sides carry one object; the badges say so.
  await expect(page.getByTestId('overview-tile-front')).toContainText('1');
  await expect(page.getByTestId('overview-tile-back')).toContainText('1');

  // Clicking a tile jumps to that side and closes the overview.
  await page.getByTestId('overview-tile-front').click();
  await expect(page.getByTestId('overview-modal')).not.toBeVisible();
  await expect(page.getByTestId('area-tab-front')).toHaveAttribute('aria-selected', 'true');

  // Escape closes it too.
  await page.getByTestId('overview-button').click();
  await expect(page.getByTestId('overview-modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('overview-modal')).not.toBeVisible();
});
