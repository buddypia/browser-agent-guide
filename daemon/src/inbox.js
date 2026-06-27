// inbox スキャナ + MCP content ビルダー。
// ブラウザ拡張（MVP）が保存した視覚フィードバックを読み、AI コーディング CLI へ
// 「image(PNG) + ファイルパス」の両方で返すための土台。DOM/ネットワークに依存しない純粋寄りモジュール。
//
// inbox レイアウト（拡張 §4.3 と同一）:
//   <inboxDir>/<slug>/shot.png        # 注釈 burn-in 済み（vision 1次）
//                     raw.png         # 元スクショ（任意）
//                     annotation.json # 座標/selector/intent
//                     memo.md         # 人間可読

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, isAbsolute, sep } from 'node:path';
import { homedir, platform } from 'node:os';
import { execFileSync } from 'node:child_process';
import { decodeBase64 } from './writer.js';
import { hostSlug } from './slug.js';

export const SHOT = 'shot.png';
export const RAW = 'raw.png';
export const ANNOTATION = 'annotation.json';
export const MEMO = 'memo.md';

// Windows の「Downloads」既知フォルダー GUID（移動済み時はレジストリにこの名前で絶対パスが入る）。
const DOWNLOADS_GUID = '{374DE290-123F-4565-9164-39C4925E467B}';

// Windows: レジストリから実 Downloads パスを読む（移動/OneDrive バックアップ対応）。無ければ null。
// 'Shell Folders'(REG_SZ=解決済み) を優先し、'User Shell Folders'(REG_EXPAND_SZ=%VAR% 入り) を後段に。
function downloadsFromWindowsRegistry() {
  for (const key of ['Shell Folders', 'User Shell Folders']) {
    try {
      const out = execFileSync(
        'reg',
        ['query', `HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\${key}`, '/v', DOWNLOADS_GUID],
        { encoding: 'utf8', timeout: 2000, windowsHide: true }
      );
      // REG_SZ は解決済みなので %VAR% 展開しない（パスに literal '%' があっても壊さない）。
      // REG_EXPAND_SZ のみ %VAR% を展開し、未解決の %...% が残れば不採用にする。
      const m = out.match(/(REG_(?:EXPAND_)?SZ)\s+(.+?)\s*$/m);
      if (m) {
        if (m[1] === 'REG_EXPAND_SZ') {
          const expanded = m[2].replace(/%([^%]+)%/g, (_, v) => process.env[v] || `%${v}%`);
          if (expanded && !expanded.includes('%')) return expanded;
        } else {
          const val = m[2].trim();
          if (val) return val;
        }
      }
    } catch {
      /* 値が無い(クリーンインストール既定)/reg 不在 → 次のキーやフォールバックへ */
    }
  }
  return null;
}

// Linux: XDG から実 Downloads パスを得る。無ければ null。
function downloadsFromXdg() {
  // 1) xdg-user-dir DOWNLOAD（引数はハードコード必須。内部で eval されるため外部入力厳禁）。
  try {
    const out = execFileSync('xdg-user-dir', ['DOWNLOAD'], { encoding: 'utf8', timeout: 2000 })
      .trim()
      .replace(/\/+$/, '');
    if (out && out !== homedir()) return out;
  } catch {
    /* 未インストール(headless 等) → user-dirs.dirs を直接読む */
  }
  // 2) ${XDG_CONFIG_HOME:-~/.config}/user-dirs.dirs を直接パース（$HOME 展開のみ）。
  try {
    const cfg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
    const text = readFileSync(join(cfg, 'user-dirs.dirs'), 'utf8');
    const m = text.match(/^\s*XDG_DOWNLOAD_DIR="?(.+?)"?\s*$/m);
    if (m) {
      // 末尾スラッシュを除いてから homedir 等価判定（"$HOME/" を Downloads と誤認しない）。
      const v = m[1].replace(/^\$\{?HOME\}?/, homedir()).replace(/\/+$/, '');
      if (v && v !== homedir()) return v;
    }
  } catch {
    /* 無ければ OS 既定へフォールバック */
  }
  return null;
}

