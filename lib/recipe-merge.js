// recipe-merge.js — 学習レシピの永続化マージ（純粋ロジック）。
//
// service-worker.js から抽出して Node 単体テスト可能にしたもの。
// 役割: 新しく学習したアクションを既存レシピへマージする。
//   - 既存アクションはそのまま保持（手編集した when/waitFor を壊さない）。
//   - 取り込むアクションは {verb,args,reason} に加えて任意の when/waitFor を保持する
//     （画面別 SPA ターゲティング — 以前はここで剥がれていた）。
//   - 重複は verb+args(+when+waitFor) で判定。画面別に when が異なるアクションは別物として残す。
//
// when/waitFor の形は content-script.js の evalWhen / waitFor 処理と一致させる:
//   when:    { urlContains?, selectorExists?, selectorAbsent? }
//   waitFor: { selector, timeoutMs? }

/**
 * 学習アクションを既存レシピへマージする。
 * @param {Array} existing - 既存レシピのアクション配列（when/waitFor を含み得る）
 * @param {Array} actions - 新規に学習したアクション
 * @param {{ has(verb: string): boolean }} [recipeVerbs] - 永続化を許可する verb の集合（省略時は全許可）
 * @returns {Array} マージ後のアクション配列
 */
export function mergeRecipeActions(existing, actions, recipeVerbs) {
  const isAllowed = (verb) =>
    recipeVerbs && typeof recipeVerbs.has === 'function' ? recipeVerbs.has(verb) : true;
  const base = Array.isArray(existing) ? existing : [];
  const next = [...base];
  const seen = new Set(base.map(recipeKey));
  for (const action of actions || []) {
    if (!action || !isAllowed(action.verb)) continue;
    const recipeAction = {
      verb: action.verb,
      args: clonePlain(action.args || {}),
      reason: action.reason || 'チャットで覚えた変更',
    };
    // when/waitFor を保持する（画面別 SPA ターゲティング）。空/不正は付けない。
    const when = cleanCondition(action.when);
    if (when) recipeAction.when = when;
    const waitFor = cleanWaitFor(action.waitFor);
    if (waitFor) recipeAction.waitFor = waitFor;
    const key = recipeKey(recipeAction);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(recipeAction);
  }
  return next;
}

/**
 * 重複判定キー。when/waitFor は存在するときだけ含めるので、
 * それらを持たないアクションのキーは従来と byte 同一（後方互換）。
 */
export function recipeKey(action) {
  const key = { verb: action?.verb || '', args: sortKeys(action?.args || {}) };
  if (action?.when) key.when = sortKeys(action.when);
  if (action?.waitFor) key.waitFor = sortKeys(action.waitFor);
  return JSON.stringify(key);
}

/** when 条件を既知キーだけに正規化。何も無ければ null。 */
export function cleanCondition(when) {
  if (!when || typeof when !== 'object') return null;
  const out = {};
  if (typeof when.urlContains === 'string' && when.urlContains) out.urlContains = when.urlContains;
  if (typeof when.selectorExists === 'string' && when.selectorExists) out.selectorExists = when.selectorExists;
  if (typeof when.selectorAbsent === 'string' && when.selectorAbsent) out.selectorAbsent = when.selectorAbsent;
  return Object.keys(out).length ? out : null;
}

/** waitFor を {selector, timeoutMs?} に正規化。selector が無ければ null。 */
export function cleanWaitFor(waitFor) {
  if (!waitFor || typeof waitFor !== 'object') return null;
  if (typeof waitFor.selector !== 'string' || !waitFor.selector) return null;
  const out = { selector: waitFor.selector };
  const timeoutMs = Number(waitFor.timeoutMs);
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) out.timeoutMs = timeoutMs;
  return out;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .sort()
    .reduce((out, key) => {
      out[key] = sortKeys(value[key]);
      return out;
    }, {});
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}
