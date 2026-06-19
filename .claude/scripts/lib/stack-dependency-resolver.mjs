/**
 * stack-dependency-resolver.mjs — stack-config(ATAM 산출물) → 시드 package.json 의존성 해석.
 *
 * P6-A: 시드 package.json 의 vendor 의존성을 stack-config.json#stack.<layer>.selected.name 기반으로
 * 동적 결정한다. scaffold-deploy.mjs(생성) 와 scaffold-validator.mjs(검증) 가 공용 import 하여
 * "생성도 스택 무시, 검증도 스택 무시" 이중 공백을 단일 SSOT 로 폐쇄한다.
 *
 * 매핑 SSOT: .claude/skills/project-scaffolder/references/stack-dependency-catalog.json
 *
 * R-CM-028 boundary: 본 모듈은 생성기 전용 (deployed-assets.json#scripts.always 미등재 → scaffold 미배포).
 * 카탈로그 JSON 은 references/ wholesale 복사로 scaffold 에 배포되나 소비자(본 모듈)가 부재하여 inert.
 *
 * 순수 함수 — filesystem 접근 없음. 카탈로그/stackConfig 는 호출자가 읽어서 주입한다 (테스트 용이).
 */

/** 객체 키를 알파벳 순으로 정렬한 새 객체 반환 (골든 snapshot 결정성). */
function sortKeys(obj) {
  const sorted = {};
  for (const key of Object.keys(obj).sort()) sorted[key] = obj[key];
  return sorted;
}

/** stack 레이어의 검색 대상 문자열 (name + version) 을 lowercase 로 만든다. */
function layerSearchText(selected) {
  if (!selected || typeof selected !== 'object' || !selected.name) return null;
  return `${selected.name} ${selected.version || ''}`.toLowerCase();
}

/** 카탈로그에서 base 를 가진 유효한 platform 엔트리만 반환 (없으면 null). */
function getPlatformCatalog(catalog, platform) {
  if (!catalog || typeof catalog !== 'object') return null;
  const platformCatalog = catalog[platform];
  if (!platformCatalog || typeof platformCatalog !== 'object' || !platformCatalog.base) return null;
  return platformCatalog;
}

/** stackConfig.stack 가 유효 객체면 반환, 아니면 null. */
function getStackLayers(stackConfig) {
  const stack = stackConfig && typeof stackConfig === 'object' ? stackConfig.stack : null;
  return stack && typeof stack === 'object' ? stack : null;
}

/** stack.<layer>.selected.name 이 있는 레이어의 lowercase 검색 문자열 맵. */
function buildLayerTextMap(stack) {
  const layerText = {};
  for (const [layer, layerVal] of Object.entries(stack)) {
    const text = layerSearchText(layerVal?.selected);
    if (text !== null) layerText[layer] = text;
  }
  return layerText;
}

/** 단일 룰이 어느 레이어들로 매치했는지 반환 (없으면 빈 배열). exclude 우선. */
function ruleMatchedLayers(rule, layerText) {
  const match = (Array.isArray(rule.match) ? rule.match : []).map((m) => String(m).toLowerCase());
  const exclude = (Array.isArray(rule.exclude) ? rule.exclude : []).map((e) => String(e).toLowerCase());
  // rule.layers 생략 시 selected.name 이 있는 모든 레이어 검사.
  const ruleLayers = Array.isArray(rule.layers) && rule.layers.length ? rule.layers : Object.keys(layerText);

  const hits = [];
  for (const layer of ruleLayers) {
    const text = layerText[layer];
    if (!text) continue;
    const hasMatch = match.some((m) => m && text.includes(m));
    const hasExclude = exclude.some((e) => e && text.includes(e));
    if (hasMatch && !hasExclude) hits.push(layer);
  }
  return hits;
}

