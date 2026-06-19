// お描きモード中に、サイト側の「モーダル外をクリック/タップで閉じる」挙動で
// 既存のモーダル/ポップアップが閉じてしまわないことを検証するリグレッションスペック。
// content/content-script.js を chrome スタブ付きで直接注入し、START_DRAWING を発火させて
// ページ上(モーダル外)をドラッグする。
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const contentScript = fs.readFileSync(path.join(projectRoot, 'content/content-script.js'), 'utf8');
const contentCss = fs.readFileSync(path.join(projectRoot, 'content/content.css'), 'utf8');
// content-script は SW から GET_I18N でロケール辞書を受け取る。テストでは日本語辞書を供給して
// ツールバー等が実文言(短い)で描画されるようにする(キー文字列のままだと寸法がズレる)。
const jaLocaleJson = fs.readFileSync(path.join(projectRoot, 'sidepanel/locales/ja.json'), 'utf8');

// 「モーダル外をクリックで閉じる」を capture/bubble の両段で実装したテストページ。
// 実サイトでよくある実装(pointerdown/mousedown/click のいずれか)を網羅する。
const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <div id="modal" style="position:fixed;left:120px;top:300px;width:160px;height:160px;background:#fff;border:2px solid #333">
    モーダル
  </div>
  <script>
    const modal = document.getElementById('modal');
    function maybeClose(e){ if(!modal.contains(e.target)) modal.dataset.closed = '1'; }
    document.addEventListener('pointerdown', maybeClose, true); // capture 段
    document.addEventListener('mousedown', maybeClose);          // bubble 段
    document.addEventListener('click', maybeClose);              // bubble 段
  </script>
</body></html>`;

test('お描きツールバーはi18n読み込み完了後に描画される', async ({ page }) => {
  await page.setContent(PAGE_HTML);
  await page.addScriptTag({
    content: `
      window.__bagListener = null;
      window.__bagI18n = ${jaLocaleJson};
      window.chrome = {
        runtime: {
          onMessage: { addListener: (fn) => { window.__bagListener = fn; } },
          sendMessage: (msg, cb) => {
            if (msg && msg.type === 'GET_I18N') {
              const r = { ok: true, result: { locale: 'ja', messages: window.__bagI18n, fallback: window.__bagI18n } };
              const p = new Promise((resolve) => setTimeout(() => resolve(r), 80));
              if (typeof cb === 'function') { p.then(cb); return; }
              return p;
            }
            if (typeof cb === 'function') { cb({ ok: true }); return; }
            return Promise.resolve({ ok: true });
          },
          get lastError() { return null; },
        },
        storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } },
      };
    `,
  });
  await page.addStyleTag({ content: contentCss });
  await page.addScriptTag({ content: contentScript });

  await page.evaluate(
    () => new Promise((resolve) => window.__bagListener({ type: 'START_DRAWING' }, {}, resolve))
  );

  await expect(page.locator('.bag-draw-tool[data-tool="ellipse"]')).toContainText('円');
  await expect(page.locator('.bag-draw-toolbar')).not.toContainText('cs.draw.toolEllipse');
});

test.describe('お描き中のモーダル保護', () => {
  test.beforeEach(async ({ page }) => {
    await page.setContent(PAGE_HTML);
    // content-script が参照する chrome API を最小スタブ化し、onMessage リスナーを捕捉する。
    // content-script より前に評価する必要があるため、独立した script タグで先に注入する。
    await page.addScriptTag({
      content: `
        window.__bagListener = null;
        window.__bagI18n = ${jaLocaleJson};
        window.chrome = {
          runtime: {
            onMessage: { addListener: (fn) => { window.__bagListener = fn; } },
            sendMessage: (msg, cb) => {
              if (msg && msg.type === 'GET_I18N') {
                const r = { ok: true, result: { locale: 'ja', messages: window.__bagI18n, fallback: window.__bagI18n } };
                if (typeof cb === 'function') { cb(r); return; }
                return Promise.resolve(r);
              }
              if (typeof cb === 'function') { cb({ ok: true }); return; }
              return Promise.resolve({ ok: true });
            },
            get lastError() { return null; },
          },
          storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } },
        };
      `,
    });
    await page.addStyleTag({ content: contentCss });
    await page.addScriptTag({ content: contentScript });
    // START_DRAWING を発火してお描きモードへ。
    await page.evaluate(
      () => new Promise((resolve) => window.__bagListener({ type: 'START_DRAWING' }, {}, resolve))
    );
    await expect(page.locator('.bag-draw-overlay')).toHaveCount(1);
  });

  test('モーダル外をドラッグして描いてもモーダルは閉じない', async ({ page }) => {
    // モーダル(120,300)-(280,460) の外側=上部領域をドラッグして円を描く。
    await page.mouse.move(60, 80);
    await page.mouse.down();
    await page.mouse.move(140, 140, { steps: 8 });
    await page.mouse.move(300, 200, { steps: 8 });
    await page.mouse.up();

    // サイトの閉じる処理は発火していない。
    await expect(page.locator('#modal')).not.toHaveAttribute('data-closed', '1');
    // 図形は確定描画されている(確定グループに子要素が増える)。
    const drawn = await page.locator('.bag-draw-committed > *').count();
    expect(drawn).toBeGreaterThan(0);
  });

  test('ツールバーのボタン操作でもモーダルは閉じない', async ({ page }) => {
    await page.locator('.bag-draw-tool[data-tool="rect"]').click();
    await page.locator('.bag-draw-color').nth(1).click();
    await expect(page.locator('#modal')).not.toHaveAttribute('data-closed', '1');
    await expect(page.locator('.bag-draw-tool[data-tool="rect"]')).toHaveClass(/is-active/);
  });
});
