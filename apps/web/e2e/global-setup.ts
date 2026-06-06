import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { makeLogoPng } = require('./fixtures/make-logo.js') as {
  makeLogoPng: (w?: number, h?: number) => Buffer;
};

export default function globalSetup(): void {
  writeFileSync(join(__dirname, 'fixtures', 'logo.png'), makeLogoPng(200, 200));
  // Deliberately tiny: lands deep in the "poor" DPI band for the warning spec.
  writeFileSync(join(__dirname, 'fixtures', 'tiny.png'), makeLogoPng(64, 64));
}
