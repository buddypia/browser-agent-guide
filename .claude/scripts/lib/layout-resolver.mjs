/**
 * layout-resolver.mjs — R-CM-026 brief2dev .brief2dev/ Layout Resolver (단일 SSOT 헬퍼)
 *
 * data/registry/brief2dev-layout.json 의 카테고리를 결정적 경로로 해결한다.
 * 모든 hook/script 는 .brief2dev/ 직접 하드코딩 대신 이 모듈의 헬퍼를 사용해야 한다.
 *
 * 역할:
 *   - system 카테고리 (registry.json, learnings.jsonl, ...) 경로 결정
 *   - run 카테고리 (active-run state) 경로 결정
 *   - system/session-history 디렉토리 경로 결정
 *   - run-scoped 카테고리 (stage-output, handoff, reports, references) 디렉토리 결정
 *   - active run_id 조회 (.brief2dev/run/active.json 우선)
 *
 * 설계 원칙:
 *   - 순수 함수 (read 한정 부작용 — fs.existsSync/readFileSync 만)
 *   - throw 안 함 — 부재/오류 시 안전 기본값 반환
 *   - 결정적 — 동일 입력 + 동일 파일시스템 상태 → 항상 동일 경로
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, resolve, dirname } from 'node:path';

/** 프로젝트 루트 (CLAUDE_PROJECT_DIR 우선) — 프로세스 실제 루트 (system/governance/scan 기준, 불변) */
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR
  ? resolve(process.env.CLAUDE_PROJECT_DIR)
  : process.cwd();

/**
 * worktree_local 해석 base 의 동기 스코프 override (R-CM-035 예외 5 — loom cross-worktree run mutation).
 *
 * webui 서버(main 프로세스)가 *다른 worktree* 의 run 을 archive/삭제할 때, worktree_local
 * 자산(`run/active.json`, `runs/<id>/`)을 그 worktree 기준으로 해석하게 한다. system_persistent
 * (`getArchivesRoot`/`resolveSystemFile` → `resolveSystemPersistentRoot` git-common-dir)는 영향받지
 * 않아 archive snapshot/registry/index 는 항상 main 에 누적된다 (R-CM-026 / R-CM-030 정합).
 *
 * **동기 전용**: `fn` 은 동기 함수여야 한다 (try/finally 로 복원). async 호출 사이에 override 가
 * 누출되지 않도록 archive 코어는 sync fs 만 사용한다. webui 는 단일 프로세스·단일 사용자라
 * AsyncLocalStorage 없이 module 변수 + sync 스코프로 충분 (over-engineering 회피).
 */
let _projectDirOverride = null;

/**
 * worktree_local 해석 base (override > PROJECT_DIR). getPipelineDataRoot + saga state dir 등에 사용.
 * system_persistent 해석(resolveSystemPersistentRoot)은 본 함수를 쓰지 않으므로 override 무영향.
 * @returns {string} 절대 경로
 */
export function getProjectDir() {
  return _projectDirOverride || PROJECT_DIR;
}

/**
 * `dir` 을 worktree_local base 로 override 한 채 동기 함수 `fn` 을 실행하고 결과를 반환한다.
 * 실행 후(throw 포함) 이전 override 로 반드시 복원한다 (re-entrant 안전 — 이전 값 보존).
 *
 * @template T
 * @param {string} dir - worktree 절대/상대 경로. falsy 면 override 해제 효과.
 * @param {() => T} fn - 동기 콜백
 * @returns {T}
 */
export function withProjectDirOverride(dir, fn) {
  const prev = _projectDirOverride;
  _projectDirOverride = dir ? resolve(dir) : null;
  try {
    return fn();
  } finally {
    _projectDirOverride = prev;
  }
}

/**
 * system_persistent root 의 캐시 (1회 git 호출로 결정).
 * null = 아직 미해결, false = 해결 실패 (PROJECT_DIR fallback 확정).
 */
let _systemPersistentRootCache = null;

