#!/usr/bin/env node
// 「メモを残す / お描き」注釈 (chrome.storage.local の aiAdvisorAnnotations) を、daemon への
// capture 送信を一切経由せず、Chrome の remote-debugging (CDP) 経由で直接読み出す。
//
// 背景: 「メモを残す」はページ内のローカル注釈を保存するだけで、daemon/MCP には送信されない
// (送信には明示的な「画像でAIへ送る」操作、または Options の daemon+autoSync 設定 [既定 OFF] が要る)。
// capture が一度も行われていない場合、daemon の inbox は空のままで bag_page_feedback 系の MCP
// ツールからは何も読めない。本スクリプトは、拡張機能自身の実行コンテキスト (サイドパネル/オプション
// ページ。開いていなければ新規に開く) に対して CDP の Runtime.evaluate を直接叩き、
// chrome.storage.local を読み出すことで、この経路を完全に回避する。
//
// 安全上の理由により、読み出すキーは "aiAdvisorAnnotations" 固定 (メモ/お描きのみ)。設定ブロブ
// "aiAdvisorSettings" には AI API キーが入っているため、本スクリプトは絶対にそれへは触れない。
//
// 前提: remote-debugging 有効な Chrome が起動していること。例:
//   open -na "Google Chrome" --args \
//     --user-data-dir=<デバッグ専用プロファイル> --remote-debugging-port=9333 \
//     --remote-debugging-address=127.0.0.1
//   (詳細・注意点は docs/reading-annotations-via-cdp.md)
//
// 使い方:
//   node scripts/read-annotations-cdp.mjs                          # 既定ポート候補(9333,9222)を順に試す
//   node scripts/read-annotations-cdp.mjs --port 9222
//   node scripts/read-annotations-cdp.mjs --kind note --scope example.com --json
//   node scripts/read-annotations-cdp.mjs --extension-id <32文字id>  # 同名拡張が複数ある時に固定
//   node scripts/read-annotations-cdp.mjs --since 2026-07-01 --limit 5

import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_PORTS = [9333, 9222];
const DEFAULT_EXTENSION_NAME = 'Browser Agent Guide';
const CANDIDATE_PATHS = ['sidepanel/sidepanel.html', 'options/options.html'];
const STORAGE_KEY = 'aiAdvisorAnnotations';
const EXT_ID_RE = /^chrome-extension:\/\/([a-p]{32})\//;
const MAX_CANDIDATE_EXTENSIONS = 8; // 無関係な拡張へ延々とタブを開かないための上限

function printHelp() {
  console.log(`node scripts/read-annotations-cdp.mjs [options]

  --port <n>            試す remote-debugging ポート (複数指定可、既定: ${DEFAULT_PORTS.join(', ')})
  --extension-id <id>   拡張IDを固定 (自動判別をスキップ)
  --extension-name <s>  manifest name の一致条件 (既定: "${DEFAULT_EXTENSION_NAME}")
  --kind <k>            note | drawing | all (既定: all)
  --scope <substr>      scope(=ページ origin+pathname) の部分一致で絞り込み
  --since <ISO日付>     この日時以降の createdAt だけ表示
  --limit <n>           最大表示件数
  --json                JSON で出力 (既定は人間可読な一覧)
  --keep-tab            自動で開いた確認用タブを閉じずに残す
  -h, --help            このヘルプ`);
}

function parseArgs(argv) {
  const args = {
    ports: [],
    extensionId: '',
    extensionName: DEFAULT_EXTENSION_NAME,
    kind: 'all',
    scope: '',
    since: '',
    limit: 0,
    json: false,
    keepTab: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') args.ports.push(Number(argv[++i]));
    else if (a === '--extension-id') args.extensionId = argv[++i];
    else if (a === '--extension-name') args.extensionName = argv[++i];
    else if (a === '--kind') args.kind = argv[++i];
    else if (a === '--scope') args.scope = argv[++i];
    else if (a === '--since') args.since = argv[++i];
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--json') args.json = true;
    else if (a === '--keep-tab') args.keepTab = true;
    else if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`unknown option: ${a}`);
      printHelp();
      process.exit(2);
    }
  }
  if (args.ports.length === 0) {
    const envPort = Number(process.env.CHROME_DEBUG_PORT || '');
    args.ports = envPort ? [envPort, ...DEFAULT_PORTS] : DEFAULT_PORTS;
  }
  return args;
}

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 0;
    this.pending = new Map();
  }

  async connect() {
    if (typeof WebSocket === 'undefined') {
      throw new Error(
        'この Node には組み込み WebSocket が無い (Node 22+ 推奨)。`node --version` を確認してください。'
      );
    }
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', (e) => reject(new Error(`CDP接続失敗: ${this.wsUrl}`)), { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve(msg);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDPタイムアウト: ${method}`));
        }
      }, 10000);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* noop */
    }
  }
}

