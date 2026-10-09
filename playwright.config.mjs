import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  testMatch: '**/*.spec.mjs',
  timeout: 60_000,
  retries: process.env.CI ? 2 : 1,
  workers: process.env.PW_WORKERS ? Number(process.env.PW_WORKERS) : 2,
  reporter: [['list']],
  use: {
    colorScheme: 'dark',
    viewport: { width: 390, height: 780 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
