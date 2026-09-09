// Behavioural proof that PostHog is inert while unconfigured.
//
// __tests__/posthogAnalyticsGovernance.test.js pins the disabled-state rules
// by reading the wrapper's SOURCE TEXT. That catches a rule being deleted,
// but a source-text assertion still passes if the rule is present and wrong —
// it never observes what the vendor SDK actually receives. This file closes
// that gap: it loads the REAL services/analytics/posthogClient.core.ts with
// `posthog-react-native` replaced by a recording stub (see
// helpers/posthogVendorStubLoader.mjs), drives every route that could reach
// PostHog, and asserts on what the vendor actually saw.
//
// The claim under test is the strong one: while unconfigured the vendor SDK
// is NEVER CONSTRUCTED. That matters more than "capture is a no-op" — a
// constructed client is network-capable on its own (lifecycle events, queued
// flushes) regardless of whether the app ever calls capture.
//
// The enabled case at the bottom is the negative control. It runs the same
// probe against a configured build and asserts the vendor DOES see a
// construct and captures, so the "zero events" assertions above are known to
// be capable of failing rather than vacuously true.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const REGISTER = path.join(__dirname, 'helpers', 'posthogVendorStubRegister.mjs');
const PROBE = path.join(__dirname, 'helpers', 'posthogEgressProbe.mjs');
const CORE = path.join(ROOT, 'services', 'analytics', 'posthogClient.core.ts');

const KEY = 'EXPO_PUBLIC_POSTHOG_API_KEY';
const HOST = 'EXPO_PUBLIC_POSTHOG_HOST';

/**
 * Runs the probe in a child process under `overrides`. A key or host set to
 * `undefined` is removed entirely, so the case is evaluated against a clean
 * environment even when the developer or CI runner exports a real value.
 */
function probe(overrides) {
  const env = { ...process.env };
  delete env[KEY];
  delete env[HOST];
  for (const [name, value] of Object.entries(overrides)) {
    if (value !== undefined) env[name] = value;
  }

  const result = spawnSync(process.execPath, ['--import', REGISTER, PROBE, CORE], {
    encoding: 'utf8',
    env,
  });

  assert.equal(
    result.status,
    0,
    `probe exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  return JSON.parse(result.stdout);
}

// ─── Disabled state: the vendor SDK is never constructed ────────────────────

const DISABLED_CASES = [
  ['A: no key and no host', { [KEY]: undefined, [HOST]: undefined }],
  ['B: key only', { [KEY]: 'phc_probe', [HOST]: undefined }],
  ['C: host only', { [KEY]: undefined, [HOST]: 'https://example.invalid' }],
  ['D: empty key with a valid host', { [KEY]: '', [HOST]: 'https://example.invalid' }],
  ['E: valid key with an empty host', { [KEY]: 'phc_probe', [HOST]: '' }],
  ['F1: whitespace-only key', { [KEY]: '   ', [HOST]: 'https://example.invalid' }],
  ['F2: whitespace-only key and host', { [KEY]: '   ', [HOST]: '   ' }],
  ['F3: host that is not a URL', { [KEY]: 'phc_probe', [HOST]: 'not-a-url' }],
  ['F4: host with a non-http scheme', { [KEY]: 'phc_probe', [HOST]: 'javascript:alert(1)' }],
];

for (const [label, overrides] of DISABLED_CASES) {
  test(`${label} -> no client, no vendor calls, zero egress`, () => {
    const observed = probe(overrides);

    assert.equal(observed.configured, false, `${label}: should report unconfigured`);
    assert.equal(observed.clientIsNull, true, `${label}: client must be null`);
    assert.deepEqual(
      observed.events,
      [],
      `${label}: the vendor SDK must never be constructed or called`,
    );
  });
}

// ─── Negative control: a configured build really does reach the vendor ──────

test('negative control: a configured build constructs the client and captures', () => {
  const observed = probe({ [KEY]: 'phc_probe', [HOST]: 'https://example.invalid' });

  assert.equal(observed.configured, true);
  assert.equal(observed.clientIsNull, false);

  const ops = observed.events.map((e) => e.op);
  assert.ok(ops.includes('construct'), 'a configured build must construct the client');
  assert.ok(
    ops.includes('capture'),
    'a configured build must reach capture — otherwise the zero-egress assertions above prove nothing',
  );
});

test('the five bridged sinks reach PostHog only once configured', () => {
  const enabled = probe({ [KEY]: 'phc_probe', [HOST]: 'https://example.invalid' });
  const captured = enabled.events.filter((e) => e.op === 'capture').map((e) => e.event);

  // Each bridged sink's real emit function, exercised by the probe.
  for (const event of [
    'closet_candidate_created',
    'kplus_feature_exposed',
    'today_with_elise_impression',
    'voice_submit',
    'vto_entry_tap',
  ]) {
    assert.ok(captured.includes(event), `configured build should forward ${event}`);
  }

  const disabled = probe({ [KEY]: undefined, [HOST]: undefined });
  assert.deepEqual(
    disabled.events,
    [],
    'the same five sink emissions must produce zero vendor calls while unconfigured',
  );
});

// ─── The privacy posture the client is actually constructed with ────────────

test('the constructed client carries the V1 product-analytics-only options', () => {
  const observed = probe({ [KEY]: 'phc_probe', [HOST]: 'https://example.invalid' });
  const construct = observed.events.find((e) => e.op === 'construct');
  assert.ok(construct, 'expected a construct event');

  // Asserted against the options object the vendor was actually handed, not
  // against the source text that produced it.
  assert.equal(construct.options.enableSessionReplay, false);
  assert.equal(construct.options.errorTracking.autocapture, false);
  assert.equal(construct.options.disableRemoteFeatureFlags, true);
  assert.equal(construct.options.preloadFeatureFlags, false);
  assert.equal(construct.options.disableSurveys, true);
  assert.equal(construct.options.disableGeoip, true);
});

test('config values are trimmed before reaching the vendor SDK', () => {
  const observed = probe({
    [KEY]: '  phc_probe  ',
    [HOST]: '  https://example.invalid  ',
  });
  const construct = observed.events.find((e) => e.op === 'construct');
  assert.ok(construct, 'expected a construct event');

  assert.equal(construct.apiKey, 'phc_probe');
  assert.equal(construct.options.host, 'https://example.invalid');
});
