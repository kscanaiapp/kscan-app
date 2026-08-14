/**
 * IOS-03 — self-service account restoration (Build 29).
 *
 * Covers the surfaces that did not exist before this phase: the `/account/restore`
 * route, the restoration service, and the signed-out resend entry point — plus
 * the governing SQL, because "single use", "expired", and "resend invalidates
 * the old link" are enforced in `restore_account_by_token_hash` and
 * `rotate_restoration_token_by_email`, not in client code.
 *
 * The property the whole feature rests on: a restoration token is a bearer
 * credential for an account. It may live only in the incoming URL, in route
 * memory, and in the request body — never in storage, a log, or navigation
 * history that outlives its use.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  const sandbox = {
    __DEV__: false,
    console,
    exports: module.exports,
    module,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return module.exports;
}

function readSource(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
function readCode(rel) {
  return readSource(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const RESTORE_ROUTE = 'app/(public)/account/restore.tsx';
const AUTH = 'app/auth/index.tsx';
const VALID_TOKEN = 'Abcdefgh_1234567890-ABCDEFGHIJKLMNOPQRSTUVWX';

function loadRestoration() {
  return loadTsModule('services/accountRestoration.ts');
}

/** Minimal supabase double that records every functions.invoke call. */
function fakeSupabase(handler) {
  const calls = [];
  return {
    calls,
    client: {
      functions: {
        invoke: async (name, options) => {
          calls.push({ name, body: options?.body });
          return handler(name, options);
        },
      },
    },
  };
}

/* ── Token extraction ──────────────────────────────────────────────────── */

test('only plausibly-shaped tokens are accepted from a link', () => {
  const { extractRestorationToken } = loadRestoration();

  assert.equal(extractRestorationToken(VALID_TOKEN), VALID_TOKEN);
  assert.equal(extractRestorationToken(`  ${VALID_TOKEN}  `), VALID_TOKEN);
  // expo-router hands back an array when a query param repeats.
  assert.equal(extractRestorationToken([VALID_TOKEN, 'second']), VALID_TOKEN);

  assert.equal(extractRestorationToken('short'), null, 'too short');
  assert.equal(extractRestorationToken(''), null);
  assert.equal(extractRestorationToken(null), null);
  assert.equal(extractRestorationToken(undefined), null);
  assert.equal(extractRestorationToken({}), null);
  assert.equal(
    extractRestorationToken(`${VALID_TOKEN}<script>`),
    null,
    'outside the base64url alphabet',
  );
});

/* ── Restore outcomes (Phase E) ────────────────────────────────────────── */

test('VALID TOKEN: restore succeeds and directs the user back to sign-in', async () => {
  const { restoreAccountWithToken } = loadRestoration();
  const fake = fakeSupabase(() => ({ data: { status: 'restored' }, error: null }));

  const result = await restoreAccountWithToken(fake.client, VALID_TOKEN);
  assert.equal(result.outcome, 'restored');
  assert.match(result.message, /sign in again/i);

  assert.equal(fake.calls.length, 1, 'restore-account is called exactly once');
  assert.equal(fake.calls[0].name, 'restore-account');
  // Field-wise, not deepEqual: the body is constructed inside the VM sandbox,
  // so its prototype comes from another realm and deepStrictEqual would fail on
  // that alone.
  assert.deepEqual(Object.keys(fake.calls[0].body), ['token']);
  assert.equal(fake.calls[0].body.token, VALID_TOKEN);
});

test('INVALID / EXPIRED / USED TOKEN: all fail identically and offer a new link', async () => {
  const { restoreAccountWithToken } = loadRestoration();

  // The backend answers all three with the same 400 — deliberately, so token
  // state cannot be probed. The client must not invent a distinction.
  for (const _case of ['invalid', 'expired', 'already used']) {
    const fake = fakeSupabase(() => ({
      data: null,
      error: { context: { status: 400 } },
    }));
    const result = await restoreAccountWithToken(fake.client, VALID_TOKEN);
    assert.equal(result.outcome, 'invalid', _case);
    assert.match(result.message, /no longer valid/i);
    assert.match(result.message, /request a new one/i);
  }
});

