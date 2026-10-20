---
id: workflow-step
term: "Workflow step / 構造化手順 (対象・操作・確認)"
aliases: ["structured step", "記録ワークフロー手順", "RUN_STEP", "pick step"]
deprecated_terms: []
status: stable
owner: "@buddypia"
bounded_context: extension
progress:
  state: shipped
  tracking: ""
source_refs:
  - { type: spec, path: ".agents/skills/workflow-steps/SKILL.md", anchor: "workflow-steps" }
code_refs:
  - { path: "lib/workflow.js", symbol: "normalizeStep" }
  - { path: "lib/workflow.js", symbol: "pickCandidate" }
  - { path: "content/content-script.js", symbol: "runStep" }
  - { path: "background/service-worker.js", symbol: "driveWorkflow" }
  - { path: "background/service-worker.js", symbol: "handleWorkflowRequest" }
  - { path: "lib/judge-client.js", symbol: "callJudgeChoice" }
  - { path: "lib/judge-client.js", symbol: "judgeChain" }
  - { path: "lib/judge-client.js", symbol: "askClef" }
  - { path: "lib/judge-client.js", symbol: "callJudgeVisualCheck" }
api_refs: []
db_refs: []
related: ["verb-registry", "affordance"]
last_verified: 2026-10-20
confidence: medium
---

## 定義

記録ワークフロー(`chrome.storage.local` キー `aiAdvisorWorkflow`)の1手順を、
**対象(locator)・操作(action)・確認(check)** に分けた構造化データ。記録 ON 中の
実際のクリック/入力/選択/チェックを content script がそのまま手順にする(観察記録)。
名前付きで複数保存できる(`saved[]`、最大50件)。記録・メモ・編集・学習候補は作業中の `steps` だけに書かれ、
保存済みエントリは明示的な保存(`saveWorkflow`)でだけ変わる。未保存の変更(`hasUnsavedSteps`)を切替で捨てる前に確認する。

- `action.verb` は閉じた集合 `click | fill | select | check`。`value` は `{name}` 変数を含められる
  (パスワードは値を保存せず `{password}` に置換)。
- `locator.kind` は `fixed`(記録した要素を anchor で再特定)か `pick`(同じ形の項目が3つ以上並ぶ
  リスト内の操作。`scope`/`item` 署名/`inner` で実行時に候補を列挙)。リストとみなすのは項目らしいタグ/role/クラスか、
  汎用 div なら先頭3つが同じ種類の操作要素を持つ並びだけ(選択欄・入力欄・送信ボタンが並ぶフォームの行は `fixed`)。
  既定の選び方は押した要素のテキストが項目間で一意かつ項目全文への部分一致でも1件ならそれ(評価や価格で変わる
  項目全文より安定)、無ければ項目全文。`text` の値の末尾「…」(記録時に切った値)は前方部分として照合する。
  実行時の項目内の対象は、記録した要素のセレクタが項目内で1つに当たればそれ、無ければ位置のパス。
- `choice.by` は `index | text | first | last | min | max | ai`。候補からの選択は SW の純関数
  `pickCandidate` が決め、決まらない時(曖昧/該当なし/`ai`)だけ AI に **候補キーの enum から1つ**
  を選ばせる(`callAIChoice`。応答が無ければ1回 `AI_CHOICE_TIMEOUT_MS` で打ち切って失敗にする)。AI が補った結果は `suggestion` として残り、人間が採用した時だけ学習される。
  判断AI(`settings.judge.provider:'jev' | 'clef' | 'eg2'`)を設定すると、この候補選択だけを System 1
  (TypeSafe Jev / Cloudflare Clef / ローカル EmbeddingGemma 2) に任せる(`callJudgeChoice`。チャット/verbs 生成は LLM のまま)。
  3つは同じ形の provider(`JUDGE_PROVIDERS`)で、予備(`settings.judge.fallback`)を選ぶと主が答えられない時(HTTP/通信エラー・契約外の応答)
  だけ予備に聞く(`judgeChain` の順)。確信度が低い・該当なしは答えなので予備に回さず、全部だめなら全部の理由で失敗する。
  選んだ候補の確信度(Jev / Clef の確率または eg2 のコサイン類似度。Jev と Clef は同じ {state, questions} → probabilities の契約)が `minConfidence` 以上なら進んで
  確信度つきの `suggestion` を残し(理由の文には選んだ判断AIの名前 Jev / Clef / eg2 を入れる)、未満なら最有力を `suggestion.pending` に残して `heldKind:'judge'` で保留する。
  記録要素が無い時の差し替え(候補がページ全体)は確信度に関わらず保留する。判断の承認は
  `judgeApprovedStepId`(候補選択だけを通す)で、確定系ゲートの `approvedStepId` とは別に持つ。
