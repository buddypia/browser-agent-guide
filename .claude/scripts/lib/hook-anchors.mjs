/**
 * hook-anchors.mjs - Hook 정규식 anchor SSOT
 *
 * PreToolUse Bash hook 들이 명령 시작 (`^`) 또는 chain operator (`;` `&&` `||` `|`)
 * 또는 newline (shell 명령 분리자) 직후만 매칭하기 위한 공통 anchor.
 *
 * 단순 word boundary `\b` 는 진단 코드 / quoted string / heredoc body / grep / echo
 * 안의 trigger string 까지 false-positive 매칭 (PR #493 root cause F1-F5).
 *
 * 본 lib 으로 5 hook (commit-guard / destructive-git-guard / dev-server-guard /
 * pre-ship-review-guard / worktree-policy-guard) 의 anchor inline 18+ 곳을 단일
 * SSOT 로 통합. silent diverge 위험 차단 — 한 hook 의 anchor 만 바뀌어도 다른
 * hook 이 stale 한 cluster 재발 경로 차단.
 */

/**
 * 명령 시작 / chain operator / newline / command substitution 직후만 매칭하는 anchor.
 *
 * 경계 종류:
 *   - `^`            명령 시작
 *   - `[;&|\n]\s*`   chain operator (`;` `&&` `||` `|`) / newline
 *   - `\$\(\s*`      command substitution `$(...)` — inner 명령은 shell 이 실제 실행 (DEBT-79)
 *   - `` `\s* ``     legacy backtick substitution — 동일하게 실제 실행
 *
 * subshell/backtick 안의 git 명령은 `echo` 의 *리터럴 인자* (실행 안 됨) 와 달리 shell 이
 * 실제 실행하므로 destructive/commit/ship trigger 검사 대상이다 (예: `echo $(git stash clear)`
 * 는 stash clear 가 실제 실행됨). heredoc body (데이터) 는 stripHeredocBodies 가 별도 제거하므로
 * 본 anchor 와 직교. commit -m 본문 안 `$(...)` 는 stripCommitMessageBody 가 먼저 제거.
 *
 * Note: `\\n` JS string literal → RegExp 생성 시 `\n` regex metachar (실제 newline) 해석.
 * 향후 수정자가 `\\n` → `\n` (single backslash) 으로 실수 변경 시 regex 는 literal
 * `\` + `n` 두 문자로 해석되어 newline 매칭 깨짐. JS string escape level 보존 의무.
 */
export const CMD_ANCHOR_SRC = '(?:^|[;&|\\n]\\s*|\\$\\(\\s*|`\\s*)';

/**
 * pattern source 앞에 anchor 를 prepend 하여 RegExp 생성.
 *
 * 사용 예:
 *   anchoredPattern('git\\s+commit\\b', 'i')
 *   → /(?:^|[;&|\n]\s*)git\s+commit\b/i
 *
 * @param {string} patternSrc - anchor 뒤에 붙일 정규식 source (string, RegExp 아님)
 * @param {string} [flags=''] - RegExp flags (i/g 등)
 * @returns {RegExp}
 */
export function anchoredPattern(patternSrc, flags = '') {
  return new RegExp(CMD_ANCHOR_SRC + patternSrc, flags);
}