test('a malformed token never reaches the network', async () => {
  const { restoreAccountWithToken } = loadRestoration();
  const fake = fakeSupabase(() => ({ data: { status: 'restored' }, error: null }));

  const result = await restoreAccountWithToken(fake.client, 'nope');
  assert.equal(result.outcome, 'invalid');
  assert.equal(fake.calls.length, 0);
});

test('a server failure is distinguished from an invalid link and is retryable', async () => {
  const { restoreAccountWithToken } = loadRestoration();
  const fake = fakeSupabase(() => ({ data: null, error: { context: { status: 500 } } }));

  const result = await restoreAccountWithToken(fake.client, VALID_TOKEN);
  assert.equal(result.outcome, 'failed');
  assert.match(result.message, /try again/i);
});

test('a 202 pending-unban response is reported honestly, not as full success', async () => {
  const { restoreAccountWithToken } = loadRestoration();
  const fake = fakeSupabase(() => ({
    data: { status: 'restored_pending_unban' },
    error: null,
  }));

  const result = await restoreAccountWithToken(fake.client, VALID_TOKEN);
  assert.equal(result.outcome, 'pending_unban');
  assert.match(result.message, /longer/i);
});

test('a 2xx with an unrecognised body is not treated as success', async () => {
  const { restoreAccountWithToken } = loadRestoration();
  const fake = fakeSupabase(() => ({ data: { status: 'something-else' }, error: null }));
  assert.equal((await restoreAccountWithToken(fake.client, VALID_TOKEN)).outcome, 'failed');

  const empty = fakeSupabase(() => ({ data: null, error: null }));
  assert.equal((await restoreAccountWithToken(empty.client, VALID_TOKEN)).outcome, 'failed');
});

test('a thrown transport error never echoes the token back', async () => {
  const { restoreAccountWithToken } = loadRestoration();
  const fake = fakeSupabase(() => {
    throw new Error(`network failed while posting {"token":"${VALID_TOKEN}"}`);
  });

  const result = await restoreAccountWithToken(fake.client, VALID_TOKEN);
  assert.equal(result.outcome, 'failed');
  assert.ok(!result.message.includes(VALID_TOKEN), 'the token must not leak through an error');
});

/* ── Resend (Phase C / E) ──────────────────────────────────────────────── */

test('RESEND is enumeration-safe: matched and unmatched are indistinguishable', async () => {
  const { requestRestorationEmail, RESEND_GENERIC_MESSAGE } = loadRestoration();

  const matched = fakeSupabase(() => ({ data: { status: 'ok' }, error: null }));
  const unmatched = fakeSupabase(() => ({ data: { status: 'ok' }, error: null }));

  const a = await requestRestorationEmail(matched.client, 'exists@example.test');
  const b = await requestRestorationEmail(unmatched.client, 'nobody@example.test');

  assert.deepEqual(a, b, 'the two cases must be byte-identical to the caller');
  assert.equal(a.message, RESEND_GENERIC_MESSAGE);
  assert.match(a.message, /if an eligible deletion request exists/i);
  assert.ok(
    !/we found|is pending deletion|no account/i.test(a.message),
    'the copy must never confirm or deny an account',
  );
});

test('resend normalizes the address and rejects obvious non-addresses locally', async () => {
  const { requestRestorationEmail } = loadRestoration();
  const fake = fakeSupabase(() => ({ data: { status: 'ok' }, error: null }));

  await requestRestorationEmail(fake.client, '  Person@Example.TEST  ');
  assert.deepEqual(Object.keys(fake.calls[0].body), ['email']);
  assert.equal(fake.calls[0].body.email, 'person@example.test');
  assert.equal(fake.calls[0].name, 'resend-restoration-email');

  const rejected = await requestRestorationEmail(fake.client, 'not-an-address');
  assert.equal(rejected.ok, false);
  assert.equal(fake.calls.length, 1, 'no request is made for an unusable address');
});

