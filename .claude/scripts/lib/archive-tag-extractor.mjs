#!/usr/bin/env node
/**
 * Archive Tag Extractor (R-CM-032)
 *
 * archive-and-reset 시점에 stage-output JSON 에서 4축 taxonomy tag 자동 추출.
 *
 * 4축:
 *   - business_model (business-context.json#business_model)
 *   - revenue_model (business-context.json#revenue_model)
 *   - geography (business-context.json#geographic_target — array or string)
 *   - domain_keywords (business-context.json#description — Korean morpheme + 영어 키워드)
 *
 * 의도적 단순화 (P0):
 *   - morpheme 분석은 외부 라이브러리 미사용 (한국어 단어 추출 heuristic)
 *   - embedding 미사용 — keyword frequency + 사전 stop-words 만
 *   - P1 에서 embedding/morpheme 라이브러리 도입 검토
 */

const BUSINESS_MODELS = ['B2C', 'B2B', 'B2B2C', 'marketplace'];
const REVENUE_MODELS = ['freemium', 'subscription', 'transaction', 'sponsored', 'one_time'];

// 한국어 stop-words (의미 약한 조사/어미/대명사)
const STOP_WORDS_KO = new Set([
  '있다', '없다', '이다', '하다', '되다', '같은', '같이', '대한', '대해',
  '위한', '위해', '이상', '이하', '관련', '경우', '때문', '다음', '이전',
  '먼저', '나중', '계속', '진행', '확정', '확인', '결정', '예정', '가능',
  '필요', '많이', '많은', '적은', '정도', '약간', '모두', '모든', '전체',
  '일부', '바로', '직접', '간접', '아예', '이미', '그런', '저런', '이런',
  '하지만', '그러나', '그리고', '또한', '또는',
]);

const STOP_WORDS_EN = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'can', 'this', 'that', 'these', 'those',
  'and', 'or', 'but', 'if', 'then', 'else', 'for', 'with', 'from', 'to',
  'in', 'on', 'at', 'by', 'of', 'object', 'mvp', 'from-research',
]);

const DOMAIN_SIGNAL_PATTERNS = [
  [/pptx|powerpoint|パワーポイント|파워포인트/gi, 'pptx'],
  [/google\s+slides|slides|スライド|슬라이드/gi, 'slides'],
  [/presentation|presentations|プレゼン|提案資料|프레젠테이션|발표자료|제안서/gi, 'presentation'],
  [/template|templates|テンプレート|템플릿/gi, 'template'],
  [/\bai\b|人工知能|인공지능/gi, 'ai'],
  [/saas/gi, 'saas'],
  [/upload|アップロード|업로드/gi, 'upload'],
  [/export|書き出し|出力|내보내기|출력/gi, 'export'],
  [/remix|リミックス|再構成|리믹스|재구성|정리/gi, 'remix'],
  [/brand|branding|ブランド|브랜드/gi, 'brand'],
  [/editable|編集可能|編集|편집/gi, 'editable'],
  [/deck|decks|資料|덱|자료/gi, 'deck'],
  [/consultant|consultants|コンサルタント|컨설턴트/gi, 'consultant'],
  [/founder|founders|創業者|창업자/gi, 'founder'],
  [/marketer|marketers|マーケター|마케터/gi, 'marketer'],
  [/privacy|security|プライバシー|セキュリティ|개인정보|보안/gi, 'privacy'],
];

// 흔한 한국어 조사 — 단어 끝에서 strip (의미 손실 최소)
const KOREAN_PARTICLES = [
  '으로써', '으로서', '에서는', '에서도', '에게서', '으로부터', '에서의',
  '으로', '에서', '에게', '한테', '에게서',
  '이며', '이고', '이라', '이라고', '입니다', '입니다',
  '들이', '들을', '들의', '들에', '들과',
  '를', '을', '이', '가', '은', '는', '의', '도', '만', '에', '와', '과', '도', '나',
];

function stripKoreanParticles(word) {
  let w = word;
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of KOREAN_PARTICLES) {
      if (w.endsWith(p) && w.length > p.length + 1) {
        w = w.slice(0, -p.length);
        changed = true;
        break;
      }
    }
  }
  return w;
}

/**
 * business-context.json 에서 4축 tag 추출.
 * @param {object} businessContext - parsed business-context.json
 * @returns {{ business_model, revenue_model, geography, domain_keywords }}
 */
