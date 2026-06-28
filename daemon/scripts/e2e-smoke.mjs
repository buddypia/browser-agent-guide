// 実バイナリ end-to-end スモーク: 実際に node src/index.js を起動し、
// 拡張役の WS クライアントで push → デーモンが書き込み → MCP クライアントで get_latest 取得、
// を一連で確認する。一時 inbox を使うので Downloads は汚さない。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const here = dirname(fileURLToPath(import.meta.url));
const indexJs = resolve(here, '../src/index.js');
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TOKEN = 'e2e-token';
const PORT = 8791;
const inbox = mkdtempSync(join(tmpdir(), 'vf-e2e-'));
// 偽 WebP（RIFF....WEBP）。MCP inline 専用コンパクト変種の経路を検証する。
const INLINE_WEBP_B64 = (() => {
  const pad = Buffer.alloc(64, 0x20);
  return Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), pad]).toString('base64');
})();
const INLINE_MAX_BYTES = 14 * 1024; // inbox.js と同じ omit 閾値（回帰検知用）。

// retention 検証用: 起動前に「古い別案件」を1件仕込む（起動時 sweep で done/ へ退避されるはず）。
const STALE_ID = '20260101-000000__stale-example-com__stale__deadbee';
{
  const dir = join(inbox, STALE_ID);
  mkdirSync(dir, { recursive: true });
  const png = Buffer.from(PNG_B64, 'base64');
  writeFileSync(join(dir, 'shot.png'), png);
  writeFileSync(
    join(dir, 'annotation.json'),
    JSON.stringify({ url: 'https://stale.example.com/old', title: 'STALE', capturedAt: '2026-01-01T00:00:00.000Z', items: [] })
  );
  const past = new Date(Date.now() - 10_000); // 10秒前（grace/maxAge=1s より十分古い）
  utimesSync(join(dir, 'shot.png'), past, past);
}

// retention ON。maxAge=5s(stale 10s前は退避、push 直後の新規は対象外)、grace=1s、
// maxPerFamily=1(同一ページ族の新世代 push で旧世代を退避させ onSaved sweep を検証)、doneTtl は大きく。
const proc = spawn(
  'node',
  [
    indexJs, '--inbox', inbox, '--port', String(PORT), '--token', TOKEN,
    // このスモークは inbox への即時保存と retention(done/ 退避)を検証するので disk を明示する
    // （既定の memory モードは inbox を作らないため、ここでは disk に固定する）。
    '--storage', 'disk',
    '--retention', 'on', '--retention-max-age', '5s', '--retention-grace', '1s',
    '--retention-max-per-family', '1', '--retention-done-ttl', '100d',
  ],
  { stdio: ['ignore', 'inherit', 'inherit'] }
);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function wsPush(payload) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
    const t = setTimeout(() => rej(new Error('ws timeout')), 4000);
    ws.on('open', () => ws.send(JSON.stringify(payload)));
    ws.on('message', (d) => {
      clearTimeout(t);
      ws.close();
      res(JSON.parse(d.toString()));
    });
    ws.on('error', rej);
  });
}
function fail(msg) {
  console.error('NG:', msg);
  proc.kill();
  rmSync(inbox, { recursive: true, force: true });
  process.exit(1);
}

