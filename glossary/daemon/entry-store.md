---
id: entry-store
term: "Entry Store / キャプチャ保管 (memory|hybrid|disk)"
aliases: ["entryStore", "storage mode"]
deprecated_terms: []
status: stable
owner: "@buddypia"
bounded_context: daemon
progress:
  state: shipped
  tracking: ""
source_refs:
  - { type: spec, path: "AGENTS.md", anchor: "daemon-architecture" }
  - { type: doc, path: "daemon/README.md" }
code_refs:
  - { path: "daemon/src/store.js", symbol: "normalizeStorageMode" }
api_refs: []
db_refs: []
related: ["visual-feedback"]
last_verified: 2026-06-28
confidence: high
---

## 定義

daemon がブラウザから push された注釈付きキャプチャを保持する抽象。3 モード:

- `memory`(既定): RAM 保持(FIFO 上限 50)。画像/`file_path` が実際に要求された時だけ
  OS の一時ディレクトリへ materialize し、`cleanup()` で破棄。`<Downloads>/ai-inbox` を作らない。
- `hybrid`: 同様だが materialize 先が実 `<inbox>/<slug>/`。
- `disk`: WS push のたびに即書き込み(`writeEntry`)。`list`/retention/再起動跨ぎの履歴はこのモードのみ。

`normalizeStorageMode` が文字列入力を上記モードへ正規化する。

## 不変条件

- 2 つの image ツールの Codex⇔Claude-Code パリティ(`structuredContent` を付けない)は
  全モードで不変。