/* ── Governing SQL: single use, expiry, rotation (Phase E) ─────────────── */

const LIFECYCLE_SQL = readSource(
  'supabase/migrations/20260722191013_account_deletion_lifecycle.sql',
);

test('restore_account_by_token_hash enforces single use, expiry, and grace', () => {
  const fn = LIFECYCLE_SQL.slice(
    LIFECYCLE_SQL.indexOf('create or replace function public.restore_account_by_token_hash'),
  ).split('$$;')[0];

  // Matches only an unconsumed, unexpired token on a live deactivated row.
  assert.match(fn, /dr\.status = 'deactivated'/);
  assert.match(fn, /dr\.restoration_token_used_at is null/);
  assert.match(fn, /dr\.restoration_token_expires_at > now\(\)/);
  assert.match(fn, /dr\.grace_period_ends_at > now\(\)/);
  assert.match(fn, /dr\.purged_at is null/);
  assert.match(fn, /legal_hold_until is null or dr\.legal_hold_until <= now\(\)/);

  // Consumes the token as it restores, so a replay cannot match.
  assert.match(fn, /restoration_token_used_at = now\(\)/);
  assert.match(fn, /restoration_token_hash = null/);
  // Matching is by hash only — a token for one account cannot restore another.
  assert.match(fn, /where dr\.restoration_token_hash = p_token_hash/);
});

test('rotate_restoration_token_by_email invalidates the previous link', () => {
  const fn = LIFECYCLE_SQL.slice(
    LIFECYCLE_SQL.indexOf('create or replace function public.rotate_restoration_token_by_email'),
  ).split('$$;')[0];

  assert.match(fn, /restoration_token_hash = p_token_hash/, 'the stored hash is replaced');
  assert.match(fn, /restoration_token_used_at = null/, 'the new link is unconsumed');
  assert.match(fn, /restoration_token_expires_at = claimed\.grace_period_ends_at/);
  // Only one hash column exists, so writing the new one necessarily supersedes
  // the old: the previous link can never match again.
  assert.match(LIFECYCLE_SQL, /deletion_requests_restoration_token_hash_uidx/);
});

test('restoration resend rotation enforces three attempts in a rolling 24-hour window', () => {
  const fn = LIFECYCLE_SQL.slice(
    LIFECYCLE_SQL.indexOf('create or replace function public.rotate_restoration_token_by_email'),
  ).split('$$;')[0];

  assert.match(fn, /day_ago timestamptz := now\(\) - interval '24 hours'/);
  assert.match(fn, /coalesce\(claimed\.restoration_email_count, 0\) >= 3/);
  assert.match(fn, /claimed\.restoration_email_sent_at > day_ago/);
  assert.match(fn, /else 1\s+end/, 'a new 24-hour window resets the counter');
});

test('resend eligibility is scoped to live deactivated rows only', () => {
  const peekSql = readSource(
    'supabase/migrations/20260723021735_account_deletion_claim_retry_peek_v2.sql',
  );
  assert.match(peekSql, /dr\.status='deactivated'/);
  assert.match(peekSql, /dr\.restored_at is null/);
  assert.match(peekSql, /dr\.purged_at is null/);
  assert.match(peekSql, /dr\.grace_period_ends_at > now\(\)/);
});

test('the resend function persists the new hash BEFORE sending', () => {
  const fn = readSource('supabase/functions/resend-restoration-email/index.ts');
  const rotateIdx = fn.indexOf("rpc('rotate_restoration_token_by_email'");
  const sendIdx = fn.indexOf('sendRestorationEmail(');
  assert.ok(rotateIdx !== -1 && sendIdx !== -1);
  assert.ok(rotateIdx < sendIdx, 'a delivered link must always be backed by a stored hash');
});

