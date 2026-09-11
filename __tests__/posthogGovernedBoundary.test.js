// PH35-R3 — the governed analytics boundary.
//
// THE CLAIM: no caller can put an unregistered event name, an unregistered
// property, or an unsafe value in front of PostHog — regardless of which
// reference it holds.
//
// WHY THIS SUITE EXISTS: the five feature telemetry sinks each allowlist and
// scrub their own events, and they do it well. But the adapter's bridge
// target, `forwardTelemetryToPostHog`, was an exported function with no
// runtime contract. A probe pushed an arbitrary event name carrying free
// text, a signed URL, an email, a JWT, a UUID, a base64 data URI, a file
// path, a nested object, an array of user content and a raw stack trace
// straight through it to `posthog.capture`, verbatim. That is the bypass this
// boundary closes.
//
// Every assertion below inspects the payload the VENDOR actually received
// (helpers/posthogBoundaryProbe.mjs), with PostHog configured and a live
// client — not the boundary function's return value in isolation.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { runProbeProcess } = require('./helpers/posthogProbeSpawn.js');

const PROBE = path.join(__dirname, 'helpers', 'posthogBoundaryProbe.mjs');

// A real, registered event with a real, allowlisted property.
const GOVERNED_EVENT = 'closet_candidate_created';
const GOVERNED_PROPERTY = 'sourceType';
const GOVERNED_VALUE = 'camera';

/** NaN / Infinity cannot survive JSON; the probe rehydrates this marker. */
const NON_FINITE = (kind) => ({ __number__: kind });

