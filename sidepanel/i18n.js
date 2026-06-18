export const DEFAULT_LOCALE = 'en';

export const LANGUAGE_OPTIONS = [
  { value: 'en', label: 'English', shortLabel: 'EN', intlLocale: 'en-US' },
  { value: 'ko', label: '한국어', shortLabel: 'KO', intlLocale: 'ko-KR' },
  { value: 'ja', label: '日本語', shortLabel: 'JA', intlLocale: 'ja-JP' },
  { value: 'zh', label: '中文', shortLabel: 'ZH', intlLocale: 'zh-CN' },
];

const SUPPORTED_LOCALES = new Set(LANGUAGE_OPTIONS.map((language) => language.value));
const cache = new Map();

export function normalizeLocale(locale) {
  const value = String(locale || '').toLowerCase().replace('_', '-');
  if (SUPPORTED_LOCALES.has(value)) return value;
  const base = value.split('-')[0];
  return SUPPORTED_LOCALES.has(base) ? base : DEFAULT_LOCALE;
}

export function localeToIntl(locale) {
  return LANGUAGE_OPTIONS.find((language) => language.value === normalizeLocale(locale))?.intlLocale || 'en-US';
}

export function languageName(locale) {
  return LANGUAGE_OPTIONS.find((language) => language.value === normalizeLocale(locale))?.label || 'English';
}

export async function createI18n(locale = DEFAULT_LOCALE) {
  let currentLocale = normalizeLocale(locale);
  const fallbackMessages = await loadMessages(DEFAULT_LOCALE);
  let messages = currentLocale === DEFAULT_LOCALE ? fallbackMessages : await loadMessages(currentLocale);

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
