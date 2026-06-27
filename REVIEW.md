# REVIEW — visual-feedback capture に Chrome tab metadata を流す

## 概要
Chrome 拡張の対象タブを side panel に表示し、visual-feedback capture のメタデータとして
`tab:{tabId,windowId,index,active}` を `annotation.json` / `memo.md` / daemon MCP context へ流すようにした。
daemon MCP は `tabId` / `windowId` フィルタも受け取り、同じ URL を複数タブで開いている場合でも
対象 capture を絞り込める。

## なぜ
URL/title だけでは「同じ URL を別タブで開いている」ケースを一意にできない。Chrome 拡張の実操作経路は
既に `tabId` を使っているため、capture と MCP 連携にも同じ識別子を表示・保存・返却する必要があった。
また `chrome.tabs.captureVisibleTab(windowId)` は window 内のアクティブタブを撮る API なので、対象タブが
非アクティブになった状態で manual capture すると別タブを誤撮影する恐れがあった。

## 何を
- side panel に対象 Chrome タブの `tabId` / `windowId` / タブ位置を表示。
- `GET_ACTIVE_TAB_STATE` に `windowId` / `tabIndex` / `tabActive` を追加。
- visual-feedback capture で `annotation.tab` と daemon WS payload の `tab` を保存。
- `memo.md` に Chrome tab 行を出力。
- manual capture は対象タブが非アクティブならエラーにし、auto-sync は従来どおり skip。
- daemon context/list/image text に `chrome_tab` / `tab` を出力。
- daemon MCP の latest/list 系フィルタに `tabId` / `windowId` を追加。
- README 各言語、daemon README、visual-feedback usage、AGENTS.md を更新。

## どうやって
拡張側は service worker で `chrome.tabs.get(tabId)` した `tab` から最小限の数値メタデータを作る。
保存の authority は `annotation.json` のままにして、daemon は `annotation.tab` を正規化して
`buildEntryContext` / `queryEntries` / `matchesFilter` へ流す。memory-backed store でも `entry.tab` を保持し、
disk/hybrid/memory のどの経路でも context が同じ形になるようにした。

## 影響
- MCP 利用者は `get_latest_visual_feedback_context({ urlContains, tabId })` のように指定できる。
- `tabId` は Chrome セッション内の一時IDで、閉じたタブや再起動後の永続IDではない。
- 既存の image tool の「`structuredContent` を返さない」不変条件は変更していない。
- URL/title だけでの既存フィルタや `contextId` gate は維持。

## トレードオフ
- 過去 capture の `annotation.json` には `tab` が無いので、古い entry は `tabId` フィルタでは一致しない。
  その場合は既存どおり `id` / `contextId` / `urlContains` / `titleContains` で扱う。
- manual capture の非アクティブタブエラーは一手増えるが、別タブの誤撮影を避ける安全側の挙動。

## 残作業
- なし。PR 前に `origin/main` との差分確認は必要（現在 worktree は `origin/main` に対して behind 1）。

## ファイル構造
```
background/service-worker.js     # tab metadata 保存、非アクティブ capture guard
sidepanel/sidepanel.*            # 対象タブ表示
sidepanel/locales/*.json         # 対象タブ表示と memo の多言語文言
daemon/src/inbox.js              # tab 正規化、context/list/image text、tab filter
daemon/src/server.js             # MCP schema/説明/empty/stale scope に tab filter
daemon/src/store.js              # memory store でも tab を保持
daemon/test/*.mjs                # tab context/filter 回帰
README*.md / daemon/README.md
docs/visual-feedback-mvp-usage.md
AGENTS.md
```

## レビュー依頼
- `tabId` / `windowId` を latest/list 系 filter に入れる粒度が妥当か。
- manual capture で対象タブ非アクティブ時にエラーにする UX が適切か。
- 既存の `contextId` gate と新しい `tabId` filter の説明が十分か。

## 検証
- `npm run check`
- `cd daemon && npm test`
- `git diff --check`
