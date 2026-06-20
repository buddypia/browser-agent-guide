/**
 * apply-patch-paths.mjs — Codex `apply_patch` 대상 파일 경로 추출 (순수 lib SSOT)
 *
 * Codex CLI 는 파일 편집 시 항상 `tool_name: "apply_patch"` 를 보내며, 패치 본문은
 * `tool_input.command` 문자열에 담긴다 (codex 공식 spec: "Bash and apply_patch use
 * tool_input.command" — https://developers.openai.com/codex/hooks). 본 lib 는 그 패치
 * 문자열에서 대상 파일 경로를 추출한다.
 *
 * worktree-policy-guard (main 직접 편집 차단) 와 worktree-session-owner-guard
 * (cross-worktree 편집 차단) 가 공유한다. R-CM-037 Rule 5 (hook 간 직접 import 금지,
 * 순수 lib SSOT) 정합 — 두 hook 이 본 lib 를 import 한다.
 *
 * 레퍼런스: trip-jarvis `.agents/hooks/lib/worktree-policy-core.mjs#extractApplyPatchFilePaths`
 * (운영 검증된 구현). apply_patch heredoc 의 `*** Add|Update|Delete File:` / `*** Move to:`
 * 라인 파싱 + invocation fallback.
 *
 * Used by local worktree guard hooks.
 */

import { isAbsolute, join } from 'path';

/**
 * apply_patch command 문자열에서 대상 파일 abs 경로 배열 추출.
 *
 * @param {string} command - apply_patch 패치 본문 (tool_input.command)
 * @param {string} [baseDir] - 상대 경로 정규화 기준 (절대 경로면 그대로)
 * @returns {string[]} 중복 제거된 abs 경로 배열 (입력 부적합 시 빈 배열)
 */
export function extractApplyPatchFilePaths(command, baseDir = '') {
  if (typeof command !== 'string' || !command.trim()) return [];

  const paths = [];
  const addPath = (raw) => {
    if (!raw || typeof raw !== 'string') return;
    const p = raw.trim();
    if (!p) return;
    paths.push(isAbsolute(p) ? p : (baseDir ? join(baseDir, p) : p));
  };

  // CRLF 안전: split('\n') 후 잔여 \r 제거. JS 정규식 `.` 는 \r 을 매칭하지 않으므로
  // \r 제거 없이는 CRLF 패치 라인의 `(.+)$` 가 통째로 fail → 경로 0건 → 가드 우회 (CRITICAL).
  for (const rawLine of command.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const hunk = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
    if (hunk) {
      addPath(hunk[1]);
      continue;
    }
    const move = line.match(/^\*\*\* Move to: (.+)$/);
    if (move) addPath(move[1]);
  }

  // invocation fallback 제거 (HIGH 오탐 차단): `(?:apply_patch|patch)\s+...` 정규식은
  // 패치 본문 diff 라인의 'patch' 키워드에서 오탐 경로를 추출 → policy-guard false deny.
  // codex apply_patch 는 항상 heredoc (`*** ... File:` 마커) 형식이므로 File 라인 0건이면
  // fail-open (빈 배열 → passthrough, R-CM-006 Rule 2) 이 footgun fallback 보다 안전.

  return [...new Set(paths)];
}
