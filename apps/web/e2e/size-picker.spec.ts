import { expect, test } from '@playwright/test';

test('garment size: pick, save, show on mockup, restore on reopen', async ({ page }) => {
  await page.goto('/editor/classic-tee');
  await page.waitForFunction(() => Boolean(window.__studioCanvas?.backgroundImage));

  // Some ink so the design is saveable.
  await page.getByTestId('tool-text').click();
  await page.getByTestId('add-text-button').click();

  // Size chips live in the Product panel; none selected by default.
  await page.getByTestId('tool-product').click();
  await expect(page.getByTestId('size-chip-XL')).toHaveAttribute('aria-checked', 'false');
  await page.getByTestId('size-chip-XL').click();
  await expect(page.getByTestId('size-chip-XL')).toHaveAttribute('aria-checked', 'true');

  await page.getByTestId('save-design').click();
  await expect(page.getByTestId('editor-status')).toContainText('Design saved');

  // Mockup page surfaces the chosen size.
  await page.getByTestId('generate-mockup').click();
  await page.waitForURL(/\/designs\//);
  await expect(page.getByTestId('design-size')).toHaveText('XL');

  // Reopen restores the chip; a clean design is not dirty until size changes.
  await page.getByTestId('edit-design').click();
  await page.waitForFunction(() => Boolean(window.__studioCanvas?.backgroundImage));
  await page.getByTestId('tool-product').click();
  await expect(page.getByTestId('size-chip-XL')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('save-design')).toBeDisabled();

  // Clicking the active chip clears the size and re-arms save.
  await page.getByTestId('size-chip-XL').click();
  await expect(page.getByTestId('size-chip-XL')).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('save-design')).toBeEnabled();
});
