'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CARD = path.join(ROOT, 'components', 'AnalysisCard.tsx');

function read() {
  return fs.readFileSync(CARD, 'utf8');
}

function reportButtonBlock(source) {
  const start = source.indexOf('function AnalysisReportButton({');
  assert.ok(start >= 0, 'AnalysisReportButton exists');
  const end = source.indexOf('\nexport function AnalysisCard(', start);
  assert.ok(end > start, 'AnalysisReportButton block closes before AnalysisCard');
  return source.slice(start, end);
}

function assertPersistedIdGuard(source) {
  const block = reportButtonBlock(source);
  assert.match(block, /scanSourceId\?: string \| null/);
  assert.match(block, /const \{ openAiOutputReport \} = useAiOutputReporting\(\);/);
  assert.match(
    block,
    /if \(!scanSourceId\) return null;/,
    'legacy scan Report must stay hidden until a durable scan id exists',
  );
  assert.match(
    block,
    /openAiOutputReport\(\{ feature: 'Scan Results', itemId: scanSourceId \?\? null \}\)/,
    'when visible, the report must use the persisted scan id',
  );
}

test('legacy AnalysisCard hides Report Response until the scan has a persisted id', () => {
  assertPersistedIdGuard(read());
});

test('NEGATIVE CONTROL: removing the persisted-id guard is detected', () => {
  const source = read();
  const mutated = source.replace('  if (!scanSourceId) return null;\n', '');
  assert.notEqual(mutated, source);
  assert.throws(() => assertPersistedIdGuard(mutated));
});
