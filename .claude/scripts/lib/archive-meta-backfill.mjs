/**
 * archive-meta-backfill.mjs — 봉인 기록 메타 일관성 백필 (순수 로직)
 *
 * `_archive-meta.json` 의 `business_description` / `current_stage_at_archive`
 * / `stages_summary` 가 비어 Observatory 봉인 기록이 slug 원본만 노출하거나
 * 8단계 스텝퍼를 생략하는 불일치를 해소한다. fs 접근 없는 순수 함수만 두어
 * migrate-archive-meta CLI 와 archive-and-reset#archiveOneOrphan 가 공유한다
 * (DRY — R-CM-029 Rule 3/4).
 *
 * 백필 출처 우선순위 (사용자 결정 2026-05-18):
 *   1) 자기 stages_summary 가 비지 않았으면 current_stage 를 거기서 도출.
 *   2) 동일 run_id 의 rich sibling archive 에서 desc/stage/summary 백필.
 * sibling 이 정본 (같은 run 의 더 완전한 봉인) 이므로 일관성·정확성 최선.
 *
 * Boundary (R-CM-028): 관점 1 (brief2dev 자체 Observatory) 전용.
 */

// Observatory STAGE_LABELS 와 동일한 정규 8단계 순서 (webui/observatory/app.js).
// 이 순서를 벗어난 키는 UI 스텝퍼가 validArch=false 로 생략하므로 SSOT 일치 필수.
export const STAGE_ORDER = Object.freeze([
  'intake',
  'market_research',
  'mvp_scoping',
  'platform_decision',
  'stack_selection',
  'infra_design',
  'scaffolding',
  'output_gate',
]);

function isNonEmptyObject(value) {
  return !!value && typeof value === 'object' && Object.keys(value).length > 0;
}

/**
 * stages_summary 에서 봉인 시점 현재 단계를 도출.
 * running 단계가 있으면 그 단계, 없으면 가장 멀리 진행된 completed 단계.
 * @param {object|null|undefined} stagesSummary
 * @returns {string|null}
 */
export function deriveCurrentStage(stagesSummary) {
  if (!stagesSummary || typeof stagesSummary !== 'object') return null;
  let running = null;
  let lastCompleted = null;
  for (const id of STAGE_ORDER) {
    const s = stagesSummary[id];
    if (!s || typeof s !== 'object') continue;
    if (s.status === 'running') running = id;
    if (s.status === 'completed') lastCompleted = id;
  }
  return running || lastCompleted || null;
}

/** stages_summary 의 진행(completed|running) 단계 수 — sibling richness 척도. */
function progressCount(stagesSummary) {
  if (!stagesSummary || typeof stagesSummary !== 'object') return 0;
  let n = 0;
  for (const id of STAGE_ORDER) {
    const s = stagesSummary[id];
    if (s && (s.status === 'completed' || s.status === 'running')) n += 1;
  }
  return n;
}

/**
 * 동일 run_id 의 가장 풍부한 sibling 선택 (자기 제외).
 * 후보 조건: business_description 보유 + stages 진행 1+.
 * 정렬: 진행 단계 수 desc → archived_at desc.
 *
 * @param {string} targetSlug
 * @param {string|null|undefined} runId
 * @param {Array<{slug:string, meta:object}>} allMetas
 * @returns {{slug:string, meta:object}|null}
 */
export function pickSibling(targetSlug, runId, allMetas) {
  if (!runId || !Array.isArray(allMetas)) return null;
  const candidates = allMetas.filter(
    (e) =>
      e &&
      e.slug !== targetSlug &&
      e.meta &&
      e.meta.run_id === runId &&
      e.meta.business_description &&
      progressCount(e.meta.stages_summary) > 0,
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const ca = progressCount(a.meta.stages_summary);
    const cb = progressCount(b.meta.stages_summary);
    if (cb !== ca) return cb - ca;
    const ta = Date.parse(a.meta.archived_at || '') || 0;
    const tb = Date.parse(b.meta.archived_at || '') || 0;
    return tb - ta;
  });
  return candidates[0];
}

/**
 * 단일 archive 메타에 필요한 백필 패치를 계산.
 * 채울 게 없으면 null 반환 (idempotent — 재실행 시 무변경).
 *
 * @param {{slug:string, meta:object}} target
 * @param {Array<{slug:string, meta:object}>} allMetas
 * @returns {{patch:object, provenance:{fields:string[], sources:string[]}}|null}
 */
export function resolveBackfill(target, allMetas) {
  if (!target || !target.meta || typeof target.meta !== 'object') return null;
  const meta = target.meta;
  const needsDesc = !meta.business_description;
  const needsStage = !meta.current_stage_at_archive;
  const summaryEmpty = !isNonEmptyObject(meta.stages_summary);

  const patch = {};
  const provenance = { fields: [], sources: [] };

  // 1) 자기 stages_summary 로 current_stage 도출 (가장 정확 — 자기 기록).
  if (needsStage && !summaryEmpty) {
    const s = deriveCurrentStage(meta.stages_summary);
    if (s) {
      patch.current_stage_at_archive = s;
      provenance.fields.push('current_stage_at_archive');
      provenance.sources.push('own_stages_summary');
    }
  }

  // 2) sibling 로 잔여 갭 백필.
  const stillNeedsStage = needsStage && patch.current_stage_at_archive === undefined;
  if (needsDesc || stillNeedsStage || summaryEmpty) {
    const sib = pickSibling(target.slug, meta.run_id, allMetas);
    if (sib) {
      let usedSibling = false;
      if (needsDesc && sib.meta.business_description) {
        patch.business_description = sib.meta.business_description;
        provenance.fields.push('business_description');
        usedSibling = true;
      }
      if (summaryEmpty && isNonEmptyObject(sib.meta.stages_summary)) {
        patch.stages_summary = sib.meta.stages_summary;
        provenance.fields.push('stages_summary');
        usedSibling = true;
      }
      if (stillNeedsStage) {
        const s =
          sib.meta.current_stage_at_archive || deriveCurrentStage(sib.meta.stages_summary);
        if (s) {
          patch.current_stage_at_archive = s;
          provenance.fields.push('current_stage_at_archive');
          usedSibling = true;
        }
      }
      if (usedSibling) provenance.sources.push(`sibling:${sib.slug}`);
    }
  }

  if (Object.keys(patch).length === 0) return null;
  return { patch, provenance };
}
