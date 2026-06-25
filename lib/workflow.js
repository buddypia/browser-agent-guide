// ページ跨ぎ「ワークフロー」の純データ層。
//
// 各ページで残したメモ(note/お描き)を、その「URL」とともに残した順に記録し、
// チャットで AI に「URL順の操作手順」として一括で伝えるためのもの。
// 既存の単一ページ「お描きワークフロー(操作手順)」を、ページをまたいで一本化する拡張で、
// content / sidepanel / service-worker の3コンテキストが同じ chrome.storage.local キーを共有する。
//
// 注意: content-script.js は非モジュール IIFE のため本ファイルを import できない。
// content 側は同等の最小ロジックを内蔵するが、ステップの「形」は必ず本ファイルの定義に合わせること
// (読み出し側の normalizeWorkflow がどちらの書き込みも吸収する)。

export const WORKFLOW_KEY = 'aiAdvisorWorkflow';

const EMPTY = { recording: false, steps: [], saved: [] };

/** 保存形(任意の生データ)を {recording, steps[], saved[]} へ正規化する。欠落・型崩れに耐える。 */
export function normalizeWorkflow(raw) {
  const wf = raw && typeof raw === 'object' ? raw : {};
  return {
    recording: wf.recording === true,
    steps: Array.isArray(wf.steps) ? wf.steps.filter(Boolean).map(normalizeStep) : [],
    saved: Array.isArray(wf.saved) ? wf.saved.filter(Boolean).map(normalizeSaved) : [],
  };
}

/** 1ステップ(あるページで残した1メモ)を正規化する。 */
export function normalizeStep(s) {
  const step = s && typeof s === 'object' ? s : {};
  return {
    id: String(step.id || ''),
    annoId: String(step.annoId || ''),
    url: String(step.url || ''),
    matchType: step.matchType || 'page',
    pattern: String(step.pattern || ''),
    kind: step.kind === 'drawing' ? 'drawing' : 'note',
    text: String(step.text || ''),
    target: String(step.target || ''),
    createdAt: String(step.createdAt || ''),
  };
}

function normalizeSaved(w) {
  const saved = w && typeof w === 'object' ? w : {};
  return {
    id: String(saved.id || ''),
    name: String(saved.name || ''),
    createdAt: String(saved.createdAt || ''),
    steps: Array.isArray(saved.steps) ? saved.steps.filter(Boolean).map(normalizeStep) : [],
  };
}

/** ステップを annoId で更新、無ければ末尾に追加した新配列を返す(記録は時系列=URL順)。 */
export function upsertStep(steps, step) {
  const list = Array.isArray(steps) ? steps.slice() : [];
  const norm = normalizeStep(step);
  const i = norm.annoId ? list.findIndex((s) => s.annoId && s.annoId === norm.annoId) : -1;
  if (i >= 0) list[i] = { ...list[i], ...norm };
  else list.push(norm);
  return list;
}

/** 指定アノテーション由来のステップを取り除いた新配列を返す。 */
export function removeStepByAnno(steps, annoId) {
  return (Array.isArray(steps) ? steps : []).filter((s) => s && s.annoId !== annoId);
}

/**
 * AI へ渡す「URL順の操作手順」を組み立てる。
 * 本文も対象も無い空ステップは落とし、1件も残らなければ null(プロンプトに節を出さない)。
 */
export function crossPageWorkflowForPrompt(raw) {
  const wf = normalizeWorkflow(raw);
  const steps = wf.steps
    .filter((s) => (s.text && s.text.trim()) || s.target)
    .map((s, i) => ({
      order: i + 1,
      url: s.url,
      pattern: s.pattern,
      kind: s.kind,
      text: s.text,
      target: s.target,
    }));
  if (!steps.length) return null;
  return { count: steps.length, steps };
}

// ===========================================================================
// 自動実行(セッション) — 記録した手順を「ページ遷移ごとに」自動で走らせる仕組み。
// セッションは明示的な開始/停止(opt-in)。常時ONトグルは置かない(暴発防止)。
// ===========================================================================

