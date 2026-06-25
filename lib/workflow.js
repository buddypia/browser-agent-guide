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

/** 実行セッションを正規化する。active=実行中、doneStepIds=このセッションで実行済みのステップid。 */
export function normalizeRun(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    active: r.active === true,
    doneStepIds: Array.isArray(r.doneStepIds) ? r.doneStepIds.filter((x) => typeof x === 'string') : [],
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

/** 自動実行で「実行する意味がある」手順(本文が空でない)。 */
export function actionableSteps(workflow) {
  return normalizeWorkflow(workflow).steps.filter((s) => s.text && s.text.trim());
}

/**
 * 指定URLでこのセッションがまだ実行していない手順を返す。
 * pattern(記録時の origin+pathname) 優先、無ければ url で突き合わせる。
 */
export function pendingStepsForUrl(workflow, run, url) {
  const done = new Set(normalizeRun(run).doneStepIds);
  return actionableSteps(workflow).filter((s) => {
    if (done.has(s.id)) return false;
    return samePageUrl(s.pattern || s.url, url);
  });
}

/** セッションの全 actionable 手順が実行済みなら true(=完了)。 */
export function isRunComplete(workflow, run) {
  const ids = actionableSteps(workflow).map((s) => s.id);
  if (!ids.length) return true;
  const done = new Set(normalizeRun(run).doneStepIds);
  return ids.every((id) => done.has(id));
}

// 不可逆操作(購入・送信・削除の最終確定)の疑いがあるラベル。自動実行ではクリックを保留する。
// content-script.js 側にも同等リストを内蔵する(非モジュールのため import 不可)。変更時は両方そろえる。
export const IRREVERSIBLE_KEYWORDS = [
  // 日本語
  '確定', '購入', '注文', '支払', '決済', '送信', '削除', '退会', '解約', '申込', '申し込み', 'チェックアウト',
  // English
  'buy', 'purchase', 'order', 'checkout', 'pay', 'payment', 'submit', 'place order', 'confirm', 'delete', 'remove account',
];

/** ラベルが不可逆操作っぽいか(大文字小文字無視・部分一致)。 */
export function isIrreversibleLabel(label) {
  const s = String(label || '').toLowerCase();
  if (!s) return false;
  return IRREVERSIBLE_KEYWORDS.some((kw) => s.includes(kw.toLowerCase()));
}