/**
 * system_persistent 카테고리의 단일 SSOT root 를 반환한다 (R-CM-030 worktree 통일).
 *
 * 우선순위:
 *   1. process.env.BRIEF2DEV_SYSTEM_ROOT 명시 (테스트 격리 / override)
 *   2. git rev-parse --git-common-dir 의 부모 (= main worktree 루트)
 *   3. PROJECT_DIR fallback (git 외부 / 비-worktree / git 호출 실패)
 *
 * 반환값은 `.brief2dev` 부모 디렉토리 경로 (절대 경로). 호출자는 join 으로
 * `.brief2dev/system/...` 을 조립한다.
 *
 * **함정 주의**: 이름이 "system_persistent root" 이지만 *system 파일 경로가 아님*.
 * `<root>` 만 반환하므로 호출자가 `.brief2dev/system/<filename>` 을 조립해야 한다.
 * system 파일 직접 접근은 `resolveSystemFile(filename)` 권장 — 자동으로
 * `.brief2dev/system/<filename>` 절대 경로 산출 + new vs legacy path fallback 처리.
 * raw root 직접 join (예: `join(root, 'learnings.jsonl')`) 은 main root 에 파일을
 * 잘못 append 하는 위반 패턴 (본 세션 2026-05-24 사례).
 *
 * 본 함수는 throw 하지 않는다 — git 실패는 fallback 으로 graceful degrade.
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd=PROJECT_DIR] - git 호출 cwd (테스트 격리용)
 * @param {boolean} [opts.bustCache=false] - 캐시 무효화 (테스트용)
 * @returns {string} 절대 경로
 */
export function resolveSystemPersistentRoot(opts = {}) {
  const { cwd = PROJECT_DIR, bustCache = false } = opts;

  if (process.env.BRIEF2DEV_SYSTEM_ROOT) {
    return resolve(process.env.BRIEF2DEV_SYSTEM_ROOT);
  }

  // R-CM-030: vitest sandbox 격리. B2D_TEST_SANDBOX=1 일 때 CLAUDE_PROJECT_DIR
  // 을 system_persistent root 로 사용 (git common-dir 무시). worktree 에서
  // vitest 실행 시에도 main repo 의 system 을 변조하지 않도록 강제.
  if (process.env.B2D_TEST_SANDBOX === '1' && process.env.CLAUDE_PROJECT_DIR) {
    return resolve(process.env.CLAUDE_PROJECT_DIR);
  }

  if (!bustCache && _systemPersistentRootCache !== null) {
    return _systemPersistentRootCache || PROJECT_DIR;
  }

  try {
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) {
      _systemPersistentRootCache = false;
      return PROJECT_DIR;
    }
    const absGitDir = resolve(cwd, out);
    const mainWorktreeRoot = dirname(absGitDir);
    _systemPersistentRootCache = mainWorktreeRoot;
    return mainWorktreeRoot;
  } catch {
    _systemPersistentRootCache = false;
    return PROJECT_DIR;
  }
}

/**
 * 런타임 데이터 루트 (예: `.brief2dev/` 또는 산출물의 `docs/discovery/`) — env-aware + project-config-aware (lazy lookup).
 *
 * 우선순위 (매 호출마다 평가):
 *   1. <PROJECT_DIR>/project-config.json#pipeline_data_root 명시 string → join(PROJECT_DIR, 그 path)
 *   2. fallback → join(PROJECT_DIR, '.brief2dev')
 *
 * **Lazy lookup (사용자 결정 2026-05-25 옵션 3)**: const 가 아닌 함수 — 매 호출에서 project-config.json 을
 * sync read. R-CM-026 Rule 8 단일 진입점 SSOT: 본 모듈만 `.brief2dev` literal 보유, pipeline-config 등
 * 다른 모듈은 본 함수를 import 위임.
 *
 * **보안 가드**: pipeline_data_root 입력에 절대 경로 (`/...`) 또는 path traversal (`..`) 포함 시 silent fallback
 * (R-CM-006 Rule 2 fail-open 정합). 산출물 project-config.json 은 scaffold-deploy 가 생성하므로 사용자 직접
 * 제어 input 은 아니지만 defense-in-depth.
 *
 * **성능**: disk I/O 매 호출. hot loop 호출 시 caller 가 결과를 변수로 cache 권장.
 *
 * @returns {string} 절대 경로
 */
export function getPipelineDataRoot() {
  // worktree_local base — withProjectDirOverride 적용 시 그 worktree 기준 (R-CM-035 예외 5).
  const base = getProjectDir();
  const configPath = join(base, 'project-config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      const raw = config?.pipeline_data_root;
      if (typeof raw === 'string') {
        const trimmed = raw.trim();
        // 보안 가드 (의도적으로 strict): 빈 문자열 / 절대 경로 / `..` substring 포함 path → silent fallback.
        // `..` substring 검사라 `docs..v2` 같은 임의 이름도 거부 — `pipeline_data_root` 는 단순 디렉토리명 (예: `docs/discovery`) 가정.
        if (trimmed.length > 0 && !trimmed.startsWith('/') && !trimmed.includes('..')) {
          return join(base, trimmed);
        }
      }
    } catch {
      // JSON parse 실패 등 silent fallback
    }
  }
  return join(base, '.brief2dev');
}

