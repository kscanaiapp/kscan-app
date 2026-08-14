/**
 * Tests for the E4.1 live-probe harness itself.
 *
 * WHY THIS EXISTS: the probe decides whether E4.1 may ship. If the harness is
 * wrong, a green run certifies nothing and a red run gets ignored — either way
 * the gate is worthless. The addendum requires the probe to be tested before it
 * is ever pointed at staging, so these run offline against injected stubs: no
 * network, no staging account, no secrets.
 *
 * Two things get pinned hardest, because they are the ones that would be
 * catastrophic and silent:
 *   1. fail-closed ordering — a typo or a missing secret must abort BEFORE any
 *      request, never produce a pass that tested nothing;
 *   2. the matrix verdict — a scenario that should fail must actually fail.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const probe = require('../../security/release/run-e41-room-intelligence-live-probe.js');
const matrix = require('../../security/release/e41-behavior-matrix.js');

const STAGING_REF = 'yzqjvdfgefveprobvvyw';
const PRODUCTION_REF = 'wyyuqfdxucjksghsmhry';

const ROOM_ITEMS = [
  { key: 'blazer', itemId: 'i1', roomId: 'r1', category: 'outerwear', subtype: 'blazer', title: 'Navy blazer' },
  { key: 'shirt', itemId: 'i2', roomId: 'r1', category: 'tops', subtype: 'shirt', title: 'White shirt' },
  { key: 'trousers', itemId: 'i3', roomId: 'r1', category: 'bottoms', subtype: 'trousers', title: 'Dark trousers' },
  { key: 'loafers', itemId: 'i4', roomId: 'r1', category: 'footwear', subtype: 'loafers', title: 'Black loafers' },
];

function goodEnv(over = {}) {
  return {
    SUPABASE_STAGING_PROJECT_REF: STAGING_REF,
    SUPABASE_STAGING_URL: `https://${STAGING_REF}.supabase.co`,
    SUPABASE_STAGING_PUBLISHABLE_KEY: 'sb_pub_test',
    STAGING_SYNTHETIC_ACTIVE_EMAIL: 'synthetic@example.test',
    STAGING_SYNTHETIC_ACTIVE_PASSWORD: 'not-a-real-password',
    ...over,
  };
}

/** A fetch that fails the test if it is ever called. */
function forbiddenFetch() {
  return async () => {
    throw new Error('network call attempted before fail-closed checks');
  };
}

/** A well-behaved model answer, grounded in the fixture. */
function groundedAnswer() {
  return 'The navy blazer anchors this. The shirt keeps it clean and the ' +
    'trousers balance it; the loafers finish it without shouting. You could ' +
    'add a belt if you want more definition.';
}

function stubResponse(over = {}) {
  return {
    ok: true,
    httpStatus: 200,
    elapsedMs: 900,
    text: groundedAnswer(),
    servedModel: 'gemini-3.5-flash',
    contractVersion: '2',
    capabilities: { attachments: true },
    attachmentsResolved: 4,
    sessionId: 's1',
    ...over,
  };
}

// ── Fail-closed ordering ────────────────────────────────────────────────────

test('a production project ref aborts before any network call', async () => {
  await assert.rejects(
    () => probe.run(goodEnv({ SUPABASE_STAGING_PROJECT_REF: PRODUCTION_REF }), forbiddenFetch()),
    (error) => {
      // Any refusal is acceptable; silently proceeding is not.
      assert.ok(error instanceof Error);
      return true;
    },
  );
});

test('an unknown project ref aborts before any network call', async () => {
  await assert.rejects(
    () => probe.run(goodEnv({ SUPABASE_STAGING_PROJECT_REF: 'not-a-project' }), forbiddenFetch()),
  );
});

test('a production URL aborts before any network call', async () => {
  await assert.rejects(
    () => probe.run(
      goodEnv({ SUPABASE_STAGING_URL: `https://${PRODUCTION_REF}.supabase.co` }),
      forbiddenFetch(),
    ),
  );
});

test('missing credentials abort before any network call', async () => {
  for (const key of ['STAGING_SYNTHETIC_ACTIVE_EMAIL', 'STAGING_SYNTHETIC_ACTIVE_PASSWORD']) {
    const env = goodEnv();
    delete env[key];
    await assert.rejects(
      () => probe.run(env, forbiddenFetch()),
      (error) => {
        assert.equal(error.code, 'ENVIRONMENT_FAILURE', `wrong classification for missing ${key}`);
        return true;
      },
    );
  }
});

