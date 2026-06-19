/**
 * claude-agents-integrity.mjs — CLAUDE.md ↔ AGENTS.md 상호 순환 @import 검출.
 *
 * PR #531 마이그레이션이 4개 하위 dir 의 CLAUDE.md/AGENTS.md 를 상호 순환 포인터
 * (CLAUDE.md=`@AGENTS.md` + AGENTS.md=`@CLAUDE.md`, 콘텐츠 0) 로 만들어 디렉토리
 * 로컬 거버넌스 콘텐츠를 silently 유실시킨 손상 클래스의 재발을 차단한다.
 *
 * 올바른 패턴 (루트): CLAUDE.md=`@AGENTS.md` (포인터) + AGENTS.md=실제 콘텐츠.
 * 순환 (버그): 양쪽 모두 서로를 가리키는 pure pointer → @import 가 빈 콘텐츠로 해석.
 *
 * ecosystem-health-guard E19 가 import 하여 Stop 시점 검출. 순수 함수 (테스트 용이) —
 * filesystem read 외 부수효과 없음. hook auto-run 회피 위해 hook 본문이 아닌 lib 로 분리
 * (.claude/hooks/AGENTS.md "lib 추출" 안티패턴 정합).
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// brief2dev 자체 소유 디렉토리만 (oss/ 서드파티 · output/ 생성물 제외).
export const CLAUDE_AGENTS_DIRS = [
  '.',
  '.claude/hooks',
  '.claude/scripts',
  '.claude/skills',
  'data/rules-as-code',
];

// 단일 라인 pure @import 포인터 (예: `@AGENTS.md`). 멀티라인/주석 동반 시 미매치 (= 콘텐츠 보유).
const PURE_IMPORT_RE = /^@([\w./-]+\.md)$/;

/** 파일이 순수 @import 포인터면 대상 파일명 반환, 아니면 null (부재/읽기실패/콘텐츠 보유 포함). */
function pureImportTarget(filePath) {
  if (!existsSync(filePath)) return null;
  let content;
  try {
    content = readFileSync(filePath, 'utf-8').trim();
  } catch {
    return null;
  }
  const m = content.match(PURE_IMPORT_RE);
  return m ? m[1] : null;
}

/**
 * 주어진 projectDir 의 CLAUDE.md ↔ AGENTS.md 상호 순환 쌍을 검출한다.
 *
 * @param {string} projectDir - 스캔 기준 루트
 * @param {string[]} [dirs=CLAUDE_AGENTS_DIRS] - 스캔 대상 상대 디렉토리
 * @returns {Array<{id:string,severity:string,dir:string,message:string,fix:string}>}
 */
export function detectCircularClaudeAgentsImports(projectDir, dirs = CLAUDE_AGENTS_DIRS) {
  const violations = [];
  for (const dir of dirs) {
    const claudeTarget = pureImportTarget(join(projectDir, dir, 'CLAUDE.md'));
    const agentsTarget = pureImportTarget(join(projectDir, dir, 'AGENTS.md'));
    // 둘 다 순수 포인터이고 서로를 가리키면 순환 (콘텐츠 0).
    if (claudeTarget === 'AGENTS.md' && agentsTarget === 'CLAUDE.md') {
      violations.push({
        id: 'E19',
        severity: 'MAJOR',
        dir,
        message: `[CLAUDE.md 순환] ${dir}/CLAUDE.md ↔ AGENTS.md 가 서로만 @import (콘텐츠 0) — 디렉토리 거버넌스가 AI 컨텍스트에서 silently 누락`,
        fix: `${dir}/AGENTS.md 에 실제 콘텐츠 복원 + ${dir}/CLAUDE.md 는 @AGENTS.md 포인터 유지 (루트 패턴). 원문은 git history 복원 (#531 손상 클래스)`,
      });
    }
  }
  return violations;
}
