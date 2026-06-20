/**
 * review-report.mjs — Worktree Review Report (REVIEW.md) 위치 + 검증 SSOT
 *
 * Why (R-CM-030 "한계 (정직 명시)" 갭 폐쇄):
 *   기존 Pre-Ship Human Review Panel 강제는 `pre-ship-review-guard` 가 **마커 존재만**
 *   검사한다 (룰 자체가 "AI 가 패널 없이 마커 생성 후 호출 시 우회 가능" 으로 명시).
 *   본 lib 는 "사람이 리뷰할 수 있는 본문이 실제로 출력되었는가" 를 **결정론적으로**
 *   검증하기 위한 단일 출처다. 검증 대상은 worktree-local `REVIEW.md` 파일(artifact).
 *
 * 왜 transcript 가 아니라 file 인가 (의도된 trade-off):
 *   - 결정론적이고 node:test 로 검증 가능 (transcript header 매칭은 CLI 간 취약).
 *   - PR 본문에 그대로 첨부 가능 → 사람이 GitHub 에서도 리뷰.
 *   - Claude Code / Codex 양쪽에서 동일 검증 (CLI uniform).
 *
 * 순수 lib (파일/네트워크/전역상태 0 — content 문자열만 입력). hook + helper CLI +
 * tests 가 import 하는 SSOT. hook 간 직접 import 금지(R-CM-006)이므로 본 lib 만 공유.
 *
 * 위치 컨벤션은 PLAN.md(`worktree-plan-path.mjs`)와 동형:
 *   `.tmp/worktree-<safeBranch>/REVIEW.md` (`.gitignore` 의 `.tmp/` 로 머지 누출 차단).
 *
 * Boundary (R-CM-028): 관점 1 (brief2dev 자체 / 본 transplant) 전용.
 */

import { basename, join } from 'node:path';
import { safeBranchKey, inferBranchFromWorktreePath } from './worktree-plan-path.mjs';

/**
 * 필수 9 섹션 — 사용자 열거 항목과 1:1 충실 매핑.
 *   작업내용 / 왜 / 무엇을(어떤 작업) / 어떻게 / 영향범위 / 트레이드오프 / 잔여작업 /
 *   폴더구조 / 리뷰요청 항목.
 * 각 섹션: key + 표준 heading + aliases (EN/JP — 프로젝트 bilingual 컨벤션).
 * aliases 는 heading 텍스트에 대해 case-insensitive 로 매칭한다 (ASCII 는 word-boundary,
 * CJK 는 substring — sectionRegex 참조).
 */
export const REQUIRED_SECTIONS = [
  { key: 'summary', title: 'Summary', aliases: ['summary', '概要', '作業内容', 'what was done'] },
  { key: 'why', title: 'Why', aliases: ['why', 'なぜ', '理由', '背景', 'motivation', 'rationale'] },
  { key: 'what', title: 'Changed Files', aliases: ['changed files', 'what', '変更ファイル', '変更内容', 'どんな作業'] },
  { key: 'how', title: 'How', aliases: ['how', '作業方法', 'どのように', 'approach', 'アプローチ', '手順'] },
  { key: 'impact', title: 'Impact', aliases: ['impact', '影響範囲', '影響'] },
  { key: 'tradeoffs', title: 'Trade-offs', aliases: ['trade-offs', 'tradeoffs', 'トレードオフ', 'decisions', '判断', '代替'] },
  { key: 'remaining', title: 'Remaining Work', aliases: ['remaining', '残作業', 'follow-up', 'followup', 'todo', 'risks', 'リスク', 'ロールバック', 'rollback'] },
  { key: 'structure', title: 'File Structure', aliases: ['file structure', 'フォルダー構造', 'ディレクトリ構造', '作業フォルダー', 'directory structure', 'folder structure'] },
  { key: 'review_requests', title: 'Review Requests', aliases: ['review requests', 'review request', 'レビュー依頼', 'レビューを求める', '確認依頼', '確認してほしい', 'request review'] },
];

/** REVIEW.md 본문에 박는 HEAD 앵커. helper 가 stamp, hook 이 현재 HEAD 와 대조 (staleness). */
export const HEAD_MARKER_RE = /<!--\s*bag-review:\s*head\s*=\s*([0-9a-fA-F]{7,40})\s*-->/;

/** 본문 채움 판정 시 placeholder(미작성 stub) 로 보는 라인. */
const PLACEHOLDER_RE = /^(?:todo|tbd|t\.b\.d\.?|n\/?a|fill(?:\s*in)?|\.\.\.|[-—–•*]|<.*>)$/i;

/**
 * worktree 안에서의 REVIEW.md 상대 경로 (worktree 루트 기준).
 * `.tmp/worktree-<safeBranch>/REVIEW.md`.
 */
export function reviewReportRelPath(branch) {
  return join('.tmp', `worktree-${safeBranchKey(branch)}`, 'REVIEW.md');
}

/**
 * worktree 절대 경로로부터 REVIEW.md 절대 경로를 반환. branch 미명시 시 path 에서 추론.
 */
export function resolveReviewReportPath(worktreePath, branch = null) {
  const inferred = branch || inferBranchFromWorktreePath(worktreePath) || basename(worktreePath);
  return join(worktreePath, reviewReportRelPath(inferred));
}

/**
 * 섹션 1개의 alias 들을 단일 정규식으로 컴파일.
 *   - ASCII alias → word-ish boundary (`how` 가 `shower` 류에 오매칭하지 않도록).
 *   - 비-ASCII(CJK) alias → plain substring (`\b` 가 CJK 에서 무의미).
 */
