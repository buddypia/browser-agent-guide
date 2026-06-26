# REVIEW — daemon の既定 storage を `memory` 化（inbox 完全撤去）

## 概要
視覚フィードバック daemon の既定 storage を `disk` から **`memory`** に変更し、ユーザーの
`<Downloads>/ai-inbox/` を**一切作らない**経路を既定にした。`memory` は受信した合成 PNG を
RAM 保持し、image/`file_path` 要求時だけ**プロセス専用の OS tmp** に一時 materialize して
終了時に破棄する。永続化・履歴・retention が要る人向けに `hybrid` / `disk` を明示オプトインとして残す。

## なぜ (背景)
「Chrome 拡張 × MCP 連携で inbox（ディスク上の `ai-inbox/<slug>/` ステージング）を完全に消せるか」
という要望への回答。調査で確認した前提:
- MCP 仕様は画像を inline `ImageContent`（base64）で返せる＝ファイル不要（Claude Code は inline 解釈可）。
- MCP Streamable HTTP は stateless 設計で、状態はメモリ＋明示ハンドル（`contextId`）で持てる。
- MV3 拡張はサーバを待ち受けられない（`chrome.sockets.tcpServer` は Apps 専用）ため daemon プロセス自体は
  消せないが、**daemon がディスクにステージングする必要はない**。
- 既存コードに in-memory `entryStore`（`hybrid`）が既にあり土台が揃っていた。

## 何を (変更点)
- `daemon/src/store.js`: storage に **`memory`** モードを追加（`hybrid` と共通の memory-backed store を共有化）。
  `memory` の `materialize()` は inbox ではなく `mkdtemp` の OS tmp に書き、`cleanup()` で破棄。
  `normalizeStorageMode` を `memory`/`hybrid`/`disk` の3値に（旧: `memory`→`hybrid` alias を廃止）。
- `daemon/src/index.js`: 既定を `memory` に。起動 stderr のモード説明、終了時 `entryStore.cleanup()`、使い方コメント。
- `daemon/test/store.test.mjs`: `normalizeStorageMode` の期待値更新＋`memory` モードの統合テスト追加。
- `daemon/scripts/e2e-smoke.mjs`: ディスク+retention 検証スモークなので `--storage disk` を明示。
- `daemon/README.md` / `AGENTS.md`: 3モード化・既定 `memory`・`store.js` の挙動を反映。

## どうやって (検証)
`hybrid` の挙動は不変のまま materialize 先だけ mode 分岐。`memory` は既存の「materialize 失敗時も
inline image + `shot_url` で返す」経路（既にテスト済み）と同型で、file_path を OS tmp に出す点だけが違う。
既存の回帰ガード（Codex `structuredContent` なし、memory-first、disambiguate-latest、stale window）は据え置き。
- `daemon npm test`: **86 件 green**（新規 memory 統合テスト含む）。
- 実バイナリ: 既定 `memory` で **inbox 未作成**＋image は inline＋OS tmp の `file_path`、`--storage disk` で
  従来の e2e-smoke（push→MCP→retention）が通ることを確認。
- `node --check src/store.js src/index.js` OK。

## 影響
- 既定で daemon-ON でも `ai-inbox` ツリーが作られない（Claude Code はディスク完全不使用）。
- `--storage` 未指定の常駐サービス（install-service）も memory＝再起動で揮発。永続化が要るなら
  `--storage disk`/`hybrid` を明示（README/起動ログ/コメントに明記）。
- Codex は inline base64（rmcp）＋ OS tmp の `file_path`（`view_image` 可）/ `shot_url` で取得。

## トレードオフ / 留意
- `memory` は再起動跨ぎの永続化・`list_visual_feedback` 履歴・retention/`done/` を持たない（割り切り）。
  → 必要時は `--storage hybrid`（遅延 inbox）/ `disk`（即時 inbox）。
- OS tmp はプロセス crash 時に残りうるが、ユーザーの Downloads は汚さない（OS 側で自浄）。

## 残作業
- なし（必須）。任意: 拡張オプション UI 文言やリリースノートへの反映は別 PR でも可。

## ファイル構造（変更）
```
AGENTS.md                     # 既定 memory・3モード・store.js を反映
daemon/README.md              # storage mode（memory/hybrid/disk）章を更新
daemon/scripts/e2e-smoke.mjs  # --storage disk を明示
daemon/src/index.js           # 既定 memory・起動ログ・終了時 cleanup・使い方
daemon/src/store.js           # memory モード追加（OS tmp materialize + cleanup）
daemon/test/store.test.mjs    # normalizeStorageMode 更新 + memory 統合テスト
```

## レビュー依頼
- 既定を `memory` にする判断（永続化を opt-in に降格）でよいか。常駐サービスのユーザー影響の許容可否。
- `memory` の materialize 先を OS tmp にする実装（cleanup タイミング・crash 時残留）の妥当性。
- Codex 利用者向けに OS tmp の `file_path` で十分か（純 inline 不可ビルドの `view_image` 対応）。
