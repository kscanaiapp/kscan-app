/**
 * Auth + Privacy preference merge tests.
 *
 * These are pure Node.js tests covering:
 *   - mergePrivacyPreferences — all four local/remote combinations
 *   - mergeNeedsWrite — detects when local ON must propagate to remote
 *   - Sign-in merge scenarios per spec
 *   - Sign-out → sign-in round-trip (remote preference preserved)
 *   - Minor-user rules applied at merge time
 *
 * Full PrivacyPreferencesContext integration tests (session boot, syncStatus
 * transitions, disabled-writes-during-refresh) require React Testing Library
 * and are documented as a follow-up gap.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mergePrivacyPreferences,
  mergeNeedsWrite,
  normalizePrivacySettings,
  buildPrivacyUpdatePatch,
} = require('../services/privacyPolicy');

// ─── mergePrivacyPreferences ──────────────────────────────────────────────────

test('merge: local ON + remote OFF → merged ON (privacy-protective wins)', () => {
  const result = mergePrivacyPreferences(
    { opt_out_of_sale: true, limit_sensitive_processing: false },
    { opt_out_of_sale: false, limit_sensitive_processing: false },
  );
  assert.equal(result.opt_out_of_sale, true);
  assert.equal(result.limit_sensitive_processing, false);
});

test('merge: local ON + remote ON → merged ON (no change)', () => {
  const result = mergePrivacyPreferences(
    { opt_out_of_sale: true, limit_sensitive_processing: true },
    { opt_out_of_sale: true, limit_sensitive_processing: true },
  );
  assert.equal(result.opt_out_of_sale, true);
  assert.equal(result.limit_sensitive_processing, true);
});

test('merge: local OFF + remote ON → merged ON (remote ON is preserved)', () => {
  const result = mergePrivacyPreferences(
    { opt_out_of_sale: false, limit_sensitive_processing: false },
    { opt_out_of_sale: true, limit_sensitive_processing: true },
  );
  assert.equal(result.opt_out_of_sale, true, 'remote ON must not be overwritten by local OFF');
  assert.equal(result.limit_sensitive_processing, true);
});

test('merge: local OFF + remote OFF → merged OFF (both off)', () => {
  const result = mergePrivacyPreferences(
    { opt_out_of_sale: false, limit_sensitive_processing: false },
    { opt_out_of_sale: false, limit_sensitive_processing: false },
  );
  assert.equal(result.opt_out_of_sale, false);
  assert.equal(result.limit_sensitive_processing, false);
});

test('merge: individual fields merge independently', () => {
  const result = mergePrivacyPreferences(
    { opt_out_of_sale: true, limit_sensitive_processing: false },
    { opt_out_of_sale: false, limit_sensitive_processing: true },
  );
  assert.equal(result.opt_out_of_sale, true);
  assert.equal(result.limit_sensitive_processing, true);
});

// ─── mergeNeedsWrite ─────────────────────────────────────────────────────────

test('mergeNeedsWrite: local ON + remote OFF → write needed', () => {
  assert.equal(
    mergeNeedsWrite(
      { opt_out_of_sale: true, limit_sensitive_processing: false },
      { opt_out_of_sale: false, limit_sensitive_processing: false },
    ),
    true,
  );
});

test('mergeNeedsWrite: local OFF + remote ON → no write needed (remote is already more restrictive)', () => {
  assert.equal(
    mergeNeedsWrite(
      { opt_out_of_sale: false, limit_sensitive_processing: false },
      { opt_out_of_sale: true, limit_sensitive_processing: false },
    ),
    false,
  );
});

test('mergeNeedsWrite: both OFF → no write needed', () => {
  assert.equal(
    mergeNeedsWrite(
      { opt_out_of_sale: false, limit_sensitive_processing: false },
      { opt_out_of_sale: false, limit_sensitive_processing: false },
    ),
    false,
  );
});

test('mergeNeedsWrite: local sensitive ON + remote sensitive OFF → write needed', () => {
  assert.equal(
    mergeNeedsWrite(
      { opt_out_of_sale: false, limit_sensitive_processing: true },
      { opt_out_of_sale: false, limit_sensitive_processing: false },
    ),
    true,
  );
});

// ─── Sign-in merge round-trip ─────────────────────────────────────────────────

test('sign-in merge: local opt-out set before sign-in propagates to remote', () => {
  // User set local opt-out while signed out, then signs in
  const local = { opt_out_of_sale: true, limit_sensitive_processing: false };
  // Remote row starts with defaults (both false) from ensure_privacy_settings()
  const remote = { opt_out_of_sale: false, limit_sensitive_processing: false };

  assert.equal(mergeNeedsWrite(local, remote), true, 'a write is required to propagate local ON');

  const merged = mergePrivacyPreferences(local, remote);
  assert.equal(merged.opt_out_of_sale, true, 'opt_out_of_sale should be ON after merge');

  const patch = buildPrivacyUpdatePatch(merged, { age_group: 'unknown', account_status: 'active' });
  assert.equal(patch.opt_out_of_sale, true);
  assert.equal(patch.last_request_source, 'mobile_app');
  assert.ok(Date.parse(patch.last_processed_at));
});

test('sign-out → sign-in: prior remote preference is not reset by local defaults', () => {
  // User had opt_out_of_sale=true on remote before signing out
  const remoteAfterSignIn = { opt_out_of_sale: true, limit_sensitive_processing: false };
  // Local defaults after sign-out (user did not change anything)
  const localAfterSignOut = { opt_out_of_sale: false, limit_sensitive_processing: false };

  // Merge on sign-in should NOT overwrite remote ON with local OFF
  const merged = mergePrivacyPreferences(localAfterSignOut, remoteAfterSignIn);
  assert.equal(merged.opt_out_of_sale, true, 'prior remote preference must survive sign-out/sign-in cycle');

  // No write needed since remote is already the privacy-protective value
  assert.equal(mergeNeedsWrite(localAfterSignOut, remoteAfterSignIn), false);
});

test('sign-in merge: both local and remote ON — no write needed, preference preserved', () => {
  const local = { opt_out_of_sale: true, limit_sensitive_processing: true };
  const remote = { opt_out_of_sale: true, limit_sensitive_processing: true };

  assert.equal(mergeNeedsWrite(local, remote), false);
  const merged = mergePrivacyPreferences(local, remote);
  assert.equal(merged.opt_out_of_sale, true);
  assert.equal(merged.limit_sensitive_processing, true);
});

// ─── Minor-user rules at merge time ──────────────────────────────────────────

test('minor: merge result passed through buildPrivacyUpdatePatch forces opt_out_of_sale ON', () => {
  // Even if both local and remote are OFF, a minor profile forces sale opt-out in the patch
  const merged = mergePrivacyPreferences(
    { opt_out_of_sale: false, limit_sensitive_processing: false },
    { opt_out_of_sale: false, limit_sensitive_processing: false },
  );
  const patch = buildPrivacyUpdatePatch(merged, { age_group: 'under_13' });
  assert.equal(patch.opt_out_of_sale, true, 'minor users always have sale opt-out forced ON');
});

test('minor: age_13_to_15 also forces sale opt-out', () => {
  const merged = mergePrivacyPreferences(
    { opt_out_of_sale: false, limit_sensitive_processing: false },
    { opt_out_of_sale: false, limit_sensitive_processing: false },
  );
  const patch = buildPrivacyUpdatePatch(merged, { age_group: 'age_13_to_15' });
  assert.equal(patch.opt_out_of_sale, true);
});

// ─── normalizePrivacySettings with merged result ──────────────────────────────

test('normalize: merged ON preferences reflect correctly in normalized output', () => {
  const row = {
    user_id: 'test-uuid',
    opt_out_of_sale: true,
    limit_sensitive_processing: true,
    consent_version: 'ccpa_cpra_mobile_v1',
    last_request_source: 'mobile_app',
    last_processed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const normalized = normalizePrivacySettings(row, { age_group: 'age_16_plus', account_status: 'active' });
  assert.equal(normalized.opt_out_of_sale, true);
  assert.equal(normalized.limit_sensitive_processing, true);
  assert.equal(normalized.sale_sharing_locked_reason, null);
});

test('normalize: merged OFF preferences with adult profile remain OFF', () => {
  const row = {
    user_id: 'test-uuid',
    opt_out_of_sale: false,
    limit_sensitive_processing: false,
  };
  const normalized = normalizePrivacySettings(row, { age_group: 'age_16_plus' });
  assert.equal(normalized.opt_out_of_sale, false);
  assert.equal(normalized.limit_sensitive_processing, false);
});

// ─── Auth input validation ────────────────────────────────────────────────────

const { validateAuthInput, mapAuthError } = require('../services/authValidation');

test('validateAuthInput: empty email fails', () => {
  const r = validateAuthInput('sign-in', '', 'password123', '');
  assert.equal(r.valid, false);
  assert.ok(r.error, 'should have an error message');
});

test('validateAuthInput: email missing @ fails', () => {
  const r = validateAuthInput('sign-in', 'notanemail', 'password123', '');
  assert.equal(r.valid, false);
  assert.match(r.error, /valid email/i);
});

test('validateAuthInput: email ending with @ fails', () => {
  const r = validateAuthInput('sign-in', 'user@', 'password123', '');
  assert.equal(r.valid, false);
  assert.match(r.error, /valid email/i);
});

test('validateAuthInput: empty password fails', () => {
  const r = validateAuthInput('sign-in', 'user@example.com', '', '');
  assert.equal(r.valid, false);
  assert.match(r.error, /password/i);
});

test('validateAuthInput: valid sign-in inputs pass', () => {
  const r = validateAuthInput('sign-in', 'user@example.com', 'password123', '');
  assert.equal(r.valid, true);
  assert.equal(r.error, null);
});

test('validateAuthInput: create-account missing confirmPassword fails', () => {
  const r = validateAuthInput('create-account', 'user@example.com', 'password123', '');
  assert.equal(r.valid, false);
  assert.match(r.error, /confirm/i);
});

test('validateAuthInput: create-account mismatched passwords fail', () => {
  const r = validateAuthInput('create-account', 'user@example.com', 'password123', 'different');
  assert.equal(r.valid, false);
  assert.match(r.error, /do not match/i);
});

test('validateAuthInput: create-account all valid inputs pass', () => {
  const r = validateAuthInput('create-account', 'user@example.com', 'password123', 'password123');
  assert.equal(r.valid, true);
  assert.equal(r.error, null);
});

test('validateAuthInput: email with leading/trailing spaces is accepted (trimmed internally)', () => {
  const r = validateAuthInput('sign-in', '  user@example.com  ', 'password123', '');
  assert.equal(r.valid, true);
});

// ─── Auth error mapping ───────────────────────────────────────────────────────

test('mapAuthError: invalid login credentials → safe copy', () => {
  const msg = mapAuthError('Invalid login credentials', 'sign-in');
  assert.match(msg, /incorrect/i);
});

test('mapAuthError: email not confirmed → confirmation hint', () => {
  const msg = mapAuthError('Email not confirmed', 'sign-in');
  assert.match(msg, /confirmed/i);
  assert.match(msg, /inbox/i);
});

test('mapAuthError: user already registered in create-account mode → suggest sign-in', () => {
  const msg = mapAuthError('User already registered', 'create-account');
  assert.match(msg, /already exist/i);
  assert.match(msg, /sign(ing)? in/i);
});

test('mapAuthError: user already registered in sign-in mode → safe copy (no disclosure)', () => {
  const msg = mapAuthError('User already registered', 'sign-in');
  assert.match(msg, /incorrect/i);
});

test('mapAuthError: network error maps to network copy', () => {
  const msg = mapAuthError('Network request failed', 'sign-in');
  assert.match(msg, /network/i);
  assert.match(msg, /connection/i);
});

test('mapAuthError: unknown error returns safe copy that does not blame credentials', () => {
  const msg = mapAuthError('Some unexpected error from server', 'sign-in');
  assert.ok(msg.length > 0);
  // Previously this asserted the copy tell the user to check their "email and
  // password". That is what made a backend outage read as a rejected password,
  // so the contract is now the inverse: an unattributed failure must not
  // implicate the user's credentials.
  assert.doesNotMatch(msg, /password/i);
});

test('mapAuthError: "rate limit" → rate-limit copy', () => {
  const msg = mapAuthError('Auth rate limit reached', 'sign-in');
  assert.equal(msg, 'Too many attempts. Please wait a few minutes and try again.');
});

test('mapAuthError: "too many requests" → rate-limit copy', () => {
  const msg = mapAuthError('Too many requests', 'create-account');
  assert.equal(msg, 'Too many attempts. Please wait a few minutes and try again.');
});

test('mapAuthError: "429" in message → rate-limit copy', () => {
  const msg = mapAuthError('Request failed with status 429', 'sign-in');
  assert.equal(msg, 'Too many attempts. Please wait a few minutes and try again.');
});
