---
id: verb-registry
term: "Verb Registry / 動詞レジストリ"
aliases: ["AI_VERBS", "動詞カタログ", "verb catalog"]
deprecated_terms: ["command list"]
status: stable
owner: "@buddypia"
bounded_context: extension
progress:
  state: shipped
  tracking: ""
source_refs:
  - { type: spec, path: "AGENTS.md", anchor: "extension-architecture" }
  - { type: doc, path: "docs/agent-markers.md" }
code_refs:
  - { path: "content/content-script.js", symbol: "AI_VERBS" }
  - { path: "lib/ai-client.js", symbol: "buildResponseSchema" }
api_refs: []
db_refs: []
related: ["recipe", "affordance"]
last_verified: 2026-06-28
confidence: high
---

## 定義

LLM が発行できる操作の **閉じた決定的集合**。`content/content-script.js` の `AI_VERBS`
(約40の verb)が唯一の真実で、`lib/ai-client.js` の `buildResponseSchema` が
Structured Outputs の enum としてそれを強制する。LLM は `AI_VERBS` に存在しない verb を
発行できない。

能力の追加 = `AI_VERBS` に verb を1つ足すこと。それが prompt とスキーマの両方へ自動的に流れる。

## やってはいけないこと

- 自由形式の DOM 操作を足さない(レジストリを開いてはいけない)。
- 高リスク verb(`setStyle` / `removeElement` / `defineMarker`)を chat 経路に晒さない。