export function extractTagsFromBusinessContext(businessContext) {
  const bc = businessContext || {};
  const searchableText = collectText([
    bc.business_description,
    bc.description,
    bc.value_proposition,
    bc.problem_statement,
    bc.solution_concept,
    bc.business,
    bc.target_users,
    bc.constraints,
    bc.forcing_answers,
    bc.interpretation,
  ]);

  // business_model
  const rawBM = collectText([
    bc.business_model,
    bc.model,
    bc.business?.business_model,
    bc.business?.model,
    bc.business?.domain,
  ]);
  const business_model = inferBusinessModel(rawBM, searchableText);

  // revenue_model
  const rawRM = collectText([
    bc.revenue_model,
    bc.business?.revenue_model,
    bc.business?.model,
    bc.pricing,
  ]).toLowerCase();
  let revenue_model = 'unknown';
  for (const m of REVENUE_MODELS) {
    if (rawRM.includes(m)) { revenue_model = m; break; }
  }

  // geography
  let geography = [];
  const rawGeo = bc.geographic_target || bc.geography || null;
  if (Array.isArray(rawGeo)) {
    geography = rawGeo.map(g => normalizeGeo(g.toString())).filter(Boolean);
  } else if (typeof rawGeo === 'string' && rawGeo) {
    geography = [normalizeGeo(rawGeo)].filter(Boolean);
  }
  if (geography.length === 0) geography = inferGeography(searchableText);
  if (geography.length === 0) geography = ['unknown'];

  const domain_keywords = extractKeywords(searchableText, 10);

  return { business_model, revenue_model, geography, domain_keywords };
}

function collectText(value, acc = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, acc);
    return acc.join(' ');
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectText(v, acc);
    return acc.join(' ');
  }
  if (typeof value === 'string' && value.trim()) acc.push(value.trim());
  return acc.join(' ');
}

function inferBusinessModel(rawBM, text) {
  const raw = (rawBM || '').toString().toUpperCase();
  for (const m of BUSINESS_MODELS) {
    if (raw.includes(m)) return m;
  }
  if (/MARKETPLACE|マッチング|마켓플레이스/.test(raw)) return 'marketplace';

  const lower = `${rawBM || ''} ${text || ''}`.toLowerCase();
  const hasBusinessBuyer = /b2b|enterprise|business|company|team|corporate|法人|企業|会社|チーム|팀|기업/.test(lower);
  const hasIndividualBuyer = /b2c|consumer|individual|solo|founder|creator|consultant|個人|創業者|コンサルタント|개인|소비자/.test(lower);

  if (hasBusinessBuyer && hasIndividualBuyer) return 'B2B2C';
  if (hasBusinessBuyer) return 'B2B';
  if (hasIndividualBuyer) return 'B2C';
  return 'unknown';
}

function inferGeography(text) {
  const t = (text || '').toLowerCase();
  const geos = new Set();
  if (/(korean|한국|kr)/.test(t)) geos.add('Korean');
  if (/(global|world|worldwide|グローバル|全球|글로벌)/.test(t)) geos.add('Global');
  if (/(us\b|united states|america|米国|アメリカ|미국|英語圏)/.test(t)) geos.add('US');
  if (/(eu\b|europe|欧州|ヨーロッパ|유럽)/.test(t)) geos.add('EU');
  if (/(jp\b|japan|日本|일본)/.test(t)) geos.add('JP');
  if (/(cn\b|china|中国|중국)/.test(t)) geos.add('CN');
  return [...geos];
}

function normalizeGeo(s) {
  const t = s.toLowerCase().trim();
  if (!t) return null;
  if (/(korean|한국|kr)/.test(t)) return 'Korean';
  if (/(global|world|글로벌|worldwide)/.test(t)) return 'Global';
  if (/(us|미국|america)/.test(t)) return 'US';
  if (/(eu|europe|유럽)/.test(t)) return 'EU';
  if (/(jp|japan|일본)/.test(t)) return 'JP';
  if (/(cn|china|중국)/.test(t)) return 'CN';
  return s.trim().slice(0, 30);
}

/**
 * 텍스트에서 키워드 N개 추출 (frequency + stop-words 제거).
 * 한국어 + 영어 mixed 지원. P0 단순 heuristic.
 * @param {string} text
 * @param {number} maxN
 * @returns {string[]}
 */
