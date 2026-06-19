/**
 * transcript.mjs — Transcript 파싱 모듈
 *
 * Claude Code Hooks의 transcript_path를 읽어서:
 * 1) 완료 마커 (<promise>...</promise>) 감지
 * 2) QA 완료 상태 (정적 분석 + 테스트) 감지
 * 3) 코드 변경 후 정적 분석 결과 감지
 *
 * Web/Node 프로젝트에서 동작하도록
 * 파일 확장자와 출력 패턴을 확장.
 */

import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/** 대용량 transcript 대응: 최대 1MB만 읽기 */
const MAX_READ_BYTES = 1 * 1024 * 1024;

/** 추적 대상 소스 확장자 (Web/Node) */
const TRACKED_SOURCE_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.html',
  '.vue',
  '.svelte',
  '.astro',
  '.json',
  '.yaml',
]);

/**
 * Lint 검증이 필요한 확장자 (TRACKED_SOURCE_EXTENSIONS의 서브셋).
 * .json 등 설정 파일은 lint 에러를 직접 생성하지 않으므로 제외.
 */
const LINT_REQUIRED_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.html',
  '.vue',
  '.svelte',
  '.astro',
]);

/** 추적 제외 경로 */
const IGNORED_PATH_SEGMENTS = [
  '/node_modules/',
  '/dist/',
  '/build/',
  '/coverage/',
  '/.next/',
  '/.nuxt/',
  '/.svelte-kit/',
  '/out/',
  '/.turbo/',
  '/docs/',
  '/.claude/',
];

/** 자동 생성 산출물 파일명 패턴 */
const GENERATED_FILE_PATTERNS = [
  /\.min\.(js|css)$/i,
  /\.bundle\.(js|css)$/i,
  /\.map$/i,
  /\.generated\.(ts|js)$/i,
];

const ANALYZE_PASS_PATTERNS = [
  /\bno issues found\b/i,
  /\b0 issues? found\b/i,
  /\bno lint(?:ing)? (?:warnings? or )?errors?\b/i,
  /\blint[_\s]passed\b/i,
  /\blint(?:ing)? passed\b/i,
  /\b0 problems?\b/i,
  /eslint.*no warnings? or errors?/i,
  /\bfound 0 errors?\b/i,
  /\btype[\s-]?check(?:ing)? (?:passed|succeeded)\b/i,
  /\banalyze[_\s]passed\b/i,
];

const ANALYZE_FAIL_PATTERNS = [
  /\b[1-9]\d*\s+issues?\s+found\b/i,
  /\b[1-9]\d*\s+problems?\b/i,
  /\b✖\s*[1-9]\d*\s+problems?\b/i,
  /\beslint\b.*\b(error|failed)\b/i,
  /\blint(?:ing)? failed\b/i,
  /\btype[\s-]?check(?:ing)? failed\b/i,
  /\bfound [1-9]\d*\s+errors?\b/i,
];

const TEST_PASS_PATTERNS = [
  /\ball tests? passed\b/i,
  /\ball \d+ tests? passed\b/i,
  /\btest suites?:\s*\d+\s+passed,\s*0\s+failed\b/i,
  /\btests?:\s*\d+\s+passed,\s*0\s+failed\b/i,
  /\btest files?\s+\d+\s+passed\b/i,
];

const TEST_FAIL_PATTERNS = [
  /\bsome tests? failed\b/i,
  /\b[1-9]\d*\s+tests?\s+failed\b/i,
  /\btest suites?:\s*[1-9]\d*\s+failed\b/i,
  /\btests?:\s*[1-9]\d*\s+failed\b/i,
  /^\s*FAIL\b/i,
  /\bfailing\b/i,
];

/**
 * ~ 경로 확장
 */
function resolvePath(path) {
  if (!path) return null;
  if (path.startsWith('~')) return join(homedir(), path.substring(1));
  return path;
}

/**
 * Transcript 내용 읽기 (대용량 파일 대응)
 */
function readTranscriptContent(resolvedPath) {
  const stat = statSync(resolvedPath);

  if (stat.size <= MAX_READ_BYTES) {
    return readFileSync(resolvedPath, 'utf-8');
  }

  const fd = openSync(resolvedPath, 'r');
  try {
    const buffer = Buffer.alloc(MAX_READ_BYTES);
    readSync(fd, buffer, 0, MAX_READ_BYTES, stat.size - MAX_READ_BYTES);

    let content = buffer.toString('utf-8');
    const firstNewline = content.indexOf('\n');
    if (firstNewline > 0) content = content.substring(firstNewline + 1);
    return content;
  } finally {
    closeSync(fd);
  }
}

