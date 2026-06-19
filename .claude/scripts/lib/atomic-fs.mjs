/**
 * atomic-fs.mjs — system_persistent 파일의 원자적 쓰기 + jsonl append 헬퍼.
 *
 * R-CM-030 worktree 통일 (PLAN.md S1) 의 일부. system_persistent SSOT 가
 * worktree 간 공유될 때 발생할 수 있는 read-modify-write race condition 을
 * 최소 비용으로 차단한다 (단일 사용자 CLI 가정 + low contention).
 *
 * 설계 원칙:
 *   - POSIX rename(2) 의 같은-디렉토리 원자성에 의존 (외부 라이브러리 회피)
 *   - 부분 쓰기 흔적 (`<file>.tmp`) 은 동일 디렉토리에 생성 후 rename
 *   - jsonl 은 O_APPEND 로 fs.appendFile 사용 (POSIX 는 PIPE_BUF 이하 atomic)
 *   - fail-soft: 쓰기 실패 시 tmp 파일 cleanup 시도
 *
 * R-CM-029 Rule 6 (Source-Driven):
 *   - Node.js fs.rename: 같은 파일시스템 안에서 atomic rename 보장
 *     (Node.js docs nodejs.org/api/fs.html, accessed 2026-05-11)
 *   - POSIX write(2) O_APPEND: PIPE_BUF (Linux=4096) 이하 단일 write atomic
 *     (Linux man-pages, accessed 2026-05-11)
 *   - 외부 lockfile 라이브러리 (proper-lockfile 등) 는 단일 사용자 CLI 환경
 *     에서 over-engineering — stdlib 두 보장으로 충분.
 */

