# @agent: マーカー規約 (v1.1) と現状

「どこを直すか」を機械的に一意特定するための、コード側の安定アンカー規約。
出典: `agent-markers-convention.html` (multi-llm-debate ×2 合議で採択)。

## 付与状況 — 主要UIに付与済み、それ以外は未付与

**主要UI (`sidepanel.html` 5 / `options.html` 8 = 計13) に付与済み。** 大半の要素には未付与なので、マーカーが無い要素は selector/表示テキストのフォールバックで特定する。
ライブの目印は動的採番の `data-bag-id` (例 `button#3`) と、chat/recipe 経路でブロックされる高リスク verb `defineMarker`。

→ **既定は「マーカー無し」前提のフォールバック経路** (SKILL.md ステップ3):
`url`(file://) → `anchorLabel` テキスト grep → `testid`/`selector` の安定部分 → 画像から推測。
マーカーは**ユーザーが opt-in したときだけ** bootstrap で付与する (下記)。マーカー手順を**黙って失敗させない**。

## 規約の核心

| 項目 | 内容 |
|---|---|
| 主マーカー | `data-agent-id="@agent:<path>"` を**唯一の正規アンカー**に。HTML5 標準の data 属性なので class/id と名前空間が直交し衝突しない |
| 限定付与 | 全要素ではなく、AI が編集・生成・検証する**安定要素だけ**に付与 (HTML肥大・コンテキスト圧迫を回避) |
| 検索 | **必ず属性名込みでアンカリング**。`rg -n 'data-agent-id="@agent:'`。**素の `@agent:` grep は禁止** (README/コメント/fixture を誤検出) |
| パターン (CIで強制) | `^@agent:[a-z0-9][a-z0-9./-]*$` (小文字英数で始まり、`.`=階層 / `/`=名前空間 / `-`=語区切り) |
| 補助属性 (任意) | `data-agent-role` (region/list/dialog… 領域分類) / `data-agent-action` (submit/cancel/open… 操作分類)。識別子は `data-agent-id` に一元集約 |

## 発見の3経路 (すべて属性名込み)

```bash
rg -n 'data-agent-id="@agent:' -g '!*.md' -g '!.claude'         # 一括 (ソース)。.md/.claude を除外
```
> 注意: `.md` を除外しないと、ドキュメント中の例示 (この規約ファイルや CLAUDE.md に書いた `data-agent-id="@agent:` という文字列) まで誤検出する (実測済み)。実マーカーはコード側の DOM 属性なので、コードファイルだけを対象にする。
```js
document.querySelectorAll('[data-agent-id^="@agent:"]')          // DOM 全列挙 (data属性値なのでエスケープ不要)
document.querySelector('[data-agent-id="@agent:advice-panel.submit-btn"]')  // 単一特定
document.querySelectorAll('[data-agent-id^="@agent:advice-panel."]')        // サブツリー抽出 (前方一致)
```

## bootstrap — opt-in でマーカーを付ける手順

ユーザーが「次回から確実にしたい」と言ったときだけ:

1. ステップ3で特定した要素に付与。命名は kebab-case + ドット階層 (任意で `<ns>/` 名前空間):
   ```html
   <section data-agent-id="@agent:advice-panel" data-agent-role="region">
     <h2 data-agent-id="@agent:advice-panel.title">アドバイス</h2>
     <button data-agent-id="@agent:advice-panel.submit-btn" data-agent-action="submit">送信</button>
   </section>
   ```
2. 値は**ページ内で一意**に保つ (コピペ由来の重複は AI の誤編集を招く)。
3. 付けたら `rg -n 'data-agent-id="@agent:'` で形式 (`^@agent:[a-z0-9][a-z0-9./-]*$`) と重複を確認。
4. 規約を文書化するなら `docs/agent-markers.md` を Single Source of Truth に。

### 命名 BNF
```
marker  ::= '@agent:' value
value   ::= (ns '/')* path
path    ::= segment ('.' segment)*
segment ::= lower (lower | digit | '-')*
```

## DO / DON'T

**DO**: 検索は `data-agent-id=` 込み / AI が触る安定アンカーだけに限定付与 / kebab-case + ドット階層 / 値はページ内一意 / CI lint で形式違反と重複を検出。

**DON'T**: 素の `@agent:` grep / 値に大文字・空白・全角・許可外記号 / class や id だけでマーキング / HTMLコメントのみを主軸 / aria・role の値を識別子へ流用 (意味論汚染) / 全要素へ過剰付与。

## 撤退条件 (フォールバック規約)

値を **data属性の外** (class / id / テストID / CSSセレクタ識別子部 / ログキー) へ流用する計画が確定したら、
`@` と `:` が CSS セレクタでエスケープ必須になるため、番兵を `__agent__` に切り替える
(検証: `^__agent__[a-z0-9][a-z0-9./-]*$`)。data属性値専用で使う限りは `@agent:` のままでよい。
