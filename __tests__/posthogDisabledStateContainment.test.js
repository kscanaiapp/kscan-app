// PH35-R1 — disabled-state PostHog containment.
//
// THE CLAIM: for every configuration that is not a usable (key, https-host)
// pair, PostHog is fully inert — no client is created, no vendor method is
// called, no polling loop is started, and nothing leaves the process.
//
// WHY THIS IS NOT THE SAME AS THE GOVERNANCE TEST:
// __tests__/posthogAnalyticsGovernance.test.js pins these rules by reading
// the wrapper's SOURCE TEXT. A source-text assertion still passes when the
// rule is present and wrong — which is exactly how the defect this file was
// written for survived: the source said `.length > 0`, the governance test
// asserted `.length > 0`, and both agreed on a rule that let a whitespace-only
// env var construct a live client.
//
// HOW THIS AVOIDS BEING AN INEFFECTIVE MOCK: the stubbed SDK
// (helpers/posthogContainmentLoader.mjs) deliberately behaves like a live
// client — on construction it opens a flush interval and sends a request to
// its host. The probe (helpers/posthogContainmentProbe.mjs) spies the process
// boundary (fetch/http/https/net/XHR/sendBeacon and timer creation) BEFORE
// importing the wrapper. So "no polling" and "zero egress" are observations
// about what the process actually did, not restatements of "capture was not
// called". Against the pre-repair wrapper these assertions fail with real
// recorded egress and a real recorded interval.
//
// Every network spy records and short-circuits: no real request is ever made
// and no PostHog endpoint is contacted by this suite.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const REGISTER = path.join(__dirname, 'helpers', 'posthogContainmentRegister.mjs');
const PROBE = path.join(__dirname, 'helpers', 'posthogContainmentProbe.mjs');
const CORE = path.join(ROOT, 'services', 'analytics', 'posthogClient.core.ts');

const KEY = 'EXPO_PUBLIC_POSTHOG_API_KEY';
const HOST = 'EXPO_PUBLIC_POSTHOG_HOST';

