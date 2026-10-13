import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  testMatch: '**/*.spec.mjs',
  timeout: 60_000,
  // 拡張を読み込んだ Chromium を spec ごとに起動する E2E では、既定 5s の expect/poll は負荷時に
  // 「content の準備待ち」だけで尽きる(2026-10-13、高負荷下で無関係な失敗が多発)。条件が満たされれば
  // 即座に返るので、成功時の所要時間は変わらない。retries では隠さない(ローカルは 0 のまま)。
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 2 : 0,
  workers: process.env.PW_WORKERS ? Number(process.env.PW_WORKERS) : 2,
  reporter: [['list']],
  use: {
    colorScheme: 'dark',
    viewport: { width: 390, height: 780 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
