// 決定的ワークフロー(content 側): 記録中の実操作がそのまま構造化手順になること、
// 繰り返し項目(リスト)のクリックが「選び方」付きの pick 手順になること、RUN_STEP が
// 要素解決 → 候補列挙 → 操作 → 事後確認 を決定的に行うことを、content-script.js を
// chrome スタブ付きで直接注入して検証する(workflow.spec.mjs と同じ手法)。
// 候補の選択ルールは lib/workflow.js の pickCandidate(SW が使う純関数)をそのまま使う。
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const contentScript = fs.readFileSync(path.join(projectRoot, 'content/content-script.js'), 'utf8');
const contentCss = fs.readFileSync(path.join(projectRoot, 'content/content.css'), 'utf8');
const jaLocaleJson = fs.readFileSync(path.join(projectRoot, 'sidepanel/locales/ja.json'), 'utf8');
// Playwright のローダは package.json に type:module が無い .js を CJS 扱いするため、
// 依存の無い ESM である lib/workflow.js を data: URL として読み込む。
const workflowSrc = fs.readFileSync(path.join(projectRoot, 'lib/workflow.js'), 'utf8');
const { normalizeStep, pickCandidate } = await import(
  `data:text/javascript;base64,${Buffer.from(workflowSrc).toString('base64')}`
);

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;font:14px sans-serif">
  <button id="new" data-testid="new-order">新しく始める</button>
  <label>数量 <input id="qty" name="qty" type="text"></label>
  <label>配送先 <select id="region" name="region">
    <option value="">選択してください</option>
    <option value="tk">東京</option>
    <option value="os">大阪</option>
    <option value="fk">福岡</option>
  </select></label>
  <h3 id="ship-h">配送方法</h3>
  <ul id="ship" aria-labelledby="ship-h">
    <li class="opt"><span class="name">ヤマト通常</span> <span class="price">¥1,200</span> <button class="pick">選ぶ</button></li>
    <li class="opt"><span class="name">佐川急便</span> <span class="price">¥1,450</span> <button class="pick">選ぶ</button></li>
    <li class="opt"><span class="name">チャーター便</span> <span class="price">¥6,800</span> <button class="pick">選ぶ</button></li>
    <li class="opt"><span class="name">日本郵便</span> <span class="price">¥1,100</span> <button class="pick">選ぶ</button></li>
  </ul>
  <label><input id="agree" type="checkbox"> 規約に同意</label>
  <button id="confirm" data-testid="confirm">注文を確定する</button>
  <output id="state">idle</output>
  <script>
    const st = document.getElementById('state');
    document.getElementById('new').addEventListener('click', () => { st.textContent = 'new'; });
    document.getElementById('confirm').addEventListener('click', () => { st.textContent = 'ordered'; });
    document.getElementById('ship').addEventListener('click', (e) => {
      const li = e.target.closest('li');
      if (e.target.closest('button') && li) st.textContent = 'ship:' + li.querySelector('.name').textContent;
    });
    window.__reorderShip = () => {
      const ul = document.getElementById('ship');
      const items = Array.from(ul.children).reverse();
      items.forEach((li) => ul.appendChild(li));
    };
  </script>
</body></html>`;

// chrome.storage.onChanged も実装したスタブ(content の wfCache が実機と同じく追従する)。
const CHROME_STUB = `
  window.__bagListener = null; window.__store = {}; window.__changed = [];
  window.__bagI18n = ${jaLocaleJson};
  const __c = (v) => (v === undefined ? undefined : structuredClone(v));
  window.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => { window.__bagListener = fn; } },
      sendMessage: (msg, cb) => {
        if (msg && msg.type === 'GET_I18N') {
          const r = { ok: true, result: { locale: 'ja', messages: window.__bagI18n, fallback: window.__bagI18n } };
          if (typeof cb === 'function') { cb(r); return; } return Promise.resolve(r);
        }
        if (typeof cb === 'function') { cb({ ok: true }); return; } return Promise.resolve({ ok: true });
      },
      get lastError() { return null; },
    },
    storage: {
      local: {
        get: (k) => Promise.resolve(typeof k === 'string' ? { [k]: __c(window.__store[k]) } : __c(window.__store)),
        set: (o) => {
          const changes = {};
          for (const [k, v] of Object.entries(o)) { changes[k] = { oldValue: __c(window.__store[k]), newValue: __c(v) }; window.__store[k] = __c(v); }
          setTimeout(() => window.__changed.forEach((fn) => fn(__c(changes), 'local')), 0);
          return Promise.resolve();
        },
      },
      onChanged: { addListener(fn) { window.__changed.push(fn); } },
    },
  };
