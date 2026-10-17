// 実地確認(要件1): 実拡張 + 実 daemon + MCP + 実 CLI で、ユーザーが「AIに渡す」にチェックした要素だけが直ることを確かめる。
// テスト(npm run check)ではない。実 CLI を呼ぶのでトークンを消費し、各 CLI のログインが要る。
// agy は CLI 引数で MCP を渡せないので、実行中だけ一意な名前(baglive_<乱数>)でグローバル設定へ登録し、終了時(Ctrl-C を含む)に外す。
// 使い方: node scripts/live/element-fix-via-cli.mjs claude codex agy   (1つ以上)
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const clis = process.argv.slice(2);
if (!clis.length || clis.some((c) => !['claude', 'codex', 'agy'].includes(c))) {
  console.error('usage: node scripts/live/element-fix-via-cli.mjs <claude|codex|agy>...');
  process.exit(2);
}
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bag-live-req1-'));
const FIXTURE = 'test/fixtures/playground.html';
const TOKEN = randomBytes(16).toString('hex');
// 利用者が登録済みの MCP 名と衝突させない(agy では上書き・削除してしまう)。
const MCP = `baglive_${TOKEN.slice(0, 8)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function startStatic() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = path.resolve(repoRoot, decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1)) || FIXTURE);
      if (!p.startsWith(repoRoot + path.sep)) return res.writeHead(403).end();
      fs.readFile(p, (err, body) => {
        if (err) return res.writeHead(404).end();
        const ct = p.endsWith('.html') ? 'text/html; charset=utf-8' : p.endsWith('.css') ? 'text/css' : p.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
        res.writeHead(200, { 'content-type': ct }).end(body);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function freePort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

async function mcpCall(mcpUrl, name, args) {
  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : text).result;
}

function run(cmd, args, { cwd, timeoutMs = 300000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => (err += String(e)));
    const t = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(t);
      resolve({ code, signal, out, err });
    });
  });
}

const staticSrv = await startStatic();
const pageUrl = `http://127.0.0.1:${staticSrv.address().port}/${FIXTURE}`;
const port = await freePort();
const mcpUrl = `http://127.0.0.1:${port}/mcp`;
const daemonInbox = path.join(workDir, 'inbox-unused');
const daemon = spawn(process.execPath, [path.join(repoRoot, 'daemon/src/index.js'), '--port', String(port), '--token', TOKEN, '--inbox', daemonInbox, '--storage', 'memory'], {
  stdio: ['ignore', 'ignore', 'ignore'],
});
const userDataDir = fs.mkdtempSync(path.join(workDir, 'chrome-'));
const report = { clis: {} };
let context;
let agyAdded = false;
// 中断されても agy のグローバル設定に死んだポートの登録を残さない。
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    if (agyAdded) spawnSync('agy', ['mcp', 'remove', MCP], { stdio: 'ignore', timeout: 30000 });
    daemon.kill('SIGTERM');
    process.exit(130);
  });
}
try {
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false)) break;
    await sleep(200);
  }
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: ['--headless=new', `--disable-extensions-except=${repoRoot}`, `--load-extension=${repoRoot}`],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).hostname;

  // 2つのメモ。note-b は「AIに渡す」を外すので、CLI に届かず、触られてもいけない。
  const scope = new URL(pageUrl).origin + new URL(pageUrl).pathname;
  const NOTE_A = 'このボタンの背景色を #c00000 にしてください';
  const NOTE_B = 'このボタンの文字色を緑 #008000 にしてください';
  await sw.evaluate(
    async ({ wsUrl, token, scope, NOTE_A, NOTE_B }) => {
      await chrome.storage.local.set({
        aiAdvisorSettings: { daemon: { enabled: true, url: wsUrl, token } },
        aiAdvisorAnnotations: {
          [scope]: [
            { id: 'note-a', kind: 'note', createdAt: '2026-10-17T00:00:00Z', note: NOTE_A, intent: '', anchor: { selector: '[data-testid="gallery-button"]', tag: 'button', role: 'button', text: '通常ボタン' } },
            { id: 'note-b', kind: 'note', createdAt: '2026-10-17T00:00:01Z', note: NOTE_B, intent: '', anchor: { selector: '[data-testid="login-submit"]', tag: 'button', role: 'button', text: 'ログイン' } },
          ],
        },
      });
    },
    { wsUrl: `ws://127.0.0.1:${port}/ws`, token: TOKEN, scope, NOTE_A, NOTE_B },
  );

  const page = await context.newPage();
  await page.goto(pageUrl);
  await page.locator('[data-bag-id]').first().waitFor({ timeout: 15000 }).catch(() => {});
  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id, pageUrl);
  // サイドパネルの「AIに渡す」チェックを外すのと同じメッセージ。
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extId}/options/options.html`);
  await ext.evaluate((m) => chrome.runtime.sendMessage(m), { type: 'SET_ANNOTATION_FOR_AI', tabId, id: 'note-b', on: false });
  await ext.close();

  // daemon ON ではメモだけの集合が画像なしで自動同期される。MCP に届くまで待つ。
  let ctxText = '';
  for (let i = 0; i < 60 && !ctxText.includes(NOTE_A); i++) {
    const ctx = await mcpCall(mcpUrl, 'get_latest_feedback_context', {});
    ctxText = (ctx?.content || []).map((c) => c.text || '').join('\n');
    if (!ctxText.includes(NOTE_A)) await sleep(500);
  }
  report.mcpHasCheckedNote = ctxText.includes(NOTE_A);
  report.mcpHasUncheckedNote = ctxText.includes(NOTE_B);
  log('MCP context: checked note =', report.mcpHasCheckedNote, '/ unchecked note =', report.mcpHasUncheckedNote);

  const styles = () =>
    page.evaluate(() => ({
      a: getComputedStyle(document.querySelector('[data-testid="gallery-button"]')).backgroundColor,
      b: getComputedStyle(document.querySelector('[data-testid="login-submit"]')).color,
    }));
  const PROMPT = [
    `MCP サーバー ${MCP} が使えます。まず get_latest_feedback_context で、ユーザーがブラウザ上でチェックしたメモを読んでください。`,
    '次に、そのメモの指示どおりに、メモが付いた要素だけを execute_actions で直してください(urlContains に "playground.html" を渡す。setStyle を使ってよい)。',
    'メモに書かれていない要素は触らないでください。ファイルの編集やシェルコマンドは使わず、MCP ツールだけを使ってください。最後に何をしたか1行で答えてください。',
  ].join('\n');

  for (const cli of clis) {
    await page.reload();
    await sleep(1500);
    const before = await styles();
    const cwd = fs.mkdtempSync(path.join(workDir, `${cli}-`));
    log(`running ${cli} ...`);
    let r;
    if (cli === 'claude') {
      const cfg = JSON.stringify({ mcpServers: { [MCP]: { type: 'http', url: mcpUrl } } });
      r = await run('claude', ['-p', PROMPT, '--mcp-config', cfg, '--strict-mcp-config', '--allowedTools', `mcp__${MCP}__get_latest_feedback_context,mcp__${MCP}__execute_actions`], { cwd });
    } else if (cli === 'codex') {
      r = await run('codex', ['exec', '--skip-git-repo-check', '-s', 'read-only', '-c', `mcp_servers.${MCP}.url="${mcpUrl}"`, '-c', `mcp_servers.${MCP}.default_tools_approval_mode="approve"`, PROMPT], { cwd });
    } else {
      agyAdded = (await run('agy', ['mcp', 'add', '--type', 'http', MCP, mcpUrl], { cwd, timeoutMs: 30000 })).code === 0;
      r = await run('agy', ['-p', PROMPT, '--add-dir', cwd, '--print-timeout', '280s'], { cwd });
    }
    const after = await styles();
    report.clis[cli] = {
      exit: r.code,
      checkedFixed: after.a === 'rgb(192, 0, 0)',
      uncheckedUntouched: after.b === before.b,
      answer: r.out.trim().slice(-600),
      stderrTail: r.err.trim().slice(-600),
    };
    log(cli, JSON.stringify({ exit: r.code, checkedFixed: report.clis[cli].checkedFixed, uncheckedUntouched: report.clis[cli].uncheckedUntouched }));
  }
} catch (e) {
  report.error = String(e?.stack || e);
  log('ERROR', report.error);
} finally {
  if (agyAdded) await run('agy', ['mcp', 'remove', MCP], { timeoutMs: 30000 });
  await context?.close().catch(() => {});
  daemon.kill('SIGTERM');
  staticSrv.close();
  staticSrv.closeAllConnections?.();
  report.daemonCreatedInbox = fs.existsSync(daemonInbox); // memory モードは inbox を作らない
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.writeFileSync(path.join(workDir, 'report.json'), JSON.stringify(report, null, 2));
  log('report:', path.join(workDir, 'report.json'));
}
const ok = !report.error && report.mcpHasCheckedNote && !report.mcpHasUncheckedNote && !report.daemonCreatedInbox && Object.values(report.clis).every((c) => c.checkedFixed && c.uncheckedUntouched);
process.exit(ok ? 0 : 1);
