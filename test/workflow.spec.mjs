// お描きワークフロー: 番号付きお描きを「操作手順」として説明する機能の検証。
// 既存の通し番号(annoDrawingNumber)を手順番号として流用し、順序コネクタ・操作パネル・
// 手順送り・AI連携(explainWorkflow / addWorkflowStep / COLLECT_CONTEXT.workflow)が
// 正しく働くことを、content-script.js を chrome スタブ付きで直接注入して検証する。
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const contentScript = fs.readFileSync(path.join(projectRoot, 'content/content-script.js'), 'utf8');
const contentCss = fs.readFileSync(path.join(projectRoot, 'content/content.css'), 'utf8');
// content-script は SW から GET_I18N でロケール辞書を受け取る。テストでは日本語辞書を供給して
// 既定言語のUI(「2手順」「AIメモ」等)を再現する。
const jaLocaleJson = fs.readFileSync(path.join(projectRoot, 'sidepanel/locales/ja.json'), 'utf8');

// 縦に並んだ3つの対象要素。t1,t2 にお描き(手順1,2)、t3 は addWorkflowStep の対象。
const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0">
  <button id="t1" style="position:fixed;left:60px;top:120px;width:160px;height:46px">ボタンA</button>
  <button id="t2" style="position:fixed;left:60px;top:300px;width:160px;height:46px">ボタンB</button>
  <button id="t3" style="position:fixed;left:60px;top:480px;width:160px;height:46px">ボタンC</button>
</body></html>`;

const CHROME_STUB = `
  window.__bagListener = null;
  window.__store = {};
  window.__bagI18n = ${jaLocaleJson};
  const __clone = (v) => (v === undefined ? undefined : structuredClone(v));
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
    storage: {
      local: {
        get: (k) => Promise.resolve(typeof k === 'string' ? { [k]: __clone(window.__store[k]) } : __clone(window.__store)),
        set: (obj) => { for (const [key, val] of Object.entries(obj)) window.__store[key] = __clone(val); return Promise.resolve(); },
      },
      onChanged: { addListener() {} },
    },
  };
`;

const send = (page, msg) => page.evaluate((m) => new Promise((r) => window.__bagListener(m, {}, r)), msg);

async function drawRectOver(page, topY) {
  const before = await page.locator('.bag-memo').count();
  await send(page, { type: 'START_DRAWING' });
  await expect(page.locator('.bag-draw-overlay')).toHaveCount(1);
  await page.locator('.bag-draw-tool[data-tool="rect"]').click();
  await page.mouse.move(66, topY + 6);
  await page.mouse.down();
  await page.mouse.move(150, topY + 24, { steps: 5 });
  await page.mouse.move(210, topY + 40, { steps: 5 });
  await page.mouse.up();
  await page.locator('.bag-draw-op[data-op="done"]').click();
  // 完了で中間モーダルを挟まず、図形の隣にAIメモが即生成される。
  await expect(page.locator('.bag-author')).toHaveCount(0);
  await expect(page.locator('.bag-memo')).toHaveCount(before + 1);
  await page.mouse.move(960, 780); // メモ/パネルから離す
}

test.describe('お描きワークフロー', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 820 });
    await page.setContent(PAGE_HTML);
    await page.addScriptTag({ content: CHROME_STUB });
    await page.addStyleTag({ content: contentCss });
    await page.addScriptTag({ content: contentScript });
  });

  test('お描きが2件以上でワークフローパネルが現れ、件数を表示する', async ({ page }) => {
    const panel = page.locator('.bag-wf-panel');
    await drawRectOver(page, 120); // 手順1
    await expect(panel).toBeHidden(); // 1件ではまだ出ない
    await drawRectOver(page, 300); // 手順2
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-wf="count"]')).toHaveText('2手順');
    // 番号バッジは通し番号 1,2。
    await expect(page.locator('.bag-anno-num')).toHaveCount(2);
    await expect(page.locator('.bag-anno-num').first()).toHaveText('1');
  });

  test('「順序を表示」で手順 i→i+1 の順序コネクタが描かれる', async ({ page }) => {
    await drawRectOver(page, 120);
    await drawRectOver(page, 300);
    // 既定では順序コネクタは出ない(メモ引き出し線とは別物)。
    await expect(page.locator('.bag-draw-layer .bag-wf-connector')).toHaveCount(0);
    await page.locator('.bag-wf-panel [data-wf="mode"]').check();
    // 2手順 → 1本の順序コネクタ。
    await expect(page.locator('.bag-draw-layer .bag-wf-connector')).toHaveCount(1);
  });

  test('COLLECT_CONTEXT が番号順の workflow を返す', async ({ page }) => {
    await drawRectOver(page, 120);
    await drawRectOver(page, 300);
    const ctx = await send(page, { type: 'COLLECT_CONTEXT' });
    expect(ctx.workflow).toBeTruthy();
    expect(ctx.workflow.count).toBe(2);
    expect(ctx.workflow.steps.map((s) => s.step)).toEqual([1, 2]);
    expect(ctx.workflow.steps[0].target).toContain('ボタンA');
    expect(ctx.workflow.steps[1].target).toContain('ボタンB');
  });

  test('explainWorkflow 動詞が手順を構造化して返す', async ({ page }) => {
    await drawRectOver(page, 120);
    await drawRectOver(page, 300);
    const out = await send(page, {
      type: 'RUN_ACTIONS',
      actions: [{ verb: 'explainWorkflow', args: {} }],
      source: 'chat',
    });
    const res = out.results[0];
    expect(res.ok).toBe(true);
    expect(res.result.count).toBe(2);
    expect(res.result.steps[0].step).toBe(1);
  });

  test('addWorkflowStep 動詞が通し番号の続きで手順を1つ追加する', async ({ page }) => {
    await drawRectOver(page, 120);
    await drawRectOver(page, 300);
    const out = await send(page, {
      type: 'RUN_ACTIONS',
      actions: [{ verb: 'addWorkflowStep', args: { selector: '#t3', kind: 'rect', note: '3番目の手順' } }],
      source: 'chat',
    });
    const res = out.results[0];
    expect(res.ok).toBe(true);
    expect(res.result.step).toBe(3);
    // 図形・番号バッジが3つになり、パネルも3手順に更新される。
    await expect(page.locator('.bag-anno-num')).toHaveCount(3);
    await expect(page.locator('.bag-wf-panel [data-wf="count"]')).toHaveText('3手順');
    // storage にも3件目の drawing が保存されている。
    const saved = await page.evaluate(() => {
      const map = window.__store.aiAdvisorAnnotations || {};
      const scope = location.origin + location.pathname;
      return (map[scope] || []).filter((a) => a.kind === 'drawing').length;
    });
    expect(saved).toBe(3);
  });

  test('手順送り(⏭)で現在手順がスポットライトされ、表示が進む', async ({ page }) => {
    await drawRectOver(page, 120);
    await drawRectOver(page, 300);
    await page.locator('.bag-wf-panel [data-wf="mode"]').check();
    await page.locator('.bag-wf-panel [data-wf="next"]').click();
    await expect(page.locator('.bag-wf-panel [data-wf="step"]')).toHaveText('1 / 2');
    // 手順1がアクティブ、手順2は減光。
    await expect(page.locator('.bag-anno-num--active')).toHaveCount(1);
    await page.locator('.bag-wf-panel [data-wf="next"]').click();
    await expect(page.locator('.bag-wf-panel [data-wf="step"]')).toHaveText('2 / 2');
  });
});