function sectionRegex(section) {
  const parts = section.aliases.map((a) => {
    const esc = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return /^[\x00-\x7F]+$/.test(a) ? `(?:^|[^a-z0-9])${esc}(?:[^a-z0-9]|$)` : esc;
  });
  return new RegExp(`(?:${parts.join('|')})`, 'i');
}

/**
 * markdown 을 heading 경계로 분해. 코드펜스(```) 내부의 `#` 는 heading 으로 보지 않는다.
 * @returns {Array<{heading: string, body: string}>}
 */
export function splitSections(content) {
  const lines = String(content || '').split('\n');
  const sections = [];
  let cur = null;
  let inCode = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      if (cur) cur.body.push(line);
      continue;
    }
    const h = !inCode && line.match(/^\s{0,3}#{1,6}\s+(.*\S)\s*$/);
    if (h) {
      cur = { heading: h[1], body: [] };
      sections.push(cur);
    } else if (cur) {
      cur.body.push(line);
    }
  }
  return sections.map((s) => ({ heading: s.heading, body: s.body.join('\n').trim() }));
}

/**
 * 섹션 본문이 "실제로 채워졌는가" 판정. HTML 주석 제거 후, 모든 content 라인이
 * placeholder(stub) 면 미작성으로 본다. trivial 변경은 본문을 짧게 써도 통과 — 단,
 * 헤더만 두고 본문 공란/placeholder 면 미작성.
 */
export function isFilled(body) {
  const stripped = String(body || '').replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!stripped) return false;
  const contentLines = stripped.split('\n').map((l) => l.trim()).filter(Boolean);
  return contentLines.some((l) => !PLACEHOLDER_RE.test(l));
}

/**
 * REVIEW.md 본문을 검증한다.
 *
 * @param {string|null} content - REVIEW.md 전체 텍스트 (파일 부재 시 null/'' 전달)
 * @param {{ headSha?: string|null }} [opts]
 * @returns {{
 *   ok: boolean,           // missing 0 + stale 아님 + present
 *   present: boolean,      // 본문 존재 여부
 *   missing: string[],     // 부재/공란 섹션 key 목록
 *   stale: boolean,        // HEAD stamp 부재/불일치 (headSha 제공 시에만 의미)
 *   stampSha: string|null  // 본문에서 추출한 HEAD stamp
 * }}
 */
export function validateReport(content, opts = {}) {
  const text = content == null ? '' : String(content);
  const present = text.trim().length > 0;
  const sections = splitSections(text);
  const missing = [];
  for (const req of REQUIRED_SECTIONS) {
    const re = sectionRegex(req);
    const matched = sections.find((s) => re.test(s.heading));
    if (!matched || !isFilled(matched.body)) missing.push(req.key);
  }

  const m = text.match(HEAD_MARKER_RE);
  const stampSha = m ? m[1].toLowerCase() : null;
  let stale = false;
  if (opts.headSha) {
    const head = String(opts.headSha).toLowerCase();
    // short sha vs full sha 모두 수용 — 한쪽이 다른 쪽의 prefix 이면 일치로 본다.
    stale = !stampSha || !(head.startsWith(stampSha) || stampSha.startsWith(head));
  }

  return { ok: present && missing.length === 0 && !stale, present, missing, stale, stampSha };
}

/**
 * REVIEW.md scaffold 템플릿 생성. helper CLI(`--scaffold`)와 hook 안내 메시지가 공유.
 * 9 섹션 헤더 + HEAD 앵커 + 작성 가이드 주석. AI 가 주석을 본문으로 치환.
 *
 * @param {{ branch?: string|null, headSha?: string|null }} [opts]
 */
export function renderTemplate(opts = {}) {
  const branch = opts.branch || '';
  const stamp = opts.headSha
    ? `<!-- bag-review: head=${opts.headSha} -->`
    : '<!-- bag-review: head=__run mark-worktree-reviewed to stamp__ -->';
  return [
    `# Worktree Review — ${branch}`,
    '',
    '> 人間がレビューするための作業レポート。各セクションの <!-- ガイド --> を実内容で置換。',
    `> stamp 行は \`node .claude/scripts/mark-worktree-reviewed.mjs ${branch || '<branch>'}\` が現在 HEAD で更新する。`,
    '',
    stamp,
    '',
    '## Summary / 概要 (作業内容)',
    '<!-- 何を変更したか + なぜ。3-5行で要点 -->',
    '',
    '## Why / なぜ (理由・背景)',
    '<!-- 動機: ユーザー要求 / バグ症状 / 既存ギャップ → 解決方向 -->',
    '',
    '## Changed Files / 変更ファイル (どんな作業)',
    '<!-- path | NEW/EDIT/DELETE | LOC | 役割 / 変更理由 -->',
    '',
    '## How / 作業方法 (どのように)',
    '<!-- アプローチ・手順・実行した検証コマンドと結果 -->',
    '',
    '## Impact / 影響範囲',
    '<!-- 影響するシステム領域: コード / ルール / hook / CI / ドキュメント / ユーザー workflow / 面除条件 -->',
    '',
    '## Trade-offs / トレードオフ (判断と代替案)',
    '<!-- 選択した設計、却下した代替とその理由。「なし」なら根拠を書く -->',
    '',
    '## Remaining Work / 残作業 (Follow-up・Risks・Rollback)',
    '<!-- 未対応 / deferred / リスク・懸念 / ロールバック手段 -->',
    '',
    '## File Structure / フォルダー構造',
    '<!-- 変更ファイルのディレクトリツリーと責務境界。新規/移動/削除の位置根拠 -->',
    '',
    '## Review Requests / レビュー依頼 (確認してほしい項目)',
    '<!-- 人間に判断・確認してほしい具体ポイントを箇条書き -->',
    '',
  ].join('\n');
}
