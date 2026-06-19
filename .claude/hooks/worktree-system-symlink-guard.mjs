#!/usr/bin/env node
/**
 * worktree-system-symlink-guard.mjs — SessionStart hook (R-CM-030 system_persistent 공유)
 *
 * 목적: worktree 안에서 세션 시작 시 `.brief2dev/system/` 이 main worktree 와
 *       공유되는 정상 symlink 인지 확인. 부재/깨짐/충돌 발견 시 AI 에게 명시
 *       복구 명령을 전달한다.
 *
 * 행동 정책 (R-CM-031 Consequential — 자동 생성 X):
 *   - 자동 생성/수정/삭제 어떤 것도 수행하지 않음. 검출 + 안내만.
 *   - 사용자/AI 가 명령을 직접 실행하여 의도를 표명하도록 유도.
 *   - main worktree 안에서는 SKIP (symlink 불필요 — 본체가 진실).
 *
 * Fail-open (R-CM-006 Rule 2):
 *   - git 외부 / lstat 실패 / 모든 예외 → silent passthrough.
 *   - 본 hook 의 fail 이 세션 시작을 막아서는 안 된다.
 *
 * SessionStart 시맨틱:
 *   - stdout 으로 출력하면 `<system-reminder>` 컨텍스트로 주입됨.
 *   - decision 키는 무시되므로 (R-CM-006 Rule 1) 단순 정보 주입.
 */

import { lstatSync, readlinkSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { safeHookMainWithProfile } from '../scripts/lib/utils.mjs';

/**
 * git common-dir 의 부모 = main worktree 루트.
 * 실패 시 null (호출자가 silent SKIP).
 */
function resolveMainWorktreeRoot(cwd) {
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!commonDir) return null;
    return dirname(resolve(cwd, commonDir));
  } catch {
    return null;
  }
}

/**
 * symlink 상태 분류. throw 하지 않는다.
 *   absent / correct_symlink / wrong_symlink / dir / file / unknown
 */
function classifyLocalSystem(localSystemPath, mainSystemDir) {
  let st;
  try {
    st = lstatSync(localSystemPath);
  } catch {
    return { status: 'absent' };
  }
  if (st.isSymbolicLink()) {
    try {
      const target = readlinkSync(localSystemPath);
      const resolved = resolve(dirname(localSystemPath), target);
      if (resolved === mainSystemDir) return { status: 'correct_symlink', target };
      // symlink 가 살아있지만 깨졌는지 검사 — target 디렉토리가 부재이면 broken.
      let broken = false;
      try {
        statSync(localSystemPath); // follow symlink
      } catch {
        broken = true;
      }
      return { status: broken ? 'broken_symlink' : 'wrong_symlink', target, resolved };
    } catch {
      return { status: 'broken_symlink' };
    }
  }
  if (st.isDirectory()) return { status: 'dir' };
  return { status: 'file' };
}

async function main() {
  const cwd = process.cwd();
  const mainRoot = resolveMainWorktreeRoot(cwd);
  if (!mainRoot) {
    // git 외부 또는 git 호출 실패 — silent passthrough (fail-open).
    return;
  }

  if (mainRoot === cwd) {
    // main worktree 자체 — 본 hook 대상 아님. SKIP.
    return;
  }

  // @layout-resolver-allow — 본 guard 는 symlink 의 부재/깨짐을 검출하는 책임.
  // resolveSystemPersistentRoot 는 symlink 정상 시 main path 를 반환하므로 본
  // hook 의 검출 의도를 우회. hardcode 가 의도적.
  const localSystemPath = join(cwd, '.brief2dev', 'system'); // @layout-resolver-allow
  const mainSystemDir = join(mainRoot, '.brief2dev', 'system'); // @layout-resolver-allow
  const relSystem = relative(cwd, localSystemPath);
  const cls = classifyLocalSystem(localSystemPath, mainSystemDir);

  // 정상 케이스 → silent (세션 시작 알림 최소화).
  if (cls.status === 'correct_symlink') return;

  // 그 외는 모두 AI 에게 안내 — 다음 액션이 명확하도록 구체 명령 포함.
  const lines = ['<worktree-system-symlink-guard>'];
  lines.push(`worktree: ${cwd}`);
  lines.push(`main worktree (system SSOT): ${mainRoot}`);
  lines.push(`상태: ${cls.status}`);

  switch (cls.status) {
    case 'absent':
      lines.push('');
      lines.push(`현재 worktree 에 \`${relSystem}\` symlink 가 없습니다.`);
      lines.push('R-CM-030 에 따라 모든 worktree 는 main 의 system/ 을 공유해야 합니다.');
      lines.push('');
      lines.push('복구 (사용자 컨펌 후 — R-CM-031 Consequential):');
      lines.push('  node .claude/scripts/worktree-init.mjs');
      break;

    case 'broken_symlink':
      lines.push('');
      lines.push(`\`${relSystem}\` 가 깨진 symlink 입니다 (target=${cls.target || '?'}).`);
      lines.push('main worktree 가 이동/삭제됐거나 symlink target 이 잘못됐을 수 있습니다.');
      lines.push('');
      lines.push('복구:');
      lines.push(`  rm '${localSystemPath}' && node .claude/scripts/worktree-init.mjs`);
      break;

    case 'wrong_symlink':
      lines.push('');
      lines.push(`\`${relSystem}\` 가 의도한 target 과 다른 곳을 가리킵니다.`);
      lines.push(`  현재 target  : ${cls.target} (= ${cls.resolved})`);
      lines.push(`  필요한 target: ${mainSystemDir}`);
      lines.push('');
      lines.push('의도된 link 가 맞다면 SKIP. 아니면 (사용자 컨펌 후) :');
      lines.push(`  rm '${localSystemPath}' && node .claude/scripts/worktree-init.mjs`);
      break;

    case 'dir':
      lines.push('');
      lines.push(`\`${relSystem}\` 가 symlink 가 아닌 실제 디렉토리 입니다.`);
      lines.push('worktree 별로 system/ 이 분기된 상태 — cross-worktree 학습/SSOT 가 깨집니다.');
      lines.push('');
      lines.push('판단 후 (사용자 컨펌 필수 — 데이터 lifecycle 영향):');
      lines.push('  비어 있다면        : node .claude/scripts/worktree-init.mjs  (자동 변환)');
      lines.push('  내용을 보존하려면  : 먼저 main 으로 병합 (수동 비교) → rm -rf 후 init');
      lines.push(`  현재 상태 점검     : ls -la '${localSystemPath}'`);
      break;

    case 'file':
      lines.push('');
      lines.push(`\`${relSystem}\` 가 파일 입니다 (디렉토리/symlink 예상).`);
      lines.push('비정상 상태 — 수동 정리 후 init 호출.');
      lines.push('');
      lines.push('복구:');
      lines.push(`  rm '${localSystemPath}' && node .claude/scripts/worktree-init.mjs`);
      break;

    default:
      return; // unknown — silent
  }

  lines.push('</worktree-system-symlink-guard>');
  process.stdout.write(lines.join('\n') + '\n');
}

safeHookMainWithProfile('worktree-system-symlink-guard', main);
