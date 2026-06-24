// lib/prompt.js の buildSystemPrompt 単体テスト（bare node script: `node test/prompt.test.mjs`）。
// 目的: 補足(note)が「手順N」として“拡張内チャットAIの主経路”であるシステムプロンプトに
//       番号付きで出ること（buildContextText の export 経路だけでなく、ここにも届く）。
//       併せて、お描き(drawing)のワークフロー手順節が従来どおり出る回帰防止。

import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../lib/prompt.js';

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`ok - ${name}`);
};

// (1) 補足は「💬 手順N（人の補足｜番号順に実施）: 本文」で番号付きに出る。
{
  const p = buildSystemPrompt({
    context: {
      annotations: [
        { kind: 'note', note: '送信前に確認', step: 1, target: '送信ボタン' },
        { kind: 'note', note: '氏名を入力', step: 2, target: '氏名欄' },
      ],
    },
  });
  assert.match(p, /💬 手順1（人の補足｜番号順に実施）: 送信前に確認/, '手順1 が出る');
  assert.match(p, /💬 手順2（人の補足｜番号順に実施）: 氏名を入力/, '手順2 が出る');
  assert.doesNotMatch(p, /💬 補足: /, '番号なしの旧表記は出ない');
  ok('補足はシステムプロンプトに手順番号付きで出る');
}

// (2) step 欠落の後方互換（古い summary でも落ちない）。
{
  const p = buildSystemPrompt({ context: { annotations: [{ kind: 'note', note: 'X' }] } });
  assert.match(p, /💬 手順\?（人の補足｜番号順に実施）: X/, 'step 欠落時は ? でフォールバック');
  ok('step 欠落でも例外なくフォールバック表記で出る');
}

// (3) お描き(drawing)は従来どおりワークフロー手順ブロックに出る（回帰防止）。
{
  const p = buildSystemPrompt({
    context: {
      annotations: [{ kind: 'drawing', note: 'ここを押す', shapeText: '丸', forAI: true, step: 1 }],
      workflow: { count: 1, steps: [{ step: 1, target: 'ボタン', shape: '丸', note: 'ここを押す', forAI: true }] },
    },
  });
  assert.match(p, /お描きワークフロー/, 'お描きワークフロー節が出る');
  ok('お描きは従来どおりワークフロー手順に出る');
}

console.log(`\n${passed} passed`);
