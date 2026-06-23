# Browser Agent Guide 視覚フィードバック デーモン（Phase 1 / 受信側 + 消費側）

ブラウザのお描き注釈スクリーンショットを 1 プロセスで受け取り・公開する常駐デーモン。

- **受信（WebSocket / `/ws`）**: 拡張の「お描きを画像でAIへ」が push した PNG+注釈を、
  トークン認証のうえ受け取る。既定は inbox に即時書き出し（原子的書き込み・0600・slug 採番はサーバ側）。
  `--storage hybrid` ではまずメモリに保持し、MCP の image/file_path 要求時だけ inbox に書き出す。
- **公開（MCP / Streamable HTTP / `/mcp`）**: AI コーディング CLI はまず `get_latest_visual_feedback_context`
  で **画像なしの軽量メタ**を読み、必要な時だけ `get_latest_visual_feedback` で
  **image(PNG) + ファイルパスの両方**を受け取って vision 解釈できる。image ツールは
  context で確認した `contextId` と `imageReason` がないと画像を返さない。

- **画像取得（HTTP GET / `/shot/<id>.png`・`/raw/<id>.png`）**: ディスクパス非依存の取得先。
  `id` だけで PNG を取れるので、ブラウザのダウンロード先と inbox がズレても（移動済み/Edge・Brave/
  「毎回確認」）`file_path` を解決せずに画像へ到達できる。トークン必須（クエリ `?token=`）。

受信・公開・画像取得は**同一ポート**に同居（HTTP は `/mcp`・`/shot|/raw`、WebSocket upgrade は `/ws`）。

> 拡張側の WS push は無効化も可能で、その場合は従来どおり `chrome.downloads` に保存される。

## 何をするか

- 拡張からの WebSocket push を受ける（トークン認証）。既定は inbox 保存、`hybrid` はメモリ優先。
- inbox(`<slug>/shot.png` + `annotation.json` + `memo.md`)を新しい順にスキャン。
- 5 つの MCP ツールを公開:
  - `bag_visual_feedback:list_visual_feedback` — 一覧（id・取得元 url/title 付き）
  - `bag_visual_feedback:get_latest_visual_feedback_context` — 最新を image なしの text/structured context で返す（主用途）
  - `bag_visual_feedback:get_visual_feedback_context` — id 指定で image なし context を返す
  - `bag_visual_feedback:get_latest_visual_feedback` — context 確認後のみ最新を image+パスで返す（必要時の vision）
  - `bag_visual_feedback:get_visual_feedback` — context 確認後のみ id 指定で image+パスを返す
- image ツールでは、image を読めない CLI 向けに `file_path` テキストを併走させる（fallback 内蔵）。
  `hybrid` でも、この image ツールを呼んだ時点で `file_path` 用の `shot.png` を materialize する。
  ただし image バイトは常にメモリ優先で返し、disk への materialize は **best-effort**（read-only
  inbox / disk full 等で失敗しても、inline image + `shot_url` で応答し落とさない。`/shot` 配信と同じ
  「バイトはメモリ優先」方針）。materialize に失敗した時だけ `file_path` 行を省き `shot_url` を案内する。
- context 出力は `dataAgentId` (`@agent:`) を最優先にし、`selector` / `testid` / `anchorLabel`
  で足りる時は image を取得しない。

### storage mode（disk / hybrid）

`inbox` は MCP の仕様上必須ではない。MCP tool は image を base64 content として返せるため、注釈データを
メモリで保持して `get_latest_visual_feedback_context` に返すことはできる。一方、このデーモンは
image を読めない CLI のために `file_path` も必ず返す設計なので、最終的な fallback と監査ログとして
ファイル化できる経路は残している。

- `disk`（既定）: WS push を受けた時点で `<inbox>/<slug>/` に保存する。既存 UI/運用と互換。
- `hybrid`: WS push 直後はメモリだけに保持する。context-only MCP tool は disk を使わない。
  `get_latest_visual_feedback` / `get_visual_feedback` が呼ばれた時だけ `<inbox>/<slug>/` を作り、
  image と同時に `file_path` fallback を返す。

つまり「Chrome Extension と MCP を直接つなぐ」実用解は、拡張 → daemon は WebSocket で直接 push、
daemon → AI CLI は MCP Streamable HTTP、保存は `hybrid` で遅延、という構成になる。Chrome 拡張自身は
MCP の HTTP endpoint を待ち受けられないため、AI CLI が接続する MCP サーバープロセスは残る。

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

- `id` は `list_visual_feedback` / `*_context` が返すもの（フォルダー名 = entry id）。
- `<browser download dir>` に依存しないため、ブラウザのダウンロード先が OS 既定と違っても URL は不変。
- `get_*_context` / image ツールのテキストにも `shot_url` / `raw_url` が併走する（`file_path` を解決
  できない時の代替取得先）。**併走 URL には token を含めない**（`/mcp` は無認証なので、書き込み権限を
  持つ token を読み取り専用の MCP レスポンスへ載せない）。取得時に `?token=<daemon token>` を付与する。
