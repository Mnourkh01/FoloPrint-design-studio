import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const FIXTURE = join(__dirname, 'fixtures', 'logo.png');
const API_DIR = join(__dirname, '..', '..', 'api');

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

/**
 * Empties the design library table so the empty state is provable. Runs through the
 * prisma CLI of the API workspace (the web app has no DB client of its own). The suite
 * runs with workers: 1, so the wipe cannot race the editor smoke spec mid-flow.
 */
const wipeDesigns = (): void => {
  execSync('npx prisma db execute --schema prisma/schema.prisma --stdin', {
    cwd: API_DIR,
    input: 'DELETE FROM "design_projects";',
    stdio: ['pipe', 'ignore', 'inherit'],
  });
};

/** Uploads the fixture logo onto the currently active print area and waits for it. */
const uploadToActiveArea = async (page: Page, areaKey: 'front' | 'back'): Promise<void> => {
  const before = await page.evaluate(
    (key) =>
      (window.__studioCanvas?.getObjects() ?? []).filter(
        (o) =>
          (o as { assetId?: string }).assetId &&
          (o as { printAreaKey?: string }).printAreaKey === key,
      ).length,
    areaKey,
  );
  await page.setInputFiles('[data-testid=upload-input]', FIXTURE);
  await page.waitForFunction(
    ({ key, prev }) =>
      (window.__studioCanvas?.getObjects() ?? []).filter(
        (o) =>
          (o as { assetId?: string }).assetId &&
          (o as { printAreaKey?: string }).printAreaKey === key,
      ).length > prev,
    { key: areaKey, prev: before },
  );
};

test.describe.serial('design library', () => {
  test.beforeAll(() => {
    wipeDesigns();
  });

  test('shows the empty state with a CTA into the editor', async ({ page }) => {
    await page.goto('/designs');
    const empty = page.getByTestId('library-empty');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText('No saved designs yet');

    await page.getByTestId('library-empty-cta').click();
    await expect(page).toHaveURL(/\/editor\/classic-tee/);
    await page.waitForFunction(() => Boolean(window.__studioCanvas?.backgroundImage));
  });

  test('create, render, find in the library, view, edit', async ({ page }) => {
    // --- Create a front + back design through the editor ---
    await page.goto('/editor/classic-tee');
    await page.waitForFunction(() => Boolean(window.__studioCanvas?.backgroundImage));

    await uploadToActiveArea(page, 'front');
    await page.getByTestId('area-tab-back').click();
    await expect(page.getByTestId('area-tab-back')).toHaveAttribute('aria-selected', 'true');
    await uploadToActiveArea(page, 'back');

    // Pick the black garment; the library row and the mockup page surface it.
    await page.getByTestId('tool-product').click();
    await page.getByTestId('color-swatch-black').click();

    await page.getByTestId('save-design').click();
    await expect(page.getByTestId('editor-status')).toContainText('Design saved');

    // --- Render previews; lands on the preview page ---
    await page.getByTestId('generate-mockup').click();
    await page.waitForURL(/\/designs\/[0-9a-f-]{36}/);
    const designId = page.url().match(/\/designs\/([0-9a-f-]{36})/)?.[1];
    expect(designId).toBeTruthy();

    // --- Topbar link into the library ---
    await page.getByTestId('nav-designs').click();
    await expect(page).toHaveURL(/\/designs$/);

    const card = page.getByTestId(`design-card-${designId}`);
    await expect(card).toBeVisible();
    await expect(card).toContainText('Classic Tee');

    const chips = card.getByTestId('design-card-areas');
    await expect(chips).toContainText('Front print · 1 object');
    await expect(chips).toContainText('Back print · 1 object');
    await expect(card.getByTestId('design-card-color')).toContainText('Black');

    const thumb = card.getByTestId('design-card-thumb-front');
    await expect(thumb).toBeVisible();
    const naturalWidth = await thumb.evaluate((el) => (el as HTMLImageElement).naturalWidth);
    expect(naturalWidth).toBeGreaterThan(0);

    // --- View mockups ---
    await card.getByTestId('design-card-view').click();
    await page.waitForURL(new RegExp(`/designs/${designId}$`));
    await expect(page.getByTestId('preview-image-front')).toBeVisible();
    await expect(page.getByTestId('preview-image-back')).toBeVisible();
    await expect(page.getByTestId('design-color')).toContainText('Black');

    // --- Print files: one download link per placed side, streaming a real PNG ---
    await expect(page.getByTestId('print-file-front')).toBeVisible();
    await expect(page.getByTestId('print-file-back')).toBeVisible();
    const printFileUrl = await page.getByTestId('print-file-front').getAttribute('href');
    const response = await page.request.get(printFileUrl!);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('image/png');
    const body = await response.body();
    expect(body.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    // --- Back to the library via the preview page link ---
    await page.getByTestId('all-designs').click();
    await expect(page).toHaveURL(/\/designs$/);
    await expect(card).toBeVisible();

    // --- Edit reopens the saved design with both objects ---
    await card.getByTestId('design-card-edit').click();
    await page.waitForURL(new RegExp(`/editor/classic-tee\\?design=${designId}`));
    await page.waitForFunction(
      () =>
        (window.__studioCanvas?.getObjects() ?? []).filter(
          (o) => (o as { assetId?: string }).assetId,
        ).length === 2,
    );
    await expect(page.getByTestId('editing-badge')).toContainText('Editing saved design');
  });

  test('duplicate and delete from the library', async ({ page }) => {
    await page.goto('/designs');
    await expect(page.getByTestId('library-count')).toContainText('1');
    const card = page.locator('[data-testid^="design-card-"][data-testid$="-card"], article.design-card').first();

    // Duplicate: a second card appears (the copy has no previews yet).
    await card.getByTestId('design-card-duplicate').click();
    await expect(page.getByTestId('library-count')).toContainText('2');
    await expect(page.getByTestId('design-card-no-preview')).toBeVisible();

    // Delete the copy (newest first = the un-rendered one); confirm dialog accepted.
    page.on('dialog', (dialog) => void dialog.accept());
    await page
      .locator('article.design-card')
      .first()
      .getByTestId('design-card-delete')
      .click();
    await expect(page.getByTestId('library-count')).toContainText('1');
    await expect(page.getByTestId('design-card-no-preview')).not.toBeVisible();
  });
});
