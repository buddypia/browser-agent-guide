# ソース特定の優先順位 と バグ・トリアージ票

「メモを残した要素」を**コード上の `file:line`** に対応づけ、1画面のトリアージ票にするための実務リファレンス。
一次情報: `daemon/src/inbox.js` の `agentLookup`(`buildEntryContext`)と `buildEntryContextText` の
`priority:` 行が**正本**。`annotation.json` スキーマ詳細は `../bag-workflow/references/daemon-mcp.md`。

---

## 1. 特定の優先順位 — daemon の `agentLookup.priority` をそのまま辿る

サーバが返す正本の順序は次の通り(これ以外の順序を勝手に作らない):

```
dataAgentId(@agent:)  →  selector  →  testid  →  anchorLabel  →  targetCandidates  →  image
```

| 順位 | キー | 探し方 | 信頼度の目安 |
|---|---|---|---|
| 1 | `dataAgentId` (@agent:) | `rg -n 'data-agent-id="@agent:' -g '!*.md' -g '!.claude'`(**属性名込み必須**。素の `@agent:` grep 禁止。`.md`/`.claude` 除外) | 高(値が一意なら一発) |
| 2 | `selector` | 安定部分(id / class / `data-*` 断片)を `rg` / `Glob` | 中(動的生成だと外しやすい) |
| 3 | `testid` | `data-testid` 値を `rg` | 中〜高 |
| 4 | `anchorLabel` | 表示テキストを `rg -n -F '<text>'` | 中(動的ページで**最も実用的**) |
| 5 | `targetCandidates[]` | daemon が出す代替 selector/label/href を順に grep | 中〜低 |
| 6 | `image` | 下記エスケープのみ(vision) | 最後の手段 |

> **マーカーは大半の要素に未付与**(主要UI = `sidepanel.html` / `options.html` の一部のみ。正確な数は
> `rg -c 'data-agent-id="@agent:'` で確認 —— 固定値を書くと陳腐化するため数は埋め込まない)。
> よって実戦の主戦力は **4. anchorLabel** と次の追加策の **html grep**。

### 実務上の追加策(★ daemon の順序ではなく「足し算」として扱う)

これらは agentLookup の正規ランクには**無い**。便利だが「daemon の優先順位」と偽らないこと:

- **`url` が `file://`** で始まる → そのページ自体がローカル HTML = ほぼソース本体。
  そのパスを **Read** し、中で `anchorLabel` を探して行を特定(grep すら不要)。
- **`html.outerHTML` grep** → selector/anchorLabel が動的で当たらない時、outerHTML の特徴的な
  class / id / 連続した内部テキストを `rg -n -F` で探す(`html` は ≤8KB、超過時 `truncated:true`)。
- **`a11y{role,name,level,states}`** で曖昧な複数一致を絞り込む(role=button かつ name="送信" 等)。

### 確定の作法
- 最初の具体的ヒットは、**その行周辺を必ず Read して**「本当にこの要素か」を確認してから報告する。
- 出力は **1件のベスト + 最大2件の alt**。grep 全ヒットの羅列はしない。
- 各候補に **絶対 `file:line`** ＋ **confidence(高/中/低)** ＋ **resolved via(どの順位で特定したか)** を必ず添える。
- 何も解決できなければ**捏造しない**。正直に言い、opt-in の @agent: マーカー付与を提案
  (`../bag-workflow/references/agent-markers.md`)。v0 キャプチャは `html`/`a11y` が `null` なので、再アノテートを勧めてもよい。

---

## 2. confidence ルーブリック

| ラベル | 目安 |
|---|---|
| **高 / high** | `@agent:` で一意特定、または `file://` ページ本体＋anchorLabel 一致。読み返しで要素が確かに合致。 |
| **中 / med** | 一意な `anchorLabel`/`testid`、または安定 selector 断片で1〜2件に収束。 |
| **低 / low** | 一致が複数で曖昧、動的生成で当たりが弱い、または vision が要る。→ 画像エスケープを検討。 |

---

## 3. バグ・トリアージ票テンプレート

**正本(唯一のコピー)は `../SKILL.md` ステップ5**。ここでは重複再掲せず、そちらを参照する
(1画面で読める票を出し、ここで止まる — 修正・操作・検証はしない)。

### スコープ未指定/曖昧のとき
票の代わりに**候補テーブル**を出して tabId を選ばせる:

```
複数の候補があります / Multiple candidates — どの tabId か教えてください（サイドパネルの copy-tabId ボタン）:
| id | tabId | windowId | url | title | captured_at |
|----|-------|----------|-----|-------|-------------|
| …  | …     | …        | …   | …     | …           |
```