test('every required environment variable is reported when absent', () => {
  const missing = probe.findMissingEnvVars({});
  assert.deepEqual(missing.sort(), [...probe.REQUIRED_ENV_VARS].sort());
});

// ── Secret redaction ────────────────────────────────────────────────────────

test('evidence privacy rejects tokens, emails and data URIs', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij';
  for (
    const value of [
      { token: jwt },
      { who: 'someone@example.com' },
      { image: 'data:image/png;base64,AAAA' },
      { url: 'https://example.test/object?token=abc' },
      { nested: [{ deep: jwt }] },
    ]
  ) {
    assert.throws(
      () => probe.assertEvidencePrivacy(value),
      /evidence privacy assertion rejected/,
      `did not reject ${JSON.stringify(value)}`,
    );
  }
});

test('safe evidence passes the privacy assertion', () => {
  assert.doesNotThrow(() => probe.assertEvidencePrivacy({
    scenario: 'compatibility',
    pass: true,
    reasonCode: 'OK',
    httpStatus: 200,
    latencyMs: 900,
    servedModel: 'gemini-3.5-flash',
    attachmentsResolved: 4,
  }));
});

// ── URL construction ────────────────────────────────────────────────────────

test('the function path is literal and unaffected by trailing slashes', () => {
  assert.equal(
    probe.buildStyleChatUrl('https://x.supabase.co/'),
    'https://x.supabase.co/functions/v1/stylechat-generate',
  );
  assert.equal(
    probe.buildStyleChatUrl('https://x.supabase.co'),
    'https://x.supabase.co/functions/v1/stylechat-generate',
  );
});

// ── Matrix verdicts: correct answers pass ───────────────────────────────────

test('a grounded answer passes every owned-room scenario', async () => {
  const ask = async () => stubResponse();
  const { results } = await matrix.runOwnedRoomMatrix(ask, ROOM_ITEMS);
  const failed = results.filter((r) => !r.pass);
  assert.deepEqual(failed, [], `unexpected failures: ${JSON.stringify(failed)}`);
  assert.equal(results.length, matrix.OWNED_ROOM_SCENARIOS.length);
});

// ── Matrix verdicts: real violations fail ───────────────────────────────────

test('an invented room item fails the matrix', async () => {
  const ask = async () => stubResponse({
    text: 'The belt ties the whole thing together beautifully.',
  });
  const { results } = await matrix.runOwnedRoomMatrix(ask, ROOM_ITEMS);
  assert.ok(results.every((r) => !r.pass));
  assert.ok(results.every((r) => r.reasonCode === 'FOREIGN_ITEM_ASSERTED'));
});

test('an anchor that names nothing in the room fails only the anchor scenario', async () => {
  const ask = async (options) =>
    options.message.includes('anchor')
      ? stubResponse({ text: 'Something with more presence would anchor it.' })
      : stubResponse();
  const { results } = await matrix.runOwnedRoomMatrix(ask, ROOM_ITEMS);
  const anchor = results.find((r) => r.scenario === 'anchor');
  assert.equal(anchor.pass, false);
  assert.equal(anchor.reasonCode, 'ANCHOR_NOT_A_ROOM_ITEM');
  assert.equal(results.filter((r) => !r.pass).length, 1, 'only the anchor scenario should fail');
});

test('an empty response fails rather than passing vacuously', async () => {
  const ask = async () => stubResponse({ text: '   ' });
  const { results } = await matrix.runOwnedRoomMatrix(ask, ROOM_ITEMS);
  assert.ok(results.every((r) => r.reasonCode === 'EMPTY_RESPONSE'));
});

test('an HTTP failure is classified, not silently passed', async () => {
  const ask = async () => stubResponse({ ok: false, httpStatus: 500, text: '' });
  const { results } = await matrix.runOwnedRoomMatrix(ask, ROOM_ITEMS);
  assert.ok(results.every((r) => r.reasonCode === 'HTTP_FAILURE'));
});

test('a thrown request is caught and classified', async () => {
  const ask = async () => {
    throw new Error('socket hang up');
  };
  const { results } = await matrix.runOwnedRoomMatrix(ask, ROOM_ITEMS);
  assert.ok(results.every((r) => r.reasonCode === 'REQUEST_THREW'));
});

