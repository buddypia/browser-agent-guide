---
id: recipe
term: "Recipe / 学習レシピ"
aliases: ["learned recipe", "site rule recipe"]
deprecated_terms: []
status: stable
owner: "@buddypia"
bounded_context: extension
progress:
  state: shipped
  tracking: ""
source_refs:
  - { type: spec, path: "AGENTS.md", anchor: "main-chat-flow-page-action-end-to-end" }
code_refs:
  - { path: "lib/recipe-merge.js", symbol: "mergeRecipeActions" }
  - { path: "background/service-worker.js", symbol: "RECIPE_VERBS" }
api_refs: []
db_refs:
  - { name: "chrome.storage.local: aiAdvisorSettings", source: "lib/storage.js" }
related: ["verb-registry"]
last_verified: 2026-06-28
confidence: high
---

## 定義

ページ訪問時に決定的に再適用される、学習済みアクション列。chat で成功した recipe verb を
`rememberSuccessfulChanges` が site rule + recipe として永続化し、再訪・SPA 内部遷移時に
1度だけ再適用する。`lib/recipe-merge.js` の `mergeRecipeActions` が新規学習を既存 recipe へ
畳み込み、手編集を保持し、`verb+args+when+waitFor` で重複排除する。

永続化・再生される verb は `RECIPE_VERBS`(service worker)と `SAFE_RECIPE_VERBS`(options)の
**両方で同一**でなければならない: `injectHtml/injectCss/injectScript/outlineElement/injectButton/injectPanel`。

## 関連の不変条件

- chat 経路の Structured Outputs スキーマは `{verb,argsJson,reason}` だけを emit するため、
  chat 由来のアクションは `when`/`waitFor` を持たない。これらは recipe JSON を手編集して付与する。
