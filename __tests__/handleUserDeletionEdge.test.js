const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'functions', 'handle-user-deletion', 'index.ts'),
  'utf8',
);

test('handle-user-deletion verifies the caller JWT with auth.getUser', () => {
  assert.match(source, /startsWith\('bearer '\)/i);
  assert.match(source, /auth\.getUser\(accessToken\)/);
});

test('handle-user-deletion validates the extracted user id as a UUID', () => {
  assert.match(source, /isValidUuid\(user\.id\)/);
  assert.match(source, /UUID_REGEX/);
});

test('handle-user-deletion does not accept a user id from the request body', () => {
  assert.doesNotMatch(source, /req\.json\(/);
  assert.doesNotMatch(source, /body\??\.[A-Za-z_]*user/i);
});

test('handle-user-deletion keeps CORS OPTIONS support', () => {
  assert.match(source, /req\.method === 'OPTIONS'/);
  assert.match(source, /Access-Control-Allow-Methods': 'POST, OPTIONS'/);
});

test('handle-user-deletion returns safe errors and avoids raw REST detail logs', () => {
  assert.match(source, /Unable to process deletion request/);
  assert.doesNotMatch(source, /console\.error\([^;]*detail/s);
});

test('handle-user-deletion guards duplicate pending or processing requests', () => {
  assert.match(source, /status=in\.\(pending,processing\)/);
  assert.match(source, /already_requested/);
});
