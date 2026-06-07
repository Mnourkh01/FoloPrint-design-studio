import { defineConfig } from '@playwright/test';

const CI = Boolean(process.env.CI);

/**
 * Smoke suite for the editor flow.
 * Requires Postgres up + migrated + seeded (npm run db:up && npm run db:migrate && npm run db:seed).
 * Starts the API and the web app itself (reuses already-running ones in dev).
 *
 * Local runs use the dev servers (watch mode, instant iteration). CI runs the
 * PRODUCTION builds: dev-mode Next compiles routes on first hit and re-checks
 * types per request, which under a long render-heavy suite caused a roaming
 * one-test stall (always green isolated). The CI workflow builds the API (type
 * gate) and the web app before Playwright runs, so the servers here only start
 * what is already compiled.
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  // One retry kept as a safety net for genuine environmental hiccups (a real
  // regression still fails every attempt); production servers removed the
  // dev-mode stall this used to absorb at retries: 2.
  retries: CI ? 1 : 0,
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
      // CI: the compiled API (dist exists from the workflow's type-gate build).
      command: CI ? 'npm run start -w @foloprint/api' : 'npm run start:dev -w @foloprint/api',
      cwd: '../..',
      url: 'http://localhost:3001/health',
      // Reuse the dev server locally; in CI always start a fresh, isolated one.
      reuseExistingServer: !CI,
      timeout: 120_000,
    },
    {
      // CI: the production web server (.next built by the workflow step).
      command: CI ? 'npm run start -w @foloprint/web' : 'npm run dev -w @foloprint/web',
      cwd: '../..',
      url: 'http://localhost:3000',
      reuseExistingServer: !CI,
      timeout: 120_000,
    },
  ],
});
