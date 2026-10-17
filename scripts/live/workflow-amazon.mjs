// 実地確認(要件2, amazon.co.jp, 未ログインの使い捨てプロファイル): 人の操作で記録 → 別セッションで自動実行。
// 検索語の入力 → 検索 → 動的な結果から商品を選ぶ → 商品ページ → 「今すぐ買う」は人が承認するまで押さずに止まること。
// 未ログインなので、記録時に押す「今すぐ買う」もサインイン画面へ移るだけで購入は成立しない。テスト(npm run check)ではない。
// TYPESAFE_API_KEY があれば Jev、BAG_LIVE_JUDGE=eg2 ならローカル eg2 に、2回目の商品選びを任せ、判断の保留を承認しても確定系では再び止まることを見る。
// 使い方: [TYPESAFE_API_KEY=... | BAG_LIVE_JUDGE=eg2] node scripts/live/workflow-amazon.mjs
import { launchWithExtension, liveJudge, log, sleep, summarizeSteps, waitSteps } from './workflow-lib.mjs';

const TOP = 'https://www.amazon.co.jp/';
const x = await launchWithExtension('amazon', { locale: 'ja-JP' });
const report = { runs: [] };
try {
  await x.startRecording();
  // 1) 人の操作で記録する
  const page = await x.context.newPage();
  await page.goto(TOP);
  await page.locator('#twotabsearchtextbox').waitFor({ timeout: 30000 }); // 「Loading」中継ページの後の本ページ
  await x.waitReady(page);
  await page.locator('#twotabsearchtextbox').fill('サラサクリップ 0.5 黒');
  await page.locator('#nav-search-submit-button').click();
  await page.waitForURL(/\/s\?/, { waitUntil: 'domcontentloaded' });
  await x.waitReady(page);
  const results = page.locator('[data-component-type="s-search-result"] h2');
  await results.first().waitFor({ timeout: 20000 });
  const target = results.filter({ hasText: /サラサクリップ/ }).filter({ hasText: /黒/ }).first();
  const chosen = (await target.count()) ? target : results.first();
  report.recordChosen = await chosen.innerText();
  // 商品リンクは target=_blank。人は新しいタブで続ける(手順は URL で結び付く)。
  const popup = x.context.waitForEvent('page', { timeout: 15000 }).catch(() => null);
  await chosen.click();
  const prod = (await popup) || page;
  await prod.waitForURL(/\/dp\/|\/gp\/product\//, { timeout: 45000, waitUntil: 'domcontentloaded' });
  await x.waitReady(prod);
  const buy = prod.locator('#buy-now-button');
  if (!(await buy.count())) throw new Error('この商品ページに「今すぐ買う」が無い: ' + prod.url());
  await buy.click();
  await prod.waitForLoadState('domcontentloaded');
  await prod.close();
  const steps = await waitSteps(x.readStore, (s) => s.some((st) => st.gate));
  report.steps = summarizeSteps(steps);
  log('recorded steps', JSON.stringify(report.steps, null, 1));

  // 2) 別セッションで自動実行する(ルールの選び方) / 3) 商品選びを判断AI(Jev / eg2)に任せる
  const settle = async (run, gateStep) => ({
    done: run?.doneStepIds?.length,
    heldAtGate: !!gateStep && run?.heldStepId === gateStep.id,
    finalUrl: decodeURIComponent(page.url().split('?')[0]),
    movedToSignin: /signin|\/ap\//.test(page.url()),
    messages: (await x.autorunMessages()).slice(-6),
  });
  const runOnce = async (label, mutate, vars = {}) => {
    const s = JSON.parse(JSON.stringify(steps));
    mutate?.(s);
    await page.goto(TOP);
    await page.locator('#twotabsearchtextbox').waitFor({ timeout: 30000 });
    await x.waitReady(page);
    const tabId = await x.tabIdOf(TOP);
    const gateStep = s.find((st) => st.gate);
    let { start, run } = await x.runSteps(tabId, s, vars);
    const r = { label, start, total: s.length, heldLabel: run?.heldLabel || null, ...(await settle(run, gateStep)) };
    if (run?.heldKind === 'judge') {
      // 人が示された候補を確かめて承認 → その候補で進み、確定系(今すぐ買う)では再び止まること。
      await x.clearAutorunMessages();
      r.approve = await x.sendToSw({ type: 'APPROVE_WORKFLOW_STEP', tabId });
      run = await x.waitRunStopped();
      r.afterApprove = await settle(run, gateStep);
    }
    const last = r.afterApprove || r;
    r.ok = last.heldAtGate && !last.movedToSignin && last.done === s.length - 1;
    report.runs.push(r);
    log(label, JSON.stringify(r, null, 1));
    await sleep(500);
  };
  await runOnce('rule');
  if (liveJudge) {
    await runOnce(
      liveJudge,
      (s) => {
        const pick = s.find((st) => st.locator?.kind === 'pick' && st.url && new URL(st.url).pathname === '/s');
        if (pick) pick.choice = { by: 'ai', value: 'ゼブラ サラサクリップ 0.5 黒 の商品(替芯・他色・他社製品ではない)' };
        const fill = s.find((st) => st.action?.verb === 'fill');
        if (fill) fill.action.value = '{q}';
      },
      { q: 'サラサ 0.5 ブラック' },
    );
  }
} catch (e) {
  report.error = String(e?.stack || e);
  log('ERROR', report.error);
} finally {
  await x.close(report);
}
process.exit(!report.error && report.runs.length && report.runs.every((r) => r.ok) ? 0 : 1);
