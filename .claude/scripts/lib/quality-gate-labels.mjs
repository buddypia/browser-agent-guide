/**
 * quality-gate-labels.mjs — Quality Gate label enum 단일 SSOT
 *
 * R-CM-030 Rule 8 (Pre-Ship Quality Gate) 환경 분기 + 자가 점검 fallback 의
 * marker JSON `quality_gate` 필드 enum. mark-pre-ship-confirmed.mjs (CLI 발행자)
 * 와 pre-ship-review-guard.mjs (hook 검증자) 양쪽이 import 하여 사용한다.
 *
 * 라벨 의미:
 * - `agent_go`         : `/code-review --fix` (Claude Code, simplification + correctness 통합) + code-reviewer agent 둘 다 Go (정상 경로). 2026-05-27 사용자 결정으로 `/simplify` 완전 폐기 + `simplifit` 스킬 deprecate 후 `/code-review` 단일 진입점
 * - `self_review_pass` : agent 호출 실패/skip 시 자가 점검 통과 (Panel Decisions 사유 명시)
 * - `trivial_skip`     : R-CM-030 Rule 10 trivial 면제 (≤2 파일 + ≤20 LOC + non-substantive)
 *
 * 새 라벨 추가 시 본 파일만 갱신하면 발행자 / 검증자 동시 반영 — mismatch 회귀 차단.
 */
export const VALID_QUALITY_LABELS = new Set(['agent_go', 'self_review_pass', 'trivial_skip']);
