import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const FIXTURE = join(__dirname, 'fixtures', 'logo.png');

// Matches the seeded "classic-tee" back print area (apps/api/prisma/seed.ts).
const BACK = { x: 361, y: 240, width: 533, height: 756 } as const;

/** Center + scaled size of the first designed object on the canvas. */
const objectCenter = (page: Page): Promise<{ x: number; y: number; w: number; h: number }> =>
  page.evaluate(() => {
    const canvas = window.__studioCanvas as unknown as {
      getObjects(): Array<{
        kind?: string;
        left: number;
        top: number;
        getScaledWidth(): number;
        getScaledHeight(): number;
      }>;
    };
    const obj = canvas.getObjects().find((o) => o.kind);
    if (!obj) throw new Error('no design object on canvas');
    return { x: obj.left, y: obj.top, w: obj.getScaledWidth(), h: obj.getScaledHeight() };
  });

test('arrow keys nudge the selected object by 1 px, 10 with Shift', async ({ page }) => {
  await page.goto('/editor/classic-tee');
  await page.waitForFunction(() => Boolean(window.__studioCanvas?.backgroundImage));

  // A text object is enough: nudge applies to any selected design object.
  await page.getByTestId('tool-text').click();
  await page.getByTestId('add-text-button').click();
  await page.waitForFunction(
    () => (window.__studioCanvas?.getObjects() ?? []).some((o) => (o as { kind?: string }).kind === 'text'),
  );

  const start = await objectCenter(page);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowUp');
  let now = await objectCenter(page);
  expect(now.x).toBeCloseTo(start.x + 2, 0);
  expect(now.y).toBeCloseTo(start.y - 1, 0);

  await page.keyboard.press('Shift+ArrowDown');
  now = await objectCenter(page);
  expect(now.y).toBeCloseTo(start.y + 9, 0);

  // Nudges count as edits: the design is saveable.
  await expect(page.getByTestId('save-design')).toBeEnabled();
});

test('back side offers Full back / Center back / Locker patch presets', async ({ page }) => {
  await page.goto('/editor/classic-tee');
  await page.waitForFunction(() => Boolean(window.__studioCanvas?.backgroundImage));

  // Upload onto the BACK side; presets are per-side and image-only.
  await page.getByTestId('area-tab-back').click();
  await expect(page.getByTestId('area-tab-back')).toHaveAttribute('aria-selected', 'true');
  await page.setInputFiles('[data-testid=upload-input]', FIXTURE);
  await page.waitForFunction(
    () => (window.__studioCanvas?.getObjects() ?? []).some((o) => (o as { kind?: string }).kind === 'image'),
  );

  await page.getByTestId('context-tool-position').click();
  await expect(page.getByTestId('placement-full')).toHaveText('Full back');
  await expect(page.getByTestId('placement-back-center')).toBeVisible();

  // Locker patch: small artwork centered just below the collar.
  await page.getByTestId('placement-locker-patch').click();
  const placed = await objectCenter(page);
  expect(placed.x).toBeCloseTo(BACK.x + BACK.width / 2, 0);
  expect(placed.y).toBeCloseTo(BACK.y + BACK.height * 0.07, 0);
  // The 200px-square fixture is height-bound: 12% of the area's height.
  expect(placed.h).toBeLessThanOrEqual(BACK.height * 0.12 + 1);
});
