const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'functions', 'handle-user-deletion', 'index.ts'),
  'utf8',
);
const commonSource = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'functions', '_shared', 'deletion', 'common.ts'),
  'utf8',
);

test('handle-user-deletion verifies the caller JWT with auth.getUser', () => {
  assert.match(commonSource, /startsWith\('bearer '\)/i);
  assert.match(commonSource, /auth\.getUser\(accessToken\)/);
  assert.match(source, /requireUser\(req\)/);
});

test('handle-user-deletion validates the extracted user id as a UUID', () => {
  assert.match(commonSource, /isValidUuid\(user\.id\)/);
  assert.match(commonSource, /UUID_REGEX/);
});

test('handle-user-deletion does not accept a user id from the request body', () => {
  assert.doesNotMatch(source, /body\??\.[A-Za-z_]*userId/i);
  assert.doesNotMatch(source, /body\??\.[A-Za-z_]*user_id/i);
});

test('handle-user-deletion keeps CORS OPTIONS support', () => {
  assert.match(source, /req\.method === 'OPTIONS'/);
  assert.match(source, /corsHeaders/);
});

test('handle-user-deletion returns safe errors and avoids raw REST detail logs', () => {
  assert.match(source, /Unable to process deletion request/);
  assert.doesNotMatch(source, /console\.error\([^;]*detail/s);
});

test('handle-user-deletion creates deactivated lifecycle with 30-day grace', () => {
  assert.match(source, /status: 'deactivated'/);
  assert.match(source, /addDaysIso\(now, 30\)/);
  assert.match(source, /grace_period_ends_at/);
  assert.match(source, /restoration_token_hash/);
  assert.match(source, /revokeAllSessions/);
  assert.match(source, /sendRestorationEmail/);
});

test('restoration email uses Render transactional route, not direct Resend', () => {
  assert.match(commonSource, /KSCAN_EMAIL_RENDER_URL/);
  assert.match(commonSource, /KSCAN_EMAIL_INTERNAL_SECRET/);
  assert.match(commonSource, /\/internal\/email\/account-deletion-restoration/);
  assert.match(commonSource, /x-kscan-email-secret/);
  assert.match(commonSource, /account_deletion_restoration/);
  assert.match(commonSource, /buildRestorationIdempotencyKey/);
  assert.doesNotMatch(commonSource, /api\.resend\.com/);
});

test('restoration idempotency keys are stable per request and supersede on resend', () => {
  assert.match(commonSource, /deletion-restore:\$\{params\.requestId\}/);
  assert.match(commonSource, /deletion-restore:\$\{params\.requestId\}:resend:/);
  assert.match(commonSource, /deletion-restored:\$\{params\.requestId\}/);
});

test('handle-user-deletion guards duplicate active lifecycle requests', () => {
  assert.match(source, /ACTIVE_STATUSES/);
  assert.match(source, /alreadyRequested: true/);
});
