// 決定的ワークフローの E2E(拡張を実際に読み込む): 実操作で記録 → 選び方/変数を直す →
// 並び順と注文IDが変わった別セッションで、AI キー無しのまま最後の確定ボタン手前まで自動実行 →
// 承認ゲートで停止 → 承認で完走、を service worker のランナーごと検証する。
import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const SHIPPING = [
  ['ヤマト通常', 1200],
  ['佐川急便', 1450],
  ['チャーター便', 6800],
  ['日本郵便', 1100],
];

function shopHtml(order) {
  const items = order
    .map(([name, price]) => `<li class="opt"><span class="name">${name}</span> <span class="price">¥${price.toLocaleString('en-US')}</span> <button class="pick">選ぶ</button></li>`)
    .join('');
  const orderId = 100 + Math.floor(Math.random() * 900);
  return `<!doctype html><html><head><meta charset="utf-8"><title>配送方法</title></head><body>
  <h2 id="ship-h">配送方法</h2>
  <ul id="ship" aria-labelledby="ship-h">${items}</ul>
  <output id="state">idle</output>
  <a id="next" data-testid="next" href="/checkout/${orderId}">次へ</a>
  <script>
    document.getElementById('ship').addEventListener('click', (e) => {
      const li = e.target.closest('li');
      if (!e.target.closest('button') || !li) return;
      const name = li.querySelector('.name').textContent;
      sessionStorage.setItem('ship', name);
      document.getElementById('state').textContent = 'ship:' + name;
    });
  </script></body></html>`;
}