/**
 * `.brief2dev/system/` — 시스템 영속 자산 (registry, learnings 등).
 *
 * **Lazy lookup**: getPipelineDataRoot() 의 lookup 결과를 따른다.
 *
 * @returns {string} 절대 경로
 */
export function getSystemRoot() {
  return join(getPipelineDataRoot(), 'system');
}

/**
 * `.brief2dev/runs/` — run-scoped 산출물 루트.
 *
 * @returns {string} 절대 경로
 */
export function getRunsRoot() {
  return join(getPipelineDataRoot(), 'runs');
}

/**
 * `.brief2dev/governance/` — 거버넌스 영속 자산 (handoff/retrospectives/audits).
 *
 * @returns {string} 절대 경로
 */
export function getGovernanceRoot() {
  return join(getPipelineDataRoot(), 'governance');
}

/**
 * `.brief2dev/inbox/` — 파이프라인 시작 전 참고 자료 스테이징.
 *
 * @returns {string} 절대 경로
 */
export function getInboxRoot() {
  return join(getPipelineDataRoot(), 'inbox');
}

/**
 * `.brief2dev/transplants/` — OSS 이식 시스템 (별도 레이아웃).
 *
 * @returns {string} 절대 경로
 */
export function getTransplantsRoot() {
  return join(getPipelineDataRoot(), 'transplants');
}

/**
 * `.brief2dev/archives/` — sealed idea archive snapshot 루트.
 *
 * **system_persistent root 기준** (main worktree, 사용자 결정 2026-05-14). 각 worktree 의 archive-and-reset
 * 산출물이 main 으로 sync 되어 cross-aidea archive 누적이 보존되도록 한다. `.brief2dev/run/active.json` 은
 * worktree-local (per-session 격리) 이지만 archives 는 cross-worktree 공유.
 *
 * 본 함수는 getPipelineDataRoot() lookup 과 *독립* — system_persistent root 가 base 라 project-config.json
 * 의 `pipeline_data_root` 영향 없음. 산출물 (관점 2) 에서는 의미 부재. **본체 (관점 1) 전용 cross-aidea 자산**.
 *
 * @returns {string} 절대 경로
 */
export function getArchivesRoot() {
  return join(resolveSystemPersistentRoot(), '.brief2dev', 'archives');
}

/**
 * `.brief2dev/_archive/` — governance/raw history archive 루트.
 *
 * @returns {string} 절대 경로
 */
export function getArchiveRoot() {
  return join(getPipelineDataRoot(), '_archive');
}

// ═══════════════════════════════════════════════════════════════
// system 카테고리 (system_persistent lifecycle)
// ═══════════════════════════════════════════════════════════════

/**
 * system 카테고리 파일 경로를 결정한다.
 *
 * 우선순위 (R-CM-030 worktree 통일):
 *   1. projectDir 명시 + 명시 root 에 새 경로 존재 → 명시 root 의 새 경로 (테스트 격리 우선)
 *   2. system_persistent root (`git common-dir` 의 부모) 의 새 경로 존재 → 그 경로
 *   3. system_persistent root 의 옛 경로 (.brief2dev/<filename>) 존재 + 새 경로 부재 → 옛 경로 (P3 legacy fallback)
 *   4. 둘 다 부재 시: 새 경로 (write target)
 *
 * projectDir 인자는 테스트 격리용 — 기본값 PROJECT_DIR 시 system_persistent root 자동 해결.
 * 명시 시 그 경로를 강제 사용 (BRIEF2DEV_SYSTEM_ROOT env 와 동등 효과).
 *
 * @param {string} filename - 파일명 (예: "learnings.jsonl", "registry.json")
 * @param {string} [projectDir] - 프로젝트 루트 명시 (테스트 격리). 미명시 시 system_persistent root.
 *   **주의**: `filename === 'active-run.json'` 인 경우 본 인자는 무시되고 `getActiveRunPath()` 로
 *   위임된다 (worktree_local lifecycle, R-CM-026 2026-05-14). active-run state 의 worktree 격리가
 *   필요한 호출자는 `getActiveRunPath()` 를 직접 사용 권장.
 * @returns {string} 절대 경로
 */
