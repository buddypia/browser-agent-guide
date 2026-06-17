// Browser Agent Guide を「実際に読み込んだ Chrome」で起動し、デバッグ・プレイグラウンドを開く。
// 拡張のサイドパネル / 注釈 / 動詞操作を、実拡張に対して手で(または Playwright で)検証するための起動スクリプト。
//
//   node scripts/debug-with-extension.mjs
//
// 仕組み:
//   1. プロジェクトルートを http://127.0.0.1 で静的配信（content script は file:// より http が確実）
//   2. 拡張を --load-extension で読み込んだ headed Chromium を起動
//   3. プレイグラウンドを開く（content script が注入され、ページ内インスペクターが点灯する）
// 終了: Ctrl+C
//
// 注意:
//   - 拡張アイコンからサイドパネルを開く操作は手動。開いて「手がかりを表示」やチャットを実行すると、
//     ページ左の「拡張インスペクター」の data-bag-id カウントが動く。
//   - injectScript（User Scripts API）を使う場合は拡張詳細画面で "Allow User Scripts" を ON に。
import { chromium } from '@playwright/test';
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
  if (p.endsWith('.json')) return 'application/json; charset=utf-8';
  if (p.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

function startStaticServer() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const requested = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || FIXTURE;
      const filePath = path.resolve(projectRoot, requested);
      if (!filePath.startsWith(projectRoot + path.sep)) {
        res.writeHead(403); res.end('Forbidden'); return;
      }
      fs.readFile(filePath, (err, body) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'content-type': contentType(filePath) });
        res.end(body);
      });
    });
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

const server = await startStaticServer();
const origin = `http://127.0.0.1:${server.address().port}`;
const pageUrl = `${origin}/${FIXTURE}`;

const context = await chromium.launchPersistentContext('', {
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: [
    `--disable-extensions-except=${projectRoot}`,
    `--load-extension=${projectRoot}`,
  ],
});

const page = context.pages()[0] || (await context.newPage());
await page.goto(pageUrl);

console.log('');
console.log('  Browser Agent Guide デバッグ・プレイグラウンドを起動しました');
console.log('  ────────────────────────────────────────────────');
console.log('  対象ページ : ' + pageUrl);
console.log('  拡張       : ' + projectRoot + ' (--load-extension で読込済み)');
console.log('');
console.log('  次の操作を試せます:');
console.log('   1. ツールバーの Browser Agent Guide アイコンをクリック → サイドパネルを開く');
console.log('   2. 「手がかりを表示」/「補足を付ける」/「お描き」/ チャット指示');
console.log('   3. ページ左「拡張インスペクター」の data-bag-id カウントが動くのを確認');
console.log('');
console.log('  終了するには Ctrl+C');
console.log('');

const shutdown = async () => {
  await context.close().catch(() => {});
  await new Promise((r) => server.close(r));
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// 拡張のページ(サイドパネル等)を閉じても落ちないよう、コンテキストの close を待つ
context.on('close', shutdown);