`;

const send = (page, msg) => page.evaluate((m) => new Promise((r) => window.__bagListener(m, {}, r)), msg);
const steps = (page) => page.evaluate(() => (window.__store.aiAdvisorWorkflow || {}).steps || []);
const runStep = (page, step, options = {}) => send(page, { type: 'RUN_STEP', step: normalizeStep(step), options });
const state = (page) => page.locator('#state').innerText();

async function load(page, { recording = false } = {}) {
  await page.setViewportSize({ width: 900, height: 900 });
  // about:blank では pushState が使えないため、実 URL として配信する。
  await page.route('http://bag.test/**', (route) => route.fulfill({ contentType: 'text/html', body: PAGE_HTML }));
  await page.goto('http://bag.test/orders/new');
  await page.addScriptTag({ content: CHROME_STUB });
  await page.evaluate((rec) => {
    window.__store.aiAdvisorWorkflow = { recording: rec, steps: [], saved: [] };
  }, recording);
  await page.addStyleTag({ content: contentCss });
  await page.addScriptTag({ content: contentScript });
  await send(page, { type: 'PING' });
  await page.waitForTimeout(50); // init(loadWorkflowCache) の完了待ち
}

// 記録 → そのまま RUN_STEP に流す(SW の決定的ランナーと同じ手順で候補を選ぶ)。
async function execute(page, rawStep, extra = {}) {
  const step = normalizeStep(rawStep);
  let res = await runStep(page, step, extra);
  if (res.status === 'choose') {
    const pick = pickCandidate(res.candidates, step.choice);
    if (pick.status !== 'ok') return { ...res, pick };
    res = await runStep(page, step, { ...extra, choiceKey: res.candidates[pick.index].key, token: res.token });
  }
  return res;
}

test.describe('決定的ワークフロー: 観察記録', () => {
  test('記録中のクリック・入力・選択・チェックがそのまま構造化手順になる', async ({ page }) => {
    await load(page, { recording: true });
    await page.click('#new');
    await page.fill('#qty', '12');
    await page.click('h3'); // blur → change
    await page.selectOption('#region', 'os');
    await page.check('#agree');
    await page.waitForTimeout(50);
    const list = await steps(page);
    expect(list.map((s) => s.action.verb)).toEqual(['click', 'fill', 'select', 'check']);
    expect(list[0]).toMatchObject({ kind: 'action', target: '新しく始める', locator: { kind: 'fixed' }, gate: false });
    expect(list[0].locator.anchor.selector).toBe('[data-testid="new-order"]');
    expect(list[1]).toMatchObject({ target: '数量', action: { value: '12' } });
    expect(list[2]).toMatchObject({ action: { value: '大阪' }, choice: { by: 'text', value: '大阪' } });
    expect(list[3]).toMatchObject({ action: { verb: 'check', value: 'on' } });
    expect(new Set(list.map((s) => s.id)).size).toBe(4); // 一意ID(ページを跨いでも衝突しない)
  });

  test('同じ欄への連続入力は1手順にまとまり、パスワードは値を保存せず変数になる', async ({ page }) => {
    await load(page, { recording: true });
    await page.evaluate(() => {
      const pw = document.createElement('input');
      pw.type = 'password';
      pw.id = 'pw';
      pw.setAttribute('aria-label', 'パスワード');
      document.body.appendChild(pw);
    });
    await page.fill('#qty', '1');
    await page.click('h3');
    await page.fill('#qty', '3');
    await page.click('h3');
    await page.fill('#pw', 'secret');
    await page.click('h3');
    await page.waitForTimeout(50);
    const list = await steps(page);
    expect(list.map((s) => [s.action.verb, s.action.value])).toEqual([
      ['fill', '3'],
      ['fill', '{password}'],
    ]);
    expect(list[1].needsReview).toBe(true);
    expect(JSON.stringify(list)).not.toContain('secret');
  });

  test('リスト内のクリックは「選び方」付きの pick 手順になり、確定系ボタンは承認ゲート付きになる', async ({ page }) => {
    await load(page, { recording: true });
    await page.click('#ship li:nth-child(3) button');
    await page.click('#confirm');
    await page.waitForTimeout(50);
    const [pick, confirm] = await steps(page);
    expect(pick.locator.kind).toBe('pick');
    expect(pick.target).toBe('配送方法'); // aria-labelledby の見出し
    expect(pick.choice).toEqual({ by: 'text', value: 'チャーター便 ¥6,800 選ぶ' });
    expect(pick.locator.item).toMatchObject({ tag: 'li', classes: ['opt'] });
    expect(pick.locator.inner).toBe(':scope > button');
    expect(pick.needsReview).toBe(true);
    expect(confirm.gate).toBe(true); // 「注文を確定する」
    expect(confirm.locator.kind).toBe('fixed');
  });

  test('記録OFF・拡張自身のUI・実行器の操作は記録しない', async ({ page }) => {
    await load(page, { recording: false });
    await page.click('#new');
    await page.waitForTimeout(50);
    expect(await steps(page)).toEqual([]);
    await page.evaluate(() => {
      window.__store.aiAdvisorWorkflow = { recording: true, steps: [], saved: [] };
      window.__changed.forEach((fn) => fn({ aiAdvisorWorkflow: { newValue: window.__store.aiAdvisorWorkflow } }, 'local'));
    });
    await runStep(page, { action: { verb: 'click' }, locator: { kind: 'fixed', anchor: { selector: '#new', tag: 'button' } } });
    await page.waitForTimeout(50);
    expect(await steps(page)).toEqual([]); // 実行器の el.click() は isTrusted=false で記録されない
  });

  test('クリック直後の SPA 遷移はその手順の URL 確認として自動で付く', async ({ page }) => {
    await load(page, { recording: true });
    await page.evaluate(() => {
      document.getElementById('new').addEventListener('click', () => {
        history.pushState({}, '', '/orders/8812/edit');
        document.body.appendChild(document.createElement('div')); // DOM 変化で content が URL 変化を検知
      });
    });
    await page.click('#new');
    await expect.poll(async () => (await steps(page))[0]?.check?.type).toBe('url');
    const step = normalizeStep((await steps(page))[0]);
    expect(step.check.value).toMatch(/\/orders\/:id\/edit$/); // 動的IDはパターンへ汎化
  });
});

test.describe('決定的ワークフロー: RUN_STEP', () => {
  test('固定手順: 記録どおりの要素を操作し、入力値は事後確認される', async ({ page }) => {
    await load(page, { recording: true });
    await page.click('#new');
    await page.fill('#qty', '12');
    await page.click('h3');
    await page.check('#agree');
    await page.waitForTimeout(50);
    const [click, fill, check] = await steps(page);
    await page.evaluate(() => {
      window.__store.aiAdvisorWorkflow.recording = false;
      document.getElementById('qty').value = '';
      document.getElementById('agree').checked = false;
      document.getElementById('state').textContent = 'idle';
    });
    expect(await execute(page, click)).toMatchObject({ status: 'ok', label: '新しく始める' });
    expect(await state(page)).toBe('new');
    expect((await execute(page, { ...fill, action: { verb: 'fill', value: '24' } })).status).toBe('ok');
    await expect(page.locator('#qty')).toHaveValue('24');
    expect((await execute(page, check)).status).toBe('ok');
    await expect(page.locator('#agree')).toBeChecked();
  });

  test('pick 手順: 並び順が変わっても「テキスト」ルールで同じ項目を選ぶ', async ({ page }) => {
    await load(page, { recording: true });
    await page.click('#ship li:nth-child(3) button');
    await page.waitForTimeout(50);
    const [pick] = await steps(page);
    await page.evaluate(() => window.__reorderShip());
    const res = await execute(page, { ...pick, choice: { by: 'text', value: 'チャーター便' } });
    expect(res.status).toBe('ok');
    expect(await state(page)).toBe('ship:チャーター便');
  });

  test('pick 手順: 「数値が最小」ルールは実行時の候補から決定的に選ぶ', async ({ page }) => {
    await load(page, { recording: true });
    await page.click('#ship li:nth-child(1) button');
    await page.waitForTimeout(50);
    const [pick] = await steps(page);
    const first = await runStep(page, { ...pick, choice: { by: 'min' } });
    expect(first.status).toBe('choose');
    expect(first.candidates.map((c) => c.key)).toEqual(['c0', 'c1', 'c2', 'c3']);
    const res = await execute(page, { ...pick, choice: { by: 'min' } });
    expect(res.status).toBe('ok');
    expect(await state(page)).toBe('ship:日本郵便');
  });

  test('pick 手順: ルールで決まらない時は SW に候補を返す(曖昧/該当なし)', async ({ page }) => {
    await load(page, { recording: true });
    await page.click('#ship li:nth-child(2) button');
    await page.waitForTimeout(50);
    const [pick] = await steps(page);
    await page.evaluate(() => { document.getElementById('state').textContent = 'idle'; });
    const amb = await execute(page, { ...pick, choice: { by: 'text', value: '便' } });
    expect(amb.pick.status).toBe('ambiguous');
    const none = await execute(page, { ...pick, choice: { by: 'text', value: 'FedEx' } });
    expect(none.pick.status).toBe('none');
    expect(await state(page)).toBe('idle'); // 何も押していない
  });

  test('select 手順: 選択肢を候補として返し、選んだ値を事後確認する', async ({ page }) => {
    await load(page, { recording: true });
    await page.selectOption('#region', 'os');
    await page.waitForTimeout(50);
    const [sel] = await steps(page);
    await page.selectOption('#region', '');
    const res = await execute(page, { ...sel, choice: { by: 'text', value: '福岡' } });
    expect(res.status).toBe('ok');
    await expect(page.locator('#region')).toHaveValue('fk');
  });

  test('承認ゲート: gate 付きクリックは held で止まり、approved なら押す', async ({ page }) => {
    await load(page, { recording: true });
    await page.click('#confirm');
    await page.waitForTimeout(50);
    const [confirm] = await steps(page);
    await page.evaluate(() => { document.getElementById('state').textContent = 'idle'; });
    expect(await execute(page, confirm)).toMatchObject({ status: 'held', label: '注文を確定する' });
    expect(await state(page)).toBe('idle');
    expect((await execute(page, confirm, { approved: true })).status).toBe('ok');
    expect(await state(page)).toBe('ordered');
  });

  test('対象が消えたら missing と代替候補を返し、選ばれた要素のアンカーを返す', async ({ page }) => {
    await load(page);
    const step = {
      action: { verb: 'click' },
      target: '新規作成',
      locator: { kind: 'fixed', anchor: { selector: '#gone', tag: 'button', role: 'button', text: '新規作成', testid: 'gone' } },
    };
    const res = await runStep(page, step, { timeoutMs: 300 });
    expect(res.status).toBe('missing');
    const idx = res.candidates.findIndex((c) => c.text === '新しく始める');
    expect(idx).toBeGreaterThanOrEqual(0);
    const done = await runStep(page, step, { choiceKey: res.candidates[idx].key, token: res.token });
    expect(done.status).toBe('ok');
    expect(done.anchor.selector).toBe('[data-testid="new-order"]');
    expect(await state(page)).toBe('new');
  });

  test('試走(dryRun)は操作せず対象だけ返す / 古い候補トークンは stale', async ({ page }) => {
    await load(page, { recording: true });
    await page.click('#confirm');
    await page.waitForTimeout(50);
    const [confirm] = await steps(page);
    await page.evaluate(() => { document.getElementById('state').textContent = 'idle'; });
    const dry = await execute(page, confirm, { dryRun: true });
    expect(dry).toMatchObject({ status: 'ok', dry: true });
    expect(await state(page)).toBe('idle');
    await expect(page.locator('.bag-step-flash')).toHaveCount(1);
    expect((await runStep(page, confirm, { choiceKey: 'c0', token: 'old' })).status).toBe('stale');
  });

  test('確認(text): 期待テキストが出なければ failed を返す', async ({ page }) => {
    await load(page);
    const step = {
      action: { verb: 'click' },
      target: '新しく始める',
      locator: { kind: 'fixed', anchor: { selector: '[data-testid="new-order"]', tag: 'button' } },
      check: { type: 'text', value: '注文番号' },
    };
    const res = await runStep(page, step, { timeoutMs: 300 });
    expect(res.status).toBe('failed');
    expect(res.error).toContain('注文番号');
  });
});