// OS のダウンロードフォルダーを解決する。検出失敗時は <homedir>/Downloads。
// 注意: chrome.downloads の実保存先は「ブラウザ設定」依存で、OS の Downloads と必ずしも一致しない
// （ユーザーが変更/Edge・Brave 等）。その差は拡張からの downloadsDir ハンドシェイクで埋める。
export function resolveDownloadsDir() {
  let detected = null;
  try {
    if (platform() === 'win32') detected = downloadsFromWindowsRegistry();
    else if (platform() === 'linux') detected = downloadsFromXdg();
    // darwin: ~/Downloads（ディスク上の実名は常に英語 'Downloads'。ローカライズは表示のみ）。
  } catch {
    detected = null;
  }
  return detected || join(homedir(), 'Downloads');
}

// 既定 inbox は <検出した Downloads>/ai-inbox（拡張のフォールバック保存先に合わせる）。
export function defaultInboxDir() {
  return join(resolveDownloadsDir(), 'ai-inbox');
}

// 拡張が報告した downloadsDir から「採用してよい inbox」を計算する。採用不可なら null。
// 安全境界: 採用先はユーザーのホーム配下に限定する（WS トークンが漏れても書き込み範囲を絞る）。
// ホーム外に Downloads を置くケース（例: Windows で D:\Downloads）は --inbox / BAG_VF_INBOX の明示指定を使う。
export function inboxFromDownloadsDir(downloadsDir, { home = homedir() } = {}) {
  if (!downloadsDir || typeof downloadsDir !== 'string' || !isAbsolute(downloadsDir)) return null;
  const candidate = resolve(join(downloadsDir, 'ai-inbox'));
  const root = resolve(home);
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  return candidate;
}

