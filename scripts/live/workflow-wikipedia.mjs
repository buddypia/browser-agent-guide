// 実地確認(要件2, ja.wikipedia.org): 人の操作で記録 → 別セッションで自動実行し、ページを跨いでダウンロード完了まで進むこと。
// 入力 → 動的な検索候補から選ぶ → 記事 → ツール → PDF ページ → ダウンロード(check.type='download')。
// TYPESAFE_API_KEY があれば、2回目は候補選びを System One(Jev) に任せる。テスト(npm run check)ではない。
// 使い方: [TYPESAFE_API_KEY=...] node scripts/live/workflow-wikipedia.mjs
import { launchWithExtension, log, summarizeSteps, waitSteps } from './workflow-lib.mjs';

const MAIN = 'https://ja.wikipedia.org/wiki/%E3%83%A1%E3%82%A4%E3%83%B3%E3%83%9A%E3%83%BC%E3%82%B8';
const x = await launchWithExtension('wikipedia');
const report = { runs: [] };
try {
  await x.startRecording();
  // 1) 人の操作で記録する
  const page = await x.context.newPage();
  await page.goto(MAIN);
  await x.waitReady(page);
  const search = page.locator('#searchform input[name="search"]');
  await search.click();
  await search.pressSequentially('東京タワー', { delay: 60 });
  const item = page.locator('.cdx-menu-item').filter({ hasText: /^東京タワー/ }).first();
  await item.waitFor({ timeout: 15000 });
  await item.click();
  await page.waitForURL(/\/wiki\/%E6%9D%B1%E4%BA%AC%E3%82%BF%E3%83%AF%E3%83%BC$/);
  await x.waitReady(page);
  await page.locator('#vector-page-tools-dropdown-checkbox').click();
  await page.getByRole('link', { name: 'PDF 形式でダウンロード' }).click();
  await page.waitForURL(/DownloadAsPdf/);
  await x.waitReady(page);
  const dl = page.waitForEvent('download', { timeout: 60000 });
  await page.getByRole('button', { name: 'ダウンロード' }).click();
  report.recordDownload = (await dl).suggestedFilename();
  const steps = await waitSteps(x.readStore, (s) => s.some((st) => st.check?.type === 'download'));
  report.steps = summarizeSteps(steps);
  log('recorded steps', JSON.stringify(report.steps, null, 1));

  // 2) 別セッションで自動実行する(ルールの選び方) / 3) 候補選びを Jev に任せる
  const runOnce = async (label, mutate) => {
    const s = JSON.parse(JSON.stringify(steps));
    mutate?.(s);
    await page.goto(MAIN);
    await x.waitReady(page);
    const before = await x.sw.evaluate(async () => (await chrome.downloads.search({})).length);
    const { start, run } = await x.runSteps(await x.tabIdOf(MAIN), s);
    const downloads = await x.sw.evaluate(async () => (await chrome.downloads.search({ orderBy: ['-startTime'] })).map((d) => ({ file: d.filename.split('/').pop(), state: d.state, bytes: d.bytesReceived })));
    const r = { label, start, done: run?.doneStepIds?.length, total: s.length, held: run?.heldStepId || null, finalUrl: decodeURIComponent(page.url()), newDownloads: downloads.length - before, latestDownload: downloads[0], messages: (await x.autorunMessages()).slice(-8) };
    r.ok = r.done === r.total && r.newDownloads > 0 && r.latestDownload?.state === 'complete';
    report.runs.push(r);
    log(label, JSON.stringify(r, null, 1));
  };
  await runOnce('rule');
  if (process.env.TYPESAFE_API_KEY) {
    await runOnce('jev', (s) => {
      const pick = s.find((st) => st.locator?.kind === 'pick');
      if (pick) pick.choice = { by: 'ai', value: '東京都港区にある電波塔そのものの記事(小説・映画・駅などではない)' };
    });
  }
} catch (e) {
  report.error = String(e?.stack || e);
  log('ERROR', report.error);
} finally {
  await x.close(report);
}
process.exit(!report.error && report.runs.length && report.runs.every((r) => r.ok) ? 0 : 1);
