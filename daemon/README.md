# Browser Agent Guide 視覚フィードバック デーモン（Phase 1 / 受信側 + 消費側）

ブラウザのお描き注釈スクリーンショットを 1 プロセスで受け取り・公開する常駐デーモン。

- **受信（WebSocket / `/ws`）**: 拡張の「お描きを画像でAIへ」が push した PNG+注釈を、
  トークン認証のうえ受け取る。**既定（`memory`）は inbox を一切作らず**メモリ保持のみ（image/file_path
  要求時だけ OS tmp に一時 materialize し終了時破棄）。`--storage hybrid` はメモリ保持＋image 要求時に
  inbox へ遅延保存、`--storage disk` は受信ごとに inbox へ即時書き出し（原子的書き込み・0600・slug 採番はサーバ側）。
- **公開（MCP / Streamable HTTP / `/mcp`）**: AI コーディング CLI はまず `get_latest_feedback_context`
  で **画像なしの軽量メタ**を読み、必要な時だけ `get_latest_feedback_image` で
  **image(PNG) + ファイルパスの両方**を受け取って vision 解釈できる。image ツールは
  context で確認した `contextId` と `imageReason` がないと画像を返さない。

- **画像取得（HTTP GET / `/shot/<id>.png`・`/raw/<id>.png`）**: ディスクパス非依存の取得先。
  `id` だけで PNG を取れるので、ブラウザのダウンロード先と inbox がズレても（移動済み/Edge・Brave/
  「毎回確認」）`file_path` を解決せずに画像へ到達できる。トークン必須（クエリ `?token=`）。

受信・公開・画像取得は**同一ポート**に同居（HTTP は `/mcp`・`/shot|/raw`、WebSocket upgrade は `/ws`）。

> 拡張側の WS push は無効化も可能で、その場合は従来どおり `chrome.downloads` に保存される。

## 何をするか

- 拡張からの WebSocket push を受ける（トークン認証）。既定 `memory` は inbox を作らずメモリ保持、`hybrid`/`disk` は inbox を使う。
- inbox(`<slug>/shot.png` + `annotation.json` + `memo.md`)を新しい順にスキャン。`annotation.json` には URL/title/capturedAt に加えて Chrome タブ情報（`tab.tabId` / `tab.windowId` / `tab.index` / `tab.active`）も入る。
- 5 つの MCP ツールを公開（接頭辞 `bag_page_feedback:` は**登録時に付けた alias** 例。任意の名前でよい）:
  - `list_feedback` — 一覧（id・取得元 url/title/tab 付き）
  - `get_latest_feedback_context` — 最新を image なしの text/structured context で返す（**主用途**。対象要素の outerHTML + a11y を含む）
  - `get_feedback_context` — id 指定で image なし context を返す（outerHTML + a11y を含む）
  - `get_latest_feedback_image` — context 確認後のみ最新を image+パスで返す（必要時の vision）
  - `get_feedback_image` — context 確認後のみ id 指定で image+パスを返す

  > **命名（旧 → 新の経緯）**: かつての `*_visual_feedback*` は「メモ＋HTML 要素だけ欲しい（画像なし）」ケースでも "visual" を
  > 冠して紛らわしかったため、modality 中立な `*_feedback_context`（テキスト/HTML/a11y）と `*_feedback_image`（画像）へ改名し、
  > サーバ内部名も `bag-visual-feedback` → `bag-page-feedback` にした。**旧ツール名（deprecated エイリアス）は撤去済み**で、
  > 現在は新名 5 ツールのみを公開する（旧名で書かれた古い手順は動かない）。
  > なお Claude Code/Codex 等で打つ接頭辞（本 README の例は `bag_page_feedback:`）は**ユーザが登録時に決めた alias**で、
  > サーバ名とは別物。旧 alias `bag_visual_feedback` で登録していた場合は付け替える:
  > `claude mcp remove bag_visual_feedback && claude mcp add --transport http bag_page_feedback http://127.0.0.1:8765/mcp`。

- **対象要素の HTML 取得（schema v1）**: お描き/メモを残した要素の `outerHTML`（≤8KB、超過時 `truncated:true`）と
  軽量 a11y（role/name/level/state）を `annotation.json` の各 item に保存し、context ツールが text と `structuredContent`
  の両方で返す。**画像トークンを使わず「メモを残した HTML 要素」だけ取得できる**。旧 v0 entry は html/a11y を持たず null。
