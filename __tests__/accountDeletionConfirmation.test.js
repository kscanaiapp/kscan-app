/**
 * IOS-03 — account deletion confirmation reliability.
 *
 * ROOT CAUSE this locks down: the confirmation the user received made a claim
 * the deployed backend never satisfies. It said the account "can be restored
 * using the email we sent" — but no restoration email is sent when a request
 * is accepted (supabase/functions/handle-user-deletion sends none, and
 * process-account-deletions sends none either; resend-restoration-email has no
 * client caller). It also asserted "You have been signed out" while the user
 * was still signed in. The one claim a tester could actually check was false,
 * so the confirmation could not be trusted — and acknowledging it signed them
 * out and replaced the route, leaving no trace on the login screen.
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

const PRIVACY = 'app/privacy.tsx';
const AUTH = 'app/auth/index.tsx';

function loadNotice() {
  return loadTsModule('services/accountDeletionNotice.ts');
}

/* ── Case A — accepted request ─────────────────────────────────────────── */

test('A: an accepted request produces confirmation without permanent-purge wording', () => {
  const n = loadNotice();
  const message = n.buildAccountDeletionNoticeMessage({
    alreadyRequested: false,
    gracePeriodEndsAt: null,
  });
  assert.match(message, /deletion request was received/i);
  assert.ok(
    !/permanently deleted|has been deleted|purged|erased/i.test(message),
    'accepted means an active lifecycle exists, never that the account was purged',
  );
  assert.match(message, /restored/i, 'the lifecycle is restorable and must say so');
});

test('A: the confirmation never claims a restoration email was sent', () => {
  const n = loadNotice();
  for (const notice of [
    { alreadyRequested: false, gracePeriodEndsAt: null },
    { alreadyRequested: true, gracePeriodEndsAt: '2026-09-12T00:00:00Z' },
  ]) {
    const message = n.buildAccountDeletionNoticeMessage(notice);
    assert.ok(
      !/email we sent|we sent you an email|check your email/i.test(message),
      `no email is sent at request time; copy must not promise one: ${message}`,
    );
  }
});

test('A: the deployed request path really does not send a restoration email', () => {
  // Guards the premise of the copy above. If a restoration email is ever wired
  // into the request path, this fails and the copy should be revisited.
  const handler = readSource('supabase/functions/handle-user-deletion/index.ts');
  const worker = readSource('supabase/functions/process-account-deletions/index.ts');
  assert.ok(!/sendRestorationEmail/.test(handler), 'handle-user-deletion sends no restoration email');
  assert.ok(!/sendRestorationEmail/.test(worker), 'process-account-deletions sends no restoration email');
});

/* ── Case B — the confirmation survives the sign-out transition ─────────── */

test('B: the confirmation survives the sign-out/navigation transition', () => {
  const n = loadNotice();
  // Privacy proves acceptance and records the notice...
  n.setAccountDeletionNotice({ alreadyRequested: false, gracePeriodEndsAt: null });
  // ...then the screen unmounts, the user is signed out and the route is
  // replaced with /auth. The confirmation must still reach them there.
  const afterTransition = n.consumeAccountDeletionNotice();
  assert.ok(afterTransition, 'confirmation must not be destroyed with the Privacy screen');
  assert.match(
    n.buildAccountDeletionNoticeMessage(afterTransition),
    /deletion request was received/i,
  );
});

test('B: the auth screen consumes the notice and renders it', () => {
  const code = readCode(AUTH);
  assert.match(code, /consumeAccountDeletionNotice\(\)/);
  assert.match(code, /testID="auth-account-deletion-notice"/);
});

/* ── Case C — already requested ────────────────────────────────────────── */

