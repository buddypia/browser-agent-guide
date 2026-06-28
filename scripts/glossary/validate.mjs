#!/usr/bin/env node
// 用語集の検証ゲート(機械検証できる事実だけを止める)。依存ゼロ・Node 組み込みのみ。
// 違反があれば exit 1(npm run check のゲートに組み込む想定)。
//
// 検証項目:
//   1. frontmatter のパース・必須フィールド・enum
//   2. id 一意 / id == ファイル名 / bounded_context == 親フォルダ名
//   3. source_refs.path / code_refs.path の実在、code_refs.symbol の出現
//   4. related の解決(孤立リンク禁止)
//   5. @term: マーカーの形式と、id が実在用語を指すこと(孤立マーカー禁止)
//   6. status: stable の鮮度(last_verified が GLOSSARY_FRESH_DAYS 日以内、既定 180)
// anchor 不一致や「code_refs があるのにマーカー無し」は警告(WARN)に留める(脆くしない)。

import { readFileSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { loadEntries, indexById } from './lib/entries.mjs';
import { scanCodeMarkers } from './lib/code.mjs';

const ROOT = process.cwd();
const FRESH_DAYS = parseInt(process.env.GLOSSARY_FRESH_DAYS || '180', 10);

const REQUIRED = ['id', 'term', 'status', 'owner', 'bounded_context', 'last_verified', 'confidence'];
const ENUMS = {
  status: ['draft', 'in-progress', 'stable', 'deprecated'],
  confidence: ['high', 'medium', 'low'],
};
const PROGRESS_STATES = ['planned', 'in-progress', 'shipped'];
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const errors = [];
const warns = [];
const err = (where, msg) => errors.push(`✗ ${where}: ${msg}`);
const warn = (where, msg) => warns.push(`⚠ ${where}: ${msg}`);

function slugify(h) {
  return h.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function checkRefList(where, list, kind) {
  if (list == null) return;
  if (!Array.isArray(list)) { err(where, `${kind} はリストであること`); return; }
  for (const ref of list) {
    if (typeof ref !== 'object' || Array.isArray(ref)) { err(where, `${kind} の要素はマップであること`); continue; }
    if (kind === 'source_refs' || kind === 'code_refs') {
      if (!ref.path) { err(where, `${kind} に path がありません`); continue; }
      const abs = join(ROOT, ref.path);
      if (!existsSync(abs)) { err(where, `${kind} の path が存在しません: ${ref.path}`); continue; }
      if (kind === 'source_refs' && ref.anchor) {
        const text = readFileSync(abs, 'utf8');
        const slugs = new Set();
        for (const m of text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) slugs.add(slugify(m[1]));
        if (!slugs.has(slugify(ref.anchor))) warn(where, `${ref.path} に anchor "${ref.anchor}" 相当の見出しが見つかりません`);
      }
      if (kind === 'code_refs' && ref.symbol) {
        const text = readFileSync(abs, 'utf8');
        if (!text.includes(ref.symbol)) err(where, `code_refs.symbol "${ref.symbol}" が ${ref.path} に出現しません`);
      }
    }
  }
}

function daysBetween(isoDate, today) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return Math.floor((today - d) / 86400000);
}

function main() {
  let entries;
  try {
    entries = loadEntries(ROOT);
  } catch (e) {
    console.error(`✗ 用語集の読み込みに失敗: ${e.message}`);
    process.exit(1);
  }
  if (entries.length === 0) {
    console.error('✗ glossary/ に用語エントリが1件もありません');
    process.exit(1);
  }

  let byId;
  try {
    byId = indexById(entries);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }

  const today = new Date();
  for (const e of entries) {
    const where = e.relPath;
    const d = e.data;
    for (const k of REQUIRED) {
      if (d[k] == null || d[k] === '') err(where, `必須フィールド欠落: ${k}`);
    }
    if (d.id && !ID_RE.test(d.id)) err(where, `id 形式違反 "${d.id}" (規約 ${ID_RE})`);
    if (d.id && basename(e.path, '.md') !== d.id) err(where, `ファイル名 (${basename(e.path, '.md')}) と id (${d.id}) が不一致`);
    if (d.bounded_context && basename(dirname(e.path)) !== d.bounded_context) {
      err(where, `親フォルダ (${basename(dirname(e.path))}) と bounded_context (${d.bounded_context}) が不一致`);
    }
    for (const [k, allowed] of Object.entries(ENUMS)) {
      if (d[k] != null && !allowed.includes(d[k])) err(where, `${k} の値 "${d[k]}" は許可外 (${allowed.join('/')})`);
    }
    if (d.progress != null) {
      if (typeof d.progress !== 'object') err(where, 'progress はマップであること');
      else if (d.progress.state && !PROGRESS_STATES.includes(d.progress.state)) {
        err(where, `progress.state "${d.progress.state}" は許可外 (${PROGRESS_STATES.join('/')})`);
      }
    }
    if (d.last_verified != null && !DATE_RE.test(String(d.last_verified))) {
      err(where, `last_verified は YYYY-MM-DD 形式であること: "${d.last_verified}"`);
    }
    checkRefList(where, d.source_refs, 'source_refs');
    checkRefList(where, d.code_refs, 'code_refs');
    if (d.related != null) {
      if (!Array.isArray(d.related)) err(where, 'related はリストであること');
      else for (const rid of d.related) {
        if (!byId.has(rid)) err(where, `related の "${rid}" に対応する用語がありません(孤立リンク)`);
      }
    }
    // 鮮度ゲート(stable のみ)
    if (d.status === 'stable' && DATE_RE.test(String(d.last_verified))) {
      const age = daysBetween(d.last_verified, today);
      if (age > FRESH_DAYS) err(where, `鮮度切れ: last_verified が ${age} 日前 (上限 ${FRESH_DAYS} 日)。内容を再検証して last_verified を更新してください`);
    }
  }

  // @term: マーカー検証
  const codeFiles = scanCodeMarkers(ROOT);
  for (const f of codeFiles) {
    for (const me of f.errors) err(f.relPath, `@term マーカー(L${me.line}): ${me.message}`);
    for (const m of f.markers) {
      if (!byId.has(m.id)) err(f.relPath, `@term マーカー(L${m.startLine}): "${m.id}" に対応する用語がありません(孤立マーカー)`);
    }
  }
  // 逆向きの soft check: code_refs があるのにマーカーが無いファイル
  const markedPaths = new Set(codeFiles.flatMap((f) => f.markers.length ? [f.relPath] : []));
  for (const e of entries) {
    for (const ref of e.data.code_refs || []) {
      if (ref.path && !markedPaths.has(ref.path)) {
        warn(e.relPath, `code_refs ${ref.path} に @term: マーカーがありません(staleness が効かないため付与を推奨)`);
      }
    }
  }

  for (const w of warns) console.warn(w);
  if (errors.length) {
    for (const x of errors) console.error(x);
    console.error(`\n用語集 validate: ${errors.length} 件のエラー / ${warns.length} 件の警告(${entries.length} 用語を検査)`);
    process.exit(1);
  }
  console.log(`用語集 validate OK(${entries.length} 用語 / ${codeFiles.length} ファイルのマーカーを検査、警告 ${warns.length} 件)`);
}

main();
