// 用語集エントリ(Markdown)の YAML frontmatter を解釈する依存ゼロの STRICT パーサ。
//
// 方針: 長期運用での「黙ってミスパースする」事故を防ぐため、サポートする構文を
//   明示的に限定し、想定外の行に出会ったら *必ず throw* する(fail-loud)。
//   js-yaml 等を入れないのは、本リポジトリの「依存を増やさない」方針に合わせるため。
//
// サポートする YAML サブセット(glossary/_schema.md が正典):
//   key: scalar                         スカラー("..." で囲むと空白/記号を含められる)
//   key: ["a", "b"]                     インラインの文字列リスト([] は空リスト)
//   key: { a: 1, b: "x" }               インラインのマップ({} は空マップ)
//   key:                                ブロック。直後のインデント行が
//     - scalar / - { ... }                シーケンス(各要素はスカラー or インラインマップ)
//     subkey: scalar                      または サブマップ(どちらか一方。混在は throw)
//   # 行頭(トリム後)が # の行はコメント。値の途中の # はコメント扱いしない(URL/アンカー保護)。
//
// 値は全てそのまま文字列として返す(数値/真偽値への自動変換はしない=曖昧さ排除)。

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function splitFrontmatter(text) {
  const m = FM_RE.exec(text);
  if (!m) return { raw: null, body: text };
  return { raw: m[1], body: text.slice(m[0].length) };
}

// 引用符・[]・{} のネストを尊重して、depth 0 の delim でだけ分割する。
function splitTop(str, delim = ',') {
  const out = [];
  let buf = '';
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inStr) {
      if (ch === '"' && str[i - 1] !== '\\') inStr = false;
      buf += ch;
      continue;
    }
    if (ch === '"') { inStr = true; buf += ch; continue; }
    if (ch === '[' || ch === '{') { depth++; buf += ch; continue; }
    if (ch === ']' || ch === '}') { depth--; buf += ch; continue; }
    if (ch === delim && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  out.push(buf);
  return out;
}

function unquote(s, ctx) {
  const t = s.trim();
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
    // 単純なエスケープ(\" )のみ対応。それ以外のエスケープは想定しない。
    return t.slice(1, -1).replace(/\\"/g, '"');
  }
  if (t.startsWith('"') || t.endsWith('"')) {
    throw new Error(`frontmatter: 引用符が閉じていません: ${ctx} -> ${s}`);
  }
  return t;
}

function parseScalarOrInline(value, ctx) {
  const v = value.trim();
  if (v === '' ) return '';
  if (v === '[]') return [];
  if (v === '{}') return {};
  if (v[0] === '[') {
    if (v[v.length - 1] !== ']') throw new Error(`frontmatter: リストが閉じていません: ${ctx} -> ${value}`);
    const inner = v.slice(1, -1).trim();
    if (inner === '') return [];
    return splitTop(inner).map((x) => unquote(x, ctx));
  }
  if (v[0] === '{') return parseInlineMap(v, ctx);
  return unquote(v, ctx);
}

function parseInlineMap(value, ctx) {
  const v = value.trim();
  if (v[0] !== '{' || v[v.length - 1] !== '}') {
    throw new Error(`frontmatter: インラインマップが不正です: ${ctx} -> ${value}`);
  }
  const inner = v.slice(1, -1).trim();
  const obj = {};
  if (inner === '') return obj;
  for (const pair of splitTop(inner)) {
    const idx = indexOfKeySep(pair);
    if (idx < 0) throw new Error(`frontmatter: インラインマップの要素に ':' がありません: ${ctx} -> ${pair}`);
    const k = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    obj[k] = parseScalarOrInline(val, `${ctx}.${k}`);
  }
  return obj;
}

// "key: value" の区切り(": " か 末尾 ":")の位置を、引用符を尊重して探す。
function indexOfKeySep(line) {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== '\\') inStr = !inStr;
    if (inStr) continue;
    if (ch === ':' && (i === line.length - 1 || line[i + 1] === ' ')) return i;
  }
  return -1;
}

function indent(line) {
  let n = 0;
  while (n < line.length && line[n] === ' ') n++;
  return n;
}

export function parseFrontmatter(text) {
  const { raw, body } = splitFrontmatter(text);
  if (raw === null) throw new Error('frontmatter: --- で囲まれた frontmatter が見つかりません');
  const lines = raw.split(/\r?\n/);
  const data = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) { i++; continue; }
    if (indent(line) !== 0) {
      throw new Error(`frontmatter: 予期しないインデント行(トップレベルにキーが必要): "${line}"`);
    }
    const sep = indexOfKeySep(line);
    if (sep < 0) throw new Error(`frontmatter: 'key:' の形式ではありません: "${line}"`);
    const key = line.slice(0, sep).trim();
    const rest = line.slice(sep + 1).trim();
    if (rest !== '') {
      data[key] = parseScalarOrInline(rest, key);
      i++;
      continue;
    }
    // ブロック: 子行を集める(インデント > 0)
    const children = [];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === '') { i++; continue; }
      if (indent(l) === 0) break;
      children.push(l);
      i++;
    }
    data[key] = parseBlock(children, key);
  }
  return { data, body };
}

function parseBlock(children, key) {
  if (children.length === 0) return null;
  const isSeq = children[0].trim().startsWith('- ');
  if (isSeq) {
    const out = [];
    for (const l of children) {
      const t = l.trim();
      if (!t.startsWith('- ')) {
        throw new Error(`frontmatter: シーケンス '${key}' に非シーケンス行が混在しています: "${l}"`);
      }
      out.push(parseScalarOrInline(t.slice(2).trim(), `${key}[]`));
    }
    return out;
  }
  const obj = {};
  for (const l of children) {
    const t = l.trim();
    if (t.startsWith('- ')) {
      throw new Error(`frontmatter: マップ '${key}' にシーケンス行が混在しています: "${l}"`);
    }
    const sep = indexOfKeySep(t);
    if (sep < 0) throw new Error(`frontmatter: マップ '${key}' の子が 'key: value' ではありません: "${l}"`);
    const k = t.slice(0, sep).trim();
    obj[k] = parseScalarOrInline(t.slice(sep + 1).trim(), `${key}.${k}`);
  }
  return obj;
}