/* ── Restore route (Phase B) ───────────────────────────────────────────── */

test('the restore route lives at exactly /account/restore', () => {
  assert.ok(
    fs.existsSync(path.join(ROOT, RESTORE_ROUTE)),
    'the emailed link targets /account/restore; (public) is a group and adds no segment',
  );
  const base = readSource('supabase/functions/_shared/deletion/common.ts');
  assert.match(base, /'https:\/\/kscan\.app\/account\/restore'/);
});

test('the restore route is reachable signed out and by a deactivated session', () => {
  const guard = require('../services/routingGuard');

  const signedOut = guard.getRoutingGuardState({
    pathname: '/account/restore',
    loading: false,
    session: null,
    profileLoading: false,
    profile: null,
  });
  assert.equal(signedOut.action, 'allow', 'a signed-out user must reach the link');

  // A deactivated user may still hold a session; the pending-deletion redirect
  // must not bounce them away from the one screen that can save them.
  const deactivated = guard.getRoutingGuardState({
    pathname: '/account/restore',
    loading: false,
    session: { expires_at: Math.floor(Date.now() / 1000) + 3600 },
    profileLoading: false,
    profile: { account_status: 'pending_deletion' },
    onboardingComplete: true,
  });
  assert.equal(deactivated.action, 'allow');

  assert.ok(guard.isPublicRoute('/account/restore'));
  assert.ok(guard.isLimitedAccountRoute('/account/restore'));
});

test('the route consumes the token exactly once and then drops it from history', () => {
  const code = readCode(RESTORE_ROUTE);
  assert.match(code, /restoreAccountWithToken\(/);
  assert.match(code, /attemptedRef/, 'a single-flight latch guards the single-use token');
  assert.match(
    code,
    /router\.setParams\(\{ token: undefined \}\)/,
    'the token is cleared from the route after use',
  );
  // router.replace to the same path would remount the screen, reset the latch,
  // and repaint a success as "link not valid".
  assert.ok(
    !/router\.replace\('\/account\/restore'\)/.test(code),
    'clearing the token must not remount the screen',
  );
});

test('the restore route never persists the token', () => {
  const code = readCode(RESTORE_ROUTE);
  assert.ok(!/AsyncStorage|SecureStore|localStorage/.test(code), 'no local persistence');
  assert.ok(!/console\.(log|warn|error)/.test(code), 'no logging of route state');
  assert.ok(!/analytics|track\(|breadcrumb/i.test(code), 'no analytics or breadcrumbs');

  const service = readCode('services/accountRestoration.ts');
  assert.ok(!/AsyncStorage|SecureStore|localStorage/.test(service));
  assert.ok(!/console\.(log|warn|error)/.test(service));
});

test('the route offers bounded success and failure destinations', () => {
  const code = readCode(RESTORE_ROUTE);
  assert.match(code, /testID="account-restore-result"/);
  assert.match(code, /router\.replace\('\/auth'\)/, 'success returns to sign-in');
  assert.match(code, /router\.replace\('\/auth\?restore=1'\)/, 'failure offers a resend');
});

/* ── Resend surface on the auth screen (Phase C) ───────────────────────── */

test('the auth screen exposes the resend surface signed out', () => {
  const code = readCode(AUTH);
  assert.match(code, /requestRestorationEmail\(/);
  assert.match(code, /testID="auth-restore-account-toggle"/);
  assert.match(code, /testID="auth-restore-email-input"/);
  assert.match(code, /testID="auth-restore-submit"/);
  assert.match(code, /testID="auth-restore-result"/);
  // Opened directly when the restore route sends the user here.
  assert.match(code, /restoreParamRequested/);
});

test('the auth resend copy never confirms or denies an account', () => {
  const code = readCode(AUTH);
  assert.ok(
    !/we found your deletion request|pending deletion|no account with that email/i.test(code),
    'the resend surface must not become an account-existence oracle',
  );
});