function runProbe(spec) {
  const env = { ...process.env };
  env.EXPO_PUBLIC_POSTHOG_API_KEY = 'phc_boundaryprobe';
  env.EXPO_PUBLIC_POSTHOG_HOST = 'https://example.invalid';

  const result = runProbeProcess(PROBE, [JSON.stringify(spec)], env);
  assert.equal(
    result.status,
    0,
    `probe exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  return JSON.parse(result.stdout);
}

/** Drive the real adapter and report what the vendor received. */
function send(event, payload) {
  const observed = runProbe({ mode: 'send', event, payload });
  assert.equal(observed.threw, null, 'analytics must never throw into product code');
  assert.equal(observed.clientCreated, true, 'boundary tests must run against a LIVE client');
  return observed;
}

/** Call the boundary directly, for cases JSON round-tripping would distort. */
const boundary = (event, payload) => runProbe({ mode: 'boundary', event, payload });
const registry = () => runProbe({ mode: 'registry' });

// ─── The event contract ─────────────────────────────────────────────────────

test('a registered event with a registered property reaches the vendor intact', () => {
  const observed = send(GOVERNED_EVENT, { [GOVERNED_PROPERTY]: GOVERNED_VALUE });

  assert.equal(observed.captureCount, 1);
  assert.equal(observed.capturedEvent, GOVERNED_EVENT);
  assert.deepEqual(observed.capturedProperties, { [GOVERNED_PROPERTY]: GOVERNED_VALUE });
});

test('an unknown event name is dropped whole, not forwarded with stripped properties', () => {
  const observed = send('totally_made_up_event', { [GOVERNED_PROPERTY]: GOVERNED_VALUE });
  assert.equal(observed.captureCount, 0, 'an unreviewed event name is itself data');
});

for (const [label, badEvent] of [
  ['empty string', ''],
  ['a number', 12345],
  ['null', null],
  ['an object', { toString: 'x' }],
  ['an array', ['closet_candidate_created']],
]) {
  test(`a non-conforming event name (${label}) is dropped`, () => {
    assert.equal(send(badEvent, {}).captureCount, 0);
  });
}

// ─── The property contract: the 14 unsafe classes ───────────────────────────

const UNSAFE_PROPERTIES = [
  ['unknown property', 'someUnknownKey', 'anything'],
  ['free text', 'freeText', 'the user typed this whole sentence in'],
  ['URL', 'url', 'https://example.com/results'],
  ['signed URL', 'signedUrl', 'https://cdn.example.com/s.jpg?token=SECRETSIG&exp=9'],
  ['base64 / data URI', 'base64', 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ'],
  ['email', 'email', 'leaky.person@example.com'],
  ['UUID', 'uuid', 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa'],
  ['JWT', 'jwt', 'eyJhbGciOiJIUzI1NiJ9.SENTINELPAYLOAD.sig'],
  ['nested object', 'nested', { deep: { secret: 'payload' } }],
  ['array of user content', 'arr', ['user content', 'more user content']],
  ['raw error message', 'errorMessage', 'TypeError: x is not a function'],
  ['raw stack trace', 'stack', 'Error: boom\n    at Foo (/app/src/a.ts:12:5)'],
  ['image / media path', 'imagePath', 'file:///var/mobile/Containers/photo.heic'],
  ['query string fragment', 'query', '?token=abc&user=42'],
];

for (const [label, key, value] of UNSAFE_PROPERTIES) {
  test(`unsafe property is stripped before the vendor: ${label}`, () => {
    const observed = send(GOVERNED_EVENT, {
      [GOVERNED_PROPERTY]: GOVERNED_VALUE,
      [key]: value,
    });

    assert.equal(observed.captureCount, 1, `${label}: the governed event itself still fires`);
    assert.deepEqual(
      observed.capturedProperties,
      { [GOVERNED_PROPERTY]: GOVERNED_VALUE },
      `${label}: only the governed property may survive`,
    );
    assert.ok(
      !observed.serialized.includes(String(key)),
      `${label}: the property key itself must not reach the vendor`,
    );
  });
}

// ─── Unsafe values inside an ALLOWLISTED key ────────────────────────────────
//
// The key allowlist is the first defence; these prove the value sanitizer is
// a real second one, because here the key is legitimately registered.

for (const [label, value] of [
  ['UUID', 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa'],
  ['free text', 'Cannot read property foo of undefined'],
  ['URL', 'https://cdn.example.com/a.jpg'],
  ['JWT', 'eyJhbGciOiJIUzI1NiJ9.SENTINELPAYLOAD.sig'],
  ['long opaque blob', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2'],
  ['nested object', { a: 1 }],
]) {
  test(`unsafe value in an allowlisted key is stripped: ${label}`, () => {
    const observed = send(GOVERNED_EVENT, { [GOVERNED_PROPERTY]: value });
    assert.equal(observed.captureCount, 1);
    assert.deepEqual(observed.capturedProperties, {}, `${label}: value must not survive`);
  });
}

for (const kind of ['NaN', 'Infinity']) {
  test(`non-finite number is stripped: ${kind}`, () => {
    const governed = boundary(GOVERNED_EVENT, { countBucket: NON_FINITE(kind) });
    assert.equal(governed.allowed, true);
    assert.deepEqual(governed.payload, {}, `${kind} must not survive`);
    assert.deepEqual(governed.strippedKeys, ['countBucket']);
  });
}

test('a finite number in an allowlisted key survives', () => {
  const governed = boundary(GOVERNED_EVENT, { countBucket: 7 });
  assert.deepEqual(governed.payload, { countBucket: 7 });
});

test('a non-object payload cannot smuggle anything through', () => {
  for (const payload of ['a string payload', 42, ['array', 'payload'], null]) {
    const observed = send(GOVERNED_EVENT, payload);
    assert.equal(observed.captureCount, 1);
    assert.deepEqual(observed.capturedProperties, {});
  }
});

// ─── Negative control ───────────────────────────────────────────────────────

test('negative control: the same payload crosses when the boundary is not applied', () => {
  // The pre-repair adapter body was `posthog.capture(event, payload)` with no
  // validation. Reproduced here as the one-line function it was, and fed the
  // exact payload the tests above reject — proving those tests describe a
  // real change in behaviour rather than a rule that was always true.
  const unsafePayload = {
    freeText: 'the user typed this whole sentence in',
    signedUrl: 'https://cdn.example.com/s.jpg?token=SECRETSIG',
    email: 'leaky.person@example.com',
    nested: { deep: { secret: 'payload' } },
  };
  const preRepairCaptured = [];
  const preRepairForward = (event, payload) => preRepairCaptured.push({ event, payload });

  preRepairForward('totally_made_up_event', unsafePayload);

  assert.equal(preRepairCaptured.length, 1, 'pre-repair forwarded the unknown event');
  assert.deepEqual(
    preRepairCaptured[0].payload,
    unsafePayload,
    'pre-repair forwarded every unsafe property verbatim',
  );

  // The same inputs through the real boundary.
  const governed = boundary('totally_made_up_event', unsafePayload);
  assert.equal(governed.allowed, false);
  assert.equal(governed.reason, 'unknown_event');
  assert.deepEqual(governed.payload, {});

  // And end-to-end: nothing reaches the vendor.
  assert.equal(send('totally_made_up_event', unsafePayload).captureCount, 0);
});

// ─── The registry ───────────────────────────────────────────────────────────

test('the registry is composed from the shipped sinks, with no name collisions', () => {
  const observed = registry();
  assert.equal(
    observed.size,
    observed.declared.length,
    'a duplicate event name across surfaces would make the winning contract depend on declaration order',
  );
  assert.equal(new Set(observed.declared).size, observed.declared.length);

  // The count is derived from the sinks, so it moves only when a sink does.
  const summed = observed.contracts.reduce((n, c) => n + c.eventCount, 0);
  assert.equal(observed.size, summed);
});

test('every registered event is anonymous-safe and owned by a bridged sink', () => {
  const observed = registry();
  const owners = new Set(observed.contracts.map((c) => c.owner));
  assert.equal(owners.size, observed.contracts.length);

  for (const entry of observed.entries) {
    assert.equal(entry.anonymousAllowed, true, `${entry.event} must be emittable anonymously`);
    assert.ok(entry.propertyCount > 0, `${entry.event} must have a property contract`);
  }
});

test('no registered property name is identity- or content-shaped', () => {
  const forbidden =
    /^(email|name|phone|token|jwt|url|uri|image|prompt|transcript|address|lat|lng|userId|user_id)$/i;
  for (const contract of registry().contracts) {
    for (const property of contract.properties) {
      assert.ok(
        !forbidden.test(property),
        `${contract.surface}: property "${property}" is identity- or content-shaped`,
      );
    }
  }
});

test('every surface declares governance metadata', () => {
  for (const contract of registry().contracts) {
    assert.ok(['low', 'medium', 'high'].includes(contract.privacySensitivity), contract.surface);
    assert.ok(['none', 'low'].includes(contract.commerceSensitivity), contract.surface);
    assert.ok(contract.owner.startsWith('services/'), contract.surface);
  }
});
