# Browser Agent Guide 🧭 — 決定的なページエージェント（Chrome 拡張）

> ブラウザ操作 AI を脱線させないためのガードレールとガイド。

[English](README.md) · [한국어](README.ko.md) · **日本語** · [中文](README.zh.md)

---

**非エンジニアが**、ブラウザ操作 AI（チャット UI）に的確な指示を出せるよう、
表示中のページに**補足・目印・合図ボタン・お描き（要素を円・四角・矢印・ペンで囲む）をクリックだけで付けられる** Chrome 拡張機能です。
付けた補足はページ単位（オリジン+パス）で**永続化され、再訪時に必ず同じ場所へ復元**されます（=再現性）。
要素は**複数シグナルの堅牢なアンカー**（安定 ID パス・`data-testid`・`name`・`aria-label`・テキスト一致）で毎回同じものに再解決されるため、AI が決定的に同じ結果を得られます。

サイドパネルのチャットから AI（Structured Outputs）に直接指示することもでき、AI は
**閉じた動詞レジストリ**（`clickAffordance` / `fillAffordance` / `markElement` / `addNote` …）だけを使って決定的に操作します。
**安定要素 ID** と **Structured Outputs** の組み合わせにより、*同じプロンプトは同じアクションを生成*します。

> 用語: 「補足を付ける」操作は内部的には**注釈（annotation）**として保存されます。
> 種類は **💬コメント** / **📌目印（要素に決定的な名前を付ける）** / **🔘合図ボタン** / **🖍お描き（要素を円・四角・矢印・ペンで囲む）** の4つ。

## コンセプト（なぜ決定的か）

| 要件 | 実装 |
| --- | --- |
| AI 連携 + Structured Outputs | `background` から AI API を呼び、JSON Schema(strict) で出力を強制 |
| API キー保存 | `chrome.storage.local`（ローカルのみ）+ 設定ページ |
| 必要なページを記憶 | 補足保存やチャット変更時にルールを自動追加。保存範囲は URL / ドメイン / 全サイトから選択でき、手動で前方一致 / 正規表現にも変更可能 |
| サイドバーから補助UIを仕込む | コンテンツスクリプトの **動詞レジストリ** を AI が呼び出す。明示依頼された HTML / CSS / JS 注入はレシピとして保存できる |
| AI 協調・一貫性 | AI は登録済みの動詞しか使えない。要素には決定的な `aiId` を付与。レシピは読込時に再適用 |

AI は自由に DOM を触るのではなく、**あらかじめ用意した動詞の集合からのみ**操作を選びます。
これにより「同じ指示 → 同じ動詞 → 同じ結果」という再現性のある協調環境になります。
ページ本文やHTML属性に含まれる命令は未信頼データとして扱います。ユーザーが明示した場合のみ
`injectHtml` / `injectCss` / `injectScript` を使い、成功した注入は再訪時ルールへ保存されます。
`injectScript` は Chrome の User Scripts API 経由で実行するため、ページの inline script CSP に依存しません。
`setStyle` / `removeElement` / `defineMarker` のような直接変更・削除系の動詞はチャットAIの候補から除外し、
チャット/自動レシピ経由でも拒否します。

## インストール（開発者モード）

1. Chrome で `chrome://extensions` を開く
2. 右上の「デベロッパーモード」を ON
3. 「パッケージ化されていない拡張機能を読み込む」→ このフォルダを選択
4. ツールバーのアイコンをクリックするとサイドパネルが開きます

> Chrome 135 以上が必要です（Side Panel API + User Scripts API）。
> Chrome 138 以降で `injectScript` を使う場合は、拡張機能の詳細画面で **Allow User Scripts** を ON にしてください。

## 初期設定

1. 拡張アイコンを右クリック →「オプション」（またはサイドパネルの「設定」）
2. **① AI 接続**: プロバイダ（OpenAI / Anthropic / Gemini / カスタム）と API キー、モデルを入力して保存
   - OpenAI 互換: `response_format: json_schema(strict)` を使用
   - Anthropic: ツール強制（`tool_choice`）で構造化出力を取得
   - Gemini: `generationConfig.responseMimeType: "application/json"` と `responseJsonSchema` を指定
3. **② AI注入の自動保存** で、注入した HTML / CSS / JS をこのURL・このドメイン・全サイトのどこへ保存するか選びます
4. 補足を保存したり、チャットでページに変更を加えたりすると、選択した範囲のルールが自動で記憶されます
5. 必要に応じて **③ 記憶したURL / 有効化ルール** と **④ 記憶ルール** を編集します

## 使い方（非エンジニア向け · クリックで補足を付ける）

