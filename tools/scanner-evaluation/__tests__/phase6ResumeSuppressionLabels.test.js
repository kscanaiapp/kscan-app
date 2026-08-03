'use strict';

/**
 * Resume-path label resolution.
 *
 * A resumed run summarizes every durable record in the run, but only the cases
 * still to process are passed in as this invocation's selection. Building the
 * suppression label map from that selection meant a resumed run looked up 33
 * records in a 2-entry map and threw `missing governed label` — after every
 * provider call had already been paid for and persisted.
 *
 * These tests pin the property that matters: the label map must cover every
 * record being summarized, whatever subset the current invocation is
 * processing.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const suppressionMetrics = require('../lib/suppressionMetrics');

function label(caseId, overrides = {}) {
  return {
    caseId,
    category: 'tops',
    clothingType: 'shirt',
    subtype: 'oxford_shirt',
    primaryColor: 'blue',
    material: ['cotton'],
    pattern: ['solid'],
    brand: null,
    ...overrides,
  };
}

function record(caseId) {
  return {
    caseId,
    projection: { category: 'tops', clothingType: 'shirt', subtype: 'oxford_shirt', primaryColor: 'blue', material: ['cotton'], pattern: ['solid'], brand: null },
    profiles: { neutral: { fields: [] } },
  };
}

test('summarizing a record whose label is absent is refused, not silently skipped', () => {
  // The guard itself must stay. A resumed run that quietly dropped unlabelled
  // records would under-report suppression denominators instead of failing.
  assert.throws(
    () => suppressionMetrics.summarizeSuppression([record('a'), record('b')], new Map([['a', label('a')]])),
    /missing governed label for b/,
  );
});

test('a full-manifest label map covers records outside the current selection', () => {
  const all = ['a', 'b', 'c'];
  const manifestLabels = new Map(all.map((id) => [id, label(id)]));
  // Simulates a resume: durable spans every completed case, while only 'c'
  // remained to process in this invocation.
  const durable = all.map(record);
  assert.doesNotThrow(() => suppressionMetrics.summarizeSuppression(durable, manifestLabels));
});

test('a selection-scoped label map is exactly what used to fail', () => {
  const durable = ['a', 'b', 'c'].map(record);
  const selectionScoped = new Map([['c', label('c')]]);
  assert.throws(
    () => suppressionMetrics.summarizeSuppression(durable, selectionScoped),
    /missing governed label/,
    'this is the pre-repair behaviour and must remain detectable',
  );
});

test('the runner builds its label map from the manifest, not the selection', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'build4Funnel.js'), 'utf8');
  const call = source.slice(source.indexOf('suppression: suppressionMetrics.summarizeSuppression'));
  const head = call.slice(0, 400);
  assert.match(
    head,
    /new Map\(manifest\.cases\.map\(/,
    'the suppression label map must be built from manifest.cases',
  );
  assert.ok(
    !/new Map\(cases\.map\(/.test(head),
    'the label map must not be scoped to this invocation’s case selection',
  );
});

test('extra labels in the map are harmless', () => {
  // The manifest carries holdout labels too. They must never affect a
  // development-split summary, which only ever summarizes development records.
  const durable = ['a'].map(record);
  const withExtras = new Map([['a', label('a')], ['holdout-1', label('holdout-1')]]);
  const only = suppressionMetrics.summarizeSuppression(durable, new Map([['a', label('a')]]));
  const withHoldout = suppressionMetrics.summarizeSuppression(durable, withExtras);
  assert.deepEqual(withHoldout, only, 'unused labels must not change any computed value');
});