function isIgnoredPath(fp) {
  const normalized = fp.replace(/\\/g, '/');
  return IGNORED_PATH_SEGMENTS.some((seg) => normalized.includes(seg));
}

function isGeneratedFile(fp) {
  return GENERATED_FILE_PATTERNS.some((pattern) => pattern.test(fp));
}

/**
 * Web/Node 중심 추적 대상 파일 판정.
 * (레거시 TypeScript도 지원)
 */
function isTrackedSourceFile(fp) {
  if (!fp || typeof fp !== 'string') return false;
  if (isIgnoredPath(fp)) return false;
  if (isGeneratedFile(fp)) return false;

  const normalized = fp.replace(/\\/g, '/');
  const dotIndex = normalized.lastIndexOf('.');
  if (dotIndex === -1) return false;
  const ext = normalized.slice(dotIndex).toLowerCase();
  return TRACKED_SOURCE_EXTENSIONS.has(ext);
}

/**
 * Lint 검증이 필요한 파일 판정.
 * .json 등 설정 파일을 제외하고, lint 대상 소스 파일만 감지한다.
 */
function isLintRequiredFile(fp) {
  if (!fp || typeof fp !== 'string') return false;
  if (isIgnoredPath(fp)) return false;
  if (isGeneratedFile(fp)) return false;

  const normalized = fp.replace(/\\/g, '/');
  const dotIndex = normalized.lastIndexOf('.');
  if (dotIndex === -1) return false;
  const ext = normalized.slice(dotIndex).toLowerCase();
  return LINT_REQUIRED_EXTENSIONS.has(ext);
}

/**
 * Transcript에서 마지막 사용자 메시지 위치를 검색한다.
 */
function findLastUserMessageIndex(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === 'user') return i;
    } catch {
      continue;
    }
  }
  return -1;
}

/**
 * Transcript에서 마지막 소스 변경(Write/Edit) 위치를 검색한다.
 *
 * Claude Code transcript 실제 형식:
 * - assistant.message.content[].{type:'tool_use', name:'Edit|Write', input.file_path}
 * 레거시/테스트 형식:
 * - top-level tool_name/name + input.file_path
 */
function findLastCodeChangeIndex(lines, fileChecker = isTrackedSourceFile) {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);

      if (entry.type === 'assistant') {
        const content = entry.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'tool_use' && (block.name === 'Write' || block.name === 'Edit')) {
              const fp = block.input?.file_path || '';
              if (fileChecker(fp)) return i;
            }
          }
        }
      }

      const toolName = entry.tool_name || entry.name || '';
      const filePath = entry.input?.file_path || entry.tool_input?.file_path || '';
      if ((toolName === 'Write' || toolName === 'Edit') && fileChecker(filePath)) {
        return i;
      }
    } catch {
      continue;
    }
  }
  return -1;
}

function hasPattern(line, patterns) {
  return patterns.some((pattern) => pattern.test(line));
}

function parseAnalyzeResult(line) {
  if (hasPattern(line, ANALYZE_FAIL_PATTERNS)) return false;
  if (hasPattern(line, ANALYZE_PASS_PATTERNS)) return true;
  return null;
}

function parseTestResult(line) {
  if (hasPattern(line, TEST_FAIL_PATTERNS)) return false;

  if (hasPattern(line, TEST_PASS_PATTERNS)) return true;

  if (/0\s+failed/i.test(line) && /(test|suite|spec|jest|vitest)/i.test(line)) {
    return true;
  }

  return null;
}

/**
 * 완료 마커 검색.
 * user 타입 엔트리는 스킵 (완료 마커는 assistant만 출력).
 */
export function detectCompletionMarker(transcriptPath, marker) {
  const path = resolvePath(transcriptPath);
  if (!path || !existsSync(path)) return false;

  try {
    const content = readTranscriptContent(path);
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`<promise>\\s*${escaped}\\s*</promise>`, 'is');

    const lines = content.split('\n').filter((l) => l.trim());
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'user') continue;
        if (pattern.test(line)) return true;
      } catch {
        continue;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * QA 완료 감지 (정적 분석 + 테스트).
 *
 * 2-pass 방식:
 * 1) 마지막 코드 변경 위치 감지
 * 2) 그 이후의 analyze/test 결과만 유효 처리
 */