test('C: an already-active lifecycle confirms without claiming a new deletion', () => {
  const n = loadNotice();
  const message = n.buildAccountDeletionNoticeMessage({
    alreadyRequested: true,
    gracePeriodEndsAt: null,
  });
  assert.match(message, /already active/i);
  assert.ok(!/was received/i.test(message), 'must not imply a new request was just created');
  assert.ok(!/error|couldn't|failed/i.test(message), 'already-active is not an error');
});

/* ── Case D/E — failure and unaccepted responses ───────────────────────── */

test('D: a failed submission sets no notice and does not sign the user out', () => {
  const code = readCode(PRIVACY);
  const catchBlock = code.slice(code.indexOf('Account deletion request failed'));
  assert.ok(
    !/setAccountDeletionNotice/.test(catchBlock),
    'a failed request must never record an accepted-deletion notice',
  );
  assert.ok(
    !/signOut\(\)/.test(catchBlock) && !/router\.replace/.test(catchBlock),
    'a failed request must leave the user on the screen so they can retry',
  );
  assert.match(catchBlock, /couldn't submit your request/i);
});

test('E: acceptance is decided by the service normalizer, which fails closed', () => {
  const deletion = require(path.join(ROOT, 'services/accountDeletion.js'));
  // Statuses that exist in the lifecycle but never mean "a new submission was
  // accepted" must not normalize to accepted.
  for (const status of ['completed', 'rejected', 'cancelled', 'restored', 'purged', 'failed']) {
    assert.ok(
      !deletion.ACTIVE_DELETION_STATUSES.includes(status),
      `${status} must never count as an active deletion lifecycle`,
    );
  }
  for (const status of ['pending', 'processing', 'deactivated', 'purging', 'legal_hold']) {
    assert.ok(
      deletion.ACTIVE_DELETION_STATUSES.includes(status),
      `${status} is an active lifecycle state`,
    );
  }
});

test('E: the notice is only recorded after the awaited submission resolves', () => {
  const code = readCode(PRIVACY);
  const submitAt = code.indexOf('await submitAccountDeletionRequest');
  const noticeAt = code.indexOf('setAccountDeletionNotice(');
  assert.ok(submitAt > 0 && noticeAt > 0);
  assert.ok(noticeAt > submitAt, 'acceptance must be proven before any success state is recorded');
});

/* ── Case F/G — duplicate submission and cancel ────────────────────────── */

test('F: rapid confirm taps produce exactly one submission', () => {
  const code = readCode(PRIVACY);
  // The guard must be the FIRST statement of confirmDeletion — a `disabled`
  // prop alone loses a same-frame double tap.
  const body = code.slice(code.indexOf('const confirmDeletion = async () =>'));
  const guardAt = body.indexOf('if (deletionSubmitting) return;');
  const submitAt = body.indexOf('await submitAccountDeletionRequest');
  assert.ok(guardAt >= 0, 'confirmDeletion must single-flight the submission');
  assert.ok(guardAt < submitAt, 'the guard must precede the submission');
});

test('F: the confirmation Modal is dismissed BEFORE the await, not alongside the Alert', () => {
  // On iOS an Alert presented in the same commit that dismisses an RN Modal can
  // be swallowed with the modal's view controller — the user would then never
  // see the confirmation, which is the IOS-03 symptom itself. The dismissal
  // must therefore happen before the network round-trip, not just before
  // Alert.alert.
  const body = readCode(PRIVACY);
  const start = body.indexOf('const confirmDeletion = async () =>');
  const fn = body.slice(start, body.indexOf('const handleExport', start));
  const dismissAt = fn.indexOf('setDeletionConfirmVisible(false)');
  const submitAt = fn.indexOf('await submitAccountDeletionRequest');
  const alertAt = fn.indexOf('Alert.alert(');
  assert.ok(dismissAt >= 0 && submitAt > 0 && alertAt > 0);
  assert.ok(
    dismissAt < submitAt,
    'the Modal must be dismissed before the await so it is fully gone before the Alert',
  );
  assert.ok(
    fn.indexOf('setDeletionConfirmVisible(false)', submitAt) === -1 ||
      fn.indexOf('setDeletionConfirmVisible(false)', submitAt) > alertAt,
    'no Modal dismissal may share a commit with Alert.alert',
  );
});

test('G: cancelling the initial confirmation submits nothing', () => {
  const code = readCode(PRIVACY);
  // Cancel only closes the modal; it must not touch the deletion service.
  assert.match(code, /title="Cancel"[\s\S]{0,220}setDeletionConfirmVisible\(false\)/);
  const cancelRegion = code.slice(code.indexOf('title="Cancel"'), code.indexOf('title="Cancel"') + 300);
  assert.ok(!/submitAccountDeletionRequest|setAccountDeletionNotice/.test(cancelRegion));
});

/* ── Case H — grace-period copy ────────────────────────────────────────── */

test('H: a valid grace-period timestamp is displayed', () => {
  const n = loadNotice();
  const message = n.buildAccountDeletionNoticeMessage({
    alreadyRequested: false,
    gracePeriodEndsAt: '2026-09-12T00:00:00Z',
  });
  assert.match(message, /restored until /i);
  assert.match(message, new RegExp(String(new Date('2026-09-12T00:00:00Z').toLocaleDateString()).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('H: an absent timestamp falls back to generic grace-period copy', () => {
  const n = loadNotice();
  const message = n.buildAccountDeletionNoticeMessage({
    alreadyRequested: false,
    gracePeriodEndsAt: null,
  });
  assert.match(message, /during the grace period/i);
  assert.ok(!/Invalid Date|NaN|undefined|null/.test(message));
});

test('H: a malformed timestamp never produces an invented or invalid date', () => {
  const n = loadNotice();
  for (const bad of ['not-a-date', '', '   ', '2026-13-45T99:99:99Z']) {
    const message = n.buildAccountDeletionNoticeMessage({
      alreadyRequested: false,
      gracePeriodEndsAt: bad,
    });
    assert.ok(!/Invalid Date|NaN/.test(message), `malformed input leaked: ${message}`);
    assert.match(message, /during the grace period/i);
  }
});

/* ── Case I — one-time consumption ─────────────────────────────────────── */

test('I: the notice appears once and does not reappear on later auth visits', () => {
  const n = loadNotice();
  n.setAccountDeletionNotice({ alreadyRequested: false, gracePeriodEndsAt: null });
  assert.ok(n.consumeAccountDeletionNotice(), 'first visit shows it');
  assert.equal(n.consumeAccountDeletionNotice(), null, 'second visit must show nothing');
  assert.equal(n.consumeAccountDeletionNotice(), null);
});

test('I: a cold start with no request shows no notice', () => {
  const n = loadNotice();
  assert.equal(n.consumeAccountDeletionNotice(), null);
});

test('I: a pending notice can be cleared without being shown', () => {
  const n = loadNotice();
  n.setAccountDeletionNotice({ alreadyRequested: true, gracePeriodEndsAt: null });
  n.clearAccountDeletionNotice();
  assert.equal(n.consumeAccountDeletionNotice(), null);
});

/* ── Privacy / PII constraints ─────────────────────────────────────────── */

test('the notice carries no PII, token, or persisted state', () => {
  const source = readSource('services/accountDeletionNotice.ts');
  const code = readCode('services/accountDeletionNotice.ts');
  assert.ok(!/AsyncStorage|SecureStore|localStorage/.test(code), 'must stay in memory only');
  assert.ok(!/token/i.test(code), 'no restoration token may be handled here');
  assert.ok(!/email/i.test(code), 'no email address may be carried');
  assert.ok(source.includes('MEMORY ONLY'), 'the constraint must stay documented');

  const n = loadNotice();
  n.setAccountDeletionNotice({
    alreadyRequested: false,
    gracePeriodEndsAt: null,
    // Extra fields must not survive normalization.
    email: 'someone@example.com',
    restorationToken: 'abcdef0123456789abcdef0123456789',
    userId: '11111111-1111-4111-8111-111111111111',
  });
  const stored = n.consumeAccountDeletionNotice();
  assert.deepEqual(Object.keys(stored).sort(), ['alreadyRequested', 'gracePeriodEndsAt']);
});

test('no deletion state is placed in route parameters', () => {
  const code = readCode(PRIVACY);
  assert.match(code, /router\.replace\('\/auth'\)/, 'destination stays a bare route');
  assert.ok(!/router\.replace\(`\/auth\?/.test(code), 'no query parameters carry deletion state');
});

/* ── IOS-02 preservation (shared file) ─────────────────────────────────── */

test('IOS-02: the Blocked Users surface in privacy.tsx is intact', () => {
  const code = readCode(PRIVACY);
  assert.match(code, /accessibilityLabel="Unblock user"/);
  assert.match(code, /unblockDressingRoomUser\(/);
  assert.match(code, /listDressingRoomBlockedUsers\(/);
  assert.match(code, /unblockFlightRef\.current\.run\(/);
});
