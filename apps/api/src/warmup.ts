import sharp from 'sharp';
import { resolveFont } from '@foloprint/renderer';

/**
 * Warms the text-rendering path once at boot.
 *
 * The mockup/print renderer rasterizes text with sharp's `text:` input, which
 * runs through libvips -> Pango -> fontconfig. The FIRST such call in a process
 * pays a one-time fontconfig cost: scanning the font directories and building
 * (or reading) the fontconfig cache. With a warm cache that is milliseconds,
 * but on a cold CI runner with no cache and the bundled font directories it can
 * stall for many seconds. That cold start was the roaming "one render-heavy
 * spec hangs ~120s, always green on retry in ~2s" failure in the Playwright
 * suite: whichever spec happened to trigger the first text raster ate the cost.
 *
 * Doing one throwaway raster here, before the server starts listening, moves
 * that cost into startup. Playwright's webServer readiness already waits on
 * /health (which only responds after listen), so the warmup is absorbed there
 * and never inside a test's timeout. The warmup must never block boot: any
 * failure is logged and swallowed (a real render error would still surface on
 * the actual request).
 */
export async function warmTextRenderer(): Promise<void> {
  const startedAt = process.hrtime.bigint();
  try {
    const font = resolveFont('inter');
    await sharp({
      text: {
        text: 'warmup',
        font: `${font.family} 24`,
        fontfile: font.filePath,
        rgba: true,
        dpi: 72,
      },
    })
      .png()
      .toBuffer();
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    console.log(`Text renderer warmed in ${Math.round(ms)}ms`);
  } catch (error) {
    console.warn(
      `Text renderer warmup skipped: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}
