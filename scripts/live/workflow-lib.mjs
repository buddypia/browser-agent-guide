// 実サイトでのワークフロー実地確認の共通部品: 使い捨てプロファイルで拡張を読み込み、記録 → 自動実行を観測する。
// 判断AI(Jev)のキーはこのプロファイルの storage にだけ置き、終了時にプロファイルごと消す。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

export const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export async function launchWithExtension(name, { locale } = {}) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `bag-live-${name}-`));
  const userDataDir = fs.mkdtempSync(path.join(workDir, 'chrome-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    ...(locale ? { locale } : {}),
    args: ['--headless=new', `--disable-extensions-except=${repoRoot}`, `--load-extension=${repoRoot}`],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extPage = await context.newPage();
  await extPage.goto(`chrome-extension://${new URL(sw.url()).host}/options/options.html`);
  // サイドパネルが受け取る自動実行の通知(WORKFLOW_AUTORUN_EVENT)を拡張ページで拾う。
  await extPage.evaluate(() => {
    window.__autorun = [];
    chrome.runtime.onMessage.addListener((m) => void window.__autorun.push(m));
  });
  const sendToSw = (msg) => extPage.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), msg);
  const readStore = (k) => sw.evaluate(async (key) => (await chrome.storage.local.get(key))[key], k);
  const tabIdOf = (prefix) => extPage.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => (t.url || '').startsWith(u))?.id, prefix);
  const waitReady = async (page) => {
    for (let i = 0; i < 60; i++) {
      const id = await tabIdOf(page.url());
      if (id && (await extPage.evaluate((t) => chrome.tabs.sendMessage(t, { type: 'PING' }).then((r) => r?.ok === true, () => false), id))) return;
      await sleep(250);
    }
    throw new Error('content not ready: ' + page.url());
  };
  const autorunMessages = () => extPage.evaluate(() => window.__autorun.map((m) => m.text).filter(Boolean));
  const clearAutorunMessages = () => extPage.evaluate(() => void (window.__autorun.length = 0));
  // 記録を始める。judge は Jev(キーが無ければルールの選び方だけを確かめる)。
  const startRecording = () =>
    sw.evaluate(
      (key) =>
        chrome.storage.local.set({
          aiAdvisorSettings: key ? { judge: { provider: 'jev', apiKey: key, minConfidence: 0.7 } } : {},
          aiAdvisorWorkflow: { recording: true, steps: [], saved: [] },
        }),
      process.env.TYPESAFE_API_KEY || '',
    );
  // 記録した手順を作業中に置き、自動実行を始めて止まるまで待つ。
  const runSteps = async (tabId, steps, vars = {}) => {
    await sw.evaluate((st) => chrome.storage.local.set({ aiAdvisorWorkflow: { recording: false, steps: st, saved: [] }, aiAdvisorWorkflowRun: null }), steps);
    await clearAutorunMessages();
    const start = await sendToSw({ type: 'START_WORKFLOW_AUTORUN', tabId, vars });
    const run = await waitRunStopped();
    return { start, run };
  };
  const waitRunStopped = async () => {
    let run;
    for (let i = 0; i < 240; i++) {
      run = await readStore('aiAdvisorWorkflowRun');
      if (run && run.active === false) break;
      await sleep(500);
    }
    await sleep(1500);
    return run;
  };
  const close = async (report) => {
    fs.writeFileSync(path.join(workDir, 'report.json'), JSON.stringify(report, null, 2));
    await context.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
    log('report:', path.join(workDir, 'report.json'), '(profile removed with the judge key)');
  };
  return { context, sw, sendToSw, readStore, tabIdOf, waitReady, autorunMessages, clearAutorunMessages, startRecording, runSteps, waitRunStopped, close };
}

// 記録が手順として保存されるまで待つ(記録は content → SW で非同期に書かれる)。
export async function waitSteps(readStore, done) {
  let steps = [];
  for (let i = 0; i < 40; i++) {
    steps = (await readStore('aiAdvisorWorkflow'))?.steps || [];
    if (done(steps)) break;
    await sleep(500);
  }
  return steps;
}

// 報告用の手順の要約。入力値(value)は {変数} だけ残し、打った文字列は出さない。
export const summarizeSteps = (steps) =>
  steps.map((s) => ({ verb: s.action?.verb, value: /^\{\w+\}$/.test(s.action?.value || '') ? s.action.value : undefined, target: s.target, locator: s.locator?.kind, choice: s.choice?.by, check: s.check?.type, gate: s.gate, url: (s.url || '').split('?')[0] }));
