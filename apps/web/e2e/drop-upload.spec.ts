import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const FIXTURE = join(__dirname, 'fixtures', 'logo.png');

/**
 * Regression guard for "upload stopped working": dropping a file on the canvas
 * used to hit the browser default (navigate to the image, replacing the editor
 * and the unsaved design). The stage now accepts drops and uploads to the
 * active side; non-images are rejected client-side with a readable message.
 */

const dropOnStage = async (
  page: import('@playwright/test').Page,
  file: { base64: string; name: string; type: string },
) => {
  await page.evaluate(async (f) => {
    const res = await fetch(`data:${f.type};base64,${f.base64}`);
    const blob = await res.blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], f.name, { type: f.type }));
    const stage = document.querySelector('[aria-label="Design workspace"]')!;
    const init = { bubbles: true, cancelable: true, dataTransfer: dt };
    stage.dispatchEvent(new DragEvent('dragover', init));
    stage.dispatchEvent(new DragEvent('drop', init));
  }, file);
};

test('dropping a PNG on the stage uploads it to the active print area', async ({ page }) => {
  await page.goto('/editor/classic-tee');
  await page.waitForFunction(() => Boolean(window.__studioCanvas));

  await dropOnStage(page, {
    base64: readFileSync(FIXTURE).toString('base64'),
    name: 'dropped-logo.png',
    type: 'image/png',
  });

  // The upload landed on the front side and the editor survived the drop
  // (no navigation away from the page).
  await expect(page.getByTestId('editor-status')).toContainText('added to Front print');
  await expect(page.getByTestId('area-tab-front')).toContainText('1');
  await expect(page).toHaveURL(/\/editor\/classic-tee/);
});

test('dropping a non-image is rejected client-side with a readable message', async ({ page }) => {
  await page.goto('/editor/classic-tee');
  await page.waitForFunction(() => Boolean(window.__studioCanvas));

  await dropOnStage(page, {
    base64: Buffer.from('not an image').toString('base64'),
    name: 'notes.txt',
    type: 'text/plain',
  });

  await expect(page.getByTestId('editor-status')).toContainText('not a PNG or JPEG');
  // Nothing was added anywhere.
  await expect(page.getByTestId('area-tab-front')).not.toContainText('1');
});
