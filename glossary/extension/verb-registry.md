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
  - { type: spec, path: ".agents/skills/extension-architecture/SKILL.md", anchor: "extension-architecture" }
  - { type: doc, path: "docs/agent-markers.md" }
code_refs:
  - { path: "content/content-script.js", symbol: "AI_VERBS" }
  - { path: "lib/ai-client.js", symbol: "buildResponseSchema" }
  - { path: "content/content-script.js", symbol: "AGENT_ALLOWED_VERBS" }
  - { path: "daemon/src/server.js", symbol: "EXECUTE_ACTIONS_VERBS" }
api_refs: []
db_refs: []
related: ["recipe", "affordance"]
last_verified: 2026-10-17
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
- 外部エージェント経路(`execute_actions` / `scripts/cdp-bridge.mjs`)を allow-list の外へ広げない。
  `AGENT_ALLOWED_VERBS`(content)と `EXECUTE_ACTIONS_VERBS`(`daemon/src/server.js`、MCP の `verb` enum)は
  同じ一覧で、`test/agent-verbs.test.mjs` が一致を検査する。`inject*` / `navigateTo` / `removeElement` /
  `submitForm` は含めず、確定/購入/削除や名前の無いボタンのクリックは `held:true` で保留する(解除の手段は渡さない)。
  `setStyle` は `agentStyleProblem` で色・枠線・文字・余白・大きさのプロパティに限り、`url()` などの外部参照を断る
  (読んだ内容の持ち出しや、要素を重ねて人に誤クリックさせることに使えるため)。重ねる・動かす・透過させる
  プロパティ(position / z-index / transform / opacity 等)は断るが、色や大きさで目立たなくすることまでは防げない。
  経路名は SW が `execute_actions` に固定し、daemon の申告を使わない。
- 秘密を含みうるページ由来のデータ(ページがクリップボードへ書いたテキスト等)を `COLLECT_CONTEXT` に自動で混ぜない。
  読む verb(`readSignals` の `clipboard`)で明示的に求めた時だけ返す。