try {
  await wait(800); // listen 待ち

  // 1) 拡張役: WS push
  const ack = await wsPush({
    type: 'visual_feedback',
    capturedAt: '2026-06-18T02:03:04.005Z',
    url: 'https://example.com/e2e',
    title: 'E2E',
    image: { shot: PNG_B64, raw: PNG_B64, inline: `data:image/webp;base64,${INLINE_WEBP_B64}`, inlineMime: 'image/webp' },
    annotation: { url: 'https://example.com/e2e', title: 'E2E', items: [{ n: 1, note: 'E2E メモ' }] },
    memo: '# memo\n',
  });
  if (ack.type !== 'ack') fail(`ack ではない: ${JSON.stringify(ack)}`);
  console.log('OK push → ack id =', ack.id);

  // 2) CLI役: MCP context-first → 必要時 image get_latest
  const client = new Client({ name: 'e2e', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)));
  const ctx = await client.callTool({ name: 'get_latest_visual_feedback_context', arguments: { urlContains: 'e2e' } });
  const res = await client.callTool({
    name: 'get_latest_visual_feedback',
    arguments: {
      urlContains: 'e2e',
      contextId: ctx.structuredContent?.id,
      imageReason: 'e2e smoke explicitly verifies the high-cost MCP image transport path',
    },
  });
  await client.close();
  const ctxTxt = ctx.content.find((c) => c.type === 'text');
  if (!ctxTxt?.text.includes(ack.id)) fail('context が push したエントリを返さない');
  const img = res.content.find((c) => c.type === 'image');
  const txt = res.content.find((c) => c.type === 'text');
  if (!img) fail('MCP が image を返さない');
  if (!txt.text.includes(ack.id)) fail('get_latest が push したエントリを返さない');
  // inline コンパクト変種を渡したので webp で返り、サイズは omit 閾値より十分小さいはず（回帰検知）。
  if (img.mimeType !== 'image/webp') fail(`inline を渡したのに image mime が webp でない: ${img.mimeType}`);
  const inlineBytes = Buffer.from(img.data, 'base64').length;
  if (inlineBytes > INLINE_MAX_BYTES) fail(`inline image が予算超過: ${inlineBytes} > ${INLINE_MAX_BYTES}`);
  console.log('OK MCP context-first → context と image の両方が path に', ack.id, 'を含む');
  console.log('OK MCP get_latest → inline', img.mimeType, inlineBytes, 'bytes (<', INLINE_MAX_BYTES, ')');

  // 3) retention 検証: 起動時 sweep が stale を done/ へ退避 → 一覧から消え、id 指定では done/ から復元できる
  const client2 = new Client({ name: 'e2e-retention', version: '0' });
  await client2.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)));
  const listRes = await client2.callTool({ name: 'list_visual_feedback', arguments: {} });
  const listTxt = listRes.content.find((c) => c.type === 'text')?.text || '';
  const staleCtx = await client2.callTool({ name: 'get_visual_feedback_context', arguments: { id: STALE_ID } });
  await client2.close();
  if (listTxt.includes(STALE_ID)) fail('retention: stale が一覧に残っている（done/ へ退避されていない）');
  if (staleCtx.structuredContent?.id !== STALE_ID) fail('retention: 退避した stale を id で復元できない（findEntry done/ graft）');
  console.log('OK retention(startup) → stale を done/ へ退避し、一覧から消え、id 指定では done/ から復元できる');

  // 4) onSaved sweep 検証: grace を抜けた後に同一ページ族の新世代を push すると、
  //    保存直後の sweep(onSaved) が旧世代を family cap(=1) で done/ へ退避する。
  await wait(1500); // 1回目(ack.id)を grace(1s)外にする
  const ack2 = await wsPush({
    type: 'visual_feedback',
    capturedAt: '2026-06-18T02:03:06.005Z', // 別 capturedAt → 別 id・同 family(example-com__e2e)
    url: 'https://example.com/e2e',
    title: 'E2E',
    image: { shot: PNG_B64 },
    annotation: { url: 'https://example.com/e2e', title: 'E2E', items: [{ n: 1, note: '2nd' }] },
  });
  if (ack2.type !== 'ack' || ack2.id === ack.id) fail(`2回目 push の ack 異常: ${JSON.stringify(ack2)}`);
  await wait(300); // onSaved sweep 完了待ち
  const client3 = new Client({ name: 'e2e-onsaved', version: '0' });
  await client3.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)));
  const list2 = await client3.callTool({ name: 'list_visual_feedback', arguments: {} });
  const list2Txt = list2.content.find((c) => c.type === 'text')?.text || '';
  const oldCtx = await client3.callTool({ name: 'get_visual_feedback_context', arguments: { id: ack.id } });
  await client3.close();
  if (list2Txt.includes(ack.id)) fail('onSaved sweep: 旧世代が一覧に残っている（family cap で退避されていない）');
  if (!list2Txt.includes(ack2.id)) fail('onSaved sweep: 新世代が一覧に無い');
  if (oldCtx.structuredContent?.id !== ack.id) fail('onSaved sweep: 退避した旧世代を id で復元できない');
  console.log('OK retention(onSaved) → 新世代 push で旧世代が family cap により done/ へ退避し、id 復元可');

  console.log('\nE2E OK: 拡張(WS push) → デーモン → CLI(MCP) + retention(startup/onSaved) が一連で通った');
  proc.kill();
  rmSync(inbox, { recursive: true, force: true });
  process.exit(0);
} catch (e) {
  fail(String(e?.message || e));
}