export function extractKeywords(text, maxN = 10) {
  if (!text || typeof text !== 'string') return [];

  // tokenize — 한국어 단어 (2자 이상) + 영어 단어 (3자 이상)
  const tokens = [];
  const domainSignals = extractDomainSignals(text);
  for (const signal of domainSignals) {
    tokens.push(signal, signal);
  }
  // 영문 단어
  const enMatches = text.match(/[a-zA-Z][a-zA-Z0-9\-]{2,}/g) || [];
  for (const m of enMatches) {
    const lower = m.toLowerCase();
    if (!STOP_WORDS_EN.has(lower) && lower.length >= 3) {
      tokens.push(lower);
    }
  }
  // 한국어 단어 (한글 연속 2자 이상) + 조사 stripping
  const koMatches = text.match(/[가-힯]{2,}/g) || [];
  for (const m of koMatches) {
    const stem = stripKoreanParticles(m);
    if (stem.length >= 2 && !STOP_WORDS_KO.has(stem)) {
      tokens.push(stem);
    }
  }

  // frequency
  const freq = new Map();
  for (const t of tokens) {
    freq.set(t, (freq.get(t) || 0) + 1);
  }

  // top N by frequency, tiebreak by token length (longer 우선 — 더 specific)
  const sorted = [...freq.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return b[0].length - a[0].length;
  });

  const ranked = sorted.map(([t]) => t);
  const prioritized = [];
  const seen = new Set();
  for (const token of [...domainSignals, ...ranked]) {
    if (seen.has(token)) continue;
    seen.add(token);
    prioritized.push(token);
    if (prioritized.length >= maxN) break;
  }

  return prioritized;
}

function extractDomainSignals(text) {
  const signals = [];
  for (const [pattern, keyword] of DOMAIN_SIGNAL_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) signals.push(keyword);
  }
  return signals;
}

/**
 * Stage 1 + Stage 2 handoff JSON 에서 key_decisions top 3 추출.
 * @param {object} handoff1 - stage-1-handoff.json
 * @param {object} handoff2 - stage-2-handoff.json (optional)
 * @returns {string[]} (최대 3개, 각 ≤120자)
 */
export function extractKeyDecisions3(handoff1, handoff2) {
  const all = [];
  for (const h of [handoff1, handoff2]) {
    if (h && Array.isArray(h.key_decisions)) {
      for (const kd of h.key_decisions) {
        const desc = (kd.description || kd.decision || '').toString();
        const conf = typeof kd.confidence === 'number' ? kd.confidence : 0;
        if (desc) all.push({ desc, conf });
      }
    }
  }
  // confidence 내림차순
  all.sort((a, b) => b.conf - a.conf);
  return all.slice(0, 3).map(x => x.desc.slice(0, 120));
}

/**
 * stage-1 handoff 에서 evidence_summary 추출.
 * @param {object} handoff1
 * @returns {{ T1, T2, T3, grade }}
 */
export function extractEvidenceSummary(handoff1) {
  const h = handoff1 || {};
  const eb = h.evidence_breakdown || {};
  const T1 = Array.isArray(eb.T1_direct) ? eb.T1_direct.length : (eb.T1 || 0);
  const T2 = Array.isArray(eb.T2_inferred) ? eb.T2_inferred.length : (eb.T2 || 0);
  const T3 = Array.isArray(eb.T3_assumed) ? eb.T3_assumed.length : (eb.T3 || 0);
  const grade = h.evidence_grade || 'D';
  return { T1, T2, T3, grade };
}

/**
 * stage-2 market-research.json 에서 viability_score 추출.
 * @param {object} marketResearch
 * @returns {number|null}
 */
export function extractViabilityScore(marketResearch) {
  if (!marketResearch || !marketResearch.viability_score) return null;
  const t = marketResearch.viability_score.total;
  return typeof t === 'number' ? t : null;
}

/**
 * archive 안의 stages_summary 에서 completed stage 목록 추출.
 * @param {object} archiveMeta - _archive-meta.json
 * @returns {string[]}
 */
export function extractStageProgress(archiveMeta) {
  const ss = (archiveMeta && archiveMeta.stages_summary) || {};
  return Object.entries(ss)
    .filter(([, v]) => v && v.status === 'completed')
    .map(([k]) => k);
}
