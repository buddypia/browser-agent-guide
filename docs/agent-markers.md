# @agent: マーカー規約（Single Source of Truth / v1.1）

AI エージェントがブラウザUIの要素を**一意かつ決定的に**特定するための正規アンカー規約。
出典: multi-llm-debate ×2 の合議（旧 `agent-markers-convention.html`）。`/bag-workflow` スキルは
この規約に従って要素を特定し、必要なら opt-in で付与する。**この文書がプロジェクトの正典**。

## なぜ必要か

動的に生成される CSS セレクタ（`div:nth-of-type(1) > … > button:nth-of-type(3)`）や表示テキストは、
リフローや再生成でずれ、ソースコードにも直接対応しない。`data-agent-id="@agent:<path>"` という
**固定の名札**を要素に埋めると、お描きが指す要素・ライブDOM・ソースが**同じ値で 1 対 1** につながる。

## 主マーカー（唯一の正規アンカー）

```html
<button
  data-agent-id="@agent:login-form.submit"   <!-- 必須・ページ内で一意 -->
  data-agent-role="region"                    <!-- 任意: 領域の分類 -->
  data-agent-action="submit">送信</button>     <!-- 任意: 操作の分類 -->
```

- HTML5 標準の data 属性なので class（Tailwind 等）/ id と名前空間が直交し衝突しない。
- 識別子は `data-agent-id` に**一元集約**する。`role`/`action` は分類用で、識別には使わない。

## 命名規則（CI で強制できる）

正規表現: `^@agent:[a-z0-9][a-z0-9./-]*$`

```
marker  ::= '@agent:' value
value   ::= (ns '/')* path
path    ::= segment ('.' segment)*
segment ::= lower (lower | digit | '-')*
```

- 小文字英数で始まり、`.`（階層）/ `/`（名前空間）/ `-`（語区切り）を許可。
- 例: `@agent:advice-panel.submit-btn`、`@agent:v1/advice-panel.cancel-btn`

## 検索（必ず属性名込み + ドキュメント除外）

```bash
rg -n 'data-agent-id="@agent:' -g '!*.md' -g '!.claude'
```

- **素の `@agent:` grep は禁止**（README・コメント・fixture を誤検出する）。
- **`.md` / `.claude` を除外**する。除外しないと、この規約ファイルや CLAUDE.md に書いた
  `data-agent-id="@agent:` という**例示文字列まで誤検出**する（実測で必要だった）。実マーカーは
  コード側の DOM 属性なので、コードファイルだけを対象にする。

## 発見の 3 経路（すべて属性名込み）

```bash
rg -n 'data-agent-id="@agent:' -g '!*.md' -g '!.claude'          # ① ソース一括
```
```js
document.querySelectorAll('[data-agent-id^="@agent:"]')           // ② ライブDOM全列挙
document.querySelector('[data-agent-id="@agent:login-form.submit"]')  // ③ 単一特定
document.querySelectorAll('[data-agent-id^="@agent:login-form."]')    //    前方一致でサブツリー
```

## 限定付与の原則

全要素ではなく、**AI が編集・生成・検証する安定要素だけ**に付与する（HTML 肥大・コンテキスト窓の
圧迫を回避）。各画面では「主要な操作点（保存/送信/実行ボタン等）」と「主要な領域・入力」に絞る。

**動的注入UIは対象外。** content script が `injectButton` / `injectPanel` で動的に注入する要素は、
ソースに静的に存在せず（`rg` で当たらない）、既に `injected:<id>`（`data-bag-id`）＋ signal/intent という
参照機構を持つ。`@agent:` を足すと二重管理になるため、マーカーは**ソースに固定された静的UI**
（`sidepanel.html` / `options.html` 等）に限る。

## 現状の付与状況（このリポジトリ）

| ファイル | マーカー |
|---|---|
| `sidepanel/sidepanel.html` | `@agent:sidepanel.composer` / `.composer.input` / `.composer.send` / `@agent:sidepanel.draw` / `@agent:sidepanel.capture` |
| `options/options.html` | `@agent:options.ai.save` / `.memory.save` / `.daemon.save` / `.daemon.test` / `.rules.add` / `.recipe.save` / `@agent:options.export` / `@agent:options.import` |

> 追加・変更時は `rg -n 'data-agent-id="@agent:' -g '!*.md' -g '!.claude'` で**形式違反と重複**を確認すること。

## DO / DON'T

**DO**: 検索は `data-agent-id=` 込みでアンカリング / AI が触る安定アンカーだけに限定付与 /
kebab-case + ドット階層 / 値はページ内で一意 / CI lint で形式違反と重複を検出。

**DON'T**: 素の `@agent:` grep / 値に大文字・空白・全角・許可外記号 / class や id だけでマーキング /
HTML コメントのみを主軸 / `aria`・`role` の値を識別子へ流用（意味論汚染）/ 全要素へ過剰付与。

## 撤退条件（フォールバック）— `__agent__`

値を **data 属性の外**（class / id / テストID / CSS セレクタ識別子部 / ログキー）へ流用する計画が
確定したら、`@` と `:` が CSS セレクタでエスケープ必須になるため、番兵を `__agent__` に切り替える
（検証: `^__agent__[a-z0-9][a-z0-9./-]*$`）。data 属性値専用で使う限りは `@agent:` のままでよい。

## CI lint（任意）

```json
{
  "data-agent-id": {
    "type": "string",
    "pattern": "^@agent:[a-z0-9][a-z0-9./-]*$",
    "required": true,
    "unique": true
  }
}
```

このパターンを HTML の静的解析 / カスタム linter に組み込み、規約逸脱と重複を機械的に検出する。

## `/bag-workflow` スキルとの関係

`/bag-workflow`（`.claude/skills/bag-workflow/`）はこの規約の**消費者**。お描き等の手がかりが指す要素を、
まず `@agent:` マーカー（属性名込み rg）で特定し、無ければ selector/表示テキストへフォールバックする。
ユーザーが「次回から確実にしたい」と言ったときだけ、この規約に従ってマーカーを bootstrap する。
スキル内の `references/agent-markers.md` はスキル動作用の要約で、**本文書が正典**。
