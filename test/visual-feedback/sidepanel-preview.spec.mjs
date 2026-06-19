// 開発用プレビュー: お描き注釈が1件ある時のサイドパネルを描画し、
// 「お描きを画像でAIへ」CTA が注釈パネル内に出ることを目視確認する。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const outPath = path.resolve(projectRoot, '.tmp/vf-sidepanel.png');

function contentType(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.css')) return 'text/css; charset=utf-8';
  if (p.endsWith('.js')) return 'text/javascript; charset=utf-8';
  return 'application/octet-stream';
}

let server;
let origin;

test.beforeAll(async () => {
  server = await new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const requested = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || 'sidepanel/sidepanel.html';
      const filePath = path.resolve(projectRoot, requested);
      if (!filePath.startsWith(projectRoot + path.sep)) return res.writeHead(403).end('Forbidden');
      fs.readFile(filePath, (err, body) => {
        if (err) return res.writeHead(404).end('Not found');
        res.writeHead(200, { 'content-type': contentType(filePath) });
        res.end(body);
      });
    });
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('preview: お描きがある時、注釈パネルに画像でAIへ渡すCTAが出る', async ({ page }) => {
  await page.addInitScript(() => {
    const drawing = {
      id: 'a1',
      kind: 'drawing',
      note: 'ここをAIにマークダウンで出力',
      shapeText: '赤色の四角で囲んだ',
      intent: 'API一覧を構造化して抽出',
      forAI: true,
      target: '提供API一覧',
      resolved: true,
      shapePreview: {
        color: '#ef4444',
        shapes: [{ type: 'rect', x: 0.18, y: 0.22, w: 0.62, h: 0.46, color: '#ef4444' }],
      },
    };
    function result(message) {
      switch (message?.type) {
        case 'GET_ACTIVE_TAB_STATE':
          return { tabId: 1, url: 'https://example.com/api', title: 'API', rememberScope: 'page', hasApiKey: true, matched: true, remembered: true, provider: 'mock' };
        case 'LIST_ANNOTATIONS':
          return { annotations: [drawing], scope: 'https://example.com/api' };
        default:
          return {};
      }
    }
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage(message, cb) {
          queueMicrotask(() => cb?.({ ok: true, result: result(message) }));
        },
      },
      storage: {
        local: { async get() { return {}; }, async set() {}, async remove() {} },
        onChanged: { addListener() {}, removeListener() {} },
      },
      tabs: { onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
    };
  });

  await page.goto(`${origin}/sidepanel/sidepanel.html`);
  await expect(page.getByText('AI send tray')).toBeVisible();
  const cta = page.locator('#btn-capture');
  await expect(cta).toBeVisible();
  await expect(cta).toContainText('Send tray as image to AI');
  await expect(page.getByLabel('Preview of drawing 1')).toBeVisible();

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await page.locator('#anno-panel').screenshot({ path: outPath });
  console.log('saved sidepanel preview to', outPath);
});
