/**
 * enforced-by-parser.mjs
 *
 * `## Enforced by:` 라인의 공통 파서 + 면제 마커 SSOT.
 * audit-rule-enforcement.mjs (R-CM-024 I5/D1 검사) 와 validate-rules.mjs (VR4) 가 공유한다.
 *
 * **공유 이유 (R-CM-006 Single SSOT 정신)**: 두 검증기가 동일한 enforced_by raw text 를
 * 각자 파싱하면 silently diverge → false-positive/negative 의 회귀 vehicle. lib 단일 진입점으로 통일.
 *
 * **사용처**:
 *   - `.claude/scripts/audit-rule-enforcement.mjs#splitTopLevel + hasManualEnforcementMarker`
 *   - `.claude/scripts/validate-rules.mjs#classifyEnforcedBy + MANUAL_MARKERS`
 *
 * @see .claude/rules/common/rule-enforcement-honesty.md (R-CM-024 §7 면제 어휘)
 */

/**
 * R-CM-024 §7 면제 어휘 (per-token manual marker) — Single SSOT.
 *
 * enforced_by 항목의 괄호 보충에 이 어휘가 있으면 활성 hook 셋 검사 / I5 검사를 SKIP.
 * 예: `followup-debt-tracker (수동 register/audit)` → SKIP.
 *
 * 신규 마커 추가 시 R-CM-021 retrospective 작성 + R-CM-024 §7 cross-ref 업데이트.
 */
export const MANUAL_MARKER_LIST = Object.freeze([
  '수동',
  'manual',
  'on-demand',
  'prompt-level',
  'scaffold target',
  'scaffold-only',
  'retired',
]);

/**
 * MANUAL_MARKER_LIST 기반 정규식. 괄호 안 마커 검출용.
 * 예: `(수동 register/audit)` 매치, `manual register/audit` (괄호 없음) 비매치.
 */
export const MANUAL_MARKER_REGEX = new RegExp(
  '\\((?:' + MANUAL_MARKER_LIST.map((m) => m.replace(/[-]/g, '\\$&')).join('|') + ')',
  'i'
);

/**
 * enforced_by raw text 전체에 면제 마커가 포함되어 있으면 true.
 * 단일 항목이 아닌 라인 전체 검사 — I5 wired-script 검사에서 사용.
 *
 * @param {string} enfRaw — `## Enforced by:` 라인 raw text
 * @returns {boolean}
 */
export function hasManualEnforcementMarker(enfRaw) {
  if (!enfRaw) return true; // null / 빈 = 강제 X 정직 → I5 면제 (검사할 mechanism 없음)
  return MANUAL_MARKER_REGEX.test(enfRaw);
}

/**
 * top-level 분리 (괄호 내부 separator 보존).
 *
 * 인수:
 *   - 1-인자 (s): 콤마만 분리 — 기존 audit-rule-enforcement.mjs API 호환.
 *   - 2-인자 (s, sepRegex): 사용자가 지정한 separator 정규식으로 분리.
 *
 * 예:
 *   splitTopLevel('hook (a, b), other')                          → ['hook (a, b)', ' other']
 *   splitTopLevel('hook + other (a + b)', /\s\+\s|,|\sor\s/)     → ['hook ', ' other (a + b)']
 *
 * @param {string} s
 * @param {RegExp} [sepRegex] — single-char or multi-char separator. char-by-char 검사를 위해 sticky 가 아닌 일반 정규식 (글로벌 flag 없이도 동작).
 * @returns {string[]}
 */
export function splitTopLevel(s, sepRegex = null) {
  const parts = [];
  let depth = 0;
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    if (depth === 0) {
      if (sepRegex) {
        // multi-char separator 검사 (remaining string 의 prefix 매칭)
        const remaining = s.slice(i);
        const m = remaining.match(sepRegex);
        if (m && m.index === 0) {
          parts.push(buf);
          buf = '';
          i += m[0].length - 1; // 루프의 i++ 와 합쳐서 separator 전체 건너뜀
          continue;
        }
      } else if (c === ',') {
        parts.push(buf);
        buf = '';
        continue;
      }
    }
    buf += c;
  }
  if (buf.trim()) parts.push(buf);
  return parts;
}

/**
 * enforced_by 라인을 항목 배열로 분해 + skip 판정.
 *
 * 동작:
 *   - `null` / `null (...)` / `prompt-level (...)` → `{ skip: true, items: [] }`
 *   - 콤마 / ` + ` / ` or ` 로 분리 후 괄호 보충 strip
 *   - per-항목 매뉴얼 마커 (예: `'hook (수동 audit)'`) → 해당 항목만 SKIP
 *   - `.mjs/.sh/.js` 파일명 항목 → 별도 처리 (utility script 검사 대상이라 활성 hook 셋 검사 SKIP)
 *
 * @param {string} s — `## Enforced by:` 라인 raw text
 * @returns {{ skip: boolean, items: string[] }}
 */
export function classifyEnforcedBy(s) {
  if (typeof s !== 'string') return { skip: true, items: [] };
  const t = s.trim();
  if (/^null\b/i.test(t)) return { skip: true, items: [] };
  if (/prompt[- ]level/i.test(t)) return { skip: true, items: [] };
  // 콤마 / ` + ` / ` or ` 모두 top-level (괄호 외부) 일 때만 분리. 괄호 내부 separator 는 항목 일부로 보존.
  const ALL_SEPS = /,|\s\+\s|\sor\s/i;
  const parts = splitTopLevel(t, ALL_SEPS);
  const items = [];
  for (const part of parts) {
    const subTrim = part.trim();
    if (MANUAL_MARKER_REGEX.test(subTrim)) continue;
    const cleaned = subTrim.replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (cleaned && !/\.(mjs|sh|js)$/i.test(cleaned)) items.push(cleaned);
  }
  return { skip: false, items };
}
