// 判断AI(Jev)の E2E(拡張を実際に読み込む): リスト項目の表記が変わってルールで決まらない手順を、
// 偽の Jev サーバー(loopback)に判断させる。
//   - 確信度が高い → そのまま選んで進み、手順に「選んだ項目と確信度」のメモ(suggestion)を残す
//   - 確信度が低い → 手順を保留し、最有力の候補をメモ(pending)に残す → 承認で進む
//   - 判断の承認では確定系ゲートは外れない(確定系ラベルは別の承認で止まる)
import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const VARIANTS = {
  // 記録時
  rec: ['Belkin USB-C ケーブル 2m', 'Anker USB-C ケーブル 1m', 'エレコム Lightning ケーブル', 'サンワ HDMI ケーブル'],
  // 同じ商品の表記が変わった(Jev は高確信)
  relabeled: ['エレコム Lightning ケーブル', '【新パッケージ】Anker USB-C to USB-C ケーブル (1m)', 'Belkin USB-C ケーブル 2m', 'サンワ HDMI ケーブル'],
  // 同じ商品の色違いが2つ(Jev は迷う)
  twins: ['Belkin USB-C ケーブル 2m', 'Anker USB-C ケーブル(1m)ブラック', 'Anker USB-C ケーブル(1m)ホワイト', 'サンワ HDMI ケーブル'],
};

function listHtml(names, button = '選ぶ') {
  const items = names.map((n) => `<li class="opt"><span class="name">${n}</span> <button class="pick">${button}</button></li>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>検索結果</title></head><body>
  <h2 id="h">検索結果</h2><ul id="list" aria-labelledby="h">${items}</ul><output id="state">idle</output>
  <script>
    document.getElementById('list').addEventListener('click', (e) => {
      const li = e.target.closest('li');
      if (!e.target.closest('button') || !li) return;
      document.getElementById('state').textContent = 'picked:' + li.querySelector('.name').textContent;
    });
  </script></body></html>`;
}

// 偽 Jev: 本文の候補から「Anker」を含むものを選ぶ。1つなら高確信、複数なら迷う(最初を最有力に)。
// flip: 迷う時の最有力を入れ替える(承認後に問い直すと別の候補を選んでしまう状況を作る)。
function fakeJev(body, flip = false) {
  const criteria = body?.questions?.pick?.criteria || {};
  const anker = Object.keys(criteria).filter((k) => k !== 'none' && /Anker/.test(criteria[k]));
  if (flip) anker.reverse();
  const probabilities = Object.fromEntries(Object.keys(criteria).map((k) => [k, 0]));
  if (anker.length === 1) {
    probabilities[anker[0]] = 0.95;
    probabilities.none = 0.05;
  } else if (anker.length > 1) {
    probabilities[anker[0]] = 0.48;
    probabilities[anker[1]] = 0.46;
    probabilities.none = 0.06;
  } else {
    probabilities.none = 0.97;
  }
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
  return { model: 'jev-fake', answers: { pick: { type: 'choice', choice, probabilities } } };
}

function startServer(state) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname === '/v1/systemone' && req.method === 'POST') {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          const body = JSON.parse(raw);
          state.jevCalls.push({ auth: req.headers.authorization, body });
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(fakeJev(body, state.flip)));
        });
        return;
      }
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (url.pathname === '/list') return res.end(listHtml(VARIANTS[state.variant], state.button));
      res.statusCode = 404;
      res.end('not found');
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

