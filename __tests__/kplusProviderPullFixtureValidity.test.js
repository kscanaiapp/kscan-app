'use strict';

// Validate the actual optional runner inputs even when the Docker suite is
// unavailable. This proves fixture validity, not database concurrency.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, 'kplusProviderPullConcurrency.test.js'), 'utf8');
const file = ts.createSourceFile('fixture.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const timesSource = file.statements.find(node =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'times').getText(file);
const fixedNow = Date.parse('2026-11-02T12:00:00.000Z');
class FixtureDate extends Date { static now() { return fixedNow; } }
const times = new Function('Date', `${timesSource}; return times;`)(FixtureDate);

function transitionInputs() {
  const t = times();
  const inputs = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'transition') {
      inputs.push(new Function('t', 'DIGEST_A', 'DIGEST_B',
        `return (${node.arguments[0].getText(file)});`)(t, 'a'.repeat(64), 'b'.repeat(64)));
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return inputs;
}

const validPeriod = input => Date.parse(input.periodStart) < Date.parse(input.expiresAt);

test('optional K+ expired fixtures satisfy the real period boundary before testing chronology', () => {
  const expired = transitionInputs().filter(input => input.state === 'expired');
  assert.equal(expired.length, 2, 'both existing expired interleavings must be checked');
  for (const input of expired) {
    assert.ok(validPeriod(input), 'expiry must follow period start');
    assert.ok(Date.parse(input.expiresAt) < fixedNow, 'the expired snapshot must remain expired');
    assert.equal(input.willRenew, false);
  }
});

test('optional K+ provider observation ordering is unchanged and independent of expired period start', () => {
  const t = times();
  assert.equal(fixedNow - Date.parse(t.old), 120000);
  assert.equal(fixedNow - Date.parse(t.newer), 60000);
  const expired = transitionInputs().filter(input => input.state === 'expired');
  assert.deepEqual(expired.map(input => input.occurredAt).sort(), [t.old, t.newer].sort());
  assert.ok(expired.every(input => input.periodStart === t.expiredStart));
});

test('optional K+ active fixtures and expiry assertions retain their original periods', () => {
  const t = times();
  const active = transitionInputs().filter(input => input.state !== 'expired');
  assert.ok(active.length >= 3);
  for (const input of active) {
    assert.ok(validPeriod(input));
    assert.equal(input.expiresAt, t.activeEnd);
    assert.ok(input.periodStart === t.old || input.periodStart === t.newer);
  }
});

test('negative control: the original observation-as-period-start expired fixtures are refused', () => {
  const t = times();
  const expired = transitionInputs().filter(input => input.state === 'expired');
  for (const input of expired) {
    assert.equal(validPeriod({ ...input, periodStart: t.old }), false);
  }
  const authority = fs.readFileSync(path.join(__dirname,
    '../supabase/migrations/20260915030553_kplus_entitlement_authority.sql'), 'utf8');
  assert.match(authority, /p_expires_at\s*<=\s*p_period_starts_at/);
});
