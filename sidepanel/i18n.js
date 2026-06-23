export const DEFAULT_LOCALE = 'en';

// 言語設定が未指定(初回 or 'auto')のとき、ブラウザ言語に合わせる。
export const AUTO_LOCALE = 'auto';

export const LANGUAGE_OPTIONS = [
  { value: 'en', label: 'English', shortLabel: 'EN', flag: '🇺🇸', intlLocale: 'en-US' },
  { value: 'ko', label: '한국어', shortLabel: 'KO', flag: '🇰🇷', intlLocale: 'ko-KR' },
  { value: 'ja', label: '日本語', shortLabel: 'JA', flag: '🇯🇵', intlLocale: 'ja-JP' },
  { value: 'zh', label: '中文', shortLabel: 'ZH', flag: '🇨🇳', intlLocale: 'zh-CN' },
];

const SUPPORTED_LOCALES = new Set(LANGUAGE_OPTIONS.map((language) => language.value));
const cache = new Map();

export function normalizeLocale(locale) {
  const value = String(locale || '').toLowerCase().replace('_', '-');
  if (SUPPORTED_LOCALES.has(value)) return value;
  const base = value.split('-')[0];
  return SUPPORTED_LOCALES.has(base) ? base : DEFAULT_LOCALE;
}

// ブラウザのUI言語を対応ロケールへ正規化する(非対応は英語)。
export function detectBrowserLocale() {
  let raw = '';
  try {
    raw = chrome?.i18n?.getUILanguage?.() || '';
  } catch {
    raw = '';
  }
  if (!raw && typeof navigator !== 'undefined') {
    raw = navigator.language || (navigator.languages && navigator.languages[0]) || '';
  }
  return normalizeLocale(raw);
}

// 保存値を実ロケールへ解決する。未指定/'auto' はブラウザ言語に合わせる。
export function resolveLocale(stored) {
  if (!stored || stored === AUTO_LOCALE) return detectBrowserLocale();
  return normalizeLocale(stored);
}

export function localeToIntl(locale) {
  return LANGUAGE_OPTIONS.find((language) => language.value === normalizeLocale(locale))?.intlLocale || 'en-US';
}

export function languageName(locale) {
  return LANGUAGE_OPTIONS.find((language) => language.value === normalizeLocale(locale))?.label || 'English';
}

export async function createI18n(locale = DEFAULT_LOCALE) {
  let currentLocale = normalizeLocale(locale);
  // フォールバック(en)と現在ロケールを並列取得し、最初のローカライズ描画までの
  // 直列待ち(en.json → locale.json の2往復)を1往復ぶんに縮める。
  const needsLocale = currentLocale !== DEFAULT_LOCALE;
  const [fallbackMessages, localeMessages] = await Promise.all([
    loadMessages(DEFAULT_LOCALE),
    needsLocale ? loadMessages(currentLocale) : Promise.resolve(null),
  ]);
  let messages = needsLocale ? localeMessages : fallbackMessages;

  return {
    get locale() {
      return currentLocale;
    },
    async setLocale(nextLocale) {
      currentLocale = normalizeLocale(nextLocale);
      messages = currentLocale === DEFAULT_LOCALE ? fallbackMessages : await loadMessages(currentLocale);
      return currentLocale;
    },
    t(key, values = {}) {
      const template = messages[key] ?? fallbackMessages[key] ?? key;
      return interpolate(template, values);
    },
  };
}

async function loadMessages(locale) {
  const normalized = normalizeLocale(locale);
  if (cache.has(normalized)) return cache.get(normalized);
  const url = new URL(`locales/${normalized}.json`, import.meta.url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${normalized} locale (${res.status})`);
  const messages = await res.json();
  cache.set(normalized, messages);
  return messages;
}

function interpolate(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (match, name) => {
    return Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match;
  });
}