サイドパネルを開き、以下の手順でページに補足を付けます。設定や JSON 入力は不要です。

1. ツールバーの **＋補足を付ける** を押す
2. ページ上で対象（ボタン・入力欄など）を**クリック**
3. 出てきたフォームで種類を選んで保存
   - **💬 コメント** … 「ここは送信前に必ず確認」等の注意書き（AI への補足）
   - **📌 目印** … その要素に「送信ボタン」等の**決定的な名前**を付ける（以後 AI はその名前で安定参照）
   - **🔘 合図ボタン** … 押すと「意図」が記録され、AI が続きを理解できる

付けた補足は**このページに保存**され、次回アクセス時も同じ場所に復元されます。
サイドパネルの「このページの補足」一覧から編集・削除できます。

### お描き（要素を円・四角・矢印・ペンで囲む）

ツールバーの **🖍 お描き** を押すと描画モードに入り、ページ上に印を描けます。

1. ツールバーの **お描き** を押す
2. 画面上部の道具から **◯円 / ▭四角 / ↗矢印 / ✎ペン** と **色** を選ぶ
3. 対象（例: ボタン）を**ドラッグして囲む**。複数描いてもよい（取消＝Cmd/Ctrl+Z）
4. **完了** を押すと、囲んだ要素に対して**コメント**と**目的（AI向け）**を入力して保存（Escで終了）

- お描きは**囲んだ要素にアンカー**され、座標は要素の矩形に対する**比率**で保存されます。
  そのため要素が動いても追従し、**再訪・スクロール・リフローでも同じ位置に復元**されます（=再現性）。
- AI へは「赤色の円で囲んだ。コメント: …」のように**言葉で説明**されて文脈に渡るため、
  「ここを見て」「この囲んだ部分を直して」といった指示が正確に伝わります。
- 保存したお描きは「このページの補足」一覧（種類: **お描き**）から編集（コメント）・削除できます。

### 外部のブラウザ操作 AI（別のチャット UI）へ渡す

ツールバーの **文脈をコピー** を押すと、ページの決定的な説明（URL・補足・操作可能要素の
安定 ID 一覧）が**クリップボードへコピー**されます。これを別の AI チャットの先頭に貼り付けてから
指示すると、AI がページ文脈を正確に理解し、再現性高く操作できます。

### この拡張のチャットへ直接指示する

サイドパネル下部のチャットに自然文で指示することもできます。

- 「ログインボタンを探して強調して」
- 「送信ボタンに『送信ボタン』という目印を付けて」
- 「検索欄に Chrome 拡張 と入力して送信して」
- 「このページに固定の注意書きをHTMLで追加して、次回も出して」
- 「このサイト全体で見出しが見やすくなるCSSを注入して」

AI は `reply`（説明）と `actions`（動詞列）を構造化して返し、各動詞が順に実行されます。
補足・目印・合図ボタンの保存や、チャットによる表示変更が成功すると、サイドバーの「保存」セレクトで選んだ範囲に再訪時ルールが自動保存されます。
`outlineElement` などの保存済み表示変更はページ更新後も再適用されます。元に戻す場合は設定画面の「記憶したURL」または「再訪時ルール」から該当ルールを削除して、ページを更新してください。

ツールバー:
- **＋補足を付ける**: 要素をクリックして補足（コメント/目印/合図ボタン）を付ける注釈モード
- **お描き**: 円・四角・矢印・ペンで要素を囲み、コメントを添えて永続保存する描画モード
- **文脈をコピー**: 外部 AI へ貼れる決定的なページ文脈を生成してコピー
- **手がかり**: 現在の操作可能要素（aiId / 役割 / ラベル）を一覧表示
- **履歴**: 過去に送信したプロンプトを再利用（入力欄の先頭/末尾では ↑↓ でも呼び出し）
- **設定**: AI 接続・記憶したURL・再訪時ルールの設定

## 動詞レジストリ（抜粋）

実装は `content/content-script.js` の `AI_VERBS`。関数名はすべて動詞です。

| 動詞 | 役割 |
| --- | --- |
| `annotatePage` / `listAffordances` | 操作可能要素に安定 ID 付与・一覧取得 |
| `clickAffordance` / `clickElement` | クリック |
| `fillAffordance` / `fillInput` / `selectOption` | 入力・選択 |
| `submitForm` / `focusElement` / `scrollToElement` | フォーム送信・フォーカス・スクロール |
| `highlightElement` / `outlineElement` | 一時強調 / 消えない枠線 |
| `injectHtml` / `injectCss` / `injectScript` | 明示依頼された HTML / CSS / JS を注入し、再訪時に再適用 |
| `injectButton` / `injectPanel` | 手がかりボタン・サニタイズ済みパネルを仕込む |
| `waitForElement` | 要素の出現待機 |
| `navigateTo` / `goBack` / `notify` | 遷移・通知 |
| `readText` / `extractData` / `readSignals` | 読み取り・抽出・シグナル取得 |
| `startAnnotating` / `startDrawing` | 注釈モード / お描き（円・四角・矢印・ペン）モードを開始 |

