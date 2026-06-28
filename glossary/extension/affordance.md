---
id: affordance
term: "Affordance / 操作可能要素 (data-bag-id)"
aliases: ["aiId", "data-bag-id", "affordance annotation"]
deprecated_terms: []
status: stable
owner: "@buddypia"
bounded_context: extension
progress:
  state: shipped
  tracking: ""
source_refs:
  - { type: spec, path: "AGENTS.md", anchor: "extension-architecture" }
code_refs:
  - { path: "content/content-script.js", symbol: "data-bag-id" }
api_refs: []
db_refs: []
related: ["verb-registry"]
last_verified: 2026-06-28
confidence: high
---

## 定義

ページ内の操作可能な要素に、content script が **ドキュメント順で決定的に** 付与する
安定 ID(例 `button#3`)。属性名は `data-bag-id`。LLM はこの ID(`aiId`)で要素を指し、
verb 実行時の要素解決は `aiId > selector > injectedId` の優先順で行われる。

決定性が load-bearing: 同じページなら毎回同じ ID が振られることで、recipe の再生と
お描き注釈のアンカーが破綻しない。
