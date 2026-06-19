/**
 * Session Baseline Library
 *
 * Stop hook들이 "이전 세션에서 상속된 이슈"와 "이번 세션에서 발생한 이슈"를
 * 구분할 수 있게 한다. 상속된 이슈는 BLOCK하지 않고 INHERITED 태그로 표시만.
 *
 * 근본 목적: 세션이 중간 상태에서 시작되거나 과거 누적 부채가 있을 때
 * 매 턴마다 Stop hook이 반복 발화하여 결정권을 박탈하는 문제를 해결한다.
 *
 * 사용법:
 *   const baseline = loadBaseline(projectDir);
 *   const { inherited, fresh } = partitionByBaseline(violations, baseline);
 *   // fresh만 block, inherited는 별도 섹션으로 표시
 *
 * 베이스라인 캡처:
 *   node .claude/scripts/baseline-freeze.mjs
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const BASELINE_REL_PATH = '.claude/state/session-baseline.json';

export function baselinePath(projectDir) {
  return join(projectDir, BASELINE_REL_PATH);
}

export function loadBaseline(projectDir) {
  const path = baselinePath(projectDir);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    // expires_at이 설정된 베이스라인은 만료 후 무시
    if (data.expires_at) {
      const expireAt = new Date(data.expires_at).getTime();
      if (Date.now() > expireAt) return null;
    }
    return data;
  } catch {
    return null;
  }
}

export function writeBaseline(projectDir, data) {
  const dir = join(projectDir, '.claude', 'state');
  mkdirSync(dir, { recursive: true });
  writeFileSync(baselinePath(projectDir), JSON.stringify(data, null, 2));
}

/**
 * violation을 stable key로 변환. id + message는 고유 조합.
 * (message는 specific target을 포함하므로 충돌 없음)
 */
export function issueKey(v) {
  return `${v.id}::${v.message}`;
}

/**
 * violation이 baseline에 기록된 상속 이슈인지 판정
 */
export function isInherited(v, baseline) {
  if (!baseline || !Array.isArray(baseline.known_issues)) return false;
  return baseline.known_issues.includes(issueKey(v));
}

/**
 * violations를 inherited와 fresh로 분리
 */
export function partitionByBaseline(violations, baseline) {
  if (!baseline) return { inherited: [], fresh: violations };
  const inherited = [];
  const fresh = [];
  for (const v of violations) {
    if (isInherited(v, baseline)) inherited.push(v);
    else fresh.push(v);
  }
  return { inherited, fresh };
}