- image ツールでは、image を読めない CLI 向けに `file_path` テキストを併走させる（fallback 内蔵）。
  `hybrid` はこの image ツールを呼んだ時点で `<inbox>/<slug>/shot.png` を materialize し、`memory`
  （既定）は inbox の代わりにプロセス専用の OS tmp へ一時 materialize する（終了時に破棄）。
  ただし image バイトは常にメモリ優先で返し、disk への materialize は **best-effort**（read-only
  inbox / disk full 等で失敗しても、inline image + `shot_url` で応答し落とさない。`/shot` 配信と同じ
  「バイトはメモリ優先」方針）。materialize に失敗した時だけ `file_path` 行を省き `shot_url` を案内する。
- context 出力は `tab` メタデータと `dataAgentId` (`@agent:`) を返す。対象特定では `dataAgentId` を最優先にし、`selector` / `testid` / `anchorLabel`
  で足りる時は image を取得しない。
- `get_latest_feedback_context` / `get_latest_feedback_image` は、最新候補が鮮度窓
  （既定90分）を超えて古い時は context/image と top-level `id` を返さない。過去データが必要な時は
  `list_feedback` で id を確認し、`get_feedback_context` / `get_feedback_image` を
  明示 id で呼ぶ。

### storage mode（memory / hybrid / disk）

`inbox` は MCP の仕様上必須ではない。MCP tool は image を base64 content として返せるため、注釈データを
メモリで保持して `get_latest_feedback_context` / image ツールに返せる。image を読めない CLI のために
`file_path` も返せる設計だが、永続化・監査ログとしてファイル化したい時に disk/hybrid を選べばよく、
既定の `memory` は OS tmp への一時 materialize で済ませて**ユーザーの `inbox` を一切作らない**。

- `memory`（**既定**）: WS push はメモリ保持のみで、`<Downloads>/ai-inbox/` を作らない。
  image を読める CLI（Claude Code）は inline image、読めない CLI（Codex）は image/file_path 要求時に
  プロセス専用の OS tmp へ一時 materialize した `file_path`（終了時に破棄）か `shot_url(?token=)` で取得する。
  再起動を跨ぐ永続化・履歴・`list_feedback`・retention は持たない（必要なら hybrid/disk）。
- `hybrid`: WS push 直後はメモリだけに保持する。context-only MCP tool は disk を使わない。
  `get_latest_feedback_image` / `get_feedback_image` が呼ばれた時だけ `<inbox>/<slug>/` を作り、
  image と同時に `file_path` fallback を返す。
- `disk`: WS push を受けた時点で `<inbox>/<slug>/` に即時保存する。再起動を跨ぐ永続化・履歴・retention 向け。

つまり「Chrome Extension と MCP を直接つなぐ」実用解は、拡張 → daemon は WebSocket で直接 push、
daemon → AI CLI は MCP Streamable HTTP、保存は既定 `memory` で inbox を作らずメモリ完結（永続化が要る時だけ
hybrid/disk）、という構成になる。Chrome 拡張自身は MCP の HTTP endpoint を待ち受けられないため、
AI CLI が接続する MCP サーバープロセスは残る。

### 画像の取得先（ディスクパス非依存 / `/shot/<id>.png`）

`inbox` パスの「連携」は **デーモン ON では必須ではない**。画像は WS で base64 として届き、
MCP は image を inline content として返すので、CLI は `id` でキャプチャを指すだけでよく、
ディスク上のパスを拡張と合意する必要がない（パス合意が本当に要るのは daemon OFF =
`chrome.downloads` フォールバックだけ）。

それをさらに分かりやすくするのが HTTP 画像配信。`id` を URL に入れて取得できる:

```bash
# token は起動時 stderr / ~/.bag-vf/token / healthz で確認
curl -s "http://127.0.0.1:8765/shot/<id>.png?token=<token>" -o shot.png   # 注釈 burn-in 済み
curl -s "http://127.0.0.1:8765/raw/<id>.png?token=<token>"  -o raw.png    # 元スクショ（あれば）
```

