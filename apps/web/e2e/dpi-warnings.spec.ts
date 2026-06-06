import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';

const TINY_FIXTURE = join(__dirname, 'fixtures', 'tiny.png');

/** Uploads the given file onto the active area and waits for the object to land. */
const upload = async (page: Page, fixture: string): Promise<void> => {
  const before = await page.evaluate(
    () => (window.__studioCanvas?.getObjects() ?? []).filter((o) => (o as { assetId?: string }).assetId).length,
  );
  await page.setInputFiles('[data-testid=upload-input]', fixture);
  await page.waitForFunction(
    (prev) =>
      (window.__studioCanvas?.getObjects() ?? []).filter((o) => (o as { assetId?: string }).assetId).length > prev,
    before,
  );
};

test('low-res artwork: poor DPI readout, advisory save note, render not blocked, warnings on preview and library', async ({ page }) => {
  await page.goto('/editor/classic-tee');
  await page.waitForFunction(() => Boolean(window.__studioCanvas?.backgroundImage));

  // A 64x64 image at the default drop size (~182 canvas px over ~8.4in) is deep in
  // the poor band. The upload auto-selects the object, so the readout appears.
  await upload(page, TINY_FIXTURE);

  const readout = page.getByTestId('dpi-readout');
  await expect(readout).toBeVisible();
  await expect(readout).toHaveAttribute('data-level', 'poor');
  await expect(readout).toContainText('DPI');
  await expect(readout).toContainText('too low for sharp print');

  // Save proceeds (advisory, never blocked) and the status carries the quality note.
  await page.getByTestId('save-design').click();
  const status = page.getByTestId('editor-status');
  await expect(status).toContainText('Design saved');
  await expect(status).toContainText('will likely print blurry');
  await expect(status).toContainText('Front print');

  // Render is not blocked either; the preview page shows the server-computed warnings.
  await page.getByTestId('generate-mockup').click();
  await page.waitForURL(/\/designs\/[0-9a-f-]{36}/);
  const designId = page.url().match(/\/designs\/([0-9a-f-]{36})/)?.[1];
  expect(designId).toBeTruthy();

  const previewImage = page.getByTestId('preview-image-front');
  await expect(previewImage).toBeVisible();
  expect(await previewImage.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

  const warnings = page.getByTestId('quality-warnings');
  await expect(warnings).toBeVisible();
  await expect(warnings).toContainText('Front print');
  await expect(warnings).toContainText('DPI');
  await expect(warnings).toContainText('will likely print blurry');

  // The library card carries the worst-level badge.
  await page.goto('/designs');
  const card = page.getByTestId(`design-card-${designId}`);
  await expect(card).toBeVisible();
  await expect(card.getByTestId('quality-badge')).toHaveText('low res artwork');
});
