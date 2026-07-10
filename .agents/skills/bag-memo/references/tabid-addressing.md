# tabId の宛先設計 — 2つの役割と、CDP との正直な違い

このスキルの**前提条件**: 「特定タブに残したメモ」を、**そのタブだけ**取り違えず取得する。鍵は **tabId**。
ただし `chrome.tabs` の `tabId` には **2つの役割**があり、混同すると静かにバグる。ここが bag-memo 固有の核心知識
(他の参照ファイルには無い)なので、bag-workflow が動いても困らないよう**自己完結**で書く。

一次情報(コード): `daemon/src/server.js`(`FILTER_SCHEMA` / image gate / `staleLatestResult` / bare 判定), `daemon/src/inbox.js`
(`matchesFilter` / `filterNumberMatches` / `buildEntryContext` / `agentLookup`), `background/service-worker.js`
(`captureVisualFeedback`→`buildTabMetadata` がキャプチャ時に tab を刻む; `getActiveTabState` はサイドパネル表示用),
`sidepanel/sidepanel.js`(copy-tabId)。

---

## 役割A — MCP の等価フィルタ＋識別子(常に使う・完全サポート)

### tabId はどこから来るか
拡張はキャプチャ時に、対象 tabId を `chrome.tabs.get(tabId)` で引き、`buildTabMetadata` で
`tab: { tabId, windowId, index, active }` を annotation.json / memo.md に刻む(`captureVisualFeedback`→`buildAnnotationJson`)。
サイドパネルの「対象タブ」欄の表示は**別経路**で、`getActiveTabState`(`chrome.tabs.query({ active: true, currentWindow: true })`、
フィールド名は `tabIndex`/`tabActive`)が供給する。ユーザーはこの欄の **copy-tabId ボタン(`#btn-copy-tab-id`)**で値をコピーして
`/bag-memo <tabId>` に渡す。
ユーザーはこの数値を `/bag-memo <tabId>` に渡す。

### daemon 側の照合は「完全一致」
MCP 5ツール(`list_feedback` / `get_latest_feedback_context` / `get_feedback_context` /
`get_latest_feedback_image` / `get_feedback_image`)の入力 `FILTER_SCHEMA` は
`{ urlContains?, titleContains?, tabId?, windowId? }` を取り、`tabId`/`windowId` は整数。
daemon は `matchesFilter` → `filterNumberMatches` で `annotation.tab.tabId` / `annotation.tab.windowId` を
**整数の完全一致**で絞る。だから「このタブのメモだけ」は文字どおり真。

> 注: `list_feedback` にも `tabId`/`windowId` を渡してよい(共有 `../bag-workflow/references/daemon-mcp.md` の表にも記載済み)。

### 「効くからくり」: tabId は曖昧解消もやる。ただし freshness ガードは別物
共有 `~/Downloads/ai-inbox` は全プロジェクト共有。daemon の安全弁は**発火条件が2種類**あり、混同しないこと:

- **disambiguate-latest(候補リスト返し)** は *素の bare 呼び出し*(`urlContains`/`titleContains`/`tabId`/`windowId`
  が**全て null**)でのみ発火する。直近ウィンドウに **≥2 の異なるホスト**があると、1件でなく**候補リスト**を返す
  (画像なし・**top-level の `id` を出さない**=他案件の id を掴ませない)。**tabId を渡すと「フィルタ枝」**
  (`queryEntries({ limit:1, tabId })`)に入り、このガードは**飛ぶ** —— tabId は「狙い撃ち」と「曖昧解消」を1手でやる。
- **stale-latest(鮮度ガード・既定90分)** は **フィルタ枝でも発火する**(`get_latest_feedback_context` /
  `get_latest_feedback_image` はフィルタ指定時も `staleLatestResult` を返す)。**tabId を渡しても、対象キャプチャが
  window より古ければ**、単一 entry でなく **text-only の「latest が古すぎます / stale」ブロック**
  (`structuredContent.tab`/`annotations` なし)が返る。つまり「tabId を渡せば必ず1件」ではない。

