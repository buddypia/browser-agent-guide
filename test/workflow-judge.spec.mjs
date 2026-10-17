// 判断AI(Jev)の E2E(拡張を実際に読み込む): リスト項目の表記が変わってルールで決まらない手順を、
// 偽の Jev / Clef サーバー(loopback)に判断させる。
//   - 確信度が高い → そのまま選んで進み、手順に「選んだ項目と確信度」のメモ(suggestion)を残す
//   - 確信度が低い → 手順を保留し、最有力の候補をメモ(pending)に残す → 承認で進む
//   - 判断の承認では確定系ゲートは外れない(確定系ラベルは別の承認で止まる)
//   - 承認は保留時に示した候補に束縛される(承認後に AI へ問い直さない)
//   - 記録要素が消えた時の差し替えは確信度が高くても承認待ち / Jev 障害は手順番号つきで止まる
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

const FORM_HTML = (label) => `<!doctype html><html><head><meta charset="utf-8"><title>設定</title></head><body>
  <h2>設定</h2><button id="b-${label}" type="button">${label}</button> <button type="button">キャンセル</button>
  <output id="state">idle</output>
  <script>document.body.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) document.getElementById('state').textContent = 'clicked:' + b.textContent; });</script>
  </body></html>`;

// 偽 Jev: 本文の候補から prefer(正規表現)に合うものを選ぶ。1つなら高確信、複数なら迷う(最初を最有力に)。
// flip: 迷う時の最有力を入れ替える(承認後に問い直すと別の候補を選んでしまう状況を作る)。
function fakeJev(body, { prefer = 'Anker', flip = false, visualPass = true } = {}) {
  if (body?.questions?.visual) {
    const pass = visualPass ? 0.94 : 0.12;
    const fail = Number((1 - pass).toFixed(2));
    return {
      model: 'jev-fake',
      answers: { visual: { type: 'choice', choice: visualPass ? 'pass' : 'fail', probabilities: { pass, fail } } },
    };
  }
  const criteria = body?.questions?.pick?.criteria || {};
  const anker = Object.keys(criteria).filter((k) => k !== 'none' && new RegExp(prefer).test(criteria[k]));
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
          state.jevCalls.push({ auth: req.headers.authorization, headers: req.headers, body });
          res.setHeader('content-type', 'application/json');
          if (state.fail) {
            res.statusCode = 500;
            return res.end('{"error":"boom"}');
          }
          res.end(JSON.stringify(fakeJev(body, state)));
        });
        return;
      }
      // 偽 Clef (Worker プロキシ): Jev と同じ {state, questions} → answers の契約。
      if (url.pathname === '/clef' && req.method === 'POST') {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          const body = JSON.parse(raw);
          state.clefCalls.push({ auth: req.headers.authorization, body });
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ...fakeJev(body, state), model: body.model }));
        });
        return;
      }
      if (url.pathname === '/v1/embeddings' && req.method === 'POST') {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          const body = JSON.parse(raw);
          state.eg2Calls.push({ path: '/v1/embeddings', body });
          res.setHeader('content-type', 'application/json');
          const inputs = Array.isArray(body.input) ? body.input : [];
          const data = inputs.map((txt, index) => ({
            index,
            embedding: body.input_type === 'query' || new RegExp(state.prefer).test(String(txt)) ? [0.98, 0.2] : [0.1, 0.99],
          }));
          res.end(JSON.stringify({ data }));
        });
        return;
      }
      if (url.pathname === '/v1/evaluate' && req.method === 'POST') {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          const body = JSON.parse(raw);
          state.eg2Calls.push({ path: '/v1/evaluate', body });
          res.setHeader('content-type', 'application/json');
          const pass = state.visualPass !== false;
          res.end(
            JSON.stringify({
              choice: pass ? 'pass' : 'fail',
              score: pass ? 0.93 : 0.89,
              scores: pass ? { pass: 0.93, fail: 0.07 } : { pass: 0.11, fail: 0.89 },
            })
          );
        });
        return;
      }
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (url.pathname === '/list') return res.end(listHtml(VARIANTS[state.variant], state.button));
      if (url.pathname === '/form') return res.end(FORM_HTML(state.formLabel));
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