const CHECKOUT_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>注文内容</title></head><body>
  <h2>注文内容</h2>
  <label>数量 <input id="qty" name="qty" type="text"></label>
  <label>配送先 <select id="region" name="region">
    <option value="">選択してください</option><option value="tk">東京</option>
    <option value="os">大阪</option><option value="fk">福岡</option>
  </select></label>
  <button id="confirm" data-testid="confirm">注文を確定する</button>
  <output id="state">idle</output>
  <script>
    document.getElementById('confirm').addEventListener('click', () => {
      document.getElementById('state').textContent = ['ordered', sessionStorage.getItem('ship'),
        document.getElementById('qty').value, document.getElementById('region').value].join(':');
    });
  </script></body></html>`;

function startServer() {
  let shopVisits = 0;
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (url.pathname === '/shop') {
        // 訪問ごとに並び順を変える(記録時と実行時で位置が違う=位置で選ぶと壊れる状況)。
        shopVisits += 1;
        const order = shopVisits % 2 ? SHIPPING : [...SHIPPING].reverse();
        res.end(shopHtml(order));
      } else if (/^\/checkout\/\d+$/.test(url.pathname)) {
        res.end(CHECKOUT_HTML);
      } else if (url.pathname === '/reports') {
        res.end(`<!doctype html><html><head><meta charset="utf-8"><title>レポート</title></head><body>
          <a id="open" href="/reports/${100 + Math.floor(Math.random() * 900)}" target="_blank">10月の売上</a></body></html>`);
      } else if (/^\/reports\/\d+$/.test(url.pathname)) {
        res.end(`<!doctype html><html><head><meta charset="utf-8"><title>売上レポート</title></head><body>
          <a id="csv" href="/files/sales-2026-10.csv" download>CSVをダウンロード</a>
          <a id="broken" href="/files/missing.csv" download>壊れたリンク</a></body></html>`);
      } else if (url.pathname === '/files/sales-2026-10.csv') {
        res.setHeader('content-type', 'text/csv');
        res.setHeader('content-disposition', 'attachment; filename="sales-2026-10.csv"');
        res.end('month,total\n2026-10,1200\n');
      } else {
        res.statusCode = 404;
        res.end('not found');
      }
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

const readStore = (sw, key) => sw.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key);

test.describe('決定的ワークフロー E2E (拡張ロード)', () => {
  // 2本目は1本目が記録した手順を使う。1本目が落ちたら2本目は誤った前提で走らせない。
  test.describe.configure({ mode: 'serial' });
  let server;
  let origin;
  let context;
  let userDataDir;
  let sw;
  let extPage;

  test.beforeAll(async () => {
    server = await startServer();
    origin = `http://127.0.0.1:${server.address().port}`;
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bag-wf-e2e-'));
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: ['--headless=new', `--disable-extensions-except=${projectRoot}`, `--load-extension=${projectRoot}`],
    });
    sw = await getServiceWorker(context);
    const extId = new URL(sw.url()).host;
    // SW へメッセージを送る送信元として拡張ページを1枚開く(SW は自分宛ての sendMessage を受けない)。
    extPage = await context.newPage();
    await extPage.goto(`chrome-extension://${extId}/options/options.html`);
    // SW の進捗通知(notifyAutoRun のブロードキャスト)を拡張ページで拾う。
    await extPage.evaluate(() => {
      window.__autorun = [];
      chrome.runtime.onMessage.addListener((m) => void window.__autorun.push(m));
    });
  });

  test.afterAll(async () => {
    await context?.close().catch(() => {});
    if (server) {
      const closed = new Promise((r) => server.close(r));
      server.closeAllConnections?.();
      await closed;
    }
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  const sendToSw = (msg) =>
    extPage.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), msg).then((r) => {
      if (!r?.ok) throw new Error(`SW error: ${r?.error}`);
      return r.result;
    });
  const tabIdOf = (url) =>
    extPage.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => (t.url || '').startsWith(u))?.id, url);
  // 固定 sleep ではなく、content script が PING に応答するまで待つ(PING は記録状態の読み込みを待ってから応答する)。
  const waitContentReady = (page) =>
    expect
      .poll(async () => {
        const tabId = await tabIdOf(page.url());
        if (!tabId) return false;
        return extPage.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'PING' }).then((r) => r?.ok === true).catch(() => false), tabId);
      })
      .toBe(true);

  test('記録 → 並び順/IDが変わっても最後まで決定的に実行し、確定ボタンは承認まで止まる', async () => {
    test.setTimeout(90_000);
    await sw.evaluate(() => chrome.storage.local.set({ aiAdvisorWorkflow: { recording: true, steps: [], saved: [] } }));

    // --- 1) 実操作で記録(リスト2番目=チャーター便を選んで次へ → 数量/配送先/確定) ---
    const page = await context.newPage();
    await page.goto(`${origin}/shop`);
    await expect(page.locator('#ship li').first()).toContainText('ヤマト通常');
    await waitContentReady(page);
    await page.click('#ship li:nth-child(3) button');
    await page.click('#next');
    await page.waitForURL(/\/checkout\/\d+$/);
    await waitContentReady(page);
    await page.fill('#qty', '2');
    await page.locator('#qty').blur();
    await page.selectOption('#region', 'os');
    await page.click('#confirm');
    await expect(page.locator('#state')).toHaveText('ordered:チャーター便:2:os');

    let wf;
    await expect
      .poll(async () => {
        wf = await readStore(sw, 'aiAdvisorWorkflow');
        return (wf?.steps || []).map((s) => s.action?.verb).join(',');
      })
      .toBe('click,click,fill,select,click');
    const [pick, next, fill, select, confirm] = wf.steps;
    expect(pick.locator.kind).toBe('pick');
    expect(pick.choice.value).toContain('チャーター便');
    expect(next.check).toMatchObject({ type: 'url' });
    expect(next.check.value).toMatch(/\/checkout\/\d+$/);
    expect(select.choice).toEqual({ by: 'text', value: '大阪' });
    expect(confirm.gate).toBe(true);

    // --- 2) 人間が直す: 配送は「いちばん安い」、数量は実行時の変数にする。記録は止める ---
    pick.choice = { by: 'min', value: '' };
    pick.needsReview = false;
    fill.action = { verb: 'fill', value: '{qty}' };
    await sw.evaluate((steps) => chrome.storage.local.set({ aiAdvisorWorkflow: { recording: false, steps, saved: [] } }), wf.steps);

    // --- 3) 別セッション: 並び順が逆、注文IDも別。AIキー無しで自動実行 ---
    await page.goto(`${origin}/shop`);
    await expect(page.locator('#ship li').first()).toContainText('日本郵便');
    const tabId = await tabIdOf(`${origin}/shop`);
    expect(tabId).toBeTruthy();

    // 変数が足りなければ開始しない。
    expect(await sendToSw({ type: 'START_WORKFLOW_AUTORUN', tabId, vars: {} })).toMatchObject({ active: false, reason: 'vars', missing: ['qty'] });

    expect(await sendToSw({ type: 'START_WORKFLOW_AUTORUN', tabId, vars: { qty: '5' } })).toMatchObject({ active: true });
    await expect.poll(async () => (await readStore(sw, 'aiAdvisorWorkflowRun'))?.heldStepId || '', { timeout: 30_000 }).toBe(confirm.id);
    await expect(page).toHaveURL(/\/checkout\/\d+$/);
    await expect(page.locator('#qty')).toHaveValue('5');
    await expect(page.locator('#region')).toHaveValue('os');
    await expect(page.locator('#state')).toHaveText('idle'); // 確定はまだ押していない
    const held = await readStore(sw, 'aiAdvisorWorkflowRun');
    expect(held.active).toBe(false);
    expect(held.doneStepIds).toEqual([pick.id, next.id, fill.id, select.id]);

    // --- 4) 承認 → 確定ボタンだけを押して完走 ---
    expect(await sendToSw({ type: 'APPROVE_WORKFLOW_STEP', tabId })).toMatchObject({ active: true });
    await expect(page.locator('#state')).toHaveText('ordered:日本郵便:5:os', { timeout: 15_000 });
    await expect.poll(async () => (await readStore(sw, 'aiAdvisorWorkflowRun'))?.doneStepIds?.length ?? 0).toBe(5);
    expect((await readStore(sw, 'aiAdvisorWorkflowRun')).active).toBe(false);

    // AI は使っていない(ルールで決まった)ので学習候補は付かない。
    const after = await readStore(sw, 'aiAdvisorWorkflow');
    expect(after.steps.every((s) => !s.suggestion)).toBe(true);
    await page.close();
  });

  test('試走: このページの手順だけを操作せずに解決し、ルールで決まらない手順は needs-ai と示す', async () => {
    const steps = (await readStore(sw, 'aiAdvisorWorkflow')).steps;
    const page = await context.newPage();
    await page.goto(`${origin}/shop`);
    await waitContentReady(page);
    const tabId = await tabIdOf(`${origin}/shop`);

    const res = await sendToSw({ type: 'DRY_RUN_WORKFLOW', tabId, vars: { qty: '1' } });
    expect(res.results.map((r) => r.status)).toEqual(['ok', 'ok', 'other-page', 'other-page', 'other-page']);
    expect(res.results[0].chosenText).toContain('日本郵便');
    await expect(page.locator('#state')).toHaveText('idle'); // 何も押していない
    await expect(page).toHaveURL(`${origin}/shop`);

    // 選び方を「該当なし」になるテキストへ変えると、AI を呼ばずに needs-ai を返す。
    steps[0].choice = { by: 'text', value: 'FedEx' };
    await sw.evaluate((s) => chrome.storage.local.set({ aiAdvisorWorkflow: { recording: false, steps: s, saved: [] } }), steps);
    const res2 = await sendToSw({ type: 'DRY_RUN_WORKFLOW', tabId, vars: { qty: '1' } });
    expect(res2.results[0].status).toBe('needs-ai');
    await page.close();
  });
  // レポートは新しいタブで開くリンク(target=_blank)。人は新しいタブで続けて記録し、自動実行は1つのタブのまま進む。
  test('ページを跨いでレポートを開き、CSV のダウンロード完了まで確認する(記録で確認が自動で付く)', async () => {
    test.setTimeout(60_000);
    await sw.evaluate(() => chrome.storage.local.set({ aiAdvisorWorkflow: { recording: true, steps: [], saved: [] } }));
    const page = await context.newPage();
    await page.goto(`${origin}/reports`);
    await waitContentReady(page);
    const [report] = await Promise.all([context.waitForEvent('page'), page.click('#open')]);
    await report.waitForURL(/\/reports\/\d+$/);
    await waitContentReady(report);
    await report.click('#csv');

    let steps;
    await expect
      .poll(async () => {
        steps = (await readStore(sw, 'aiAdvisorWorkflow'))?.steps || [];
        return steps.map((s) => s.check?.type).join(',');
      })
      .toBe('url,download');

    // 別セッション(レポートIDが変わる): 記録を止めて自動実行 → ダウンロード完了で前進し、保存先を知らせる。
    await sw.evaluate((s) => chrome.storage.local.set({ aiAdvisorWorkflow: { recording: false, steps: s, saved: [] } }), steps);
    await page.goto(`${origin}/reports`);
    await waitContentReady(page);
    const tabId = await tabIdOf(`${origin}/reports`);
    await extPage.evaluate(() => (window.__autorun.length = 0));
    const pagesBefore = context.pages().length;
    expect(await sendToSw({ type: 'START_WORKFLOW_AUTORUN', tabId, vars: {} })).toMatchObject({ active: true });
    await expect.poll(async () => (await readStore(sw, 'aiAdvisorWorkflowRun'))?.doneStepIds?.length ?? 0, { timeout: 30_000 }).toBe(2);
    const done = await extPage.evaluate(() => window.__autorun.map((m) => m.text).join('\n'));
    expect(done).toMatch(/(保存|Saved): /);
    await expect(page).toHaveURL(/\/reports\/\d+$/); // 新しいタブを開かず、同じタブで進んだ
    expect(context.pages()).toHaveLength(pagesBefore);

    // ダウンロードが失敗したら(サーバーが 404)完了扱いにせず、手順番号つきで止まる。
    steps[1].locator.anchor = { ...steps[1].locator.anchor, selector: '#broken', text: '壊れたリンク', id: 'broken' };
    steps[1].target = '壊れたリンク';
    await sw.evaluate((s) => chrome.storage.local.set({ aiAdvisorWorkflow: { recording: false, steps: s, saved: [] } }), steps);
    await page.goto(`${origin}/reports`);
    await waitContentReady(page);
    await extPage.evaluate(() => (window.__autorun.length = 0));
    expect(await sendToSw({ type: 'START_WORKFLOW_AUTORUN', tabId, vars: {} })).toMatchObject({ active: true });
    await expect.poll(async () => (await readStore(sw, 'aiAdvisorWorkflowRun'))?.active, { timeout: 30_000 }).toBe(false);
    expect((await readStore(sw, 'aiAdvisorWorkflowRun')).doneStepIds).toHaveLength(1);
    const failed = await extPage.evaluate(() => window.__autorun.map((m) => m.text).join('\n'));
    expect(failed).toMatch(/ダウンロードが中断されました|download was interrupted/);
    await report.close();
    await page.close();
  });
});
