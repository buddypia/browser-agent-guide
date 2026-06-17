// 設定の保存・読込ヘルパー。すべて chrome.storage.local に格納する。
// APIキーを含むため同期(sync)ではなくローカルに保持する。

const STORE_KEY = 'aiAdvisorSettings';

/** 既定設定。初回起動時やキー欠落時のフォールバックに使う。 */
export const DEFAULT_SETTINGS = {
  ai: {
    provider: 'openai',                       // 'openai' | 'anthropic' | 'gemini' | 'custom'
    apiKey: '',
    baseUrl: 'https://api.openai.com/v1',     // openai / custom 用
    model: 'gpt-4o-mini',                     // openai / custom 用
    anthropicModel: 'claude-sonnet-4-6',      // anthropic 用
    geminiModel: 'gemini-3.5-flash',          // gemini 用
    temperature: 0,                           // 決定性を高めるため既定0
  },
  // AIがチャット経由で注入した表示変更を自動保存する既定範囲。
  memory: {
    defaultScope: 'page', // 'page' | 'domain' | 'all'
  },
  // 視覚フィードバックの常駐デーモン(Phase 1b)。有効時はお描き画像を WebSocket で push する
  // (無効/未到達時は chrome.downloads にフォールバック)。トークンはデーモン起動時の表示を貼る。
  daemon: {
    enabled: false,
    url: 'ws://127.0.0.1:8765/ws',
    token: '',
  },
  // 記憶済みURL/拡張を有効化するサイトのルール一覧
  sites: [
    // 例) { id, label, matchType:'page'|'domain'|'prefix'|'regex'|'all', pattern, enabled, learned }
  ],
  // ルールID -> 仕込むアクション配列(動詞レシピ)。ページ有効化時に毎回適用する。
  recipes: {},
};

/** 設定全体を取得する(欠落キーは既定値で補完)。 */
export async function getSettings() {
  const raw = await chrome.storage.local.get(STORE_KEY);
  const stored = raw[STORE_KEY] || {};
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    ai: { ...DEFAULT_SETTINGS.ai, ...(stored.ai || {}) },
    memory: { ...DEFAULT_SETTINGS.memory, ...(stored.memory || {}) },
    daemon: { ...DEFAULT_SETTINGS.daemon, ...(stored.daemon || {}) },
    sites: Array.isArray(stored.sites) ? stored.sites : [],
    recipes: stored.recipes && typeof stored.recipes === 'object' ? stored.recipes : {},
  };
}

/** 設定全体を保存する。 */
export async function saveSettings(settings) {
  await chrome.storage.local.set({ [STORE_KEY]: settings });
}

/** 部分更新して保存する。 */
export async function patchSettings(patch) {
  const cur = await getSettings();
  const next = {
    ...cur,
    ...patch,
    ai: { ...cur.ai, ...(patch.ai || {}) },
    memory: { ...cur.memory, ...(patch.memory || {}) },
    daemon: { ...cur.daemon, ...(patch.daemon || {}) },
    sites: patch.sites ?? cur.sites,
    recipes: patch.recipes ?? cur.recipes,
  };
  await saveSettings(next);
  return next;
}

/** 変更を購読する(options/sidepanel間の同期用)。 */
export function onSettingsChanged(callback) {
  const listener = (changes, area) => {
    if (area === 'local' && changes[STORE_KEY]) {
      callback(changes[STORE_KEY].newValue);
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