export function resolveSystemFile(filename, projectDir) {
  // active-run.json 은 worktree_local 로 분리되었으므로 (R-CM-026 `run` 카테고리),
  // 호출자 코드 변경 없이 자동 위임. projectDir 명시는 무시 — getActiveRunPath 가
  // PROJECT_DIR (worktree-local) 자동 해결.
  if (filename === 'active-run.json') return getActiveRunPath();
  const root = projectDir
    ? join(resolve(projectDir), '.brief2dev')
    : join(resolveSystemPersistentRoot(), '.brief2dev');
  const newPath = join(root, 'system', filename);
  const oldPath = join(root, filename);
  if (existsSync(newPath)) return newPath;
  if (existsSync(oldPath)) return oldPath;
  return newPath;
}

/**
 * system/session-history/ 디렉토리 경로를 결정한다.
 *
 * @param {string} [projectDir] - 프로젝트 루트 명시 (테스트 격리). 미명시 시 system_persistent root.
 * @returns {string} 절대 경로
 */
export function resolveSessionHistoryDir(projectDir) {
  const root = projectDir
    ? join(resolve(projectDir), '.brief2dev')
    : join(resolveSystemPersistentRoot(), '.brief2dev');
  return join(root, 'system', 'session-history');
}

// ═══════════════════════════════════════════════════════════════
// active run 조회
// ═══════════════════════════════════════════════════════════════

/**
 * active-run state 파일 경로를 반환한다 (worktree-local).
 *
 * **사용자 결정 2026-05-14 per-worktree run isolation**: active-run state 는
 * worktree 마다 격리 (multi-session safe). main 공유 system 자산 (pipeline-memory
 * 등) 과 달리 PROJECT_DIR 기준 `.brief2dev/run/active.json` 으로 해결한다.
 *
 * Legacy fallback (점진적 마이그레이션 + test fixture 호환):
 *   1. `<wt>/.brief2dev/run/active.json` 존재 → 그 경로
 *   2. system_persistent root 의 `system/active-run.json` 존재 → 그 경로 (P3 legacy)
 *   3. system_persistent root 의 `.brief2dev/active-run.json` 평탄 위치 존재 → 그 경로 (P3 flat)
 *   4. 모두 부재: 새 경로 (write target)
 *
 * @returns {string} 절대 경로
 */
export function getActiveRunPath() {
  const newPath = join(getPipelineDataRoot(), 'run', 'active.json');
  if (existsSync(newPath)) return newPath;
  const systemRoot = resolveSystemPersistentRoot();
  const systemLegacy = join(systemRoot, '.brief2dev', 'system', 'active-run.json');
  if (existsSync(systemLegacy)) return systemLegacy;
  const flatLegacy = join(systemRoot, '.brief2dev', 'active-run.json');
  if (existsSync(flatLegacy)) return flatLegacy;
  return newPath;
}

/**
 * main + 모든 worktree (.worktrees/**) 의 active-run.json 후보 경로를 수집한다.
 * active-run 은 worktree_local (R-CM-026 `run` 카테고리, 사용자 결정 2026-05-14) 이라
 * cross-worktree running guard 는 각 worktree 의 active 를 개별 확인해야 한다.
 * 경로 존재 여부는 호출자가 판단 (존재 무관 후보 반환 — fail-open).
 *
 * @param {string} [projectDir=PROJECT_DIR] 프로젝트 루트
 * @returns {string[]} active-run.json 절대 경로 목록 (main 1 + worktree N)
 */
