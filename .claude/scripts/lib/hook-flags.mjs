/**
 * hook-flags.mjs — Profile resolver (registry-derived, R-CM-006 Rule 4 Single SSOT)
 *
 * profile 멤버십은 hook-registry.mjs entry 의 `profile` 필드에서 derive 한다.
 * 본 파일은 SSOT 가 아니다.
 *
 * profile 변경:
 *   ❌ 본 파일 편집 금지
 *   ✅ hook-registry.mjs entry 의 `profile` 필드 변경 + regen-hooks-settings.mjs 실행
 *
 * 환경변수:
 *   ECC_HOOK_PROFILE   = minimal | standard (기본: standard)
 *   ECC_DISABLED_HOOKS = 쉼표 구분 hookId 목록 (강제 비활성화)
 *
 * @see .claude/scripts/lib/hook-registry.mjs (Single SSOT)
 * @see .claude/rules/common/hooks.md (R-CM-006 Rule 4)
 */
import { flattenRegistry } from './hook-registry.mjs';

const VALID_PROFILES = new Set(['minimal', 'standard']);

let _profileMapCache = null;

function buildProfileMap() {
  if (_profileMapCache) return _profileMapCache;
  const flat = flattenRegistry();
  const minimalIds = new Set();
  const standardIds = new Set();
  for (const h of flat) {
    if (h.profile === 'minimal') minimalIds.add(h.id);
    else if (h.profile === 'standard') standardIds.add(h.id);
  }
  _profileMapCache = {
    minimal: minimalIds,
    standard: new Set([...minimalIds, ...standardIds]),
  };
  return _profileMapCache;
}

let _disabledHooksCache = null;

export function getDisabledHookIds() {
  if (_disabledHooksCache) return _disabledHooksCache;
  const raw = (process.env.ECC_DISABLED_HOOKS || '').trim();
  _disabledHooksCache = raw
    ? new Set(raw.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean))
    : new Set();
  return _disabledHooksCache;
}

export function getActiveProfile() {
  const env = (process.env.ECC_HOOK_PROFILE || '').toLowerCase().trim();
  return VALID_PROFILES.has(env) ? env : 'standard';
}

export function isHookEnabled(hookId, options) {
  const disabled = getDisabledHookIds();
  if (disabled.has(hookId)) return false;
  const profile = options?.profile || getActiveProfile();
  const profileMap = buildProfileMap();
  const enabledSet = profileMap[profile];
  if (!enabledSet) return true;
  return enabledSet.has(hookId);
}

/** ecosystem-health-guard E14 호환 — Single SSOT 후엔 derive 라 항상 valid */
export function validateProfileCoverage(registryHookIds, profileUncheckedIds = []) {
  const profileMap = buildProfileMap();
  // 2-tier (minimal ⊂ standard). standard 가 전체 프로파일 superset (strict 티어 제거, 2026-06-11).
  const allProfileIds = profileMap.standard;
  const registrySet = new Set(registryHookIds);
  const uncheckedSet = new Set(profileUncheckedIds);
  const orphaned = [...allProfileIds].filter((id) => !registrySet.has(id));
  const missing = [...registrySet].filter(
    (id) => !allProfileIds.has(id) && !uncheckedSet.has(id),
  );
  return { valid: orphaned.length === 0 && missing.length === 0, orphaned, missing };
}

export function getEnabledHooks(profile) {
  const p = profile || getActiveProfile();
  const profileMap = buildProfileMap();
  const enabledSet = profileMap[p];
  if (!enabledSet) return [];
  const disabled = getDisabledHookIds();
  return [...enabledSet].filter((id) => !disabled.has(id)).sort();
}