- **承認の不変条件**: 承認が許すのは「保留時に人間へ示した候補」だけ。保留時に `run.heldLabel` へ候補の
  テキストを残し、承認で `approvedLabel` へ移す。再実行は AI に問い直さず、そのテキストの候補(一意)だけを押し、
  content の確定系ゲートも対象のテキストが `expectText` と一致する時だけ承認を効かせる(ルールで選んだ pick 候補も
  同じ。承認までに一覧が並び替わりうるため)。AI が選んだ候補を一意に示せない(テキスト無し/同じ表記が複数)時は
  保留せず止める。外部 AI へ手順の入力値も、入力欄の今の値も送らない(`labelOf` は `value` 属性=ページの初期値だけを使う)。
- `check.type` は `none | url | text | appears | visual | download`。URL は `urlPattern`(`:id` 汎化。ID 的区間・`=` を含む区間、ID がある URL では長い slug も可変)で照合し、
  `visual` はステップ実行後にタブの読込完了・アクティブ状態を確認し、`PREPARE_VISUAL_CHECK` で入力欄(`input`/`textarea`/`contenteditable`)のライブ値を透明マスクした上でスクリーンショットを撮り、offscreen(`FIT_IMAGE`)で長辺 `JUDGE_IMAGE_MAX_EDGE`(1568px。Jev はこれを超える画像を縮めずに拒否する)に縮めてから、`callJudgeVisualCheck`(Jev / Clef マルチモーダルまたは eg2 `POST /v1/evaluate`)で画面状態・UI崩れやエラー表示の有無を検証する。Jev には画像を `assets` の `{type:'image', format, data_base64}`(PNG / JPEG のみ)で渡す。
- `download` は操作の前から SW がページのダウンロード(`chrome.downloads.onCreated`。拡張自身の保存は除く)を見張り、
  ファイル名か URL に `value` を含む(空なら何でも)ものが `complete` になるまで待つ(上限60秒)。始まらない・中断・
  時間切れは失敗で止まる。記録中、クリック直後(10秒以内)に始まったダウンロードはそのクリックにこの確認を SW が自動で付ける。
- `gate: true`(確定系ラベルは自動付与)の手順は承認まで `held` で止まる。
- 失敗で止まると(`failed` / `mismatch`)、`run.failure` に止まった手順(`stepId`/`n`)・段階(`stage`: `page | resolve | choose | ai | act | check | exception`)・
  人向けの文面(`text`)・生データ(`detail`: 手順の要約、タブの URL、content の直近の応答と候補の表示テキスト、AI の種類/モデル/候補/答え/理由)を残す。
  手順の入力値は載せない。サイドパネルはこの記録からワークフロー欄の上に理由と「次にすること」と生データ(JSON・コピー可)を出し、止まった手順の番号を `!` にする。次の開始で消える。

実行は SW の `driveWorkflow` が1手ずつ: ページ合わせ → `RUN_STEP`(content の `runStep`)→ 確認 →
前進。`dryRun` は操作せず対象を光らせるだけ。`kind` を持たない旧来のメモ手順は従来どおり AI が verbs 化する。
ランナーは1つのタブで進む。新しいタブで開くリンク(`_blank`、または文書内に無いフレーム名)のクリックは `runStep` が同じタブで開く
(既存の iframe/frame を名前で狙うリンクはそのまま)。記録時は人が開いた新しいタブで続けてよい(手順は URL で結び付く)。
AI CLI は MCP の `run_workflow`(daemon → WS `workflow` `{op:'run'}` → SW `handleWorkflowRequest`)で保存済みワークフローを
id と変数で始められる。開始ページは常に新しいタブで開く(人が作業中のタブを遷移させない)。実行中/承認待ち・記録中・
サイドパネルに未保存の手順がある時や変数が足りない時は、何も開かずに断る(人の編集を捨てない)。
状態(`get_workflow_run`)は進み具合・`held` の手順番号と種類と候補の表示名・止まった手順番号と段階(`failed`)・直近の出来事の種類(phase)だけを返し、
入力値と手順ごとの文面は返さない。
承認する手段は MCP に無く、確定系も判断AIの保留も人がサイドパネルで承認する。