/** 自動実行セッションの保存キー(SW が主に管理、サイドパネルが開始/停止)。 */
export const RUN_KEY = 'aiAdvisorWorkflowRun';

/**
 * 実行セッションを正規化する。
 *   active      : 実行中
 *   doneStepIds : このセッションで実行済みのステップid
 *   tabId       : セッションを開始したタブ(他タブの遷移で乗っ取られないための所有者)
 *   navCount    : SW主導の遷移回数(暴走/不一致ループの上限判定。SW再起動を跨いでも有効)
 */
export function normalizeRun(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    active: r.active === true,
    doneStepIds: Array.isArray(r.doneStepIds) ? r.doneStepIds.filter((x) => typeof x === 'string') : [],
    tabId: Number.isInteger(r.tabId) ? r.tabId : null,
    navCount: Number.isInteger(r.navCount) && r.navCount >= 0 ? r.navCount : 0,
    startedAt: String(r.startedAt || ''),
  };
}

/** 2つのURLが同じページ(origin+pathname)を指すか。手順とページの突き合わせに使う。 */
export function samePageUrl(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin + ua.pathname === ub.origin + ub.pathname;
  } catch {
    return String(a || '') === String(b || '');
  }
}

// content/content-script.js の annotationScopeKey と同等の URL 正規化キー。
// 記録ステップの pattern はこの正規化で作られる(Amazon は /dp/ASIN へ短縮、/s は主要クエリのみ残す)。
// pendingStepsForUrl で live URL も同じ正規化を通すことで、短縮 pattern と生 URL の食い違いを無くす。
// content 側 annotationScopeKey/amazonScopeKey/amazonAsinFromPath と挙動を一致させること(drift 注意)。
export function scopeKeyForUrl(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return String(href || '');
  }
  return amazonScopeKey(url) || `${url.origin}${url.pathname}`;
}

function isAmazonHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'amazon.com' || h.includes('.amazon.');
}

function amazonAsinFromPath(pathname) {
  const m = String(pathname || '').match(/(?:^|\/)(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/ASIN)\/([A-Z0-9]{10})(?:\/|$)/i);
  return m ? m[1].toUpperCase() : '';
}

function amazonScopeKey(url) {
  if (!isAmazonHost(url.hostname)) return '';
  const asin = amazonAsinFromPath(url.pathname);
  if (asin) return `${url.origin}/dp/${asin}`;
  if (url.pathname === '/s' || url.pathname.startsWith('/s/')) {
    const keep = new URLSearchParams();
    for (const key of ['i', 'k', 'rh', 'node', 'bbn', 'field-keywords']) {
      const val = url.searchParams.get(key);
      if (val) keep.set(key, val);
    }
    const qs = keep.toString();
    return `${url.origin}${url.pathname}${qs ? `?${qs}` : ''}`;
  }
  return `${url.origin}${url.pathname}`;
}

/**
 * 自動実行で「実行する意味がある」手順(本文 or 対象が空でない)。
 * crossPageWorkflowForPrompt と判定を揃える: 本文の無いお描き/対象だけの手順も落とさない
 * (落とすと、そのページが「跨ぐ対象」として認識されず手順欠落・順序ずれを招く)。
 */
export function actionableSteps(workflow) {
  return normalizeWorkflow(workflow).steps.filter((s) => (s.text && s.text.trim()) || s.target);
}

/**
 * 指定URLでこのセッションがまだ実行していない手順を返す。
 * 記録時の pattern(scopeKeyForUrl による正規化キー)優先、無ければ url で突き合わせる。
 * live URL も scopeKeyForUrl で正規化してから比較するので、Amazon の /dp/ASIN/ref=… のような
 * 「記録時の短縮 pattern と着地時の生 URL」のズレでも取りこぼさない。
 */
export function pendingStepsForUrl(workflow, run, url) {
  const done = new Set(normalizeRun(run).doneStepIds);
  const liveKey = scopeKeyForUrl(url);
  return actionableSteps(workflow).filter((s) => {
    if (done.has(s.id)) return false;
    const stepKey = scopeKeyForUrl(s.pattern || s.url);
    return stepKey === liveKey || samePageUrl(s.pattern || s.url, url);
  });
}

