/**
 * review-report.mjs — Worktree Review Report (REVIEW.md) 위치 + 검증 SSOT
 *
 * Why (R-CM-030 "한계 (정직 명시)" 갭 폐쇄):
 *   기존 Pre-Ship Human Review Panel 강제는 `pre-ship-review-guard` 가 **마커 존재만**
 *   검사한다 (룰 자체가 "AI 가 패널 없이 마커 생성 후 호출 시 우회 가능" 으로 명시).
 *   본 lib 는 "사람이 merge/cleanup 승인 여부를 판단할 수 있는 승인依頼レビュー 본문이
 *   실제로 출력되었는가" 를 **결정론적으로** 검증하기 위한 단일 출처다. 검증 대상은
 *   worktree-local `REVIEW.md` 파일(artifact).
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
 * 필수 11 섹션 — worktree 終了時の「承認依頼レビュー」テンプレートと 1:1 に対応.
 *   承認依頼 / 状態サマリー / コミット情報 / PR Draft / 修正ファイル / 変更内容 /
 *   なぜ修正したか / トレードオフ / リスク・Rollback / 残タスク / セッション改善.
 * 각 섹션: key + 표준 heading + aliases (EN/JP — 프로젝트 bilingual 컨벤션).
 * aliases 는 heading 텍스트에 대해 case-insensitive 로 매칭한다 (ASCII 는 word-boundary,
 * CJK 는 substring — sectionRegex 참조).
 */
export const REQUIRED_SECTIONS = [
  { key: 'approval_request', title: '承認依頼', aliases: ['approval request', '承認依頼', 'レビュー内容', '承認してください'] },
  { key: 'state_summary', title: '状態サマリー', aliases: ['state summary', '状態サマリー', 'status summary', 'worktree status'] },
  { key: 'commits', title: 'Worktree のコミット情報', aliases: ['commits', 'commit information', 'コミット情報', 'git log'] },
  { key: 'pr_draft', title: 'PR Draft', aliases: ['pr draft', 'draft pr', 'PR Draft', 'PR URL', 'merge status'] },
  { key: 'changed_files_tree', title: '修正 / 追加したファイル', aliases: ['changed files tree', '修正 / 追加したファイル', '修正したファイル', '追加したファイル', '変更ファイル'] },
  { key: 'change_table', title: '変更内容', aliases: ['change table', '変更内容', 'changed files', '種別', '変更理由'] },
  { key: 'rationale', title: 'なぜ修正したか', aliases: ['rationale', 'why', 'なぜ修正したか', '背景', '解決した問題', '採用した方針'] },
  { key: 'tradeoffs', title: 'トレードオフ', aliases: ['trade-offs', 'tradeoffs', 'トレードオフ', '代替案', '犠牲にした点'] },
  { key: 'risks_rollback', title: 'リスク / Rollback', aliases: ['risks', 'rollback', 'リスク', 'ロールバック', '未検証事項'] },
  { key: 'session_remaining', title: 'セッション内の残タスク', aliases: ['remaining session tasks', '残タスク', 'セッション内の残タスク', '次に必要な作業'] },
  { key: 'session_issues', title: 'セッション内の問題点や改善点', aliases: ['session issues', '改善点', '問題点', '次回の注意', 'セッション内の問題点'] },
];

/** REVIEW.md 본문에 박는 HEAD 앵커. helper 가 stamp, hook 이 현재 HEAD 와 대조 (staleness). */
export const HEAD_MARKER_RE = /<!--\s*bag-review:\s*head\s*=\s*([0-9a-fA-F]{7,40})\s*-->/;

/** 본문 채움 판정 시 placeholder(미작성 stub) 로 보는 라인. */
const PLACEHOLDER_RE = /^(?:todo|tbd|t\.b\.d\.?|n\/?a|fill(?:\s*in)?|\.\.\.|[-—–•*]|<.*>)$/i;
const EMPTY_FIELD_RE = /^[-*]\s+[^:：]+[:：]\s*$/;
const TABLE_RULE_RE = /^[\s┃━|+\-:]+$/;
const TABLE_HEADER_RE = /^\|\s*Path\s*\|/i;
const TABLE_TEMPLATE_ROW_RE = /^\|\s*\|\s*NEW\/EDIT\/DELETE\s*\|\s*\|\s*\|\s*$/i;

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
  return contentLines.some(
    (l) =>
      !PLACEHOLDER_RE.test(l) &&
      !EMPTY_FIELD_RE.test(l) &&
      !TABLE_RULE_RE.test(l) &&
      !TABLE_HEADER_RE.test(l) &&
      !TABLE_TEMPLATE_ROW_RE.test(l),
  );
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
    const matches = sections.filter((s) => re.test(s.heading));
    const matched = matches.find((s) => isFilled(s.body));
    if (!matched) missing.push(req.key);
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
 * 11 섹션 헤더 + HEAD 앵커 + 작성 가이드 주석. AI 가 주석/빈 필드를 본문으로 치환.
 *
 * @param {{ branch?: string|null, headSha?: string|null }} [opts]
 */