async function findDebugEndpoint(ports) {
  for (const port of ports) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const version = await res.json();
        return { port, browserWsUrl: version.webSocketDebuggerUrl };
      }
    } catch {
      /* このポートは無し。次を試す */
    }
  }
  return null;
}

async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
  if (!res.ok) throw new Error(`/json/list 取得失敗 (HTTP ${res.status})`);
  return res.json();
}

function extractExtId(url) {
  const m = EXT_ID_RE.exec(url || '');
  return m ? m[1] : null;
}

// 既存の(候補パスに一致する)ページターゲット → 無ければ他の chrome-extension:// ターゲットから
// 拡張ID候補を拾い、後で新規タブを開いて確認する。既存ページ優先の順で候補IDを列挙する。
function buildCandidateIds(targets) {
  const withOpenPage = [];
  const others = new Set();
  for (const t of targets) {
    const id = extractExtId(t.url);
    if (!id) continue;
    const isOpenCandidatePage = t.type === 'page' && CANDIDATE_PATHS.some((p) => t.url.endsWith(p));
    if (isOpenCandidatePage) {
      if (!withOpenPage.includes(id)) withOpenPage.push(id);
    } else {
      others.add(id);
    }
  }
  const ordered = [...withOpenPage, ...[...others].filter((id) => !withOpenPage.includes(id))];
  return ordered.slice(0, MAX_CANDIDATE_EXTENSIONS);
}

function findOpenPageTarget(targets, extId) {
  return targets.find(
    (t) => t.type === 'page' && extractExtId(t.url) === extId && CANDIDATE_PATHS.some((p) => t.url.endsWith(p))
  );
}

// MV3 は service_worker、MV2 は background_page として拡張のバックグラウンドコンテキストが
// 既に /json/list に載っていることがある。見つかれば新規タブを開かずに済む。
function findExistingBackgroundTarget(targets, extId) {
  return targets.find(
    (t) => (t.type === 'service_worker' || t.type === 'background_page') && extractExtId(t.url) === extId
  );
}

async function evalInSession(cdp, sessionId, expression, { awaitPromise = false, attempts = 1, delayMs = 300 } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    const msg = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, sessionId);
    last = msg;
    const result = msg.result;
    if (result && !result.error && !(result.result && result.result.subtype === 'error')) {
      return result;
    }
    if (i < attempts - 1) await delay(delayMs);
  }
  return last ? last.result : null;
}

async function getManifestName(cdp, sessionId) {
  const result = await evalInSession(
    cdp,
    sessionId,
    "(chrome && chrome.runtime && chrome.runtime.getManifest && chrome.runtime.getManifest().name) || null",
    { attempts: 6, delayMs: 300 }
  );
  if (!result || result.exceptionDetails) return null;
  return result.result ? result.result.value : null;
}

async function readAnnotations(cdp, sessionId) {
  const expression = `
    (async () => {
      const r = await chrome.storage.local.get(${JSON.stringify(STORAGE_KEY)});
      return r[${JSON.stringify(STORAGE_KEY)}] || {};
    })()
  `;
  const result = await evalInSession(cdp, sessionId, expression, { awaitPromise: true, attempts: 1 });
  if (!result || result.exceptionDetails) {
    throw new Error(`chrome.storage.local.get 失敗: ${JSON.stringify(result && result.exceptionDetails)}`);
  }
  return result.result.value || {};
}

