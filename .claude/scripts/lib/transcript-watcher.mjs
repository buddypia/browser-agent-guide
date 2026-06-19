/**
 * transcript-watcher.mjs — fs.watch 기반 변경 감지 (Observatory SSE 용)
 *
 * R-CM-035 invariant: read-only. fs.watch 는 reading. write 없음.
 * R-CM-006 fail-open: watch 실패 시 silent skip (서버 기동 차단 금지).
 *
 * Node fs.watch recursive 동작:
 * - macOS (FSEvents) / Windows (ReadDirectoryChangesW): 표준 recursive.
 * - Linux (inotify): Node 20+ 부터 native recursive 지원.
 * Source: https://nodejs.org/api/fs.html#fswatchfilename-options-listener
 *
 * 디바운스 의도: jsonl append 가 매 줄마다 watch event 발생하므로 raw 트리거를
 * 직접 SSE 로 보내면 flood. 500ms 디바운스 후 단일 event.
 */

import { watch, existsSync } from 'node:fs';

const DEFAULT_DEBOUNCE_MS = 500;

/**
 * 복수 디렉터리를 watch 하고 변경을 디바운스해서 onChange callback 호출.
 *
 * @param {object} opts
 * @param {string[]} opts.roots - watch 대상 디렉터리 절대경로 배열. 부재 path 는 skip.
 * @param {(payload: {ts: string, source: string}) => void} opts.onChange - 디바운스된 변경 callback
 * @param {number} [opts.debounceMs=500] - 디바운스 시간
 * @returns {{close: () => void}} watcher 핸들 — close 호출 시 모든 watch + timer 정리
 */
export function createTranscriptWatcher(opts) {
  const onChange = typeof opts?.onChange === 'function' ? opts.onChange : () => {};
  const roots = Array.isArray(opts?.roots) ? opts.roots : [];
  const debounceMs = Number.isFinite(opts?.debounceMs) ? opts.debounceMs : DEFAULT_DEBOUNCE_MS;

  const watchers = [];
  let pendingSource = null;
  let timer = null;

  for (const root of roots) {
    if (typeof root !== 'string' || root.length === 0) continue;
    if (!existsSync(root)) continue;
    try {
      // recursive: macOS FSEvents / Linux inotify (Node 20+). 한 root 디렉터리 +
      // 하위 jsonl 까지 모두 cover.
      const w = watch(root, { recursive: true, persistent: false }, (eventType, filename) => {
        // jsonl 만 surface (다른 파일은 ignore). filename null 가능 (Windows).
        if (filename && !filename.endsWith('.jsonl')) return;
        pendingSource = root;
        if (timer) return;
        timer = setTimeout(() => {
          const ts = new Date().toISOString();
          const source = pendingSource;
          timer = null;
          pendingSource = null;
          try {
            onChange({ ts, source });
          } catch {
            // R-CM-006 fail-open: callback 에러가 watcher 자체를 죽이지 않게 흡수.
          }
        }, debounceMs);
      });
      w.on('error', () => {
        // watch 자체 에러도 fail-open (Linux inotify exhaustion 등 일시 이슈).
      });
      watchers.push(w);
    } catch {
      // fail-open: 한 root 실패가 다른 root watching 을 막지 않게.
    }
  }

  return {
    close() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          // ignore
        }
      }
      watchers.length = 0;
    },
  };
}