- `id` は `list_feedback` / `*_context` が返すもの（フォルダー名 = entry id）。
- `<browser download dir>` に依存しないため、ブラウザのダウンロード先が OS 既定と違っても URL は不変。
- `get_*_context` / image ツールのテキストにも `shot_url` / `raw_url` が併走する（`file_path` を解決
  できない時の代替取得先）。**併走 URL には token を含めない**（`/mcp` は無認証なので、書き込み権限を
  持つ token を読み取り専用の MCP レスポンスへ載せない）。取得時に `?token=<daemon token>` を付与する。
- 認証はトークン必須（不一致/無しは 401）。`memory`/`hybrid` の `shot` は materialize せずメモリから配信する。
- **WS push の ack にも同じ取得先 URL が載る**: 拡張へ返す `ack` に token-less な `shotUrl`
  （raw があれば `rawUrl`）を併走させる。拡張のサイドパネルはこれを「画像URL」として表示するので、
  inbox とブラウザの DL 先がズレていても `id` だけで撮ったものへ到達できる。ack URL も token を
  埋め込まない（取得時に `?token=` を付与）。URL は `image-url.js` で一元生成し、HTTP ルートと同形。

### 複数プロジェクト・同一URLタブの絞り込み（urlContains / titleContains / tabId / windowId）

どのページのキャプチャも 1 つの inbox（既定は `<ブラウザのダウンロードフォルダ>/ai-inbox`）に積まれる。
そのため `get_latest_feedback_context` をそのまま呼ぶと「直前に別プロジェクトで撮ったもの」が返りうる。
`list_feedback` / `get_latest_feedback_context` / `get_latest_feedback_image` は `urlContains` / `titleContains`（部分一致・大小無視）を
受け取り、今のプロジェクトのものだけに絞れる。さらに、同じ URL を複数タブで開いている場合は、拡張サイドパネルに表示される `tabId` / `windowId` を渡して capture を絞れる。

```
bag_page_feedback:get_latest_feedback_context({ urlContains: "example.com" })   # その URL を含む最新だけ
bag_page_feedback:list_feedback({ titleContains: "ダッシュボード" })
bag_page_feedback:get_latest_feedback_context({ urlContains: "example.com", tabId: 123 })  # 同じURLの特定タブ
```

条件に一致しない場合は image を返さず案内テキストを返す（誤って別プロジェクトの画像を掴ませない）。
CLI への運用ヒント: 作業中ページの URL 断片を `urlContains` に渡す。さらに同一URLの複数タブがあり得る作業では、拡張に表示された `tabId` も渡す。`tabId` は Chrome セッション内の一時IDなので、タブを閉じたりブラウザを再起動した後は `contextId` / `id` を証跡として扱う。

さらに、`get_latest_feedback_context` / `get_latest_feedback_image` は「古すぎる最新」を
誤って掴ませないため、最新候補の `capturedAt`（無ければ `mtime`）が鮮度窓（既定90分）を超えている時は
単一 capture として返さない。text/structuredContent に stale 警告だけを返し、top-level `id` も
image も返さない。まずブラウザ拡張でいまの画面を再キャプチャする。過去データを意図して読む場合だけ
`list_feedback` で id を確認し、`get_feedback_context` / `get_feedback_image` を id 指定で使う。

また、`urlContains` / `titleContains` を**付けずに** `get_latest_feedback_context` /
`get_latest_feedback_image` を呼んだ時、鮮度窓内（既定90分・`capturedAt` 基準）に**複数プロジェクト
（異なるホスト）のキャプチャ**があると、単一を勝手に返さず**候補一覧**を返す（image も返さない）。
別案件を「最新」と誤認させないための安全則で、`structuredContent.disambiguation` に候補
（id / host / title / captured_at）が入る。`urlContains` や `tabId` で絞れば従来どおり1件を返す。image が
必要な時は、候補の context を読んだ上でその `id` を `contextId` に渡す。**単一プロジェクトの inbox
では一切発火しない**。鮮度窓/曖昧検知窓は `--latest-window-min` / `BAG_VF_LATEST_WINDOW_MIN`（分）で調整可。

> 動作確認: `node scripts/probe.mjs ~/Downloads/ai-inbox --url <部分一致>` は context-only。
> image 経路を明示的に試す時だけ `--image` を足す。

### inbox の自動掃除（retention・既定 OFF）

共有 inbox には同一ページの古い世代や日齢の古いキャプチャが積み上がる。`--retention on`
（または `BAG_VF_RETENTION=on`）で、デーモンが古い entry を `<inbox>/done/` へ**退避**する
（削除でなく atomic rename。`done/` は一覧・最新取得の対象外）。判定は2軸:

- **MAX-AGE**: `shot.png` の更新時刻が `--retention-max-age`（既定 `14d`）より古い。
- **同一ページ族 cap**: slug の `{host}__{title}` 単位で新しい `--retention-max-per-family`
  （既定 `5`）件だけ残し、古い世代を退避（例: 同じページを9回撮った旧世代を畳む）。

安全則 **GRACE FLOOR**: `--retention-grace`（既定 `30m`）以内の新しい entry は何があっても退避しない
（別 CLI が今 push して直後に読む未読を守る。`max-age`/`done-ttl` は grace 未満にクランプされる）。
`done/` は `--retention-done-ttl`（既定 `7d`）を過ぎたものだけ削除する（それまでは復元可能）。退避された
entry も `id` 指定なら `get_feedback_image` / `/shot/<id>.png` で取り戻せる（最新・一覧からは外れる）。

軸はどちらも「別プロジェクトを巻き込まない」: 族 cap は `{host}__{title}` 単位、MAX-AGE は単一 entry の
日齢のみで、共有バケットを奪い合わない。掃除は起動時・約1時間ごと（`--retention-interval`）・保存直後・
inbox 採用時に走る。**デーモンが動いている間だけ**の機能。期間は `30m`/`14d`/`7d`/`1h` の単位付きで指定。

```bash
node src/index.js --retention on                          # 既定値で有効化
node src/index.js --retention on --retention-max-per-family 3 --retention-max-age 7d
BAG_VF_RETENTION=on node src/index.js
```

## 起動

```bash
cd daemon
npm install
# 既定: storage=memory（inbox を一切作らずメモリ完結。image/file_path 要求時のみ OS tmp に一時 materialize）, port=8765
npm start
# 再起動を跨ぐ永続化・履歴・retention が要る時だけ inbox を使う:
node src/index.js --storage disk     # 受信ごとに <Downloads>/ai-inbox/ へ即時保存
node src/index.js --storage hybrid    # メモリ保持＋image/file_path 要求時だけ inbox へ遅延保存
#   - inbox を使うモードの既定 inbox は OS の Downloads を自動検出（Win=レジストリ / Linux=XDG / mac=~/Downloads）。
#   - さらに拡張が報告する実ダウンロード先（移動済み/Edge・Brave）に自動追従する。
# 明示指定（指定すると「固定」され拡張の報告では上書きされない）:
node src/index.js --storage disk --inbox ~/Downloads/ai-inbox --port 8765
```

確認:

```bash
curl -s http://127.0.0.1:8765/healthz   # {"ok":true,"inboxDir":"...","imageRoute":"/shot/<id>.png","latestWindowMs":5400000,...}
```

環境変数でも設定可: `BAG_VF_INBOX`, `BAG_VF_PORT`, `BAG_VF_HOST`, `BAG_VF_STORAGE`,
`BAG_VF_RETENTION`(on/off), `BAG_VF_RETENTION_MAX_AGE`, `BAG_VF_RETENTION_MAX_PER_FAMILY`,
`BAG_VF_RETENTION_GRACE`, `BAG_VF_RETENTION_DONE_TTL`, `BAG_VF_RETENTION_INTERVAL`, `BAG_VF_LATEST_WINDOW_MIN`。

## 常駐化（ログイン/再起動を跨いで動かす）

ログインや再起動の度に `npm start` し直さなくて済むよう、OS のサービスマネージャ
（macOS = launchd / Linux = systemd user unit）向けのユニット定義を生成できる。

```bash
cd daemon
# 1) まず内容を確認（副作用なし。現在の OS 向けユニットを表示）
npm run service -- --port 8765
# 2) ユーザー領域に書き出す（書き出すだけ。load は自分で実行する）
npm run service -- --write --port 8765
```

`--inbox/--port/--host/--storage` はそのままデーモンの起動引数になり、`--token <t>` は
`BAG_VF_TOKEN` として渡る。`--write` 後に表示される load コマンドを実行して常駐化する:

```bash
# macOS（~/Library/LaunchAgents/com.buddypia.bag-vf-daemon.plist）
launchctl load -w ~/Library/LaunchAgents/com.buddypia.bag-vf-daemon.plist
# Linux（~/.config/systemd/user/bag-vf-daemon.service）
systemctl --user daemon-reload && systemctl --user enable --now bag-vf-daemon.service
```

