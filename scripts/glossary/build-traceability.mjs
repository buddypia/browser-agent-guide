#!/usr/bin/env node
// 用語 ⇄ コード/仕様 の双方向トレーサビリティ表(RTM)を生成する。依存ゼロ。
//   - 出力: glossary/TRACEABILITY.md(派生ビュー。正典は各エントリ + コードのマーカー)
//   - --check: 生成結果が既存ファイルと一致しなければ exit 1(任意。既定の gate には入れない)
// これは「可視化」であってゲートではない(陳腐化の二重管理を避けるため、鮮度強制はしない)。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEntries, indexById } from './lib/entries.mjs';
import { scanCodeMarkers } from './lib/code.mjs';

const ROOT = process.cwd();
const OUT = join(ROOT, 'glossary', 'TRACEABILITY.md');

function refList(list, render) {
  if (!Array.isArray(list) || !list.length) return '—';
  return list.map(render).join('<br>');
}

function build() {
  const entries = loadEntries(ROOT);
  const byId = indexById(entries);

  // 逆引き: term id -> [{relPath, startLine, endLine}]
  const reverse = new Map();
  const orphanMarkers = [];
  for (const f of scanCodeMarkers(ROOT)) {
    for (const m of f.markers) {
      if (!byId.has(m.id)) orphanMarkers.push({ id: m.id, relPath: f.relPath, line: m.startLine });
      if (!reverse.has(m.id)) reverse.set(m.id, []);
      reverse.get(m.id).push({ relPath: f.relPath, startLine: m.startLine, endLine: m.endLine });
    }
  }

  const lines = [];
  lines.push('# トレーサビリティ表 (Requirements Traceability Matrix)');
  lines.push('');
  lines.push('> このファイルは `scripts/glossary/build-traceability.mjs` が生成する **派生ビュー** です。');
  lines.push('> 手で編集しないでください。正典は各用語エントリ(frontmatter)とコード中の `@term:` マーカーです。');
  lines.push('> 再生成: `npm run glossary:trace`');
  lines.push('');
  lines.push(`生成対象: ${entries.length} 用語`);
  lines.push('');

  for (const e of [...entries].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const d = e.data;
    lines.push(`## \`${d.id}\` — ${d.term || ''}`);
    lines.push('');
    lines.push(`- **status**: ${d.status} / **owner**: ${d.owner} / **last_verified**: ${d.last_verified} / **confidence**: ${d.confidence}`);
    if (d.progress) lines.push(`- **progress**: ${d.progress.state || '—'}${d.progress.tracking ? ` (${d.progress.tracking})` : ''}`);
    lines.push(`- **entry**: \`${e.relPath}\``);
    lines.push('');
    lines.push('| 種別 | 参照 |');
    lines.push('|---|---|');
    lines.push(`| 仕様 source_refs | ${refList(d.source_refs, (r) => `\`${r.path}\`${r.anchor ? `#${r.anchor}` : ''}`)} |`);
    lines.push(`| 実装 code_refs | ${refList(d.code_refs, (r) => `\`${r.path}\`${r.symbol ? ` (${r.symbol})` : ''}`)} |`);
    lines.push(`| API api_refs | ${refList(d.api_refs, (r) => `${r.name || ''}${r.spec ? ` \`${r.spec}\`` : ''}`)} |`);
    lines.push(`| DB db_refs | ${refList(d.db_refs, (r) => `${r.name || ''}${r.source ? ` \`${r.source}\`` : ''}`)} |`);
    const rev = reverse.get(d.id) || [];
    const revStr = rev.length ? rev.map((r) => `\`${r.relPath}\` L${r.startLine}-${r.endLine}`).join('<br>') : '— (マーカー未設置)';
    lines.push(`| 逆引き @term: マーカー | ${revStr} |`);
    lines.push(`| 関連 related | ${Array.isArray(d.related) && d.related.length ? d.related.map((x) => `\`${x}\``).join(', ') : '—'} |`);
    lines.push('');
  }

  if (orphanMarkers.length) {
    lines.push('## ⚠ 孤立マーカー(対応する用語が無い @term:)');
    lines.push('');
    for (const o of orphanMarkers) lines.push(`- \`${o.relPath}\` L${o.line}: @term: ${o.id}`);
    lines.push('');
  }

  return { text: lines.join('\n') + '\n', orphanMarkers };
}

function main() {
  const check = process.argv.includes('--check');
  const { text, orphanMarkers } = build();
  if (check) {
    const cur = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (cur !== text) {
      console.error('✗ glossary/TRACEABILITY.md が最新ではありません。`npm run glossary:trace` で再生成してください。');
      process.exit(1);
    }
    console.log('glossary/TRACEABILITY.md は最新です。');
    return;
  }
  writeFileSync(OUT, text);
  console.log(`✓ glossary/TRACEABILITY.md を生成しました(孤立マーカー ${orphanMarkers.length} 件)。`);
}

main();
