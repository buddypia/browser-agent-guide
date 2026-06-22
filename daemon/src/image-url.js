// /shot|/raw 画像配信 URL を1か所で組み立てる純関数。
// http.js のルート（GET /shot|/raw/<id>.png）と ws.js の ack（拡張へ返す取得先）が
// 同じ形を共有するための単一の真実。format を変えるとルート正規表現と齟齬が出るので注意。
//
// 重要: token は URL に埋め込まない。/mcp は無認証で、ack も書き込み権限を持つ token を載せたくない。
// 取得側（CLI / 拡張のサイドパネル）が別途 ?token=<daemon token> を付与する（README 参照）。
// host は接続に使われた authority(host:port)。同じ宛先で必ず到達できる。
export function imageUrlFor(host, id, kind = 'shot') {
  const safeHost = host || '127.0.0.1';
  const seg = kind === 'raw' ? 'raw' : 'shot';
  return `http://${safeHost}/${seg}/${encodeURIComponent(id)}.png`;
}
