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
