#!/usr/bin/env node

/**
 * codex/trunk-session-warn.mjs — Codex CLI SessionStart 어댑터
 *
 * 본체 .claude/hooks/trunk-start-warning.mjs 의 run(data) 를 위임.
 * main 브랜치 + ALLOW_MAIN_SESSION!=1 시 worktree 사용 안내를 additionalContext 로 주입.
 *
 * 등록 위치: .codex/hooks.json#hooks.SessionStart (matcher `startup|resume`).
 * 명명: brief2dev R-CM-022 의 -warn suffix 는 금지이지만 본 파일은 exporter README 의
 *       'trunk-session-warn' 카논 명을 따른다 (R-CM-022 적용 범위는 .claude/hooks/*.mjs single-level).
 */

import { run as runTrunkWarning } from '../trunk-start-warning.mjs';
import { runAdapter } from '../../scripts/lib/cli-adapter-utils.mjs';

runAdapter(runTrunkWarning, { cli: 'codex', eventName: 'SessionStart' });
