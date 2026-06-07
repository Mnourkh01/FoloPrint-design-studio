import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { warmTextRenderer } from './warmup';

/**
 * Runs the one-time text-renderer warmup (Pango/fontconfig cold start) as an
 * application bootstrap hook, so it fires for EVERY way the app starts:
 *
 *  - the real server (main.ts -> app.listen, which runs bootstrap before binding
 *    the port, so /health readiness still implies a warm renderer), and
 *  - the Jest e2e harness (app.init() in beforeAll), where the cold start used
 *    to surface as an intermittent ECONNRESET on the one concurrent
 *    double-render test ("renders the preview on the chosen color blank"): two
 *    heavy render pipelines hitting a cold libvips/Pango at once on a 2-core CI
 *    runner. Jest has no retries, so that flake hard-failed the suite.
 *
 * Warming once at bootstrap moves the cost out of any request/test path. The
 * warmup itself never throws (see warmTextRenderer), so it can never block boot.
 */
@Injectable()
export class RenderWarmup implements OnApplicationBootstrap {
  async onApplicationBootstrap(): Promise<void> {
    await warmTextRenderer();
  }
}
