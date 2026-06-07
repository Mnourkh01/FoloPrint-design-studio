import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/** Drives the editor to a rendered single-side design and lands on its mockup page. */
async function renderedDesign(page: Page): Promise<void> {
  await page.goto('/editor/classic-tee');
  await page.waitForFunction(() => Boolean(window.__studioCanvas?.backgroundImage));
  await page.getByTestId('tool-text').click();
  await page.getByTestId('add-text-button').click();
  await page.getByTestId('save-design').click();
  await expect(page.getByTestId('editor-status')).toContainText('Design saved');
  await page.getByTestId('generate-mockup').click();
  await page.waitForURL(/\/designs\//);
  await expect(page.getByTestId('download-mockup-front')).toBeVisible();
}

/** Picks a format, clicks download, returns the saved file's first bytes + name. */
async function downloadAs(
  page: Page,
  format: 'png' | 'jpg' | 'webp',
): Promise<{ name: string; head: number[] }> {
  await page.getByTestId('mockup-format-front').selectOption(format);
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('download-mockup-front').click();
  const download = await downloadPromise;
  const path = await download.path();
  const buf = readFileSync(path);
  return { name: download.suggestedFilename(), head: [...buf.subarray(0, 4)] };
}

test('mockup download: PNG, JPG, and WebP each save a real file of that type', async ({ page }) => {
  await renderedDesign(page);

  // PNG (default): lossless, the bytes carry the PNG signature.
  const png = await downloadAs(page, 'png');
  expect(png.name).toMatch(/^mockup-.*-front\.png$/);
  expect(png.head).toEqual([0x89, 0x50, 0x4e, 0x47]);

  // JPG: re-encoded client-side, JPEG SOI magic FF D8.
  const jpg = await downloadAs(page, 'jpg');
  expect(jpg.name).toMatch(/\.jpg$/);
  expect(jpg.head.slice(0, 2)).toEqual([0xff, 0xd8]);

  // WebP: RIFF container ("RIFF" then size then "WEBP").
  const webp = await downloadAs(page, 'webp');
  expect(webp.name).toMatch(/\.webp$/);
  expect(webp.head).toEqual([0x52, 0x49, 0x46, 0x46]); // "RIFF"
});
