// 保存済みワークフローの MCP ツール: 拡張へ WS の workflow 要求(op)を渡し、結果を返す。承認するツールは無い。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../src/http.js';

async function withClient(extensionRequest, fn) {
  const inboxDir = mkdtempSync(join(tmpdir(), 'bag-wf-tools-'));
  const server = createHttpServer({ inboxDir, extensionRequest });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const client = new Client({ name: 'wf-client', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
  try {
    return await fn(client);
  } finally {
    await client.close();
    await new Promise((r) => server.close(r));
    rmSync(inboxDir, { recursive: true, force: true });
  }
}

test('workflow tools: 拡張へ op を渡し、応答の ok/type/requestId を除いて返す。承認するツールは無い', async () => {
  const calls = [];
  const extensionRequest = async (type, params) => {
    calls.push({ type, params });
    if (params.op === 'run') return { type: 'workflow_result', requestId: 'r1', ok: true, started: true, tabId: 5, workflow: { id: params.workflowId } };
    return { type: 'workflow_result', requestId: 'r0', ok: true, run: { active: false } };
  };
  await withClient(extensionRequest, async (client) => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ['list_workflows', 'run_workflow', 'get_workflow_run', 'stop_workflow']) assert.ok(names.includes(n), n);
    assert.equal(names.some((n) => /approve/i.test(n)), false, 'エージェントが自分の実行を承認できない');

    const run = await client.callTool({ name: 'run_workflow', arguments: { workflowId: 'wf-1', vars: { q: 'pen' } } });
    assert.deepEqual(run.structuredContent, { started: true, tabId: 5, workflow: { id: 'wf-1' } });
    await client.callTool({ name: 'list_workflows', arguments: {} });
    await client.callTool({ name: 'get_workflow_run', arguments: {} });
    await client.callTool({ name: 'stop_workflow', arguments: {} });
    assert.deepEqual(
      calls.map((c) => [c.type, c.params]),
      [
        ['workflow', { op: 'run', workflowId: 'wf-1', vars: { q: 'pen' } }],
        ['workflow', { op: 'list' }],
        ['workflow', { op: 'status' }],
        ['workflow', { op: 'stop' }],
      ],
    );
  });
});

test('workflow tools: 拡張が断ったら(未保存の手順など) isError で理由を返す', async () => {
  const extensionRequest = async () => {
    throw new Error('The side panel has unsaved working steps. Ask the user to save or discard them first.');
  };
  await withClient(extensionRequest, async (client) => {
    const res = await client.callTool({ name: 'run_workflow', arguments: { workflowId: 'wf-1' } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /unsaved working steps/);
  });
});