test.describe('判断AI(Jev) E2E (拡張ロード)', () => {
  test.describe.configure({ mode: 'serial' });
  const state = { variant: 'rec', button: '選ぶ', jevCalls: [], flip: false };
  let server;
  let origin;
  let context;
  let userDataDir;
  let sw;
  let extPage;
  let recorded; // 記録した pick 手順(各テストの初期状態)

  test.beforeAll(async () => {
    server = await startServer(state);
    origin = `http://127.0.0.1:${server.address().port}`;
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bag-wf-judge-'));
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: ['--headless=new', `--disable-extensions-except=${projectRoot}`, `--load-extension=${projectRoot}`],
    });
    sw = await getServiceWorker(context);
    const extId = new URL(sw.url()).host;
    extPage = await context.newPage();
    await extPage.goto(`chrome-extension://${extId}/options/options.html`);
    // LLM キーは無し。判断AIだけを loopback の偽 Jev に向ける。
    await sw.evaluate(async (base) => {
      const k = 'aiAdvisorSettings';
      const cur = (await chrome.storage.local.get(k))[k] || {};
      await chrome.storage.local.set({ [k]: { ...cur, judge: { provider: 'jev', apiKey: 'test-key', baseUrl: base, model: 'jev-fake', minConfidence: 0.7 } } });
    }, `${origin}/v1`);
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
  const waitContentReady = (page) =>
    expect
      .poll(async () => {
        const tabId = await tabIdOf(page.url());
        if (!tabId) return false;
        return extPage.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'PING' }).then((r) => r?.ok === true).catch(() => false), tabId);
      })
      .toBe(true);
  const setSteps = (steps) => sw.evaluate((s) => chrome.storage.local.set({ aiAdvisorWorkflow: { recording: false, steps: s, saved: [] } }), steps);
  const runOf = () => readStore(sw, 'aiAdvisorWorkflowRun');
  const stepOf = async () => (await readStore(sw, 'aiAdvisorWorkflow')).steps[0];

  async function openList(variant, button = '選ぶ') {
    state.variant = variant;
    state.button = button;
    const page = await context.newPage();
    await page.goto(`${origin}/list`);
    await waitContentReady(page);
    return { page, tabId: await tabIdOf(`${origin}/list`) };
  }

  test('記録: リストの2番目を選ぶ pick 手順になる', async () => {
    await sw.evaluate(() => chrome.storage.local.set({ aiAdvisorWorkflow: { recording: true, steps: [], saved: [] } }));
    const { page } = await openList('rec');
    await page.click('#list li:nth-child(2) button');
    await expect(page.locator('#state')).toHaveText('picked:Anker USB-C ケーブル 1m');
    await expect.poll(async () => (await readStore(sw, 'aiAdvisorWorkflow'))?.steps?.length ?? 0).toBe(1);
    recorded = await stepOf();
    expect(recorded.locator.kind).toBe('pick');
    expect(recorded.choice.value).toContain('Anker USB-C ケーブル 1m');
    recorded = { ...recorded, needsReview: false, gate: false };
    await page.close();
  });

  test('高確信: 表記が変わった同じ項目を選んで完走し、確信度つきのメモを残す', async () => {
    await setSteps([recorded]);
    const { page, tabId } = await openList('relabeled');
    state.jevCalls.length = 0;
    expect(await sendToSw({ type: 'START_WORKFLOW_AUTORUN', tabId, vars: {} })).toMatchObject({ active: true });
    await expect(page.locator('#state')).toHaveText('picked:【新パッケージ】Anker USB-C to USB-C ケーブル (1m)', { timeout: 15_000 });
    await expect.poll(async () => (await runOf())?.doneStepIds?.length ?? 0).toBe(1);
    expect((await runOf()).active).toBe(false);

    expect(state.jevCalls).toHaveLength(1);
    expect(state.jevCalls[0].auth).toBe('Bearer test-key');
    expect(state.jevCalls[0].body.model).toBe('jev-fake');
    const sg = (await stepOf()).suggestion;
    expect(sg.kind).toBe('choice');
    expect(sg.pending).not.toBe(true); // 実行済みの記録(提案中ではない)
    expect(sg.label).toContain('新パッケージ');
    expect(sg.reason).toMatch(/95%/);
    await page.close();
  });

  test('低確信: 保留して最有力をメモに残し、承認するとその候補で進む', async () => {
    await setSteps([recorded]);
    const { page, tabId } = await openList('twins');
    expect(await sendToSw({ type: 'START_WORKFLOW_AUTORUN', tabId, vars: {} })).toMatchObject({ active: true });
    await expect.poll(async () => (await runOf())?.heldStepId || '', { timeout: 15_000 }).toBe(recorded.id);
    const held = await runOf();
    expect(held).toMatchObject({ active: false, heldKind: 'judge', doneStepIds: [] });
    await expect(page.locator('#state')).toHaveText('idle'); // 迷ったので押していない
    const memo = (await stepOf()).suggestion;
    expect(memo).toMatchObject({ kind: 'choice', pending: true });
    expect(memo.label).toContain('ブラック');
    expect(memo.reason).toMatch(/48%/);

    // 承認後に問い直すとホワイトを選ぶ状態にしても、承認したブラックを押し、Jev は呼ばない。
    state.flip = true;
    const callsBefore = state.jevCalls.length;
    expect(await sendToSw({ type: 'APPROVE_WORKFLOW_STEP', tabId })).toMatchObject({ active: true });
    await expect(page.locator('#state')).toHaveText('picked:Anker USB-C ケーブル(1m)ブラック', { timeout: 15_000 });
    expect(state.jevCalls.length).toBe(callsBefore);
    state.flip = false;
    await expect.poll(async () => (await runOf())?.doneStepIds?.length ?? 0).toBe(1);
    const done = await runOf();
    expect(done).toMatchObject({ judgeApprovedStepId: '', approvedStepId: '', heldKind: '' });
    expect((await stepOf()).suggestion.pending).not.toBe(true); // 成功の記録で提案が上書きされた
    await page.close();
  });

  test('判断の承認では確定系ゲートは外れない', async () => {
    await setSteps([recorded]);
    const { page, tabId } = await openList('twins', '今すぐ購入');
    expect(await sendToSw({ type: 'START_WORKFLOW_AUTORUN', tabId, vars: {} })).toMatchObject({ active: true });
    await expect.poll(async () => (await runOf())?.heldKind || '', { timeout: 15_000 }).toBe('judge');
    expect(await sendToSw({ type: 'APPROVE_WORKFLOW_STEP', tabId })).toMatchObject({ active: true });

    // 候補は決まったが、確定系ラベルなので別の(通常の)承認で止まる。
    await expect.poll(async () => {
      const r = await runOf();
      return r && !r.active && r.heldStepId === recorded.id && r.heldKind === '' ? 'gate' : '';
    }, { timeout: 15_000 }).toBe('gate');
    await expect(page.locator('#state')).toHaveText('idle');
    expect((await runOf()).judgeApprovedStepId).toBe(recorded.id); // 判断の承認は持ち越す(再度迷わない)

    expect(await sendToSw({ type: 'APPROVE_WORKFLOW_STEP', tabId })).toMatchObject({ active: true });
    await expect(page.locator('#state')).toHaveText('picked:Anker USB-C ケーブル(1m)ブラック', { timeout: 15_000 });
    await page.close();
  });
});
