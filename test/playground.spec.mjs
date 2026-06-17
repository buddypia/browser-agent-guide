// Browser Agent Guide デバッグ・プレイグラウンド(test/fixtures/playground.html)の動作確認スペック。
// 拡張を読み込まず、ページ単体の挙動(フォーム送信・非同期出現・破壊的操作・SPA遷移)を検証する。
// 拡張を実際に載せて操作する手順は scripts/debug-with-extension.mjs を参照。
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
let server;
let origin;

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  return 'application/octet-stream';
}

async function startStaticServer() {
  return new Promise((resolve, reject) => {
    const next = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const requested = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || 'test/fixtures/playground.html';
      const filePath = path.resolve(projectRoot, requested);
      if (!filePath.startsWith(projectRoot + path.sep)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      fs.readFile(filePath, (err, body) => {
        if (err) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        res.writeHead(200, { 'content-type': contentType(filePath) });
        res.end(body);
      });
    });
    next.once('error', reject);
    next.listen(0, '127.0.0.1', () => resolve(next));
  });
}

test.describe('debug playground', () => {
  test.beforeAll(async () => {
    server = await startStaticServer();
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  test.afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  test.beforeEach(async ({ page }) => {
    await page.goto(`${origin}/test/fixtures/playground.html`);
  });

  test('ページが描画され主要な対象要素が見える', async ({ page }) => {
    await expect(page).toHaveTitle('Browser Agent Guide デバッグ・プレイグラウンド');
    await expect(page.getByRole('heading', { name: 'デバッグ・プレイグラウンド' })).toBeVisible();
    await expect(page.getByTestId('login-form')).toBeVisible();
    await expect(page.getByTestId('event-log')).toBeVisible();
  });

  test('ログインフォームを入力して送信できる(fill + submit)', async ({ page }) => {
    await page.getByTestId('login-username').fill('yamada_taro');
    await page.getByTestId('login-email').fill('taro@example.com');
    await page.getByTestId('plan-select').selectOption('pro');
    await page.getByTestId('login-submit').click();

    await expect(page.getByTestId('login-result')).toHaveText('送信OK: yamada_taro');
    await expect(page.getByTestId('event-log')).toContainText('フォーム送信: username=yamada_taro');
  });

  test('非同期要素 #async-result が遅延出現する(waitForElement 相当)', async ({ page }) => {
    await expect(page.locator('#async-result')).toHaveCount(0);
    await page.getByTestId('async-load').click();
    await expect(page.getByTestId('async-state')).toHaveText('loading…');
    // 1.5秒後に出現
    await expect(page.locator('#async-result')).toBeVisible({ timeout: 4000 });
    await expect(page.getByTestId('async-state')).toHaveText('loaded');
  });

  test('動的リストは追加で増える', async ({ page }) => {
    await expect(page.getByTestId('item-count')).toHaveText('3 件');
    await page.getByTestId('add-item').click();
    await page.getByTestId('add-item').click();
    await expect(page.getByTestId('item-count')).toHaveText('5 件');
    await expect(page.getByTestId('dyn-item')).toHaveCount(5);
  });

  test('破壊的操作は確認ダイアログ後に記録される', async ({ page }) => {
    page.on('dialog', (dialog) => {
      expect(dialog.message()).toContain('破壊的操作');
      dialog.accept();
    });
    await page.getByTestId('confirm-order').click();
    await expect(page.getByTestId('last-destructive')).toHaveText('注文を確定 を実行');
    await expect(page.getByTestId('event-log')).toContainText('破壊的操作を実行: 注文を確定');
  });

  test('SPA風タブはハッシュを変えてパネルを切り替える', async ({ page }) => {
    await expect(page.getByTestId('panel-home')).toBeVisible();
    await page.getByTestId('tab-orders').click();
    await expect(page).toHaveURL(/#\/orders$/);
    await expect(page.getByTestId('panel-orders')).toBeVisible();
    await expect(page.getByTestId('panel-home')).toBeHidden();
    await expect(page.getByTestId('hash-readout')).toHaveText('#/orders');
  });
});