export function resolveInboxDir(p) {
  if (!p) return defaultInboxDir();
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

// inbox 配下の <slug>/（shot.png を持つもの）を新しい順に列挙する。done/ は除外。
export function listEntries(inboxDir, limit = 20) {
  if (!inboxDir || !existsSync(inboxDir)) return [];
  let dirents;
  try {
    dirents = readdirSync(inboxDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const entries = [];
  for (const d of dirents) {
    if (!d.isDirectory() || d.name === 'done') continue;
    const dir = join(inboxDir, d.name);
    const shot = join(dir, SHOT);
    if (!existsSync(shot)) continue;
    let mtime = 0;
    try {
      mtime = statSync(shot).mtimeMs;
    } catch {
      /* stat 失敗は 0 のまま */
    }
    entries.push({ id: d.name, dir, shot, mtime });
  }
  entries.sort((a, b) => b.mtime - a.mtime || (a.id < b.id ? 1 : -1));
  return entries.slice(0, Math.max(1, limit));
}

export function findEntry(inboxDir, id, scan = 500) {
  const hit = listEntries(inboxDir, scan).find((e) => e.id === id);
  if (hit) return hit;
  // id 指定の時だけ done/ も解決する（retention の sweep が退避した capture を
  // in-flight な contextId / /shot/<id>.png で取り戻せるように）。latest/list は
  // 引き続き done/ を除外する（listEntries/queryEntries は素のまま）。
  if (!inboxDir || !id || /[\\/]/.test(id) || id === '.' || id === '..') return null;
  const dir = join(inboxDir, 'done', id);
  const shot = join(dir, SHOT);
  if (!existsSync(shot)) return null;
  let mtime = 0;
  try {
    mtime = statSync(shot).mtimeMs;
  } catch {
    /* stat 失敗は 0 のまま */
  }
  return { id, dir, shot, mtime };
}

// annotation の url/title/tab が一致するか（複数プロジェクト・同一URL複数タブの絞り込み）。
// urlContains/titleContains は大文字小文字を無視する部分一致。未指定の条件は素通し。
export function matchesFilter(annotation, { urlContains, titleContains, tabId, windowId } = {}) {
  if (urlContains) {
    const u = String(annotation?.url || '').toLowerCase();
    if (!u.includes(String(urlContains).toLowerCase())) return false;
  }
  if (titleContains) {
    const t = String(annotation?.title || '').toLowerCase();
    if (!t.includes(String(titleContains).toLowerCase())) return false;
  }
  if (!filterNumberMatches(annotation?.tab?.tabId, tabId)) return false;
  if (!filterNumberMatches(annotation?.tab?.windowId, windowId)) return false;
  return true;
}

// 新しい順スキャン + url/title/tab フィルタ。each entry に {url,title,tab} メタを付けて返す。
export function queryEntries(inboxDir, { urlContains, titleContains, tabId, windowId, limit = 20, scan = 500 } = {}) {
  const out = [];
  for (const e of listEntries(inboxDir, scan)) {
    const annotation = readAnnotation(e.dir);
    if (!matchesFilter(annotation, { urlContains, titleContains, tabId, windowId })) continue;
    out.push({
      ...e,
      url: annotation?.url || '',
      title: annotation?.title || '',
      capturedAt: annotation?.capturedAt || '',
      tab: normalizeTabMetadata(annotation?.tab),
    });
    if (out.length >= Math.max(1, limit)) break;
  }
  return out;
}

function filterNumberMatches(value, expected) {
  if (expected == null) return true;
  return Number.isInteger(value) && value === Number(expected);
}

function normalizeTabMetadata(tab) {
  if (!tab || typeof tab !== 'object') return null;
  const out = {};
  if (Number.isInteger(tab.tabId)) out.tabId = tab.tabId;
  if (Number.isInteger(tab.windowId)) out.windowId = tab.windowId;
  if (Number.isInteger(tab.index)) out.index = tab.index;
  if (typeof tab.active === 'boolean') out.active = tab.active;
  return Object.keys(out).length ? out : null;
}

function tabSummary(tab) {
  if (!tab) return '';
  const parts = [
    Number.isInteger(tab.tabId) && `tabId=${tab.tabId}`,
    Number.isInteger(tab.windowId) && `windowId=${tab.windowId}`,
    Number.isInteger(tab.index) && `index=${tab.index}`,
    typeof tab.active === 'boolean' && `active=${tab.active}`,
  ].filter(Boolean);
  return parts.length ? parts.join(' ') : '';
}

// 引数なし latest が「別プロジェクトのキャプチャ」にサイレントに乗っ取られないための曖昧検知。
// rows（新しい順の queryEntries 結果）の先頭を head とし、head の capturedAt から windowMs 以内の
// entry を hostSlug(url) でグループ化する。distinctCount>=2 なら「直近に複数プロジェクトが居る」=曖昧。
// 時刻は annotation.capturedAt を最優先（ファイル mtime は git/rsync/DL fallback で潰れるため）し、
// capturedAt が無い/壊れている時だけ mtime にフォールバックする。
// 返り値の candidates は host ごとの最新 entry を新しい順に最大5件。
export function peekDistinctRecent(rows, { windowMs = 90 * 60 * 1000 } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return { newest: null, distinctCount: 0, candidates: [] };
  const ts = (e) => {
    const t = Date.parse(e?.capturedAt);
    return Number.isNaN(t) ? Number(e?.mtime) || 0 : t;
  };
  // 窓の基準は「最新の capturedAt」。rows は mtime 降順なので rows[0] が capturedAt 最新とは限らない
  // （git/rsync/DL fallback で mtime が潰れると mtime と capturedAt が逆転する＝capturedAt を使う理由）。
  // rows[0] を anchor にすると、mtime だけ大きい古い別案件を基準にして真に新しい案件を窓外に落とし、
  // distinctCount を過小評価して曖昧検知がサイレントに不発になる。max(capturedAt) を anchor にする。
  const headTs = Math.max(...rows.map(ts));
  const byHost = new Map();
  for (const e of rows) {
    if (headTs - ts(e) > windowMs) continue; // headTs は最大なので ts(e) <= headTs
    const host = hostSlug(e?.url || '');
    if (!byHost.has(host)) byHost.set(host, e); // rows は新しい順なので host 初出 = その host の最新
  }
  // candidates は窓内 distinct host の最新。queryEntries の limit(既定8)で上限が付くので cap しない
  // （distinctCount と candidates 数を一致させ、image tool の contextId 一致判定が候補を取りこぼさない）。
  const candidates = [...byHost.entries()].map(([host, e]) => ({
    id: e.id,
    host,
    title: e.title || '',
    capturedAt: e.capturedAt || '',
  }));
  // newest は「mtime 最新」(従来 latest 契約)を維持。単一案件時の単発返却で使う。
  return { newest: rows[0], distinctCount: byHost.size, candidates };
}

export function readAnnotation(dir) {
  const p = join(dir, ANNOTATION);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// MCP tool 用の content[] を組み立てる。image を見られない CLI でも text の file_path で
// vision できるよう、必ず image と file_path の両方を返す（handoff §3.2 = fallback 内蔵）。
export function buildEntryContent(entry, { includeImage = true, shotUrlFor } = {}) {
  const annotation = readEntryAnnotation(entry);
  const content = [];
  if (includeImage) {
    const data = readEntryShotBase64(entry);
    content.push({ type: 'image', data, mimeType: 'image/png' });
  }
  content.push({ type: 'text', text: buildEntryText(entry, annotation, { shotUrlFor }) });
  return content;
}

// 画像を送らず、annotation.json 由来の手がかりだけを返す軽量 context。
// @agent: / selector / testid で特定できる時は vision を呼ばずに進められる。
export function buildEntryContext(entry, { shotUrlFor } = {}) {
  const annotation = readEntryAnnotation(entry) || {};
  const storage = entry.storage || 'disk';
  const materialized = storage === 'memory' ? Boolean(entry.materialized) : true;
  const files = entryFiles(entry, materialized);
  const items = Array.isArray(annotation.items) ? annotation.items : [];
  return {
    id: entry.id,
    entryDir: entry.dir,
    storage,
    materialized,
    files,
    // ディスクパス非依存の取得先（loopback HTTP）。ブラウザの DL 先と inbox がズレても届く。
    urls: shotUrlFor ? { shot: shotUrlFor(entry.id, 'shot'), raw: shotUrlFor(entry.id, 'raw') } : null,
    url: annotation.url || entry.url || '',
    title: annotation.title || entry.title || '',
    capturedAt: annotation.capturedAt || '',
    tab: normalizeTabMetadata(annotation.tab || entry.tab),
    viewport: annotation.viewport || null,
    image: annotation.image || null,
    annotations: items.map((it) => ({
      n: it.n ?? null,
      id: it.id || '',
      note: it.note || '',
      intent: it.intent || '',
      shapeText: it.shapeText || '',
      anchorLabel: it.anchorLabel || '',
      dataAgentId: it.dataAgentId || '',
      selector: it.selector || '',
      testid: it.testid || '',
      dataAsin: it.dataAsin || '',
      href: it.href || '',
      tag: it.tag || '',
      role: it.role || '',
      targetCandidates: Array.isArray(it.targetCandidates) ? it.targetCandidates.map(normalizeTargetCandidate) : [],
      resolved: Boolean(it.resolved),
      inViewport: it.inViewport !== false,
      bboxPx: it.bboxPx || null,
    })),
    agentLookup: {
      priority: ['dataAgentId', 'selector', 'testid', 'anchorLabel', 'targetCandidates', 'image'],
      sourceSearch: 'rg -n \'data-agent-id="@agent:\' -g \'!*.md\' -g \'!.claude\'',
      imageGate: {
        requiredArgs: ['contextId', 'imageReason'],
        contextId: entry.id,
      },
    },
  };
}

export function buildEntryContextText(context) {
  const lines = [];
  lines.push('visual_feedback_context: image omitted');
  lines.push(`id: ${context.id}`);
  lines.push(`entry_dir: ${context.entryDir}`);
  lines.push(`storage: ${context.storage}${context.materialized ? ' (materialized)' : ' (memory; image request will materialize file_path)'}`);
  if (context.files.shot) lines.push(`shot_path: ${context.files.shot}`);
  else lines.push('shot_path: (not materialized yet)');
  if (context.files.raw) lines.push(`raw_path: ${context.files.raw}`);
  if (context.files.annotation) lines.push(`annotation_path: ${context.files.annotation}`);
  if (context.files.memo) lines.push(`memo_path: ${context.files.memo}`);
  // パス非依存の取得先。file_path を解決できない（inbox がズレた）時はこの URL に ?token= を付けて PNG を取れる。
  if (context.urls?.shot) lines.push(`shot_url: ${context.urls.shot}  (append ?token=<daemon token>)`);
  if (context.urls?.raw) lines.push(`raw_url: ${context.urls.raw}`);
  if (context.url) lines.push(`url: ${context.url}`);
  if (context.title) lines.push(`title: ${context.title}`);
  if (context.capturedAt) lines.push(`captured_at: ${context.capturedAt}`);
  const contextTab = tabSummary(context.tab);
  if (contextTab) lines.push(`chrome_tab: ${contextTab}  (tabId is Chrome-session scoped)`);
  if (context.viewport) lines.push(`viewport: ${context.viewport.width}x${context.viewport.height}`);
  lines.push('agent_lookup:');
  lines.push('  priority: dataAgentId -> selector -> testid -> anchorLabel -> targetCandidates -> image');
  lines.push('  source_search: rg -n \'data-agent-id="@agent:\' -g \'!*.md\' -g \'!.claude\'');
  lines.push(`  image_gate: pass contextId="${context.id}" and imageReason only when vision is truly needed`);
  if (context.annotations.length) {
    lines.push('annotations:');
    for (const it of context.annotations) {
      const n = it.n != null ? it.n : '?';
      const memo = String(it.note || '').trim() || it.shapeText || '(メモなし)';
      const intent = String(it.intent || '').trim();
      const parts = [
        it.dataAgentId && `agent="${it.dataAgentId}"`,
        it.anchorLabel && `target="${it.anchorLabel}"`,
        it.selector && `selector="${it.selector}"`,
        it.testid && `testid="${it.testid}"`,
        it.dataAsin && `dataAsin="${it.dataAsin}"`,
        it.href && `href="${it.href}"`,
        it.role && `role="${it.role}"`,
        it.inViewport === false && 'offscreen=true',
      ].filter(Boolean);
      lines.push(`  ${n}. ${memo}${intent ? ` / intent: ${intent}` : ''}`);
      if (parts.length) lines.push(`     ${parts.join(' ')}`);
      if (it.targetCandidates?.length) {
        for (const c of it.targetCandidates.slice(0, 4)) {
          const candidateParts = [
            c.source && `source=${c.source}`,
            c.label && `label="${c.label}"`,
            c.dataAsin && `dataAsin="${c.dataAsin}"`,
            c.href && `href="${c.href}"`,
            c.selector && `selector="${c.selector}"`,
          ].filter(Boolean);
          if (candidateParts.length) lines.push(`     candidate: ${candidateParts.join(' ')}`);
        }
      }
    }
  }
  lines.push('');
  lines.push(
    'まず dataAgentId(@agent:) を最優先し、属性名込み rg でソースを探してください。' +
      '次に selector / testid / anchorLabel / targetCandidates を使います。' +
      'それでも曖昧、または見た目の判断が必要な時だけ contextId と imageReason を渡して ' +
      'get_visual_feedback / get_latest_visual_feedback で image を取得してください。'
  );
  return lines.join('\n');
}

function pathIfExists(dir, name) {
  const p = join(dir, name);
  return existsSync(p) ? p : '';
}

function readEntryAnnotation(entry) {
  if (entry?.annotation) return entry.annotation;
  return entry?.dir ? readAnnotation(entry.dir) : null;
}

function readEntryShotBase64(entry) {
  const buf = readEntryImageBuffer(entry, 'shot');
  if (!buf) throw new Error(`shot.png not found for entry ${entry?.id || ''}`);
  return buf.toString('base64');
}

// PNG のバイト列を返す共通入口（MCP の base64 化と HTTP 画像配信が共有する）。kind='shot'|'raw'。
// メモリ保持(materialize 前)エントリは payload/shotBuffer から、ディスクエントリはファイルから読む。
// バイトが取れなければ null（呼び出し側で 404 / throw を選ぶ）。
export function readEntryImageBuffer(entry, kind = 'shot') {
  if (!entry) return null;
  if (kind === 'shot') {
    if (entry.shotBuffer) return entry.shotBuffer;
    return entry.shot && existsSync(entry.shot) ? readFileSync(entry.shot) : null;
  }
  if (kind === 'raw') {
    // メモリ保持(materialize 前)は raw を payload にだけ持つ。
    if (entry.shotBuffer && !entry.materialized) {
      const raw = decodeBase64(entry.payload?.image?.raw);
      if (raw && raw.length) return raw;
    }
    const p = entry.dir ? join(entry.dir, RAW) : '';
    return p && existsSync(p) ? readFileSync(p) : null;
  }
  return null;
}

function entryFiles(entry, materialized) {
  if (!materialized) {
    return { shot: '', raw: '', annotation: '', memo: '' };
  }
  return {
    shot: entry.shot,
    raw: pathIfExists(entry.dir, RAW),
    annotation: pathIfExists(entry.dir, ANNOTATION),
    memo: pathIfExists(entry.dir, MEMO),
  };
}

// image と並走させるテキスト。先頭に絶対パス、続いて指示一覧（selector/intent）。
export function buildEntryText(entry, annotation, { shotUrlFor } = {}) {
  const lines = [];
  // file_path は実ファイルがある時だけ出す。memory-first の image 応答で disk materialize に失敗した時は
  // 存在しないパスを広告せず、shot_url(?token=) を fallback として案内する（image バイトは別途メモリから返る）。
  const shotPath = entry?.shot && existsSync(entry.shot) ? entry.shot : '';
  if (shotPath) lines.push(`file_path: ${shotPath}`);
  // file_path を解決できない（inbox がブラウザ DL 先とズレた / 未materialize）時の代替取得先。取得には ?token= を付与する。
  if (shotUrlFor) lines.push(`shot_url: ${shotUrlFor(entry.id, 'shot')}  (append ?token=<daemon token>)`);
  if (!shotPath) {
    lines.push('note: file_path は未materialize（disk 未書き込み）。上の inline image、無ければ shot_url に ?token= を付けて取得してください。');
  }
  if (annotation?.url) lines.push(`url: ${annotation.url}`);
  if (annotation?.title) lines.push(`title: ${annotation.title}`);
  if (annotation?.capturedAt) lines.push(`captured_at: ${annotation.capturedAt}`);
  const annotationTab = tabSummary(normalizeTabMetadata(annotation?.tab || entry?.tab));
  if (annotationTab) lines.push(`chrome_tab: ${annotationTab}  (tabId is Chrome-session scoped)`);
  const items = Array.isArray(annotation?.items) ? annotation.items : [];
  if (items.length) {
    lines.push('annotations:');
    for (const it of items) {
      const n = it.n != null ? it.n : '?';
      const memo = String(it.note || '').trim() || it.shapeText || '(メモなし)';
      const intent = String(it.intent || '').trim();
      const agent = it.dataAgentId ? ` agent="${it.dataAgentId}"` : '';
      const where = it.anchorLabel ? ` target="${it.anchorLabel}"` : '';
      const sel = it.selector ? ` selector="${it.selector}"` : '';
      const asin = it.dataAsin ? ` dataAsin="${it.dataAsin}"` : '';
      const href = it.href ? ` href="${it.href}"` : '';
      const off = it.inViewport === false ? ' (画面外)' : '';
      lines.push(`  ${n}. ${memo}${intent ? ` / intent: ${intent}` : ''}${agent}${where}${sel}${asin}${href}${off}`);
      if (Array.isArray(it.targetCandidates) && it.targetCandidates.length) {
        const c = normalizeTargetCandidate(it.targetCandidates[0]);
        const candidateParts = [
          c.source && `source=${c.source}`,
          c.label && `label="${c.label}"`,
          c.dataAsin && `dataAsin="${c.dataAsin}"`,
          c.href && `href="${c.href}"`,
        ].filter(Boolean);
        if (candidateParts.length) lines.push(`     candidate: ${candidateParts.join(' ')}`);
      }
    }
  }
  lines.push('');
  lines.push(
    '上の image を vision で解釈してください（テキスト座標ではなく絵そのものを見る）。' +
      'image を読めない場合は file_path の PNG（無ければ shot_url に ?token= を付けて取得）を開いてください。' +
      '各注釈は画像中の丸数字①②…と対応します。'
  );
  return lines.join('\n');
}

function normalizeTargetCandidate(candidate = {}) {
  return {
    source: candidate.source || '',
    selector: candidate.selector || '',
    label: candidate.label || '',
    dataAgentId: candidate.dataAgentId || '',
    testid: candidate.testid || '',
    dataAsin: candidate.dataAsin || '',
    href: candidate.href || '',
    tag: candidate.tag || '',
    role: candidate.role || '',
  };
}
