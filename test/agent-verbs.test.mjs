// 外部エージェント経路(execute_actions / cdp-bridge)の動詞 allow-list のパリティ検査。
// 拡張(content-script.js の AGENT_ALLOWED_VERBS)が実行時に強制し、daemon(EXECUTE_ACTIONS_VERBS)が
// MCP の入力スキーマで示す。両者がずれると、示した動詞が実行時に断られるか、断るべき動詞を示してしまう。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EXECUTE_ACTIONS_VERBS } from '../daemon/src/server.js';

const src = fs.readFileSync(new URL('../content/content-script.js', import.meta.url), 'utf8');
const marker = 'const AGENT_ALLOWED_VERBS';
const i = src.indexOf(marker);
assert.ok(i >= 0, `${marker} が content に存在する`);
const open = src.indexOf('[', i);
const close = src.indexOf(']', open);
const contentVerbs = [...src.slice(open + 1, close).matchAll(/'([^']*)'/g)].map((m) => m[1]);

assert.deepEqual(contentVerbs, EXECUTE_ACTIONS_VERBS, 'content と daemon の allow-list が一致する');

const registry = new Set([...src.matchAll(/^ {4}([A-Za-z]+): \{$/gm)].map((m) => m[1]));
for (const verb of EXECUTE_ACTIONS_VERBS) assert.ok(registry.has(verb), `${verb} は AI_VERBS に実在する`);
for (const danger of ['injectScript', 'injectHtml', 'injectCss', 'injectButton', 'injectPanel', 'navigateTo', 'goBack', 'submitForm', 'removeElement', 'defineMarker', 'addWorkflowStep']) {
  assert.equal(EXECUTE_ACTIONS_VERBS.includes(danger), false, `${danger} は外部エージェントに許さない`);
}
console.log('ok - 外部エージェントの動詞 allow-list は content と daemon で一致し、危険な動詞を含まない');