/**
 * autorun の遷移ループ判定(純関数, テスト可能)。
 * 「直近に遷移した先(lastNavUrl)へ、今回このページで1件も前進(madeProgress)していないのに
 * 再び遷移しようとしている」場合だけループとみなす。前進していれば正当な遷移として許可する
 * (= 到達成功後は lastNav の残りで誤って止めない)。
 */
export function isAutoRunNavLoop({ candidateUrl, lastNavUrl, madeProgress }) {
  if (madeProgress) return false;
  return Boolean(candidateUrl) && candidateUrl === lastNavUrl;
}

/** セッションの全 actionable 手順が実行済みなら true(=完了)。 */
export function isRunComplete(workflow, run) {
  const ids = actionableSteps(workflow).map((s) => s.id);
  if (!ids.length) return true;
  const done = new Set(normalizeRun(run).doneStepIds);
  return ids.every((id) => done.has(id));
}

// 不可逆/確定系操作の疑いがあるラベル。自動実行ではこのラベルのクリックを保留する。
// 真に不可逆な「購入・注文・支払・決済・送金・削除・退会・解約・送信・確定・同意・登録」等に限定する。
// ★ページ送り/前進だけの語(続行/続ける/進む/次へ/continue/proceed/next)は含めない:
//   これらは複数ページ手順を次ページへ送る通常ボタンのラベルそのもので、含めると最初のページで
//   held → セッション停止になり「ページを跨いで実行できない」原因になる(ページ間遷移は SW が決定論的に行う)。
// content-script.js 側にも同一リストを内蔵する(非モジュールのため import 不可)。
// test/workflow-lib.test.mjs がこの2コピーの一致をパリティ検査する。変更時は両方そろえること。
export const IRREVERSIBLE_KEYWORDS = [
  // 日本語
  '確定', '確認', '決定', '同意', '購入', '買う', '今すぐ', '注文', '支払', '決済', '課金', '請求',
  '送金', '振込', '振り込み', '送信', '削除', '退会', '解約', '申込', '申し込み', 'チェックアウト',
  '予約', '登録', '寄付', 'サインアップ',
  // English
  'buy', 'purchase', 'order', 'place order', 'place your order', 'complete order', 'checkout', 'check out',
  'pay', 'payment', 'submit', 'confirm', 'agree', 'subscribe', 'sign up',
  'signup', 'donate', 'transfer', 'send money', 'book now', 'remove', 'delete',
];

/** ラベルが不可逆操作っぽいか(大文字小文字無視・部分一致)。 */
export function isIrreversibleLabel(label) {
  const s = String(label || '').toLowerCase();
  if (!s) return false;
  return IRREVERSIBLE_KEYWORDS.some((kw) => s.includes(kw.toLowerCase()));
}

// 自動実行(autorun)で許可する動詞の allow-list(deny-by-default)。
// ページ手順の実行に必要な「読み取り・スクロール・入力・(ガード付き)クリック」だけを許可し、
// それ以外(submitForm/navigateTo/inject*/setStyle/removeElement/お描き系 等)は拒否する。
// SW は callAI 前に verbNames をこの集合へ絞り、content は isActionAllowed で二重に弾く。
// content-script.js 側にも同一リストを内蔵する。test がパリティ検査する。
export const AUTORUN_ALLOWED_VERBS = [
  'listAffordances', 'readText', 'extractData', 'readSignals', 'scrollToElement',
  'highlightElement', 'focusElement', 'waitForElement', 'explainWorkflow', 'listAnnotations',
  'exportContext', 'notify', 'noop',
  'clickAffordance', 'clickElement', 'fillAffordance', 'fillInput', 'selectOption',
];

/** autorun で許可された動詞か。 */
export function isAutoRunVerbAllowed(verb) {
  return AUTORUN_ALLOWED_VERBS.includes(verb);
}
