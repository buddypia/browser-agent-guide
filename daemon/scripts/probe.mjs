// 実 inbox に対して、実 MCP クライアント(Streamable HTTP)で取得できるかを確認するプローブ。
// 既定は context-only。image は高コストなので --image が明示された時だけ取得する。
// 使い方: node scripts/probe.mjs [inboxDir] [--url <部分一致>] [--title <部分一致>] [--image]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../src/http.js';
import { resolveInboxDir } from '../src/inbox.js';

const argv = process.argv.slice(2);
const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--url' && argv[i - 1] !== '--title');
const getOpt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const filter = {};
if (getOpt('--url')) filter.urlContains = getOpt('--url');
if (getOpt('--title')) filter.titleContains = getOpt('--title');
const wantsImage = argv.includes('--image');
const inboxDir = resolveInboxDir(positional[0]);
const server = createHttpServer({ inboxDir });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();
const url = new URL(`http://127.0.0.1:${port}/mcp`);

const client = new Client({ name: 'probe', version: '0' });
await client.connect(new StreamableHTTPClientTransport(url));

console.log('inbox:', inboxDir);
console.log('filter:', JSON.stringify(filter));
console.log('image:', wantsImage ? 'enabled by --image' : 'skipped (context-only)');
const list = await client.callTool({ name: 'list_visual_feedback', arguments: { ...filter } });
console.log('\n[list_visual_feedback]\n' + list.content.find((c) => c.type === 'text').text);

const context = await client.callTool({ name: 'get_latest_visual_feedback_context', arguments: { ...filter } });
const contextText = context.content.find((c) => c.type === 'text');
console.log('\n[get_latest_visual_feedback_context]');
console.log('  text:\n' + contextText.text.split('\n').map((l) => '    ' + l).join('\n'));

if (wantsImage) {
  const contextId = context.structuredContent?.id;
  if (!contextId) {
    console.log('\n[get_latest_visual_feedback]');
    console.log('  skipped: context did not return an id');
  } else {
    const latest = await client.callTool({
      name: 'get_latest_visual_feedback',
      arguments: {
        ...filter,
        contextId,
        imageReason: 'probe --image was explicitly requested to verify the high-cost vision path',
      },
    });
    const img = latest.content.find((c) => c.type === 'image');
    const txt = latest.content.find((c) => c.type === 'text');
    console.log('\n[get_latest_visual_feedback]');
    if (img) {
      const buf = Buffer.from(img.data, 'base64');
      const isPng = buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      console.log(`  image: ${img.mimeType}, ${buf.length} bytes, valid PNG=${isPng}`);
    }
    console.log('  text:\n' + txt.text.split('\n').map((l) => '    ' + l).join('\n'));
  }
} else {
  console.log('\n[get_latest_visual_feedback]');
  console.log('  skipped: pass --image only when context is insufficient and vision must be tested');
}

await client.close();
await new Promise((r) => server.close(r));