/**
 * 모든 룰을 적용하여 deps/devDeps 를 mutate 하고 매치 메타데이터를 반환한다.
 * matchedLayers 는 *룰이 그 레이어의 텍스트로 매치한* 레이어만 포함 (다른 레이어 오염 금지).
 */
function applyRules(rules, layerText, deps, devDeps) {
  const matchedRuleIds = [];
  const matchedLayers = new Set();

  for (const rule of rules) {
    const hits = ruleMatchedLayers(rule, layerText);
    if (hits.length === 0) continue;
    matchedRuleIds.push(rule.id);
    for (const layer of hits) matchedLayers.add(layer);
    Object.assign(deps, rule.dependencies || {});
    Object.assign(devDeps, rule.devDependencies || {});
  }

  return { matchedRuleIds, matchedLayers };
}

/** selected.name 이 있으나 어떤 룰도 그 레이어로 매치하지 못한 레이어 (ignore_layers 제외). */
function collectUnmappedLayers(layerText, stack, matchedLayers, ignoreLayers) {
  const unmappedLayers = [];
  for (const layer of Object.keys(layerText)) {
    if (ignoreLayers.has(layer)) continue;
    if (matchedLayers.has(layer)) continue;
    unmappedLayers.push({ layer, selectedName: stack[layer].selected.name });
  }
  return unmappedLayers;
}

/** 결과 객체 빌더 (키 정렬 + 메타 플래그 일관성). */
function makeResult(deps, devDeps, { matchedRuleIds = [], unmappedLayers = [], stackConfigMissing, catalogMissing }) {
  return {
    dependencies: sortKeys(deps),
    devDependencies: sortKeys(devDeps),
    matchedRuleIds,
    unmappedLayers,
    stackConfigMissing,
    catalogMissing,
  };
}

/**
 * stack-config 와 카탈로그로부터 시드 package.json 의 의존성을 해석한다.
 *
 * @param {object|null|undefined} stackConfig - stage-output/stack-config.json 파싱 결과
 * @param {object|null|undefined} catalog - stack-dependency-catalog.json 파싱 결과
 * @param {string} [platform='web-nextjs'] - platform 키
 * @returns {{
 *   dependencies: Record<string,string>,
 *   devDependencies: Record<string,string>,
 *   matchedRuleIds: string[],
 *   unmappedLayers: Array<{layer: string, selectedName: string}>,
 *   stackConfigMissing: boolean,
 *   catalogMissing: boolean
 * }}
 */
export function resolveStackDependencies(stackConfig, catalog, platform = 'web-nextjs') {
  const platformCatalog = getPlatformCatalog(catalog, platform);
  const stack = getStackLayers(stackConfig);
  const stackConfigMissing = stack === null;

  // 카탈로그 부재 → 빈 결과 (호출자가 fallback). fail-open (R-CM-006 Rule 2).
  if (!platformCatalog) {
    return makeResult({}, {}, { stackConfigMissing, catalogMissing: true });
  }

  const deps = { ...(platformCatalog.base.dependencies || {}) };
  const devDeps = { ...(platformCatalog.base.devDependencies || {}) };

  // stack-config 부재 → base 그대로 (현행 동작 보존, fail-open).
  if (stackConfigMissing) {
    return makeResult(deps, devDeps, { stackConfigMissing: true, catalogMissing: false });
  }

  const ignoreLayers = new Set(Array.isArray(platformCatalog.ignore_layers) ? platformCatalog.ignore_layers : []);
  const rules = Array.isArray(platformCatalog.rules) ? platformCatalog.rules : [];
  const layerText = buildLayerTextMap(stack);

  const { matchedRuleIds, matchedLayers } = applyRules(rules, layerText, deps, devDeps);
  const unmappedLayers = collectUnmappedLayers(layerText, stack, matchedLayers, ignoreLayers);

  return makeResult(deps, devDeps, { matchedRuleIds, unmappedLayers, stackConfigMissing: false, catalogMissing: false });
}