**回復策 / Recovery(stale が返ったら)**: (a) ブラウザ拡張で**いまの画面を再キャプチャ**する、または
(b) **freshness ガードの無い by-id ツール**で取り直す —— `list_feedback({ tabId })` で `id` を得て
`bag_page_feedback:get_feedback_context({ id })`(画像が要れば `get_feedback_image({ id, contextId: id, imageReason })`)。

逆に **`arg_kind=none`(bare)では `get_latest_*` を呼ばない** —— 先に `list_feedback` で候補を出し、tabId を選ばせる。

### 取得後の必須チェック(取り違え防止)
- **構造化側のフィールドは `tab.tabId`**(`structuredContent.tab.tabId / .windowId / .index / .active`)。
- **人間向け TEXT 側のラベルは `chrome_tab:`** で、必ず `(tabId is Chrome-session scoped)` を伴う。
- この2つは**別物**。取り違え防止チェックは **`structuredContent.tab.tabId === 要求 tabId`** で行う(TEXT の文字列ではなく)。
- 併せて `url`/`title` が狙ったページらしいかも見る(同じ tabId が別ページに再利用される可能性の保険)。不一致なら停止して再スコープ。

---

## 役割B — ライブページへのアクセス(任意・副次。正直に書く)

### できないこと
`chrome.tabs` の `tabId` は **Chrome セッション内ID**で、daemon 自身が出力に
`(tabId is Chrome-session scoped)` と添える。**外部CLIはこの番号で attach できない**:
CDP(Chrome DevTools Protocol)が公開するのは **`targetId`** であって `chrome.tabs` の `tabId` ではない。
`playwright-cli attach --cdp=…` が取るのは **CDP エンドポイント URL** で、生の tabId ではない。

> **禁止フレーズ / NEVER**: 「`playwright-cli attach <tabId>`」「tabId N に attach」。
> **Do NOT pass a raw chrome tabId to playwright-cli attach — it expects a CDP endpoint (targetId),
> not chrome.tabs tabId; tabId is identity + MCP filter, windowId+index+url is how you re-find the live target.**

### 正しい手順(どうしてもライブで確認したい時だけ)
1. ユーザーの**起動中 Chrome** を `--remote-debugging-port=9222` 付きで立ち上げてもらう
   (非エンジニアには `claude --chrome` / `/chrome` の方が簡単。`../bag-workflow/references/browser-tools.md`)。
2. `playwright-cli attach --cdp=http://127.0.0.1:9222` で接続。
3. **target を `windowId + index + url` の一致で選ぶ**(tabId は照合の“正本の識別子”として突き合わせる対象であって、attach の鍵ではない)。
4. 読み取り前に `--raw eval "location.href"` で host/URL がキャプチャの `url` と一致するか**必ず確認**。
5. **使い捨て/重複タブは開かない**。一致 target が見つからない/Chrome に繋げない場合は、**ライブ確認をスキップ**して
   静的特定(メモ＋HTML/a11y＋ソース grep)で票を出す —— このスキルは読み取り専用なので静的で十分。

### staleness(セッション再起動の注意)
`tabId` は Chrome 再起動で振り直される。**古いキャプチャ/古いコピー値**の tabId は、いまのライブタブとは
別物を指しうる。MCP フィルタとしては**保存済みキャプチャの tabId に一致**するので取得は正しいが、
ライブ再特定では `url`/`title` を最終的な拠り所にする。

---

## まとめ(1行)

- **取得(MCP)**: `tabId` は必須フィルタ＋識別子。常に渡す。取得後 `structuredContent.tab.tabId` を検証。
  (対象が古いと freshness ガードで stale ブロックになるので、by-id `get_feedback_context({ id })` で回復)
- **ライブ(任意)**: `tabId` は識別子であって attach ハンドルではない。`windowId+index+url` で再特定し、`location.href` を確認。
