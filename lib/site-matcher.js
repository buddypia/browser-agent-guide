// URL/ドメイン/正規表現でサイトルールを判定する。決定的に動くよう副作用を持たない純関数。

/**
 * 単一ルールが URL に一致するか判定する。
 * matchType:
 *   - 'all'   : すべての http/https URL に一致
 *   - 'domain': ホスト名が pattern と完全一致、または pattern のサブドメイン
 *   - 'page'  : URL の origin+pathname が pattern と一致(query/hashは無視)
 *   - 'prefix': URL文字列が pattern で始まる
 *   - 'regex' : pattern を正規表現として URL 全体に対し test
 */
export function matchRule(url, rule) {
  if (!rule || rule.enabled === false) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (rule.matchType === 'all') return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  if (!rule.pattern) return false;
  const pattern = String(rule.pattern).trim();
  switch (rule.matchType) {
    case 'page':
      return pageKey(url) === pageKey(pattern);
    case 'domain': {
      const host = parsed.hostname.toLowerCase();
      const want = pattern.toLowerCase().replace(/^\*\./, '');
      return host === want || host.endsWith('.' + want);
    }
    case 'prefix':
      return url.startsWith(pattern);
    case 'regex':
      try {
        return new RegExp(pattern).test(url);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

function pageKey(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return String(url).split(/[?#]/, 1)[0];
  }
}

/** URL に一致する有効なルールをすべて返す。 */
export function findMatchingRules(url, sites) {
  if (!Array.isArray(sites)) return [];
  return sites.filter((rule) => matchRule(url, rule));
}

/** URL が少なくとも1つのルールに一致するか。 */
export function isSiteAllowed(url, sites) {
  return findMatchingRules(url, sites).length > 0;
}