import { writeFile, rename, appendFile, mkdir, unlink } from 'node:fs/promises';
import {
  writeFileSync,
  renameSync,
  mkdirSync,
  unlinkSync,
  existsSync,
  appendFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * JSON 객체를 atomic 하게 파일에 쓴다.
 *
 * 동작:
 *   1. 대상 디렉토리 mkdir -p
 *   2. 같은 디렉토리에 `.<basename>.tmp.<rand>` 임시 파일 작성
 *   3. fs.rename 으로 원자적 교체
 *   4. 실패 시 임시 파일 cleanup
 *
 * @param {string} path - 대상 절대 경로
 * @param {unknown} data - 직렬화 대상 (JSON.stringify 가능해야 함)
 * @param {object} [opts]
 * @param {number} [opts.spaces=2] - JSON.stringify 의 spaces 인자
 * @returns {Promise<void>}
 */
export async function writeJsonAtomic(path, data, opts = {}) {
  const { spaces = 2 } = opts;
  const dir = dirname(path);
  const base = path.slice(dir.length + 1);
  const rand = randomBytes(6).toString('hex');
  const tmp = join(dir, `.${base}.tmp.${rand}`);

  await mkdir(dir, { recursive: true });
  try {
    const payload = JSON.stringify(data, null, spaces) + '\n';
    await writeFile(tmp, payload, 'utf-8');
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * JSONL 파일에 한 줄을 append 한다.
 *
 * jsonl 은 line-oriented 이므로 read-modify-write 가 아닌 append-only.
 * POSIX O_APPEND 모드는 PIPE_BUF 이하 단일 write 의 atomicity 를 보장한다.
 * brief2dev learnings entry 는 일반적으로 1KB 미만 → PIPE_BUF (Linux 4096)
 * 안에서 동작하므로 동시 append 가 발생해도 라인 인터리브 위험 없음.
 *
 * @param {string} path - 대상 절대 경로
 * @param {unknown} entry - 1줄로 직렬화될 객체
 * @returns {Promise<void>}
 */
export async function appendJsonlAtomic(path, entry) {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const line = JSON.stringify(entry) + '\n';
  await appendFile(path, line, 'utf-8');
}

/**
 * JSONL 파일에 한 줄을 append 한다 (sync 버전).
 *
 * appendJsonlAtomic(async 형제) 과 동일한 보장:
 *   - O_APPEND 단일 write — Linux ext4/xfs 는 실용적 atomic. macOS APFS/NFS/Windows 는 보장이
 *     약하나, brief2dev 는 단일 사용자 단일 프로세스 동기 호출이라 라인 인터리브 위험 없음.
 *   - 대상 디렉토리 자동 mkdir -p
 *   - throw on failure (silent fail 차단 — R-CM-010 정합)
 *
 * 사용 위치 (sync 호출 사이트 — WebUI 위임 mutator 의 audit append 등):
 *   - decision-mutator.mjs#answerDecision (decision-answer audit trail)
 *
 * @param {string} path - 대상 절대 경로
 * @param {unknown} entry - 1줄로 직렬화될 객체
 * @returns {void}
 */
export function appendJsonlAtomicSync(path, entry) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify(entry) + '\n';
  appendFileSync(path, line, 'utf-8');
}

/**
 * JSON 객체를 atomic 하게 파일에 쓴다 (sync 버전).
 *
 * writeJsonAtomic 과 동일한 보장:
 *   - POSIX rename(2) atomic 교체
 *   - randomBytes(6) unique tmp 명 — multi-worktree 동시 호출 race 차단
 *   - 실패 시 임시 파일 cleanup
 *   - throw on failure (silent fail 차단 — R-CM-010 정합)
 *
 * 사용 위치 (sync 호출 사이트 — child_process 호출 / CLI script 등):
 *   - followup-debt-tracker.mjs#saveDebt
 *   - archive-and-reset.mjs#writeMeta / updateArchiveIndex
 *
 * @param {string} path - 대상 절대 경로
 * @param {unknown} data - 직렬화 대상 (JSON.stringify 가능해야 함)
 * @param {object} [opts]
 * @param {number} [opts.spaces=2] - JSON.stringify 의 spaces 인자
 * @returns {void}
 */
export function writeJsonAtomicSync(path, data, opts = {}) {
  const { spaces = 2 } = opts;
  const dir = dirname(path);
  const base = path.slice(dir.length + 1);
  const rand = randomBytes(6).toString('hex');
  const tmp = join(dir, `.${base}.tmp.${rand}`);

  mkdirSync(dir, { recursive: true });
  try {
    const payload = JSON.stringify(data, null, spaces) + '\n';
    writeFileSync(tmp, payload, 'utf-8');
    renameSync(tmp, path);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* tmp cleanup best-effort */
    }
    throw err;
  }
}

/**
 * 일반 텍스트(markdown 등)를 atomic 하게 파일에 쓴다 (sync 버전).
 *
 * writeJsonAtomicSync 와 동일한 보장이나 직렬화하지 않고 raw 문자열을 그대로 쓴다.
 *   - POSIX rename(2) atomic 교체
 *   - randomBytes(6) unique tmp 명 — multi-worktree 동시 호출 race 차단
 *   - 실패 시 임시 파일 cleanup
 *   - throw on failure (silent fail 차단 — R-CM-010 정합)
 *
 * 호출자가 trailing newline 을 책임진다 (JSON 처럼 자동 부착하지 않음).
 *
 * 사용 위치 (sync 호출 사이트 — CLI script 가 markdown 산출물을 부분 교체):
 *   - docs-index-build.mjs#writeIndex (docs/index.md AUTO 섹션 교체)
 *
 * @param {string} path - 대상 절대 경로
 * @param {string} text - 기록할 raw 텍스트 (그대로 기록)
 * @returns {void}
 */
export function writeTextAtomicSync(path, text) {
  const dir = dirname(path);
  const base = path.slice(dir.length + 1);
  const rand = randomBytes(6).toString('hex');
  const tmp = join(dir, `.${base}.tmp.${rand}`);

  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(tmp, String(text), 'utf-8');
    renameSync(tmp, path);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* tmp cleanup best-effort */
    }
    throw err;
  }
}
