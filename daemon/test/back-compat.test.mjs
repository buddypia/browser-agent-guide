// vf → page-feedback 改名の後方互換ガード。
// 旧命名（BAG_VF_* 環境変数 / ~/.bag-vf/token / visualFeedback）が引き続き機能することを固定する。
// 新命名（BAG_PF_*）は旧命名より優先される。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRetentionPolicy } from '../src/retention.js';
import { loadOrCreateToken, tokenPath, legacyTokenPath } from '../src/token.js';

test('retention: 旧 env BAG_VF_RETENTION を後方互換で読む', () => {
  assert.equal(resolveRetentionPolicy({ env: { BAG_VF_RETENTION: 'on' } }).enabled, true);
  assert.equal(resolveRetentionPolicy({ env: {} }).enabled, false);
});

test('retention: 新 env BAG_PF_* が旧 BAG_VF_* より優先される', () => {
  const p = resolveRetentionPolicy({ env: { BAG_PF_RETENTION: 'off', BAG_VF_RETENTION: 'on' } });
  assert.equal(p.enabled, false, '新命名が勝つ');
});

test('token: 旧 env BAG_VF_TOKEN を後方互換で読む（新 BAG_PF_TOKEN が優先）', () => {
  const saved = { pf: process.env.BAG_PF_TOKEN, vf: process.env.BAG_VF_TOKEN };
  try {
    delete process.env.BAG_PF_TOKEN;
    process.env.BAG_VF_TOKEN = 'legacy-token';
    assert.equal(loadOrCreateToken(), 'legacy-token');
    process.env.BAG_PF_TOKEN = 'new-token';
    assert.equal(loadOrCreateToken(), 'new-token', '新命名が勝つ');
  } finally {
    if (saved.pf === undefined) delete process.env.BAG_PF_TOKEN;
    else process.env.BAG_PF_TOKEN = saved.pf;
    if (saved.vf === undefined) delete process.env.BAG_VF_TOKEN;
    else process.env.BAG_VF_TOKEN = saved.vf;
  }
});

test('token: 新パスは ~/.bag-pf/token、旧パスは ~/.bag-vf/token を指す', () => {
  assert.ok(tokenPath().endsWith('/.bag-pf/token') || tokenPath().endsWith('\\.bag-pf\\token'));
  assert.ok(legacyTokenPath().endsWith('/.bag-vf/token') || legacyTokenPath().endsWith('\\.bag-vf\\token'));
});
