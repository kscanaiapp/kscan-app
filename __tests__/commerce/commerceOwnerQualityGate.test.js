/**
 * Owner quality gate, run as a test (continuation brief §28).
 *
 * Separate from CI in intent: CI asks whether the code ran, this asks whether
 * the answer would help a person. It lives in the suite so a future change that
 * quietly degrades one of the three journeys fails here rather than in someone's
 * hands.
 *
 * READY_FOR_OWNER_REVIEW is unavailable if any journey is NOT_USEFUL.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const gate = require(path.join(__dirname, '../../tools/activation/ownerQualityGate.js'));

test('no required journey is NOT_USEFUL', async () => {
  const report = await gate.run();
  assert.equal(report.journeys.length, 3);
  assert.equal(report.anyNotUseful, false, JSON.stringify(report.verdicts));
});

test('Elise: a refinement keeps the budget, leads with the match and keeps alternatives', async () => {
  const { journeys } = await gate.run();
  const j = journeys[0];
  assert.equal(j.verdict, 'USEFUL');
  assert.equal(j.checks.overBudgetGone, true, 'an over-budget option answers a different question');
  assert.equal(j.checks.blackLeads, true);
  assert.equal(j.checks.alternativesKept, true, 'and the rest of the market is still there');
  assert.equal(j.checks.oneCallEach, true, 'one provider request per shopping turn');
});

test('Packing: a real confirmed gap produces real candidates and leaks no identifiers', async () => {
  const { journeys } = await gate.run();
  const j = journeys[1];
  assert.equal(j.verdict, 'USEFUL');
  assert.equal(j.gapCertainty, 'confirmed', 'the gap came from the real deriver');
  assert.equal(j.checks.shellLeads, true, 'the piece that solves the trip leads');
  assert.equal(j.checks.noTripData, true);
});

test('Sparse: nothing is invented and nothing is captioned as a match it is not', async () => {
  const { journeys } = await gate.run();
  const j = journeys[2];
  assert.equal(j.verdict, 'USEFUL');
  assert.equal(j.checks.notAnEmptyState, true, 'no-preferred-match is not no-results');
  assert.equal(j.checks.nothingClaimsBlack, true);
  assert.equal(j.checks.alternativesShown, true);
});

test('the gate claims only what a fixture can support', async () => {
  const report = await gate.run();
  assert.equal(report.benchmarkStatus, 'INTERNAL ENGINEERING EVIDENCE ONLY');
});