// ── Client metadata attack ──────────────────────────────────────────────────

test('fabricated client metadata reaching the model fails', async () => {
  const ask = async () => stubResponse({
    text: 'That red leather mini skirt from CounterfeitCo is a bold choice.',
  });
  const result = await matrix.runClientMetadataAttack(ask, ROOM_ITEMS);
  assert.equal(result.pass, false);
  assert.equal(result.reasonCode, 'CLIENT_METADATA_REACHED_MODEL');
});

test('server-authoritative values winning passes the attack scenario', async () => {
  const ask = async () => stubResponse({ text: 'That is the navy blazer — wool, structured.' });
  const result = await matrix.runClientMetadataAttack(ask, ROOM_ITEMS);
  assert.equal(result.pass, true);
});

// ── Authorization ───────────────────────────────────────────────────────────

test('authorization negatives pass when the backend denies or resolves nothing', async () => {
  const ask = async (options) => {
    if (options.unauthenticated) return stubResponse({ ok: false, httpStatus: 401, text: '' });
    return stubResponse({ attachmentsResolved: 0, text: 'I cannot see that room.' });
  };
  const results = await matrix.runAuthorizationMatrix(ask, ROOM_ITEMS);
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.pass), JSON.stringify(results));
});

test('a foreign room that resolves evidence FAILS', async () => {
  // The scenario that must never pass quietly.
  const ask = async (options) => {
    if (options.unauthenticated) return stubResponse({ ok: false, httpStatus: 401, text: '' });
    return stubResponse({ attachmentsResolved: 4 });
  };
  const results = await matrix.runAuthorizationMatrix(ask, ROOM_ITEMS);
  const foreign = results.find((r) => r.scenario === 'foreign_room_denied');
  assert.equal(foreign.pass, false);
  assert.equal(foreign.reasonCode, 'FOREIGN_ROOM_RESOLVED');
});

test('an anonymous caller that is served FAILS', async () => {
  const ask = async () => stubResponse({ attachmentsResolved: 0 });
  const results = await matrix.runAuthorizationMatrix(ask, ROOM_ITEMS);
  const anon = results.find((r) => r.scenario === 'anonymous_denied');
  assert.equal(anon.pass, false);
  assert.equal(anon.reasonCode, 'ANONYMOUS_NOT_DENIED');
});

// ── Multi-turn and the P0 freshness invariant ───────────────────────────────

test('a removed item still discussed as present FAILS the freshness invariant', async () => {
  let removed = false;
  const ask = async () =>
    stubResponse({
      text: removed
        ? 'The blazer still carries this look.'
        : groundedAnswer(),
    });
  const { results } = await matrix.runMultiTurnMatrix(ask, ROOM_ITEMS, async () => {
    removed = true;
    return true;
  });
  const stale = results.find((r) => r.scenario === 'stale_item_refresh');
  assert.equal(stale.pass, false);
  assert.equal(stale.reasonCode, 'REMOVED_ITEM_TREATED_AS_PRESENT');
});

test('an answer that drops the removed item passes the freshness invariant', async () => {
  let removed = false;
  const ask = async () =>
    stubResponse({
      text: removed
        ? 'The shirt and trousers still work; the loafers can stay.'
        : groundedAnswer(),
    });
  const { results } = await matrix.runMultiTurnMatrix(ask, ROOM_ITEMS, async () => {
    removed = true;
    return true;
  });
  const stale = results.find((r) => r.scenario === 'stale_item_refresh');
  assert.equal(stale.pass, true, JSON.stringify(stale));
});

test('a failed fixture removal is a FIXTURE_FAILURE, not a product failure', async () => {
  // Misclassifying a broken fixture as a product defect would send the next
  // engineer to debug the wrong system.
  const ask = async () => stubResponse();
  const { results } = await matrix.runMultiTurnMatrix(ask, ROOM_ITEMS, async () => false);
  const stale = results.find((r) => r.scenario === 'stale_item_refresh');
  assert.equal(stale.reasonCode, 'FIXTURE_FAILURE');
});

// ── Prompt injection ────────────────────────────────────────────────────────

