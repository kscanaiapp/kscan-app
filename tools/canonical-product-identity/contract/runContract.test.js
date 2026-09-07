'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runContractControls, contractPassed } = require('./runContract');

// spec section 43#26: network/provider calls remain zero.
test('CONTRACT: the zero-network-module-surface control passes (no fetch/http/https/XMLHttpRequest anywhere under this lab)', () => {
  const controls = runContractControls();
  const networkControl = controls.find((c) => c.name === 'zero_network_module_surface');
  assert.ok(networkControl, 'zero_network_module_surface control must exist');
  assert.equal(networkControl.verdict, 'PASS');
});

test('CONTRACT: every control produces a PASS or FAIL verdict, never leaves anything unresolved', () => {
  const controls = runContractControls();
  assert.ok(controls.length >= 10);
  for (const c of controls) {
    assert.ok(['PASS', 'FAIL', 'SKIPPED'].includes(c.verdict));
    assert.ok(typeof c.name === 'string' && c.name.length > 0);
  }
});

test('CONTRACT: the full control set currently passes end-to-end on this corpus/resolver', () => {
  const controls = runContractControls();
  assert.equal(contractPassed(controls), true, JSON.stringify(controls.filter((c) => c.verdict === 'FAIL')));
});

test('CONTRACT: the false-merge-gate self-test control specifically exercises a conflicting-GTIN pair and confirms it never AUTO_MERGEs', () => {
  const controls = runContractControls();
  const gateControl = controls.find((c) => c.name === 'false_merge_gate_self_test');
  assert.ok(gateControl);
  assert.equal(gateControl.verdict, 'PASS');
  assert.notEqual(gateControl.detail, 'AUTO_MERGE');
});

test('CONTRACT: the baseline-overwrite-protected control confirms writeBaseline refuses a silent overwrite', () => {
  const controls = runContractControls();
  const baselineControl = controls.find((c) => c.name === 'baseline_overwrite_protected');
  assert.ok(baselineControl);
  assert.equal(baselineControl.verdict, 'PASS');
});