- 認証はトークン必須（不一致/無しは 401）。`hybrid` の `shot` は materialize せずメモリから配信する。
- **WS push の ack にも同じ取得先 URL が載る**: 拡張へ返す `ack` に token-less な `shotUrl`
  （raw があれば `rawUrl`）を併走させる。拡張のサイドパネルはこれを「画像URL」として表示するので、
  inbox とブラウザの DL 先がズレていても `id` だけで撮ったものへ到達できる。ack URL も token を
  埋め込まない（取得時に `?token=` を付与）。URL は `image-url.js` で一元生成し、HTTP ルートと同形。

### 複数プロジェクトの絞り込み（urlContains / titleContains）

どのページのキャプチャも 1 つの inbox（既定は `<ブラウザのダウンロードフォルダ>/ai-inbox`）に積まれる。
そのため `get_latest_visual_feedback_context` をそのまま呼ぶと「直前に別プロジェクトで撮ったもの」が返りうる。
`list_visual_feedback` / `get_latest_visual_feedback_context` / `get_latest_visual_feedback` は `urlContains` / `titleContains`（部分一致・大小無視）を
受け取り、今のプロジェクトのものだけに絞れる。

```
bag_visual_feedback:get_latest_visual_feedback_context({ urlContains: "example.com" })   # その URL を含む最新だけ
bag_visual_feedback:list_visual_feedback({ titleContains: "ダッシュボード" })
```

条件に一致しない場合は image を返さず案内テキストを返す（誤って別プロジェクトの画像を掴ませない）。
CLI への運用ヒント: 作業中ページの URL 断片を `urlContains` に渡すよう AGENTS.md / CLAUDE.md に書いておくとよい。

さらに、`urlContains` / `titleContains` を**付けずに** `get_latest_visual_feedback_context` /
`get_latest_visual_feedback` を呼んだ時、直近（既定90分・`capturedAt` 基準）に**複数プロジェクト
（異なるホスト）のキャプチャ**があると、単一を勝手に返さず**候補一覧**を返す（image も返さない）。
別案件を「最新」と誤認させないための安全則で、`structuredContent.disambiguation` に候補
（id / host / title / captured_at）が入る。`urlContains` で絞れば従来どおり1件を返す。image が
必要な時は、候補の context を読んだ上でその `id` を `contextId` に渡す。**単一プロジェクトの inbox
では一切発火しない**（従来挙動のまま）。窓は `--latest-window-min` / `BAG_VF_LATEST_WINDOW_MIN`（分）で調整可。

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
entry も `id` 指定なら `get_visual_feedback` / `/shot/<id>.png` で取り戻せる（最新・一覧からは外れる）。

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
# 既定: inbox=<自動検出した Downloads>/ai-inbox（拡張のフォールバック保存先に一致）, port=8765
#   - Downloads は OS から自動検出（Win=レジストリ / Linux=XDG / mac=~/Downloads）。
#   - さらに拡張が報告する実ダウンロード先（移動済み/Edge・Brave）に自動追従する。
npm start
# 明示指定（指定すると「固定」され拡張の報告では上書きされない）:
node src/index.js --inbox ~/Downloads/ai-inbox --port 8765
# プロジェクト直下の .ai-inbox を見る場合:
node src/index.js --inbox ./.ai-inbox
# inbox への即時保存を避け、MCP image/file_path 要求時だけ保存する場合:
node src/index.js --storage hybrid
```

確認:

```bash
curl -s http://127.0.0.1:8765/healthz   # {"ok":true,"inboxDir":"...","imageRoute":"/shot/<id>.png","storage":"disk|hybrid",...}
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
claude mcp add --transport http bag_visual_feedback http://127.0.0.1:8765/mcp
```

または `.mcp.json` / settings に:

```json
{
  "mcpServers": {
    "bag_visual_feedback": { "type": "http", "url": "http://127.0.0.1:8765/mcp" }
  }
}
```

### Codex CLI

```bash
codex mcp add bag_visual_feedback --url http://127.0.0.1:8765/mcp
codex mcp get bag_visual_feedback
```

または `~/.codex/config.toml` に:

```toml
[mcp_servers.bag_visual_feedback]
url = "http://127.0.0.1:8765/mcp"
```

### Antigravity — MCP 設定（`serverUrl` キー）

```json
{
  "mcpServers": {
    "bag_visual_feedback": { "serverUrl": "http://127.0.0.1:8765/mcp" }
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
3. 以降「お描きを画像でAIへ」は WS で push される。`disk` ではデーモンが即時 inbox に書き出し、
   `hybrid` では MCP の image/file_path 要求時までメモリに保持する
   （失敗時は自動で `chrome.downloads` にフォールバック）。

## 使い方（検証）

1. ブラウザ拡張でお描き → 「お描きを画像でAIへ」（WS 有効なら push、無効なら `~/Downloads/ai-inbox/<slug>/`）。
2. デーモンを起動（既定でその inbox を見る／受ける）。
3. CLI に MCP を登録して、こう頼む:
   「ブラウザで指示した視覚フィードバックを見て直して」
   → CLI が `bag_visual_feedback:get_latest_visual_feedback_context` を呼び、`@agent:` / selector / testid を先に読む。
   → 画像が必要な時だけ、context の `id` を `contextId` に入れ、理由を `imageReason` に書いて
   `bag_visual_feedback:get_latest_visual_feedback` を呼び、返った image を vision 解釈する。
   - **(検証済)** Claude Code / Codex が MCP image を実際に vision として読む（handoff §2.2）。

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