### 手がかり（affordance）と AI 協調

`annotatePage` は文書順で `button#1`, `input-text#2` のような**決定的な `aiId`** を付与します。
AI はこの ID を `clickAffordance({aiId})` 等で参照するため、推測セレクタによるブレが起きません。

`injectButton` で仕込んだボタンには中立名のDOM属性（例: `data-bag-intent`）が付き、クリックすると
`readSignals` で読めるシグナルとして記録されます。これにより
「人がボタンを押す → AI がその意図を理解して続きを実行」という協調が成立します。

### SPA・非同期ページでのレシピ

保存済み**レシピ**（`injectHtml / injectCss / injectScript / outlineElement / injectButton / injectPanel` の許可リスト）は自動で再適用されます。**シングルページアプリ（SPA）**や**遅延描画される要素**にも対応します。

- **SPA の内部遷移** — コンテンツスクリプトが `location.href` を監視し（`MutationObserver` と `popstate` / `hashchange`）、service worker へ通知します。service worker は URL を再判定し、一致するレシピを再適用します。フルリロードは不要です。
- **非同期要素の出現待ち** — レシピのアクションに `waitFor: { selector, timeoutMs }` を付けると、対象要素が現れるまで実行を遅延します（遅延ロード / クライアントサイド描画）。既定のタイムアウトは 5000ms。時間内に出現しなければそのアクションは失敗扱いになります（例外は投げません）。出現しない場合は `timeoutMs` 分だけ待つため、待たずにスキップしたいときは `when: { selectorExists }` で先に存在を確かめてください。
- **条件を満たすときだけ描画** — アクションに `when: { urlContains, selectorExists, selectorAbsent }` を付けると、条件に合うまでそのアクションはスキップされます。SPA の画面別出し分けには `urlContains`、再適用時の重複注入防止には `selectorAbsent` を使います。

`waitFor` と `when` はレシピ JSON（設定画面 → 再訪時ルール／レシピ。テンプレートボタンに記入例があります）で各アクションに付ける任意フィールドです。

## アーキテクチャ

```
sidepanel (チャットUI)
   │  CHAT {text, history, tabId}
   ▼
background (service worker)
   │  ① COLLECT_CONTEXT → content（動詞カタログ・affordance 収集）
   │  ② callAI（Structured Outputs で reply + actions を取得）
   │  ③ RUN_ACTIONS → content（動詞を順次実行）
   ▼
content-script (対象ページ内 / 動詞レジストリ + 実行器)
```

- `lib/ai-client.js` — プロバイダ非依存の構造化出力呼び出し
- `lib/prompt.js` — 動詞カタログと affordance を載せたシステムプロンプト生成
- `lib/site-matcher.js` — URL/ドメイン/正規表現の判定
- `lib/storage.js` — 設定の保存・読込

## セキュリティ / プライバシー

- API キーは `chrome.storage.local` にのみ保存され、選択した AI API 以外へは送信しません。
- プロンプト履歴とページ別の会話履歴も `chrome.storage.local` に保存されます。
- 破壊的・不可逆な操作（送信・購入・削除）は、AI が `reply` で明示してから実行する方針です。
- 動詞レジストリは閉じた集合なので、AI が想定外の DOM 操作を行うことはありません。

## カスタマイズ

動詞を追加するには `content/content-script.js` の `AI_VERBS` に
`{ description, args, run }` を 1 つ加えるだけです。`description` と `args` は
自動的に AI へのシステムプロンプトと構造化出力スキーマ（`verb` の enum）へ反映されます。

## 技術スタック

ビルド不要のバニラ JavaScript。Manifest V3、Side Panel API、`chrome.scripting`、`chrome.storage`。

## 品質ゲート

パッケージ化前に `npm run check` を実行します。JavaScript構文チェック、決定的アンカーテスト、
Playwright + axe によるサイドパネル/設定画面のUIアクセシビリティ検証をまとめて実行します。

採用したAnti-Slopワークフローは [docs/ui-quality-workflow.md](docs/ui-quality-workflow.md) にまとめています。

## ライセンス

[MIT](LICENSE)