export function detectQaCompletion(transcriptPath) {
  const NOT_FOUND = {
    complete: false,
    analyzeResult: null,
    testResult: null,
    reason: 'Transcript not available',
  };

  const path = resolvePath(transcriptPath);
  if (!path || !existsSync(path)) return NOT_FOUND;

  try {
    const content = readTranscriptContent(path);
    const lines = content.split('\n').filter((l) => l.trim());

    const lastCodeChangeIdx = findLastCodeChangeIndex(lines);
    const searchFrom = Math.max(lastCodeChangeIdx, 0);

    let analyzeResult = null;
    let testResult = null;

    for (let i = lines.length - 1; i >= searchFrom; i--) {
      const line = lines[i];

      if (analyzeResult === null) {
        const parsed = parseAnalyzeResult(line);
        if (parsed !== null) analyzeResult = parsed;
      }

      if (testResult === null) {
        const parsed = parseTestResult(line);
        if (parsed !== null) testResult = parsed;
      }

      if (analyzeResult !== null && testResult !== null) break;
    }

    const complete = analyzeResult === true && testResult === true;
    return {
      complete,
      analyzeResult,
      testResult,
      reason: complete
        ? 'All checks passed'
        : `analyze: ${analyzeResult ?? 'not run'}, test: ${testResult ?? 'not run'}`,
    };
  } catch {
    return NOT_FOUND;
  }
}

/**
 * 코드 변경 후 analyze 상태 감지 (analyze-guard용).
 */
export function detectAnalyzeStatus(transcriptPath) {
  const path = resolvePath(transcriptPath);
  if (!path || !existsSync(path)) {
    return {
      hasCodeChange: false,
      hasTypeScriptCodeChange: false, // @deprecated 레거시 호환 필드
      analyzeResult: null,
    };
  }

  try {
    const content = readTranscriptContent(path);
    const lines = content.split('\n').filter((l) => l.trim());

    // analyze-guard는 lint 대상 파일만 감지한다 (.json 등 설정 파일 제외)
    const lastCodeChangeIdx = findLastCodeChangeIndex(lines, isLintRequiredFile);
    if (lastCodeChangeIdx === -1) {
      return {
        hasCodeChange: false,
        hasTypeScriptCodeChange: false, // @deprecated 레거시 호환 필드
        analyzeResult: null,
      };
    }

    // 마지막 코드 변경이 마지막 사용자 메시지보다 앞에 있는 경우,
    // 사용자는 이미 다음 주제로 넘어갔으므로 "변경 없음"으로 처리한다.
    // 이를 통해 "질문만 하고 종료" 시 오탐을 방지한다.
    const lastUserIdx = findLastUserMessageIndex(lines);
    if (lastUserIdx > lastCodeChangeIdx) {
      return {
        hasCodeChange: false,
        hasTypeScriptCodeChange: false,
        analyzeResult: null,
      };
    }

    let analyzeResult = null;
    for (let i = lines.length - 1; i >= lastCodeChangeIdx; i--) {
      const parsed = parseAnalyzeResult(lines[i]);
      if (parsed !== null) {
        analyzeResult = parsed;
        break;
      }
    }

    // hasTypeScriptCodeChange: 하위 호환 필드 (Web 프로젝트에서는 항상 false)
    return {
      hasCodeChange: true,
      hasTypeScriptCodeChange: false,
      analyzeResult,
    };
  } catch {
    return {
      hasCodeChange: false,
      hasTypeScriptCodeChange: false,
      analyzeResult: null,
    };
  }
}

/**
 * Transcript 마지막 N줄 읽기 (디버그/분석용)
 */
export function readTranscriptTail(transcriptPath, maxLines = 20) {
  const path = resolvePath(transcriptPath);
  if (!path || !existsSync(path)) return [];

  try {
    const content = readTranscriptContent(path);
    const lines = content.split('\n').filter((l) => l.trim());
    const entries = [];

    for (let i = Math.max(0, lines.length - maxLines); i < lines.length; i++) {
      try {
        entries.push(JSON.parse(lines[i]));
      } catch {
        continue;
      }
    }

    return entries;
  } catch {
    return [];
  }
}
