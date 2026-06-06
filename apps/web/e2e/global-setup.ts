import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { makeLogoPng } = require('./fixtures/make-logo.js') as {
  makeLogoPng: (w?: number, h?: number) => Buffer;
};

export default function globalSetup(): void {
  writeFileSync(join(__dirname, 'fixtures', 'logo.png'), makeLogoPng(200, 200));
}
