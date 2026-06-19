/**
 * heredoc-strip.mjs - Bash heredoc body 제거 helper (lib SSOT)
 *
 * Bash heredoc body 안 텍스트는 *데이터* 이지 *호출 컨텍스트* 가 아니다.
 * Hook 들이 명령 string 검사 시 heredoc body 안의 trigger string 까지
 * false-positive 차단하는 문제를 root cause 차단.
 *
 * 처리 변형:
 *   `<<EOF`         — 기본
 *   `<<-EOF`        — tab strip 변형
 *   `<<'EOF'`       — single-quoted (변수 확장 X)
 *   `<<"EOF"`       — double-quoted
 *   복수 heredoc    — global flag 로 순차 제거
 *
 * 비처리 (R-CM-029 Rule 4 Surgical):
 *   - quoted string 안 trigger (`echo "ship-worktree"`) — anchor (hook-anchors.mjs CMD_ANCHOR_SRC) 로 차단
 *   - shell comment (`# ship-worktree`) — 별도 PR 후보
 *
 * 사용 hook: pre-ship-review-guard (line 58), destructive-git-guard (checkDestructiveGit).
 * cross-hook circular execution 회피 — pre-ship-review-guard 의 top-level main 가드가
 * standalone 실행 시 트리거되어 직접 import 시 stdout 충돌 발생. 본 lib 으로 분리.
 */

const HEREDOC_PATTERN =
  /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2(?=\r?\n|$)/g;

/**
 * 명령에서 heredoc body 를 모두 제거하여 inspection-safe string 반환.
 *
 * @param {string} command - Bash 명령
 * @returns {string} heredoc body 제거된 명령 (string 외 입력은 그대로 반환)
 */
export function stripHeredocBodies(command) {
  if (typeof command !== 'string') return command;
  // Fast-path — heredoc opener `<<` 부재 시 regex 진입 회피. PreToolUse Bash hook 의
  // 95%+ 케이스 (단순 git/ls/npm) 가 heredoc 없음. .includes scan 이 regex 의
  // [\s\S]*? backtracking 비용보다 훨씬 저렴.
  if (!command.includes('<<')) return command;
  return command.replace(HEREDOC_PATTERN, '');
}
