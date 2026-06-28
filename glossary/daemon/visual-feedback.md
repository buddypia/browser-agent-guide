---
id: visual-feedback
term: "Visual Feedback / お描き注釈キャプチャ"
aliases: ["お描き", "annotation capture", "drawn feedback"]
deprecated_terms: []
status: stable
owner: "@buddypia"
bounded_context: daemon
progress:
  state: shipped
  tracking: ""
source_refs:
  - { type: doc, path: "docs/visual-feedback-mvp-usage.md" }
  - { type: spec, path: "AGENTS.md", anchor: "daemon-architecture" }
code_refs:
  - { path: "lib/visual-feedback/compositor.js", symbol: "drawShape" }
  - { path: "offscreen/offscreen.js", symbol: "drawImage" }
api_refs:
  - { name: "MCP: get_latest_visual_feedback_context", spec: "daemon/src/server.js" }
  - { name: "MCP: get_latest_visual_feedback", spec: "daemon/src/server.js" }
db_refs: []
related: ["entry-store", "affordance"]
last_verified: 2026-06-28
confidence: high
---

## 定義

ユーザーがブラウザ上に描いた注釈をスクリーンショットへ合成し、AI コーディング CLI へ
MCP 経由で渡す機能。SW がアクティブ対象タブをキャプチャ → offscreen が `OffscreenCanvas` +
Canvas 2D で注釈を合成 → daemon が有効なら WS push、無効なら `chrome.downloads` で
`<download dir>/ai-inbox/<slug>/` へ保存。

`lib/visual-feedback/compositor.js` は **Canvas-2D 専用**(SVG/foreignObject/Image/drawImage 禁止。
`drawImage` は背景描画のため `offscreen.js` でのみ許可)。banned-token スキャンがビルドを守る。

## 不変条件

- 2 つの image MCP ツールは `structuredContent` を返さない(Codex⇔Claude-Code パリティ)。
- 座標は要素 rect の 0..1 分率で保存し、合成時に `factor = dpr × outputScale` で CSS px → 出力 px。