async function resolveExtensionSession(cdp, port, args) {
  const targets = await listTargets(port);
  const candidateIds = args.extensionId ? [args.extensionId] : buildCandidateIds(targets);

  if (candidateIds.length === 0) {
    return { session: null, reason: 'no-extension-targets' };
  }

  for (const extId of candidateIds) {
    // 優先順位: 開いているページ > 既存のバックグラウンドコンテキスト(service_worker/
    // background_page) > 最後の手段としての新規タブ作成。前2つならタブを一切開かずに済む。
    const existing = findOpenPageTarget(targets, extId) || findExistingBackgroundTarget(targets, extId);
    let targetId = existing ? existing.id : null;
    let createdTargetId = null;

    if (!targetId) {
      const created = await cdp.send('Target.createTarget', {
        url: `chrome-extension://${extId}/${CANDIDATE_PATHS[1]}`,
        background: true,
      });
      if (created.error || !created.result) continue;
      targetId = created.result.targetId;
      createdTargetId = targetId;
    }

    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    if (attached.error || !attached.result) {
      if (createdTargetId) await cdp.send('Target.closeTarget', { targetId: createdTargetId }).catch(() => {});
      continue;
    }
    const sessionId = attached.result.sessionId;

    const name = await getManifestName(cdp, sessionId);
    if (name === args.extensionName) {
      return { session: { sessionId, targetId, extId, createdTargetId }, reason: 'ok' };
    }

    // 不一致。自分で開いたタブなら片付けて次の候補へ。
    if (createdTargetId) {
      await cdp.send('Target.closeTarget', { targetId: createdTargetId }).catch(() => {});
    } else {
      await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    }
  }

  return { session: null, reason: 'no-name-match' };
}

function flattenAndFilter(map, args) {
  const out = [];
  for (const [scope, items] of Object.entries(map)) {
    for (const item of Array.isArray(items) ? items : []) {
      if (args.kind !== 'all' && item.kind !== args.kind) continue;
      if (args.scope && !scope.toLowerCase().includes(args.scope.toLowerCase())) continue;
      if (args.since) {
        const since = new Date(args.since);
        const created = new Date(item.createdAt || 0);
        if (!(created >= since)) continue;
      }
      out.push({ scope, ...item });
    }
  }
  out.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return args.limit > 0 ? out.slice(0, args.limit) : out;
}

function printHuman(list) {
  if (list.length === 0) {
    console.log('該当する注釈はありません (0 件)。');
    return;
  }
  list.forEach((item, i) => {
    const created = item.createdAt ? new Date(item.createdAt) : null;
    const local = created ? created.toLocaleString() : '(不明)';
    console.log(`[${i + 1}] ${item.createdAt || '(createdAt不明)'} (local: ${local})`);
    console.log(`    scope : ${item.scope}`);
    console.log(`    kind  : ${item.kind}`);
    if (item.note) console.log(`    note  : ${item.note}`);
    if (item.anchor && item.anchor.text) console.log(`    anchor: ${item.anchor.text}`);
    console.log('');
  });
  console.log(`計 ${list.length} 件`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const endpoint = await findDebugEndpoint(args.ports);
  if (!endpoint) {
    console.error(
      [
        `remote-debugging Chrome が見つかりません (試したポート: ${args.ports.join(', ')})。`,
        '',
        'Chrome を remote-debugging 付きで起動してから再実行してください。例:',
        '  open -na "Google Chrome" --args \\',
        '    --user-data-dir=<デバッグ専用プロファイル> \\',
        `    --remote-debugging-port=${args.ports[0]} --remote-debugging-address=127.0.0.1`,
        '',
        '詳細: docs/reading-annotations-via-cdp.md',
      ].join('\n')
    );
    process.exit(1);
  }

  const cdp = new CDP(endpoint.browserWsUrl);
  await cdp.connect();

  try {
    const { session, reason } = await resolveExtensionSession(cdp, endpoint.port, args);
    if (!session) {
      const hint =
        reason === 'no-extension-targets'
          ? 'この Chrome インスタンスに chrome-extension:// ターゲットが1つも見当たりません。拡張機能が読み込まれているプロファイルか確認してください。'
          : `manifest name が "${args.extensionName}" と一致する拡張が見つかりませんでした。--extension-id で明示指定するか --extension-name を確認してください。`;
      console.error(`拡張機能のコンテキストを特定できませんでした: ${hint}`);
      process.exit(1);
    }

    const map = await readAnnotations(cdp, session.sessionId);
    const list = flattenAndFilter(map, args);

    if (session.createdTargetId && !args.keepTab) {
      await cdp.send('Target.closeTarget', { targetId: session.createdTargetId }).catch(() => {});
    }

    if (args.json) {
      console.log(JSON.stringify(list, null, 2));
    } else {
      printHuman(list);
    }
  } finally {
    cdp.close();
  }
}

main().catch((err) => {
  console.error(`エラー: ${err.message}`);
  process.exit(1);
});
