const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const deletion = read('supabase/functions/handle-user-deletion/index.ts');
const correction = read('supabase/functions/privacy-correction-request/index.ts');
const exportFn = read('supabase/functions/privacy-data-export/index.ts');
const helper = read('supabase/functions/_shared/privacyRequestRateLimit.ts');
// Ported verbatim from the Build 25 line, where this file was named
// 20260808103028_privacy_request_rate_limits.sql. Applying it through the
// Management API assigned the staging version below, and the file is named for
// the version actually applied so the repository matches live staging.
const migration = read('supabase/migrations/20260808121216_privacy_request_rate_limits.sql');

test('privacy rate-limit helper returns 429 RATE_LIMITED with Retry-After', () => {
  assert.match(helper, /code: 'RATE_LIMITED'/);
  assert.match(helper, /'Retry-After'/);
  assert.match(helper, /status: 429/);
  assert.match(helper, /reserve_privacy_request_rate_limit/);
});

test('privacy rate-limit helper never takes identity from request body', () => {
  assert.match(helper, /p_user_id: userId/);
  assert.doesNotMatch(helper, /req\.json/);
});

test('handle-user-deletion rate-limits after already_requested short-circuit', () => {
  const alreadyIdx = deletion.indexOf('already_requested');
  const rateIdx = deletion.indexOf("reservePrivacyRequestRateLimit(user.id, 'account_deletion')");
  assert.ok(alreadyIdx !== -1, 'must preserve already_requested');
  assert.ok(rateIdx !== -1, 'must reserve account_deletion rate limit');
  assert.ok(alreadyIdx < rateIdx, 'existing-request check must precede rate-limit reservation');
});

test('handle-user-deletion still requires auth and rejects body user ids', () => {
  assert.match(deletion, /auth\.getUser\(accessToken\)/);
  assert.doesNotMatch(deletion, /req\.json\(/);
  assert.match(deletion, /Authentication required/);
});

test('privacy-correction-request rate-limits before insert', () => {
  const rateIdx = correction.indexOf("reservePrivacyRequestRateLimit(user.id, 'privacy_correction')");
  const insertIdx = correction.indexOf("serviceRest('privacy_correction_requests'");
  assert.ok(rateIdx !== -1);
  assert.ok(insertIdx !== -1);
  assert.ok(rateIdx < insertIdx);
  assert.match(correction, /Authentication required/);
});

test('privacy-data-export rate-limits before insert', () => {
  const rateIdx = exportFn.indexOf("reservePrivacyRequestRateLimit(user.id, 'privacy_export')");
  const insertIdx = exportFn.indexOf("serviceRest('privacy_export_requests'");
  assert.ok(rateIdx !== -1);
  assert.ok(insertIdx !== -1);
  assert.ok(rateIdx < insertIdx);
  assert.match(exportFn, /Authentication required/);
});

test('migration defines fixed actions and service_role-only EXECUTE', () => {
  assert.match(migration, /account_deletion/);
  assert.match(migration, /privacy_correction/);
  assert.match(migration, /privacy_export/);
  assert.match(migration, /security definer/i);
  assert.match(migration, /set search_path = public/);
  assert.match(migration, /revoke all on function public\.reserve_privacy_request_rate_limit/);
  assert.match(migration, /from anon/);
  assert.match(migration, /from authenticated/);
  assert.match(migration, /grant execute on function public\.reserve_privacy_request_rate_limit[\s\S]*to service_role/);
  assert.doesNotMatch(migration, /cascade/i);
});
