/**
 * unified-deployment-reader.mjs — 통합 배포 매니페스트 조회 레이어 (P3)
 *
 * data/registry/unified-deployment.json (target 1급 차원 + policy.modes discovery-lock)을
 * 읽어 target/mode/kind/boundary 로 asset 을 선택한다. 순수 함수 + fail-open(null) — 엔진
 * (scaffold-deploy.mjs)의 per-phase SSOT read 를 이 단일 SSOT 조회로 점진 교체한다.
 *
 * 매니페스트 SSOT 는 GENERATED (data/registry/migrate-to-unified-deployment.mjs). 본 reader 는
 * 읽기 전용 — 배포 결과 drift=0 을 위해 동치 회귀(tests/unit/unified-deployment-reader.test.mjs)
 * 가 legacy deployed-assets.json 과의 1:1 재현을 강제한다.
 *
 * Zero external dependencies (Node.js built-ins only).
 */

import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// .claude/scripts/lib → repo root (../../..) → data/registry/unified-deployment.json
const DEFAULT_MANIFEST_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'data',
  'registry',
  'unified-deployment.json',
);

/**
 * 매니페스트 JSON 을 로드한다. 부재/파싱 실패 시 null (fail-open — safeReadJson 동형).
 * @param {string} [manifestPath]
 * @returns {object|null}
 */
export function loadManifest(manifestPath = DEFAULT_MANIFEST_PATH) {
  try {
    if (!existsSync(manifestPath)) return null;
    return JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * asset 이 (target, mode) 에서 허용되는지 판정.
 * policy.modes[target] 부재(undefined) → 제한 없음(true). 배열 존재 → 해당 mode 포함 여부.
 * 빈 배열([])은 "이 target 에서 모든 mode 차단"(deny-all) 의미 — includes 가 항상 false.
 * (mode-enforcement: pipeline skill 은 p2-brownfield 에서 ['discovery'] 만 허용 → generation DENY)
 * @param {object|null|undefined} asset
 * @param {string} target
 * @param {string} mode
 * @returns {boolean}
 */
export function modeAllowed(asset, target, mode) {
  const modes = asset?.policy?.modes?.[target];
  if (!Array.isArray(modes)) return true;
  return modes.includes(mode);
}

/**
 * 매니페스트에서 filter 에 맞는 asset 배열(원본 객체, manifest.assets 순서 보존)을 반환한다.
 * 입력 단위는 id set 이 아니라 asset 객체 배열 — 배포 재현에 path/files/policy 가 필요하므로.
 * 계약: mode 필터는 target 과 **함께** 주어졌을 때만 효과가 있다. target 없이 mode 만 주면
 * mode 는 무시되고 전체가 반환된다(mode 는 target-scoped 개념이므로).
 * @param {object|null} manifest
 * @param {{target?:string, mode?:string, kind?:string, boundary?:string}} [filter]
 * @returns {object[]}
 */
export function selectAssets(manifest, filter = {}) {
  if (!manifest || !Array.isArray(manifest.assets)) return [];
  const { target, mode, kind, boundary } = filter;
  return manifest.assets.filter((a) => {
    if (kind && a.kind !== kind) return false;
    if (boundary && a.boundary !== boundary) return false;
    if (target && !(Array.isArray(a.targets) && a.targets.includes(target))) return false;
    // mode 필터는 target+mode 둘 다 주어졌을 때만 적용 (target 만 주면 mode 무관 전체)
    if (target && mode && !modeAllowed(a, target, mode)) return false;
    return true;
  });
}

/**
 * asset 배열 → id 문자열 배열 (편의 헬퍼).
 * @param {object[]} assets
 * @returns {string[]}
 */
export function assetIds(assets) {
  return (Array.isArray(assets) ? assets : []).map((a) => a.id);
}
