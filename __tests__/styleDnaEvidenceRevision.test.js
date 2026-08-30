// Build 34 / Track B / Phase B4 — evidence revision (deterministic V1 fallback).

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
function run(rel) {
  const out = ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(
    out,
    {
      console, exports: module.exports, module,
      Date, Math, Number, Object, Array, JSON, String, Boolean,
      require: () => { throw new Error('no requires expected'); },
    },
    { filename: rel },
  );
  return module.exports;
}

const m = run('supabase/functions/_shared/styleDna/styleDnaEvidenceRevision.ts');

test('empty evidence -> the fixed empty sentinel', () => {
  assert.equal(m.computeClosetEvidenceRevision([]), 'empty:0');
  assert.equal(m.computeClosetEvidenceRevision(undefined), 'empty:0');
  assert.equal(m.STYLE_DNA_EMPTY_EVIDENCE_REVISION, 'empty:0');
});

test('single row -> {updatedAt}:1', () => {
  assert.equal(m.computeClosetEvidenceRevision(['2026-08-30T04:22:17.123456Z']), '2026-08-30T04:22:17.123456Z:1');
});

test('multiple rows -> {MAX(updated_at)}:{count}, order-independent', () => {
  const values = ['2026-01-01T00:00:00.000Z', '2026-08-30T04:22:17.123456Z', '2026-03-01T00:00:00.000Z'];
  const expected = '2026-08-30T04:22:17.123456Z:3';
  assert.equal(m.computeClosetEvidenceRevision(values), expected);
  assert.equal(m.computeClosetEvidenceRevision([...values].reverse()), expected);
});

test('same evidence -> same revision (determinism)', () => {
  const values = ['2026-05-01T00:00:00.000Z', '2026-05-02T00:00:00.000Z'];
  assert.equal(m.computeClosetEvidenceRevision(values), m.computeClosetEvidenceRevision(values));
});

test('an edit that only bumps updated_at (same count) changes the revision', () => {
  const before = m.computeClosetEvidenceRevision(['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z']);
  const afterEdit = m.computeClosetEvidenceRevision(['2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z']);
  assert.notEqual(before, afterEdit);
});

test('a deletion (fewer rows, same latest timestamp shape) changes the revision', () => {
  const before = m.computeClosetEvidenceRevision(['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z']);
  const afterDelete = m.computeClosetEvidenceRevision(['2026-01-02T00:00:00.000Z']);
  assert.notEqual(before, afterDelete);
});

test('non-string/malformed entries are ignored rather than throwing', () => {
  assert.equal(m.computeClosetEvidenceRevision([null, undefined, 42, '2026-01-01T00:00:00.000Z']), '2026-01-01T00:00:00.000Z:1');
});
