# レビュー依頼: 記録ワークフローのページ跨ぎ自動実行が動かない問題の根治

## 概要
PR #49/#50 で入った「記録ワークフローの自動実行(autorun)」が、ページを跨いで実行されない問題を根治する。
5観点の並列調査＋敵対的検証で確認した根本原因①〜⑤を、安全境界を保ったまま最小修正する。

## なぜ (背景・根本原因)
autorun は「現在ページの記録手順を AI で実行 → SW が次手順の URL へ決定論的に遷移 → 着地後また実行」を1本の鎖で回す。
この鎖が次の理由で最初の数歩で止まっていた(いずれも実コード＋node実行で確認済み):

1. **ページ送りボタンを不可逆扱いして held → セッション停止** (最有力・全サイト)
   `IRREVERSIBLE_KEYWORDS` に「次へ/続ける/続行/進む/continue/proceed/next」が入っており、これらは
   複数ページ手順を次ページへ送る通常ボタンのラベルそのもの。autorun のクリックが held → SW がセッションを
   `active:false` 停止 → 2ページ目に到達できない。
2. **記録 pattern と着地 URL の正規化ズレで pending=0** (Amazon/リダイレクト系)
   記録時 `pattern = annotationScopeKey(href)`(Amazon は `/dp/ASIN` へ短縮)に対し、`pendingStepsForUrl` は
   生の origin+pathname で厳密比較していたため、`/dp/ASIN/ref=…` の着地で一致せず手順が実行も done もされない。
3. **`autoRunLastNav` が到達成功後もクリアされず、リダイレクト1回で恒久停止**(増幅要因)
4. **プロンプトは `navigateTo` を指示するが allow-list で除外 → AI が空応答 → failed 停止**(副因)
5. **本文の無いお描き/対象だけの手順が `actionableSteps` から脱落**して手順欠落・順序ずれ(副因)

詳細な調査・敵対的検証ログはセッション内の root-cause ワークフロー結果を参照。

## 何を (変更点)
- **①** `IRREVERSIBLE_KEYWORDS` からページ送り語(`続行/続ける/進む/次へ/continue/proceed/next`)を分離。
  真に不可逆な確定系(購入/注文/支払/決済/送金/削除/退会/解約/送信/確定/同意/登録/checkout/pay/delete 等)に限定。
  `lib/workflow.js` と `content/content-script.js` の2コピーをパリティ維持で同時修正。
- **②** `lib/workflow.js` に共有正規化 `scopeKeyForUrl(url)`(content の `annotationScopeKey` 相当、Amazon `/dp/ASIN`
  短縮・`/s` クエリ間引きを含む)を実装。`pendingStepsForUrl` で live URL も同じ正規化を通して突き合わせる。
- **③** SW `maybeAutoRunWorkflow`: 前進(`madeProgress`)できたら `autoRunLastNav.delete()`。遷移ループ判定を
  純関数 `isAutoRunNavLoop({candidateUrl,lastNavUrl,madeProgress})` に切り出し、「未前進で同一URLへ再遷移」時だけ停止。
- **④** `buildSystemPrompt({context, autorun})` を追加し、autorun では `navigateTo` 案内を出さず「★現在のページの
  手順だけ実行・ページ送りは押さない・打つ手が無ければ空でよい」を指示。`autoRunExecuteSteps` の `ranOk` を
  「空応答/noopのみ＝前進」「試して全失敗(hardFail)のみ停止」に緩和。memo に対象(target)も含める。
- **⑤** `actionableSteps` を `(text && text.trim()) || target` に揃え、`crossPageWorkflowForPrompt` と判定を一致。

## どうやって (検証)
`npm run check` 全ステージ green (EXIT=0):
- check:js / check:markers(75/75) / anchor(9) / slug / recipe / **prompt(6)** / **workflow-lib(17)** / vf(14) / **test:ui(72)**。
- 追加した回帰テスト:
  - `workflow-lib.test.mjs`: actionableSteps の対象だけ手順保持 / pendingStepsForUrl の Amazon ref URL 一致 /
    isIrreversibleLabel でページ送り語が false / scopeKeyForUrl の Amazon短縮・冪等 / isAutoRunNavLoop の真偽表。
  - `prompt.test.mjs`: autorun モードで `navigateTo` 案内を抑制(チャット経路は従来どおり案内、回帰防止)。
  - `workflow-autorun.spec.mjs`: 「次へ進む」ボタンが autorun でも held されず実行される(=primary原因の実ブラウザ固定)。

## 影響
- 既存の安全境界は不変: 真の確定/購入/削除ボタンは引き続き held、アイコンのみボタンの fail-safe hold も維持、
  破壊的動詞・`navigateTo`/`submitForm` の deny-by-default も不変。chat/recipe 経路は無変更。
- 単一プロジェクト/非Amazonの突き合わせは従来と同等(scopeKeyForUrl は origin+pathname を返すため byte 等価)。

## トレードオフ / 留意
- ①で `送信/確認/登録` は held のまま残した(安全側)。これらが純粋なページ送りのサイトでは保留が出うるが、
  購入・送信系の事故防止を優先。必要なら後続でラベル分離を精緻化できる。
- ④で「空応答＝前進」にしたため、AIがそのページで何もしなくても次ページへ進む。取りこぼしは hardFail(全失敗)
  検知で停止して知らせる。silent-skip より「跨いで進む」を優先した判断。

## 残作業 (既知のギャップ)
- SW の遷移オーケストレーション(maybeAutoRunWorkflow の2ページ実連鎖)を実 LLM 込みで回す end-to-end は、
  テスト環境に LLM が無いため未追加。代わりに純粋判定(isAutoRunNavLoop / pendingStepsForUrl 正規化)と
  content 側 held 挙動を unit/spec で固定した。将来 chrome.* をモックした SW 単体ハーネスがあれば連鎖もロック可能。

## ファイル構造
- `lib/workflow.js` … scopeKeyForUrl + amazon系ヘルパー追加 / actionableSteps・pendingStepsForUrl 改修 /
  IRREVERSIBLE_KEYWORDS 絞り込み / isAutoRunNavLoop 追加。
- `lib/prompt.js` … buildSystemPrompt に autorun 分岐。
- `background/service-worker.js` … maybeAutoRunWorkflow(前進追跡・ループ判定) / autoRunExecuteSteps(プロンプト・ranOk・memo)。
- `content/content-script.js` … IRREVERSIBLE_KEYWORDS のパリティ更新。
- `test/{workflow-lib.test.mjs,prompt.test.mjs,workflow-autorun.spec.mjs}` … 回帰テスト追加。

## レビュー依頼
- ①のキーワード分離方針(`送信/確認/登録` を held に残す線引き)が運用と合っているか。
- ④の「空応答＝前進」緩和が、取りこぼし(本来やるべき手順をスキップ)を生まないか(hardFail検知で十分か)。
- ②の scopeKeyForUrl は content の annotationScopeKey と挙動一致が前提(drift 注意)。共有方法(将来のパリティテスト)で良いか。
