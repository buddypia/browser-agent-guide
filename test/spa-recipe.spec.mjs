// 拡張を実際に読み込み、SPA内部遷移(hashchange)でレシピが再適用されること、
// when(条件)による画面別の出し分け、waitFor(出現待ち)による非同期要素対応を検証する。
// 注: 拡張のロードには Chromium の拡張対応モードが必要なため headed/--headless=new で起動する。
import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const FIXTURE = 'test/fixtures/playground.html';

function contentType(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.css')) return 'text/css; charset=utf-8';
  if (p.endsWith('.js')) return 'text/javascript; charset=utf-8';
  return 'application/octet-stream';
}

function startStaticServer() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const requested = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || FIXTURE;
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
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function getServiceWorker(context) {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  return sw;
}

// site rule(ページ一致) + レシピを storage に書き込む。ページを開く前に呼ぶこと。
async function seedRecipe(sw, { pageUrl, recipe }) {
  await sw.evaluate(
    async ({ pageUrl, recipe }) => {
      const url = new URL(pageUrl);
      await chrome.storage.local.set({
        aiAdvisorSettings: {
          sites: [
            {
              id: 'spa-test-rule',
              label: 'spa-test',
              matchType: 'page',
              pattern: url.origin + url.pathname,
              enabled: true,
            },
          ],
          recipes: { 'spa-test-rule': recipe },
        },
      });
    },
    { pageUrl, recipe },
  );
}

test.describe('SPA / 非同期レシピ再適用 (拡張ロード)', () => {
  let server;
  let origin;
  let context;
  let pageUrl;

  test.beforeAll(async () => {
    server = await startStaticServer();
    origin = `http://127.0.0.1:${server.address().port}`;
    pageUrl = `${origin}/${FIXTURE}`;
    context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        '--headless=new',
        `--disable-extensions-except=${projectRoot}`,
        `--load-extension=${projectRoot}`,
      ],
    });
  });

  test.afterAll(async () => {
    await context?.close().catch(() => {});
    if (server) await new Promise((r) => server.close(r));
  });

  test('SPA内部遷移(hashchange)でレシピが再適用され、when(urlContains)で画面別に出し分く', async () => {
    const sw = await getServiceWorker(context);
    await seedRecipe(sw, {
      pageUrl,
      recipe: [
        {
          verb: 'injectHtml',
          args: { id: 'spa-orders-only', html: '<p>orders only</p>' },
          when: { urlContains: '#/orders' },
          reason: 'orders画面のときだけ',
        },
      ],
    });

    const page = await context.newPage();
    await page.goto(pageUrl);
    // 初回(home)は when(urlContains '#/orders') 不一致 → スキップされ注入されない。
    await expect(page.getByTestId('panel-home')).toBeVisible();
    await expect(page.locator('[data-bag-injected="spa-orders-only"]')).toHaveCount(0);

    // orders タブへ(hashchange) → SPA_NAVIGATED → syncTab 再適用 → when 一致で注入。
    // (sig リセットが効かないと「適用済み」とみなされ二度と注入されないので、これがSPA再適用の証拠になる)
    await page.getByTestId('tab-orders').click();
    await expect(page).toHaveURL(/#\/orders$/);
    await expect(page.locator('[data-bag-injected="spa-orders-only"]')).toHaveCount(1, { timeout: 7000 });

    await page.close();
  });

  test('waitForで非同期に後から現れる要素を待ってからレシピを適用する', async () => {
    const sw = await getServiceWorker(context);
    await seedRecipe(sw, {
      pageUrl,
      recipe: [
        {
          verb: 'injectHtml',
          args: { id: 'spa-after-async', html: '<p>after async</p>' },
          waitFor: { selector: '#async-result', timeoutMs: 8000 },
          reason: '遅延要素が出てから',
        },
      ],
    });

    const page = await context.newPage();
    await page.goto(pageUrl);
    // 適用時点では #async-result が無いので waitFor が待機中 → まだ注入されない。
    await expect(page.getByTestId('login-form')).toBeVisible();
    await expect(page.locator('[data-bag-injected="spa-after-async"]')).toHaveCount(0);

    // 非同期ロードを起動 → 約1.5秒後に #async-result が出現 → waitFor 解決 → 注入される。
    await page.getByTestId('async-load').click();
    await expect(page.locator('#async-result')).toBeVisible({ timeout: 4000 });
    await expect(page.locator('[data-bag-injected="spa-after-async"]')).toHaveCount(1, { timeout: 8000 });

    await page.close();
  });

  test('waitForの不正なセレクタでもバッチ全体は落ちず、後続のアクションは実行される', async () => {
    const sw = await getServiceWorker(context);
    await seedRecipe(sw, {
      pageUrl,
      recipe: [
        {
          // 不正なCSSセレクタ。querySelector が SyntaxError を投げるが waitFor は「出現しない」扱いにする。
          verb: 'injectHtml',
          args: { id: 'bad-selector-wait', html: '<p>should not appear</p>' },
          waitFor: { selector: 'a[', timeoutMs: 500 },
          reason: '不正セレクタ',
        },
        {
          verb: 'injectHtml',
          args: { id: 'after-bad-selector', html: '<p>after</p>' },
          reason: '後続(これが実行されればバッチは落ちていない)',
        },
      ],
    });

    const page = await context.newPage();
    await page.goto(pageUrl);
    // 不正セレクタの action は出現待ちが失敗扱い → 注入されない。
    await expect(page.locator('[data-bag-injected="bad-selector-wait"]')).toHaveCount(0);
    // だが後続の正常な action は実行される(reject でバッチ全体が中断していない証拠)。
    await expect(page.locator('[data-bag-injected="after-bad-selector"]')).toHaveCount(1, { timeout: 5000 });

    await page.close();
  });

  test('SPA内部遷移でレシピは1回だけ適用される(id省略でも要素が重複しない)', async () => {
    const sw = await getServiceWorker(context);
    await seedRecipe(sw, {
      pageUrl,
      recipe: [
        {
          // id を省略すると毎回別IDで注入されるため、二重適用なら要素が2個に増える。
          verb: 'injectPanel',
          args: { title: 'dup', html: '<p>dup-check</p>' },
          when: { urlContains: '#/orders' },
          reason: 'id省略・重複検出用',
        },
      ],
    });

    const page = await context.newPage();
    await page.goto(pageUrl);
    await expect(page.getByTestId('panel-home')).toBeVisible();

    // orders へ遷移 → SPA_NAVIGATED 経由で1回だけ適用される。
    await page.getByTestId('tab-orders').click();
    await expect(page).toHaveURL(/#\/orders$/);
    const injected = page.locator('[data-bag-injected]').filter({ hasText: 'dup-check' });
    await expect(injected).toHaveCount(1, { timeout: 7000 });
    // 二重発火が遅れて来ないことも確認(onUpdated と SPA_NAVIGATED の二重適用が起きないこと)。
    await page.waitForTimeout(800);
    await expect(injected).toHaveCount(1);

    await page.close();
  });
});