export function renderTemplate(opts = {}) {
  const branch = opts.branch || '';
  const stamp = opts.headSha
    ? `<!-- bag-review: head=${opts.headSha} -->`
    : '<!-- bag-review: head=__run mark-worktree-reviewed to stamp__ -->';
  return [
    `# Worktree 承認依頼レビュー — ${branch}`,
    '',
    '> 人間が merge / cleanup 承認を判断するためのレビュー。各セクションの <!-- ガイド --> と空フィールドを実内容で置換。',
    `> stamp 行は \`node .claude/scripts/mark-worktree-reviewed.mjs ${branch || '<branch>'}\` が現在 HEAD で更新する。`,
    '',
    stamp,
    '',
    '## 1. 承認依頼',
    '以下の worktree 作業は完了状態です。',
    '内容を確認し、merge / cleanup に進めてよいか承認してください。',
    '選択してください:',
    '- 承認して進める',
    '- 修正が必要',
    '- 停止する',
    '',
    '## 2. 状態サマリー',
    '- Worktree path:',
    '- Branch:',
    '- Base branch:',
    '- PLAN.md:',
    '- PLAN.md checklist:',
    '- Worktree status:',
    '- Quality Gate:',
    '- Test / verify:',
    '- Draft PR:',
    '',
    '## 3. Worktree のコミット情報',
    '```text',
    '<git log --oneline origin/main..HEAD>',
    '```',
    '- Commit count:',
    '- Commit range:',
    '- Latest commit:',
    '',
    '## 4. PR Draft',
    '- PR URL:',
    '- PR status: Draft / Open',
    '- Merge status:',
    '- CI status:',
    '',
    '## 5. 修正 / 追加したファイル',
    '```text',
    '<変更ファイルのツリー構造>',
    '```',
    '',
    '## 6. 変更内容',
    '| Path | 種別 | 役割 | 変更理由 |',
    '| --- | --- | --- | --- |',
    '|  | NEW/EDIT/DELETE |  |  |',
    '',
    '## 7. なぜ修正したか',
    '- 背景:',
    '- 解決した問題:',
    '- 採用した方針:',
    '- ユーザー要求との対応:',
    '',
    '## 8. トレードオフ',
    '- 採用案:',
    '- 代替案:',
    '- 採用理由:',
    '- 犠牲にした点:',
    '- 将来見直す条件:',
    '',
    '## 9. リスク / Rollback',
    '- 影響範囲:',
    '- 既知リスク:',
    '- 未検証事項:',
    '- Rollback 方法:',
    '',
    '## 10. セッション内の残タスク',
    '- なし / あり:',
    '- 次に必要な作業:',
    '',
    '## 11. セッション内の問題点や改善点',
    '- 問題点:',
    '- 改善案:',
    '- 次回の注意:',
    '',
    '---',
    '',
    '### 承認後の Cleanup 手順 / Post-approval cleanup',
    '> 「進行」承認 + ship 完了後にこの順で後始末する（参考・固定手順）。',
    '1. `gh pr merge --squash` で PR を merge。**worktree からは `--delete-branch` を付けない** —— main が別 worktree で使用中だとマージ後のローカル checkout が "failed to run git" で失敗し（exit 0 でもリモートは未削除・マージ自体は成功）、AI がマージ失敗と誤認しうる。リモートブランチ削除は次の cleanup が行う。',
    '2. `agent-worktree-guard cleanup --confirmed` を実行 — 次を一括で片付ける:',
    '   - [ ] ローカル worktree 削除（`git worktree remove`）',
    '   - [ ] ローカルブランチ削除（`git branch -D`、`main`/`master` は除外）',
    '   - [ ] リモートブランチ削除（`git push origin --delete`、既に消えていれば skip）',
    '   - [ ] branch-local stash drop（他ブランチの stash は触らない）',
    '3. 完了報告（`# PR 承認後の完了報告`）の「Cleanup 状況」で local/remote/worktree/stash の結果を確認。',
    '',
  ].join('\n');
}