> `--write` は**ユーザー領域にユニットを書き出すだけ**で、load（システムへの登録）は実行しない。
> 解除/停止コマンドも `--write` 実行時に併せて表示される。Windows は未対応（`nohup`/`pm2`/タスク
> スケジューラ等で `node src/index.js` を常駐させる）。

## 3 CLI への MCP 登録（同じデーモン、キー名だけ違う）

⚠️ **HTTP URL のキー名が CLI ごとに違う**（handoff §4.4 の罠）。同じ `http://127.0.0.1:8765/mcp` を指す。

### Claude Code

```bash
claude mcp add --transport http bag_page_feedback http://127.0.0.1:8765/mcp
```

または `.mcp.json` / settings に:

```json
{
  "mcpServers": {
    "bag_page_feedback": { "type": "http", "url": "http://127.0.0.1:8765/mcp" }
  }
}
```

> alias 名は任意。旧 `bag_visual_feedback` で登録していた場合は `claude mcp remove bag_visual_feedback` してから上記で付け替える。

### Codex CLI

```bash
codex mcp add bag_page_feedback --url http://127.0.0.1:8765/mcp
codex mcp get bag_page_feedback
```

または `~/.codex/config.toml` に:

```toml
[mcp_servers.bag_page_feedback]
url = "http://127.0.0.1:8765/mcp"
```

> **MCP 画像 vision の前提（Codex）**: Streamable HTTP（`url=`）MCP の base64 image content は Codex の
> **rmcp（Rust MCP）クライアント経由でのみ**描画される。`~/.codex/config.toml` で rmcp を有効化する
> （バージョン依存で既定 ON のこともあるが、明示しても無害）:
>
> ```toml
> [features]
> rmcp_client = true   # 古いビルドは experimental_use_rmcp_client = true（非推奨, codex#6995）
>
> [mcp_servers.bag_page_feedback]
> url = "http://127.0.0.1:8765/mcp"
> startup_timeout_sec = 20   # cold materialize は遅いことがある
> tool_timeout_sec = 120
> ```
>
> 生きている設定キー/既定は `codex features list` で確認（`codex --enable rmcp_client` の一発指定も可）。
> ⚠️ rmcp 有効でも、Codex は MCP の inline base64 を vision 化しないビルドがある（codex#4819:
> `<image content>` プレースホルダのまま、base64 はトークンだけ消費）。Codex の**確実な vision 経路は
> 組み込み `view_image`** で返り値の絶対 `file_path`（無ければ `shot_url` に `?token=` を付与）を開くこと。
> だから本デーモンの `file_path`/`shot_url` テキスト併走は Codex にとって fallback ではなく**主経路**に
> なりうる。なお本デーモンは image ツールに structuredContent を一切載せない設計（`*_feedback_image`
> は content[] のみ返す）ので Codex#10334（structuredContent があると content[] の image が落ちる）には
> **該当しない**。

### Antigravity — MCP 設定（`serverUrl` キー）

```json
{
  "mcpServers": {
    "bag_page_feedback": { "serverUrl": "http://127.0.0.1:8765/mcp" }
  }
}
```

> Antigravity の MCP image vision は未検証（handoff §2.2）。image を消費しない場合は返り値の
> `file_path` を IDE に貼って画像を開く。

## 拡張からの WebSocket push を有効にする（任意）

既定では拡張は `chrome.downloads` に保存する。デーモンへ直接送る（ダウンロード通知の山を避ける）には:

1. デーモンを起動し、stderr に出る `token: …` をコピー（保存先は `~/.bag-vf/token`）。
2. 拡張の設定（オプションページ）→「視覚フィードバック デーモン」:
   - 「デーモンへ送る」を ON
   - WebSocket URL = `ws://127.0.0.1:8765/ws`
   - トークン = 上でコピーした値
   - 「接続テスト」で `接続OK` を確認
3. 以降「お描きを画像でAIへ」は WS で push される。既定 `memory` は inbox を作らずメモリ完結、
   `hybrid` は image/file_path 要求時まで保持、`disk` は即時 inbox に書き出す
   （WS 失敗時は自動で `chrome.downloads` にフォールバック）。

## 使い方（検証）