test.describe('判断AI(Jev / Clef / eg2) E2E (拡張ロード)', () => {
  test.describe.configure({ mode: 'serial' });
  const state = { variant: 'rec', button: '選ぶ', formLabel: '保存する', jevCalls: [], clefCalls: [], eg2Calls: [], prefer: 'Anker', flip: false, fail: false, visualPass: true };
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
    // SW の進捗通知(notifyAutoRun のブロードキャスト)を拡張ページで拾う。
    await extPage.evaluate(() => {
      window.__autorun = [];
      chrome.runtime.onMessage.addListener((m) => void window.__autorun.push(JSON.stringify(m)));
    });
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
    await expect.poll(async () => (await readStore(sw, 'aiAdvisorWorkflow'))?.steps?.length ?? 0, { timeout: 15_000 }).toBe(1);
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
    expect(held.heldLabel).toMatch(/^Anker USB-C ケーブル\(1m\)ブラック/); // 承認の束縛先 = 示した候補
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
    expect(done).toMatchObject({ judgeApprovedStepId: '', approvedStepId: '', heldKind: '', heldLabel: '', approvedLabel: '' });
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
  test('確定系ゲートの承認も保留時に示した候補に束縛され、承認後に AI へ問い直さない', async () => {
    await setSteps([recorded]);
    const { page, tabId } = await openList('relabeled', '今すぐ購入');
    expect(await sendToSw({ type: 'START_WORKFLOW_AUTORUN', tabId, vars: {} })).toMatchObject({ active: true });
    // Jev は高確信で新パッケージを選ぶが、確定系ラベルなので通常のゲートで止まる。
    await expect.poll(async () => (await runOf())?.heldStepId || '', { timeout: 15_000 }).toBe(recorded.id);
    const held = await runOf();
    expect(held.heldKind).toBe('');
    expect(held.heldLabel).toMatch(/^【新パッケージ】Anker USB-C to USB-C ケーブル \(1m\)/);
    await expect(page.locator('#state')).toHaveText('idle');

    // 承認後に問い直すと Belkin を選ぶ状態にしても、承認した候補だけを押す。
    state.prefer = 'Belkin';
    const callsBefore = state.jevCalls.length;
    expect(await sendToSw({ type: 'APPROVE_WORKFLOW_STEP', tabId })).toMatchObject({ active: true });
    await expect(page.locator('#state')).toHaveText('picked:【新パッケージ】Anker USB-C to USB-C ケーブル (1m)', { timeout: 15_000 });
    expect(state.jevCalls.length).toBe(callsBefore);
    state.prefer = 'Anker';
    await page.close();
  });

  test('ルールで選んだ確定系の承認も示した候補に束縛される: 承認前に並びが変わっても、示した項目を押す', async () => {
    await setSteps([{ ...recorded, gate: true, choice: { by: 'first', value: '' } }]);
    const { page, tabId } = await openList('rec');
    const callsBefore = state.jevCalls.length;
    expect(await sendToSw({ type: 'START_WORKFLOW_AUTORUN', tabId, vars: {} })).toMatchObject({ active: true });
    await expect.poll(async () => (await runOf())?.heldStepId || '', { timeout: 15_000 }).toBe(recorded.id);
    expect((await runOf()).heldLabel).toMatch(/^Belkin USB-C ケーブル 2m/);
    // 承認までに一覧が並び替わる(先頭が別の項目になる)。
    await page.evaluate(() => {
      const ul = document.getElementById('list');
      ul.append(ul.firstElementChild);
    });
    expect(await sendToSw({ type: 'APPROVE_WORKFLOW_STEP', tabId })).toMatchObject({ active: true });
    await expect(page.locator('#state')).toHaveText('picked:Belkin USB-C ケーブル 2m', { timeout: 15_000 });
    expect(state.jevCalls.length).toBe(callsBefore); // ルールで決まったので判断AIは呼ばない
    await page.close();
  });

  test('Jev が失敗したら「該当なし」と誤読せず、手順番号つきの失敗で止まる', async () => {
    await setSteps([recorded]);
    const { page, tabId } = await openList('relabeled');
    await extPage.evaluate(() => (window.__autorun.length = 0));
    state.fail = true;
    try {
      expect(await sendToSw({ type: 'START_WORKFLOW_AUTORUN', tabId, vars: {} })).toMatchObject({ active: true });
      await expect.poll(async () => (await runOf())?.active, { timeout: 15_000 }).toBe(false);
      const msgs = await extPage.evaluate(() => window.__autorun.join('\n'));
      expect(msgs).toContain('Jev API error 500');
      expect(msgs).not.toContain('手順?');
      expect(await runOf()).toMatchObject({ heldStepId: '', doneStepIds: [] });
      await expect(page.locator('#state')).toHaveText('idle');
    } finally {
      state.fail = false;
    }
    await page.close();
  });

  test('記録した要素が消えた時の差し替えは、確信度が高くても承認を待つ', async () => {
    // 記録要素が無い経路は毎回 WF_STEP_TIMEOUT_MS(6s) 出現を待ってから差し替えに進む(設計)。負荷時の余裕を持たせる。
    test.setTimeout(150_000);
    await sw.evaluate(() => chrome.storage.local.set({ aiAdvisorWorkflow: { recording: true, steps: [], saved: [] } }));
    state.formLabel = '保存する';
    const rec = await context.newPage();
    await rec.goto(`${origin}/form`);
    await waitContentReady(rec);
    await rec.click('#b-保存する');
    await expect.poll(async () => (await readStore(sw, 'aiAdvisorWorkflow'))?.steps?.length ?? 0, { timeout: 15_000 }).toBe(1);
    const fixed = { ...(await stepOf()), needsReview: false, gate: false };
    expect(fixed.locator.kind).toBe('fixed');
    await rec.close();
    await setSteps([fixed]);

    // ボタンの id/表記が変わって記録要素が見つからない → Jev は 0.95 で「保存」を選ぶが、自動では押さない。
    state.formLabel = '保存';
    state.prefer = '^保存$';
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/form`);
      await waitContentReady(page);
      const tabId = await tabIdOf(`${origin}/form`);
      expect(await sendToSw({ type: 'START_WORKFLOW_AUTORUN', tabId, vars: {} })).toMatchObject({ active: true });
      await expect.poll(async () => (await runOf())?.heldKind || '', { timeout: 45_000 }).toBe('judge');
      expect((await runOf()).heldLabel).toBe('保存');
      await expect(page.locator('#state')).toHaveText('idle');
      expect(await sendToSw({ type: 'APPROVE_WORKFLOW_STEP', tabId })).toMatchObject({ active: true });
      await expect(page.locator('#state')).toHaveText('clicked:保存', { timeout: 15_000 });
      await page.close();
    } finally {
      state.prefer = 'Anker';
      state.formLabel = '保存する';
    }
  });
  test('確定系の承認は示した候補にだけ効く: 承認後に記録要素が戻っても、それは押さずに再び止まる', async () => {
    // 記録要素が無い経路は毎回 WF_STEP_TIMEOUT_MS(6s) 出現を待ってから差し替えに進む(設計)。負荷時の余裕を持たせる。
    test.setTimeout(150_000);
    // 記録: 確定系ボタン(自動で gate 付き)。
    await sw.evaluate(() => chrome.storage.local.set({ aiAdvisorWorkflow: { recording: true, steps: [], saved: [] } }));
    state.formLabel = '今すぐ購入する';
    const rec = await context.newPage();
    await rec.goto(`${origin}/form`);
    await waitContentReady(rec);
    await rec.click('#b-今すぐ購入する');
    await expect.poll(async () => (await readStore(sw, 'aiAdvisorWorkflow'))?.steps?.length ?? 0, { timeout: 15_000 }).toBe(1);
    const buy = { ...(await stepOf()), needsReview: false };
    expect(buy.gate).toBe(true);
    await rec.close();
    await setSteps([buy]);

    state.formLabel = '今すぐ購入';
    state.prefer = '^今すぐ購入$';
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/form`);
      await waitContentReady(page);
      const tabId = await tabIdOf(`${origin}/form`);
      expect(await sendToSw({ type: 'START_WORKFLOW_AUTORUN', tabId, vars: {} })).toMatchObject({ active: true });
      // 記録要素が無い → 差し替え候補の承認待ち → 承認 → 確定系ゲートで「今すぐ購入」に束縛して停止。
      await expect.poll(async () => (await runOf())?.heldKind || '', { timeout: 45_000 }).toBe('judge');
      expect(await sendToSw({ type: 'APPROVE_WORKFLOW_STEP', tabId })).toMatchObject({ active: true });
      await expect.poll(async () => {
        const r = await runOf();
        return r && !r.active && r.heldKind === '' ? r.heldLabel : '';
      }, { timeout: 45_000 }).toBe('今すぐ購入');

      // 承認前にページが変わり、記録した元のボタンが戻った → 承認は「今すぐ購入」にしか効かないので押さない。
      state.formLabel = '今すぐ購入する';
      await page.reload();
      await waitContentReady(page);
      await sendToSw({ type: 'APPROVE_WORKFLOW_STEP', tabId });
      await expect.poll(async () => {
        const r = await runOf();
        return r && !r.active && r.heldStepId === buy.id ? 'held-again' : '';
      }, { timeout: 45_000 }).toBe('held-again');
      await expect(page.locator('#state')).toHaveText('idle');
      await page.close();
    } finally {
      state.prefer = 'Anker';
      state.formLabel = '保存する';
    }
  });

  test('eg2 選択時: ローカル EmbeddingGemma 2 (/v1/embeddings) で表記変更後の候補を選んで完走する', async () => {
    await sw.evaluate(async (base) => {
      const k = 'aiAdvisorSettings';
      const cur = (await chrome.storage.local.get(k))[k] || {};
      await chrome.storage.local.set({
        [k]: {
          ...cur,
          judge: { provider: 'eg2', apiKey: '', baseUrl: `${base}/v1`, model: 'jev-fake', minConfidence: 0.7 },
          eg2: { enabled: true, url: base, model: '270m', urlVersion: 2 },
        },
      });
    }, origin);
    try {
      await setSteps([recorded]);
      const { page, tabId } = await openList('relabeled');
      state.eg2Calls.length = 0;
      expect(await sendToSw({ type: 'START_WORKFLOW_AUTORUN', tabId, vars: {} })).toMatchObject({ active: true });
      await expect(page.locator('#state')).toHaveText('picked:【新パッケージ】Anker USB-C to USB-C ケーブル (1m)', { timeout: 15_000 });
      await expect.poll(async () => (await runOf())?.doneStepIds?.length ?? 0).toBe(1);
      expect(state.eg2Calls.filter((c) => c.path === '/v1/embeddings')).toHaveLength(2);
      const sg = (await stepOf()).suggestion;
      expect(sg.label).toContain('新パッケージ');
      expect(sg.reason).toContain('eg2-270m');
      await page.close();
    } finally {
      await sw.evaluate(async (base) => {
        const k = 'aiAdvisorSettings';
        const cur = (await chrome.storage.local.get(k))[k] || {};
        await chrome.storage.local.set({
          [k]: {
            ...cur,
            judge: { provider: 'jev', apiKey: 'test-key', baseUrl: `${base}/v1`, model: 'jev-fake', minConfidence: 0.7 },
          },
        });
      }, origin);
    }
  });

  test('clef 選択時: Cloudflare Clef (Worker プロキシ) で表記変更後の候補を選んで完走する', async () => {
    const setJudge = (judge) =>
      sw.evaluate(async (j) => {
        const k = 'aiAdvisorSettings';
        const cur = (await chrome.storage.local.get(k))[k] || {};
        await chrome.storage.local.set({ [k]: { ...cur, judge: j } });
      }, judge);
    await setJudge({ provider: 'clef', minConfidence: 0.7, clefEndpoint: `${origin}/clef`, clefApiKey: 'proxy-key', clefModel: 'clef-flash' });
    try {
      await setSteps([recorded]);
      const { page, tabId } = await openList('relabeled');
      state.clefCalls.length = 0;
      state.jevCalls.length = 0;
      expect(await sendToSw({ type: 'START_WORKFLOW_AUTORUN', tabId, vars: {} })).toMatchObject({ active: true });
      await expect(page.locator('#state')).toHaveText('picked:【新パッケージ】Anker USB-C to USB-C ケーブル (1m)', { timeout: 15_000 });
      await expect.poll(async () => (await runOf())?.doneStepIds?.length ?? 0).toBe(1);
      expect(state.jevCalls).toHaveLength(0);
      expect(state.clefCalls).toHaveLength(1);
      expect(state.clefCalls[0].auth).toBe('Bearer proxy-key');
      expect(state.clefCalls[0].body.model).toBe('clef-flash');
      const sg = (await stepOf()).suggestion;
      expect(sg.label).toContain('新パッケージ');
      expect(sg.reason).toMatch(/95%.*clef-flash|clef-flash.*95%/);
      await page.close();
    } finally {
      await setJudge({ provider: 'jev', apiKey: 'test-key', baseUrl: `${origin}/v1`, model: 'jev-fake', minConfidence: 0.7 });
    }
  });

  test('check.type === "visual": ステップ後の画面状態・UI崩れを System 1 で視覚確認し、NG 時は停止する', async () => {
    const stepWithVisual = {
      ...recorded,
      choice: { by: 'first', value: '' },
      check: { type: 'visual', value: '選択結果が表示され画面崩れがない' },
    };
    await setSteps([stepWithVisual]);
    const { page, tabId } = await openList('rec');
    await page.bringToFront();

    // 1) 視覚確認 OK → 完走
    state.visualPass = true;
    state.jevCalls.length = 0;
    expect(await sendToSw({ type: 'START_WORKFLOW_AUTORUN', tabId, vars: {} })).toMatchObject({ active: true });
    await expect.poll(async () => (await runOf())?.doneStepIds?.length ?? 0, { timeout: 15_000 }).toBe(1);
    const visualCalls = state.jevCalls.filter((c) => c.body?.questions?.visual);
    expect(visualCalls).toHaveLength(1);
    expect(visualCalls[0].headers['typesafe-danger-zone-images']).toBe('true');

    // 2) 視覚確認 NG (画面崩れ/エラー検出) → 停止し failed メッセージを出す
    state.visualPass = false;
    await extPage.evaluate(() => (window.__autorun.length = 0));
    try {
      expect(await sendToSw({ type: 'START_WORKFLOW_AUTORUN', tabId, vars: {} })).toMatchObject({ active: true });
      await expect.poll(async () => (await runOf())?.active, { timeout: 15_000 }).toBe(false);
      expect((await runOf()).doneStepIds).toEqual([]);
      const msgs = await extPage.evaluate(() => window.__autorun.join('\n'));
      expect(msgs).toMatch(/visual check failed|視覚確認に失敗しました/);
      expect(msgs).toContain('12%');
    } finally {
      state.visualPass = true;
    }

    // 3) 対象タブが非アクティブな場合は別タブの画面を誤って撮影せず、失敗停止する
    await extPage.bringToFront();
    const callsBeforeInactive = state.jevCalls.length;
    await extPage.evaluate(() => (window.__autorun.length = 0));
    expect(await sendToSw({ type: 'START_WORKFLOW_AUTORUN', tabId, vars: {} })).toMatchObject({ active: true });
    await expect.poll(async () => (await runOf())?.active, { timeout: 15_000 }).toBe(false);
    expect((await runOf()).doneStepIds).toEqual([]);
    expect(state.jevCalls.length).toBe(callsBeforeInactive);
    await page.close();
  });
});

