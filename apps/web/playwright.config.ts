import { defineConfig } from '@playwright/test';

/**
 * Smoke suite for the editor flow.
 * Requires Postgres up + migrated + seeded (npm run db:up && npm run db:migrate && npm run db:seed).
 * Starts the API and the web app itself (reuses already-running ones in dev).
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: [
    {
      command: 'npm run start:dev -w @foloprint/api',
      cwd: '../..',
      url: 'http://localhost:3001/health',
      // Reuse the dev server locally; in CI always start a fresh, isolated one.
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: 'npm run dev -w @foloprint/web',
      cwd: '../..',
      url: 'http://localhost:3000',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