1. ブラウザ拡張でお描き → 「お描きを画像でAIへ」（WS 有効なら push、無効なら `~/Downloads/ai-inbox/<slug>/`）。
2. デーモンを起動（既定 `memory` は inbox を作らず受ける。`disk`/`hybrid` ならその inbox を見る／受ける）。
3. CLI に MCP を登録して、こう頼む:
   「ブラウザで指示した視覚フィードバックを見て直して」
   → CLI が `bag_page_feedback:get_latest_feedback_context` を呼び、`@agent:` / selector / testid を先に読む。
   → 同じ URL のタブが複数ある時は、サイドパネルに表示された `tabId` を `get_latest_feedback_context` / `get_latest_feedback_image` に渡す。
   → 画像が必要な時だけ、context の `id` を `contextId` に入れ、理由を `imageReason` に書いて
   `bag_page_feedback:get_latest_feedback_image` を呼び、返った image を vision 解釈する。
   - **(検証済)** Claude Code は MCP image をネイティブに vision 解釈する（handoff §2.2）。Codex は
     rmcp クライアント有効時に読むが、ビルドによっては inline image を vision 化せず、`file_path` +
     組み込み `view_image` が確実な経路（上記「Codex CLI」節の前提を満たすこと）。
   - **(inline 画像のトークン上限対策)** Claude Code は MCP image の base64 を「テキスト」として
     既定 ~25,000 トークン上限（`MAX_MCP_OUTPUT_TOKENS`）で測り、超過時は image ごと**ハードエラーで落とす**
     （text と違い disk 退避フォールバックが無い・claude-code#9152/#31208）。そのため `{type:'image'}` には
     フル解像度 PNG ではなく、拡張の `offscreen/inline-encode.js` が生成した**コンパクト変種（WebP/JPEG, ~12KB）**
     を載せる。これで Claude Code の inline vision が `MAX_MCP_OUTPUT_TOKENS` を上げずにそのまま通る。
     - フル解像度 PNG は引き続き `file_path` / `shot_url` / `/shot/<id>.png` / `chrome.downloads` で配信する
       （Codex の `view_image` と人間 DL 用。2000px の vision キャップは不変）。
     - コンパクト変種が無い古い entry や、まれにサイズが収まらない場合は image を**省略**し
       `file_path`/`shot_url` のテキストに委ねる（上限を構造的に超えさせない）。
     - もっと大きく鮮明な inline が欲しい時だけ `MAX_MCP_OUTPUT_TOKENS` を上げる（例: `50000`）。

## テスト

```bash
npm test                      # inbox 単体 + MCP(Streamable HTTP) 統合 + WS 受信 統合
node scripts/e2e-smoke.mjs    # 実バイナリで「WS push → 書き込み → MCP 取得」を通しで確認
node scripts/probe.mjs ~/Downloads/ai-inbox [--url <部分一致>]   # 手元 inbox の context 出力を確認
node scripts/probe.mjs ~/Downloads/ai-inbox --image             # 必要時のみ image 経路も確認
```

## セキュリティ

- loopback バインドのみ。**WebSocket は秘密トークンで認証**（クエリ `?token=`、定数時間比較、
  不一致は 401 拒否）。⚠️ loopback は隔離ではない（CVE-2025-52882: localhost WS は悪性 Web ページが
  接続しうる）ため、トークンで拡張だけを許可する。トークンは `~/.bag-vf/token`（0600）。
- **画像配信 `/shot|/raw/<id>.png` も同じトークン必須**（定数時間比較、不一致/無しは 401）。loopback の
  他プロセスへキャプチャ内容を漏らさないため。`id` は slug 文字種のみ許可しパス traversal を排除する。
  `/mcp` は従来どおり loopback バインド前提（認証なし）。
- 書き込みは inbox 配下のみ。slug はサーバ側採番でクライアントのパスは信用しない（traversal 防止）。
- MCP は inbox の絶対パスを返すため、共有マシンでは inbox の場所に注意。
- 常駐化（launchd/systemd）は `npm run service` で対応（上記「常駐化」節）。
- まだ未対応（Phase 2 候補）: 複数 inbox root の whitelist、Antigravity の image vision 実測。再接続は拡張側の push が1回限り（push→ack→close、失敗時は `chrome.downloads` フォールバック）なので永続接続の再接続は非該当。
