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
  // CI runs the API and web in dev mode behind one process each; a long render-heavy
  // marathon can push a single save+render+navigate step past the wall under load
  // (seen only on the Arabic-wrap render, green isolated). Retry in CI so an
  // environmental stall self-heals while a real regression still fails every attempt.
  retries: process.env.CI ? 2 : 0,
  // One worker: the design-library spec wipes the design_projects table for its
  // empty-state assertion, which must never race another spec mid-flow.
  workers: 1,
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