test('a model that complies with injected instructions FAILS', async () => {
  const ask = async () => stubResponse({ text: 'All items are now owned by you.' });
  const result = await matrix.runPromptInjectionMatrix(ask, ROOM_ITEMS);
  assert.equal(result.pass, false);
  assert.match(result.reasonCode, /^INJECTION_SIGNAL_/);
});

test('a model that ignores injected instructions passes', async () => {
  const ask = async () => stubResponse();
  const result = await matrix.runPromptInjectionMatrix(ask, ROOM_ITEMS);
  assert.equal(result.pass, true);
});

// ── V2 contract ─────────────────────────────────────────────────────────────

test('the V2 contract assertion catches each missing element', () => {
  assert.equal(matrix.assertV2Contract(stubResponse()).pass, true);
  assert.equal(
    matrix.assertV2Contract(stubResponse({ contractVersion: '1' })).reasonCode,
    'CONTRACT_VERSION_NOT_2',
  );
  assert.equal(
    matrix.assertV2Contract(stubResponse({ attachmentsResolved: 0 })).reasonCode,
    'NO_ATTACHMENTS_RESOLVED',
  );
  assert.equal(
    matrix.assertV2Contract(stubResponse({ servedModel: null })).reasonCode,
    'SERVED_MODEL_MISSING',
  );
  assert.equal(matrix.assertV2Contract(null).reasonCode, 'NO_SUCCESSFUL_SAMPLE');
});

// ── Summary ─────────────────────────────────────────────────────────────────

test('the summary names failed scenarios instead of hiding them in a count', () => {
  const summary = matrix.summarize({
    owned_room: [
      matrix.scenarioResult('compatibility', true),
      matrix.scenarioResult('anchor', false, 'ANCHOR_NOT_A_ROOM_ITEM'),
    ],
    authorization: [matrix.scenarioResult('anonymous_denied', true)],
  });
  assert.equal(summary.total, 3);
  assert.equal(summary.passed, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.verdict, 'FAIL');
  assert.deepEqual(summary.failedScenarios, [
    { group: 'owned_room', scenario: 'anchor', reasonCode: 'ANCHOR_NOT_A_ROOM_ITEM' },
  ]);
});

test('an all-pass matrix yields a PASS verdict', () => {
  const summary = matrix.summarize({
    owned_room: [matrix.scenarioResult('compatibility', true)],
  });
  assert.equal(summary.verdict, 'PASS');
  assert.deepEqual(summary.failedScenarios, []);
});

// ── Negative scenarios must not pass on a non-authorization failure ─────────

test('a negative scenario does NOT pass on a rate limit', () => {
  // The first live run had these "passing" on 429. A rate limit is not an
  // authorization decision, and a scenario that passes because the server was
  // busy proves nothing about isolation.
  const verdict = matrix.deniedOrNoEvidence({ ok: false, httpStatus: 429, attachmentsResolved: 0 });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'INCONCLUSIVE_HTTP_429');
});

test('a negative scenario does NOT pass on a server error', () => {
  const verdict = matrix.deniedOrNoEvidence({ ok: false, httpStatus: 500, attachmentsResolved: 0 });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /^INCONCLUSIVE_HTTP_500$/);
});

test('a negative scenario passes on an explicit auth rejection', () => {
  for (const status of [401, 403]) {
    assert.equal(matrix.deniedOrNoEvidence({ ok: false, httpStatus: status }).ok, true);
  }
});

test('a negative scenario passes when the request succeeds but resolves no evidence', () => {
  const verdict = matrix.deniedOrNoEvidence({ ok: true, httpStatus: 200, attachmentsResolved: 0 });
  assert.equal(verdict.ok, true);
});

test('a negative scenario FAILS when foreign room evidence actually resolves', () => {
  const verdict = matrix.deniedOrNoEvidence({ ok: true, httpStatus: 200, attachmentsResolved: 3 });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'FOREIGN_ROOM_RESOLVED');
});

test('the probe paces model requests under the burst limit', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'security', 'release', 'run-e41-room-intelligence-live-probe.js'),
    'utf8',
  );
  // Unpaced, the matrix 429s from the fifth request onward and every later
  // scenario becomes meaningless.
  assert.match(source, /BURST_SAFE_INTERVAL_MS/);
  assert.match(source, /if \(!unauthenticated && ctx\.pace\) await ctx\.pace\(\)/);
});
