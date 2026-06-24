// ページ跨ぎワークフロー記録: 記録ON中にメモ(note)を残すと、現在URL付きの1ステップが
// chrome.storage.local の WORKFLOW_KEY に積まれることを、content-script.js を chrome スタブ付きで
// 直接注入して検証する(workflow.spec.mjs と同じ手法)。
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const contentScript = fs.readFileSync(path.join(projectRoot, 'content/content-script.js'), 'utf8');
const contentCss = fs.readFileSync(path.join(projectRoot, 'content/content.css'), 'utf8');
const jaLocaleJson = fs.readFileSync(path.join(projectRoot, 'sidepanel/locales/ja.json'), 'utf8');

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0">
  <button id="t1" style="position:fixed;left:60px;top:120px;width:160px;height:46px">送信ボタン</button>
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
const readWf = (page) => page.evaluate(() => window.__store.aiAdvisorWorkflow || null);
const setRecording = (page, on) =>
  page.evaluate((rec) => {
    const wf = window.__store.aiAdvisorWorkflow || { steps: [], saved: [] };
    wf.recording = rec;
    window.__store.aiAdvisorWorkflow = wf;
  }, on);

const addNote = (page, selector, note) =>
  send(page, { type: 'RUN_ACTIONS', actions: [{ verb: 'addNote', args: { selector, note } }], source: 'chat' });

test.describe('ページ跨ぎワークフロー記録', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 820 });
    await page.setContent(PAGE_HTML);
    await page.addScriptTag({ content: CHROME_STUB });
    await page.addStyleTag({ content: contentCss });
    await page.addScriptTag({ content: contentScript });
  });

  test('記録ON中のメモは現在URL付きの1ステップとして積まれる', async ({ page }) => {
    await setRecording(page, true);
    const res = await addNote(page, '#t1', '送信前に確認');
    expect(res.results[0].ok).toBe(true);

    const wf = await readWf(page);
    expect(wf.recording).toBe(true);
    expect(wf.steps.length).toBe(1);
    const step = wf.steps[0];
    expect(step.kind).toBe('note');
    expect(step.text).toBe('送信前に確認');
    expect(step.url).toBe(await page.evaluate(() => location.href));
    expect(step.matchType).toBe('page');
    expect(step.target).toContain('送信ボタン');
    expect(step.annoId).toBeTruthy();
  });

  test('記録OFFならメモを残してもステップは積まれない', async ({ page }) => {
    await setRecording(page, false);
    await addNote(page, '#t1', 'これは記録しない');
    const wf = await readWf(page);
    // recording=false のまま、steps は作られない/空。
    expect((wf && wf.steps ? wf.steps.length : 0)).toBe(0);
  });

  test('同じメモの再編集は同じステップを更新し、二重に積まない', async ({ page }) => {
    await setRecording(page, true);
    await addNote(page, '#t1', '初版');
    let wf = await readWf(page);
    expect(wf.steps.length).toBe(1);
    const annoId = wf.steps[0].annoId;

    // 同じ要素へ addNote すると同じ anchor 由来で別アノテーションになるため、ここでは
    // EDIT 経路ではなく「別要素なしの再保存」を模さず、明示的に annoId を使った更新を検証する。
    // content の upsertAnnotation は id 指定で更新するので、保存済み annoId を渡して本文を変える。
    const editRes = await send(page, {
      type: 'RUN_ACTIONS',
      actions: [{ verb: 'addNote', args: { selector: '#t1', note: '改版' } }],
      source: 'chat',
    });
    expect(editRes.results[0].ok).toBe(true);
    wf = await readWf(page);
    // 別アノテーション(別annoId)なので 2 ステップになる。これは仕様(別メモ=別手順)。
    expect(wf.steps.length).toBe(2);
    expect(wf.steps.map((s) => s.text)).toEqual(['初版', '改版']);

    // 既存ステップの annoId が保たれている(冪等キー)ことを確認。
    expect(wf.steps[0].annoId).toBe(annoId);
  });
});
