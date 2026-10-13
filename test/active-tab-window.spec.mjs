// サイドパネルの対象タブ解決(拡張を実際に読み込む): SW の currentWindow は「最後にフォーカス
// されたウィンドウ」なので、別ウィンドウにフォーカスが移るとパネルのウィンドウとずれる。
// パネルが渡す windowId でそのウィンドウのアクティブタブを引けることを検証する。
import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

test('GET_ACTIVE_TAB_STATE は渡された windowId のアクティブタブを返す', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bag-active-tab-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: ['--headless=new', `--disable-extensions-except=${projectRoot}`, `--load-extension=${projectRoot}`],
  });
  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    const extId = new URL(sw.url()).host;

    const panelPage = await context.newPage();
    await panelPage.goto(`chrome-extension://${extId}/options/options.html`);
    const target = await panelPage.evaluate(async () => {
      const win = await chrome.windows.getCurrent();
      const tab = await chrome.tabs.create({ windowId: win.id, url: 'about:blank', active: true });
      return { windowId: win.id, tabId: tab.id };
    });
    // フォーカスを別ウィンドウへ移す(DevTools 等にフォーカスが移った状況の代わり)。
    const other = await sw.evaluate(async () => {
      const w = await chrome.windows.create({ url: 'about:blank', focused: true });
      return { windowId: w.id, tabId: w.tabs[0].id };
    });

    const send = (msg) =>
      panelPage.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), msg).then((r) => {
        if (!r?.ok) throw new Error(`SW error: ${r?.error}`);
        return r.result;
      });

    const scoped = await send({ type: 'GET_ACTIVE_TAB_STATE', windowId: target.windowId });
    expect(scoped.tabId).toBe(target.tabId);
    expect(scoped.windowId).toBe(target.windowId);

    // windowId 無し(旧挙動)は最後にフォーカスされたウィンドウを見るので、パネルの窓とずれる。
    const unscoped = await send({ type: 'GET_ACTIVE_TAB_STATE' });
    expect(unscoped.windowId).toBe(other.windowId);
  } finally {
    await context.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