export function listAllActiveRunPaths(projectDir = PROJECT_DIR) {
  // worktree-local 격리 스캔: 각 worktree 의 .brief2dev/run/active.json 을 직접 본다.
  const paths = [join(projectDir, '.brief2dev', 'run', 'active.json')];
  const worktreesRoot = join(projectDir, '.worktrees');
  if (!existsSync(worktreesRoot)) return paths;
  // withFileTypes 로 디렉터리만 추린다 — 파일 (.DS_Store 등) 을 브랜치 segment 로
  // 오인하거나 worktree 내부 (node_modules/src 등) 를 over-scan 하는 것을 차단.
  let level1 = [];
  try {
    level1 = readdirSync(worktreesRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return paths;
  }
  for (const entry of level1) {
    const entryPath = join(worktreesRoot, entry);
    paths.push(join(entryPath, '.brief2dev', 'run', 'active.json'));
    // feature/foo, fix/bar 같은 2-depth 브랜치는 한 레벨 더 탐색 (디렉터리만)
    let level2 = [];
    try {
      level2 = readdirSync(entryPath, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const sub of level2) {
      paths.push(join(entryPath, sub, '.brief2dev', 'run', 'active.json'));
    }
  }
  return paths;
}

/**
 * active-run.json 의 run_id 를 반환한다 (idle/없으면 null).
 *
 * @returns {string|null}
 */
export function getActiveRunId() {
  try {
    const path = getActiveRunPath();
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    if (!data || data.status === 'idle') return null;
    return data.run_id || null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// run-scoped 카테고리 (run_scoped lifecycle)
// ═══════════════════════════════════════════════════════════════

/**
 * run-scoped 카테고리 디렉토리 경로를 결정한다.
 *
 * @param {string} subdir - 서브디렉토리 (예: "stage-output", "handoff", "reports", "references")
 * @returns {string} 절대 경로
 */
export function resolveRunScopedDir(subdir) {
  const runId = getActiveRunId();
  if (runId) {
    return join(getRunsRoot(), runId, subdir);
  }
  // active 없으면 새 경로 (write 시점에 mkdir 필요)
  return join(getRunsRoot(), '_unassigned', subdir);
}

/**
 * run-scoped 카테고리 디렉토리 (특정 run_id 명시).
 *
 * @param {string} runId - run_id (예: "brief2dev-20260428-104115")
 * @param {string} subdir
 * @returns {string} 절대 경로
 */
export function resolveRunScopedDirFor(runId, subdir) {
  if (!runId) return resolveRunScopedDir(subdir);
  return join(getRunsRoot(), runId, subdir);
}

/**
 * 현재 active run 의 루트 디렉토리를 반환한다.
 * 카테고리 sub-dir 가 아닌 run-level 자산 (inbox-manifest.json 등) 위치 결정에 사용.
 *
 * 우선순위:
 *   1. active run_id 있음 → .brief2dev/runs/<run_id>/
 *   2. active 없음 → null
 *
 * @returns {string|null} 절대 경로 또는 null
 */
export function resolveActiveRunDir() {
  const runId = getActiveRunId();
  if (!runId) return null;
  return join(getRunsRoot(), runId);
}

/**
 * idea-memory.json 파일 경로를 반환한다 (R-CM-014 P3, 2026-05-06).
 *
 * R-CM-026 layout SSOT 의 `runs/{active}/idea-memory.json` 카테고리 (lifecycle: run_scoped).
 * R-CM-028 Two-Perspective Boundary 데이터 분리 적용 — system pipeline-memory.json 과 격리된
 * per-aidea fact 저장소. archive-and-reset Phase 7 에서 함께 봉인.
 *
 * 우선순위:
 *   1. runId 명시 → .brief2dev/runs/<runId>/idea-memory.json (write target 으로도 사용 가능)
 *   2. runId 미명시 + active run_id 있음 → active run 의 idea-memory
 *   3. runId 미명시 + active 없음 → null (idle 상태에서 idea-memory 부재)
 *
 * @param {string} [runId] - 특정 run_id 명시. null 또는 undefined 시 active 사용.
 * @returns {string|null} 절대 경로 또는 null (idle + runId 미명시 시)
 */
export function resolveIdeaMemoryPath(runId) {
  if (runId) return join(getRunsRoot(), runId, 'idea-memory.json');
  const active = getActiveRunId();
  if (!active) return null;
  return join(getRunsRoot(), active, 'idea-memory.json');
}

// ═══════════════════════════════════════════════════════════════
// governance 카테고리 (permanent lifecycle)
// ═══════════════════════════════════════════════════════════════

/**
 * governance 서브디렉토리 경로를 반환한다.
 *
 * @param {string} subdir - "handoff" | "retrospectives" | "audits" | 기타 governance category
 * @param {string} [projectDir=PROJECT_DIR] - 프로젝트 루트 오버라이드 (테스트 격리용)
 * @returns {string} 절대 경로
 */
export function resolveGovernanceDir(subdir, projectDir = PROJECT_DIR) {
  const root =
    resolve(projectDir) === PROJECT_DIR
      ? getGovernanceRoot()
      : join(resolve(projectDir), relative(PROJECT_DIR, getGovernanceRoot()));
  return join(root, subdir);
}

/**
 * archive 서브디렉토리 경로를 반환한다.
 *
 * @param {string} subdir - archive 내부 서브디렉토리
 * @param {string} [projectDir=PROJECT_DIR] - 프로젝트 루트 오버라이드 (테스트 격리용)
 * @returns {string} 절대 경로
 */
export function resolveArchiveDir(subdir, projectDir = PROJECT_DIR) {
  const root =
    resolve(projectDir) === PROJECT_DIR
      ? getArchiveRoot()
      : join(resolve(projectDir), relative(PROJECT_DIR, getArchiveRoot()));
  return join(root, subdir);
}