/**
 * Runs the probe in a child process under `overrides`. A value of `undefined`
 * removes the variable, so each case is evaluated against a clean environment
 * even when the developer or CI runner exports a real value.
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

// ─── The contained configurations ───────────────────────────────────────────

const CONTAINED_CASES = [
  ['api key absent / host absent', { [KEY]: undefined, [HOST]: undefined }],
  ['api key present / host absent', { [KEY]: 'phc_probe', [HOST]: undefined }],
  ['host present / api key absent', { [KEY]: undefined, [HOST]: 'https://example.invalid' }],
  ['empty values', { [KEY]: '', [HOST]: '' }],
  ['empty key with a valid host', { [KEY]: '', [HOST]: 'https://example.invalid' }],
  ['valid key with an empty host', { [KEY]: 'phc_probe', [HOST]: '' }],
  ['whitespace values', { [KEY]: '   ', [HOST]: '   ' }],
  ['whitespace key with a valid host', { [KEY]: '   ', [HOST]: 'https://example.invalid' }],
  ['malformed host (not a URL)', { [KEY]: 'phc_probe', [HOST]: 'not-a-url' }],
  ['malformed host (no authority)', { [KEY]: 'phc_probe', [HOST]: 'https://' }],
  ['malformed host (embedded space)', { [KEY]: 'phc_probe', [HOST]: 'https://exa mple.invalid' }],
  ['invalid protocol (javascript:)', { [KEY]: 'phc_probe', [HOST]: 'javascript:alert(1)' }],
  ['invalid protocol (http:)', { [KEY]: 'phc_probe', [HOST]: 'http://example.invalid' }],
  ['invalid protocol (ftp:)', { [KEY]: 'phc_probe', [HOST]: 'ftp://example.invalid' }],
  ['invalid protocol (file:)', { [KEY]: 'phc_probe', [HOST]: 'file:///etc/passwd' }],
  ['malformed key (embedded whitespace)', { [KEY]: 'phc probe', [HOST]: 'https://example.invalid' }],
  ['malformed key (embedded tab)', { [KEY]: 'phc\tprobe', [HOST]: 'https://example.invalid' }],
];

for (const [label, overrides] of CONTAINED_CASES) {
  test(`contained: ${label}`, () => {
    const observed = probe(overrides);

    assert.equal(observed.loadError, null, `${label}: wrapper must load and run without throwing`);
    assert.equal(observed.configured, false, `${label}: must report unconfigured`);

    // POSTHOG_CLIENT_CREATED=NO
    assert.equal(observed.clientCreated, false, `${label}: POSTHOG_CLIENT_CREATED must be NO`);
    assert.equal(observed.vendorConstructed, false, `${label}: vendor SDK must never be constructed`);

    // POSTHOG_CAPTURE_CALLED=NO / IDENTIFY=NO / FLUSH=NO
    assert.equal(observed.captureCalled, false, `${label}: POSTHOG_CAPTURE_CALLED must be NO`);
    assert.equal(observed.identifyCalled, false, `${label}: POSTHOG_IDENTIFY_CALLED must be NO`);
    assert.equal(observed.flushCalled, false, `${label}: POSTHOG_FLUSH_CALLED must be NO`);
    assert.deepEqual(observed.vendorCalls, [], `${label}: no vendor method may be called at all`);

    // POSTHOG_POLLING_STARTED=NO
    assert.equal(observed.pollingStarted, false, `${label}: POSTHOG_POLLING_STARTED must be NO`);
    assert.deepEqual(observed.timers.intervals, [], `${label}: no interval may be scheduled`);

    // POSTHOG_NETWORK_EGRESS=ZERO
    assert.equal(
      observed.networkEgressTotal,
      0,
      `${label}: POSTHOG_NETWORK_EGRESS must be ZERO, saw ${JSON.stringify(observed.egress)}`,
    );
  });
}

// ─── Negative control ───────────────────────────────────────────────────────

test('negative control: a valid key + https host does construct, poll and egress', () => {
  // If this ever stops holding, every "contained" assertion above becomes
  // vacuous — the probe would be reporting zero because it cannot observe a
  // breach, not because none happened.
  const observed = probe({ [KEY]: 'phc_probe', [HOST]: 'https://example.invalid' });

  assert.equal(observed.configured, true);
  assert.equal(observed.clientCreated, true);
  assert.equal(observed.vendorConstructed, true, 'the probe must be able to see a construct');
  assert.equal(observed.captureCalled, true, 'the probe must be able to see a capture');
  assert.equal(observed.pollingStarted, true, 'the probe must be able to see a polling interval');
  // Deliberately NOT asserting identify here: PH35-R2 removed the identify
  // path entirely, so a live client never issues one. That the probe can
  // still observe identity-shaped calls is proven by the reset below, and
  // the absence of identify under a live client is asserted in
  // __tests__/posthogAnonymousIdentity.test.js.
  assert.ok(
    observed.vendorCalls.includes('reset'),
    'the probe must be able to see identity-shaped calls (reset)',
  );
  assert.equal(observed.identifyCalled, false, 'PH35-R2: a live client still never identifies');
  assert.ok(
    observed.networkEgressTotal > 0,
    'the probe must be able to see network egress — otherwise zero-egress proves nothing',
  );
});

test('surrounding whitespace is trimmed rather than treated as a breach', () => {
  // `KEY=$(cat file)` leaves a trailing newline. That value is unambiguous
  // once trimmed, so it must still configure PostHog — containment is about
  // unusable configuration, not about punishing a stray newline. The
  // embedded-whitespace cases above cover the genuinely malformed direction.
  const observed = probe({
    [KEY]: '  phc_probe\n',
    [HOST]: '  https://example.invalid  ',
  });

  assert.equal(observed.configured, true);
  const construct = observed.vendorCalls.filter((op) => op === 'construct');
  assert.deepEqual(construct, ['construct']);
});

test('the five bridged sinks stay dead while contained and forward once configured', () => {
  const enabled = probe({ [KEY]: 'phc_probe', [HOST]: 'https://example.invalid' });
  assert.ok(
    enabled.vendorCalls.filter((op) => op === 'capture').length >= 5,
    'a configured build should forward each bridged sink emission',
  );

  const contained = probe({ [KEY]: '   ', [HOST]: 'https://example.invalid' });
  assert.deepEqual(
    contained.vendorCalls,
    [],
    'the same five sink emissions must produce no vendor call while contained',
  );
  assert.equal(contained.networkEgressTotal, 0);
});

// ─── Product behaviour must not depend on analytics ─────────────────────────

test('product code paths survive an absent or invalid PostHog', () => {
  // Every wrapper entry point and every bridged sink emit is driven by the
  // probe; `loadError` is set if any of them throws.
  for (const [label, overrides] of CONTAINED_CASES) {
    const observed = probe(overrides);
    assert.equal(observed.loadError, null, `${label}: must not throw into product code`);
  }
});
