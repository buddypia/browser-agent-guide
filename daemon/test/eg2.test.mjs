import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { checkEg2Health, evaluateGoalWithEg2 } from '../src/eg2.js';
import { createMcpServer } from '../src/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// テスト用の軽量 HTTP モックサーバーを作成するヘルパー
function createMockEg2Server(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}`;
      resolve({
        url,
        close: () => new Promise((res) => server.close(res)),
      });
    });
  });
}

test('checkEg2Health: 正常系 (HTTP 200)', async () => {
  const mock = await createMockEg2Server((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  try {
    const result = await checkEg2Health({ eg2Url: mock.url, timeoutMs: 1000 });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'ok');
  } finally {
    await mock.close();
  }
});

test('checkEg2Health: 未起動ポートへの接続エラー (ECONNREFUSED)', async () => {
  // 未使用と思われるポート
  const result = await checkEg2Health({ eg2Url: 'http://127.0.0.1:59999', timeoutMs: 500 });
  assert.equal(result.ok, false);
  assert.ok(result.hint?.includes('eg2 start'));
});

test('evaluateGoalWithEg2: 正常系 (POST /v1/evaluate)', async () => {
  let receivedBody = null;
  const mock = await createMockEg2Server((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/evaluate') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        receivedBody = JSON.parse(raw);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choice: 'success',
            score: 0.942,
            scores: { success: 0.942, failure: 0.058 },
          })
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  try {
    const result = await evaluateGoalWithEg2({
      eg2Url: mock.url,
      imageBase64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      goal: 'モーダルが閉じている',
      choices: { success: '閉じている', failure: '開いている' },
      model: '440m',
      timeoutMs: 2000,
    });

    assert.equal(result.ok, true);
    assert.equal(result.choice, 'success');
    assert.equal(result.score, 0.942);
    assert.equal(result.scores.success, 0.942);

    assert.ok(receivedBody);
    assert.equal(receivedBody.goal, 'モーダルが閉じている');
    assert.equal(receivedBody.embedding_model, '440m');
    assert.equal(receivedBody.choices.success, '閉じている');
    assert.ok(Array.isArray(receivedBody.images));
    assert.ok(!receivedBody.images[0].startsWith('data:image'));
  } finally {
    await mock.close();
  }
});

test('evaluateGoalWithEg2: 引数バリデーション (必須フィールド欠落)', async () => {
  const res1 = await evaluateGoalWithEg2({ imageBase64: '', goal: 'test' });
  assert.equal(res1.ok, false);
  assert.ok(res1.error.includes('imageBase64 is required'));

  const res2 = await evaluateGoalWithEg2({ imageBase64: 'abc', goal: '' });
  assert.equal(res2.ok, false);
  assert.ok(res2.error.includes('goal is required'));
});

test('evaluate_feedback_goal MCP ツール: 画像付きエントリの評価', async () => {
  const dummyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const dummyEntry = {
    id: '20261008-120000__example_com__test__1234',
    url: 'https://example.com/test',
    title: 'Test Page',
    storage: 'memory',
    materialized: false,
    shotBuffer: dummyPng,
    annotation: {
      url: 'https://example.com/test',
      title: 'Test Page',
      capturedAt: new Date().toISOString(),
      items: [],
    },
  };

  const mockStore = {
    findEntry: (id) => (id === dummyEntry.id ? dummyEntry : null),
    queryEntries: () => [dummyEntry],
    materialize: (e) => e,
  };

  const mockEg2 = await createMockEg2Server((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/evaluate') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choice: 'success', score: 0.98, scores: { success: 0.98, failure: 0.02 } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  try {
    const server = createMcpServer(mockStore);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const res = await client.callTool({
      name: 'evaluate_feedback_goal',
      arguments: {
        id: dummyEntry.id,
        goal: 'ボタンが緑色になっている',
        eg2Url: mockEg2.url,
      },
    });

    assert.equal(Boolean(res.isError), false);
    assert.ok(res.content[0].text.includes('判定結果: success'));
    assert.ok(res.content[0].text.includes('スコア: 0.980'));
    assert.equal(res.structuredContent.choice, 'success');
    assert.equal(res.structuredContent.score, 0.98);

    await client.close();
    await server.close();
  } finally {
    await mockEg2.close();
  }
});

test('evaluate_feedback_goal MCP ツール: text-only エントリはエラー', async () => {
  const textOnlyEntry = {
    id: 'text-only-1',
    storage: 'memory',
    annotation: {
      url: 'https://example.com/notes',
      items: [{ note: 'hello' }],
    },
  };

  const mockStore = {
    findEntry: (id) => (id === textOnlyEntry.id ? textOnlyEntry : null),
    queryEntries: () => [textOnlyEntry],
    materialize: (e) => e,
  };

  const server = createMcpServer(mockStore);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const res = await client.callTool({
    name: 'evaluate_feedback_goal',
    arguments: {
      id: textOnlyEntry.id,
      goal: 'テキストが表示されている',
    },
  });

  assert.equal(res.isError, true);
  assert.ok(res.content[0].text.includes('text-only'));

  await client.close();
  await server.close();
});
