import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  testMatch: '**/*.spec.mjs',
  reporter: [['list']],
  use: {
    colorScheme: 'dark',
    viewport: { width: 390, height: 780 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
