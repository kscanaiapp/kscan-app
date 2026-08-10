/**
 * IOS29-NEW-003 — server posture for the two Apple Edge Functions and the
 * credential table.
 *
 * These are source and configuration assertions rather than runtime ones: they
 * guard the properties that decide whether the feature is safe, and that are
 * invisible in ordinary behavioural testing — who may call each function, whose
 * account a call can touch, what may be written to a log, and whether a secret
 * could ever leave the server.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function readSource(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

const LINK_FN = 'supabase/functions/apple-credential-link/index.ts';
const REVOKE_FN = 'supabase/functions/apple-revoke-credential/index.ts';
const MIGRATION = 'supabase/migrations/20260810120000_apple_auth_credentials.sql';

// ── who may call what ───────────────────────────────────────────────────────

test('config.toml pins the JWT posture of both Apple functions', () => {
  const config = readSource('supabase/config.toml');

  assert.match(
    config,
    /\[functions\.apple-credential-link\]\s*\nverify_jwt = true/,
    'credential capture must require a verified user JWT',
  );
  assert.match(
    config,
    /\[functions\.apple-revoke-credential\]\s*\nverify_jwt = false/,
    'revocation is server-to-server; it authenticates by service-role key instead',
  );
});

test('credential capture resolves the account from the bearer, never from the body', () => {
  const source = readSource(LINK_FN);

  assert.match(source, /const user = await requireUser\(req\)/);
  assert.match(source, /userClient\.auth\.getUser\(accessToken\)/);

  // The only body field consumed is the code. If a userId were ever read from
  // the body, one user could bind their Apple grant onto another account.
  assert.ok(
    !/body[^\n]*\.userId|userId.*=.*body/.test(source),
    'the request body must not be able to choose the target account',
  );
  assert.match(source, /userId: user\.id/, 'persistence must use the verified user id');
});

test('revocation refuses every caller that is not holding the service-role key', () => {
  const source = readSource(REVOKE_FN);

  assert.match(source, /requireServiceRole\(req\)/);
  assert.match(
    source,
    /secureEquals\(presented, env\('SUPABASE_SERVICE_ROLE_KEY'\)\)/,
    'the bearer must be compared against the service-role key',
  );
  assert.match(
    source,
    /export function secureEquals/,
    'the comparison must be constant time so the key cannot be recovered by timing',
  );

  // requireServiceRole must run before anything reads the body, so an
  // unauthorized caller cannot even probe for which users have credentials.
  const guardIndex = source.indexOf('requireServiceRole(req)');
  const bodyIndex = source.indexOf('await req.json()');
  assert.ok(guardIndex > -1 && bodyIndex > -1);
  assert.ok(guardIndex < bodyIndex, 'authorization must precede body parsing');
});

test('an end user cannot drive revocation for any account, including their own', () => {
  const source = readSource(REVOKE_FN);
  // There is no user-JWT path at all in this function. A valid user token is
  // simply not the service-role key, so it fails the constant-time comparison.
  assert.ok(
    !/getUser\(|SUPABASE_ANON_KEY/.test(source),
    'accepting a user JWT here would let a caller trigger revocation directly',
  );
});

// ── secrets and logging ─────────────────────────────────────────────────────

test('no Apple secret or token can be returned to a caller', () => {
  for (const file of [LINK_FN, REVOKE_FN]) {
    const source = readSource(file);
    assert.ok(
      !/json\(\{[^}]*(refreshToken|refresh_token|clientSecret|client_secret|privateKey)/.test(source),
      `${file} must never place a secret in a response`,
    );
  }

  // Responses are status words by design.
  assert.match(readSource(LINK_FN), /status: 'linked'/);
  assert.match(readSource(REVOKE_FN), /status: 'revoked'/);
});

test('nothing logs a code, a token, a secret, or an Apple response body', () => {
  for (const file of [LINK_FN, REVOKE_FN]) {
    const source = readSource(file);
    const logCalls = source.match(/logEvent\([^;]*?\);/gs) ?? [];
    assert.ok(logCalls.length > 0, `${file} should have structured logging`);

    for (const call of logCalls) {
      assert.ok(
        !/authorizationCode|refreshToken|refresh_token|clientSecret|client_secret|privateKey|envelope|\bbody\b/.test(
          call,
        ),
        `a log line in ${file} carries something it must not: ${call.slice(0, 120)}`,
      );
    }
  }
});

test('the missing-configuration log names variables without revealing values', () => {
  const source = readSource(LINK_FN);
  assert.match(source, /logEvent\('not_configured', \{ missing: resolution\.missing \}\)/);

  const config = readSource('supabase/functions/_shared/appleAuth/config.ts');
  // `missing` is built from the fixed name list, never from read values.
  assert.match(config, /missing\.push\(name\)/);
  assert.ok(
    !/missing\.push\(value|missing\.push\(`/.test(config),
    'only variable names may be reported as missing',
  );
});

test('the Apple private key is read from the environment and never persisted', () => {
  const config = readSource('supabase/functions/_shared/appleAuth/config.ts');
  assert.match(config, /APPLE_PRIVATE_KEY/);

  const clientSecret = readSource('supabase/functions/_shared/appleAuth/appleClientSecret.ts');
  // Imported as non-extractable so the key material cannot be read back out
  // even inside the function.
  assert.match(clientSecret, /'pkcs8',[\s\S]*?false, \/\/ never extractable/);

  for (const file of [LINK_FN, REVOKE_FN]) {
    const source = readSource(file);
    assert.ok(
      !/privateKeyPem[^\n]*(rest\(|insert|body: JSON\.stringify)/.test(source),
      `${file} must not write key material anywhere`,
    );
  }
});

test('no .p8 or private key material is committed anywhere in the repo', () => {
  const { execFileSync } = require('node:child_process');
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

  const keyFiles = tracked.filter((file) => /\.(p8|p12|pem|key)$/i.test(file));
  assert.deepEqual(keyFiles, [], `private key material must never be committed: ${keyFiles}`);
});

// ── storage ────────────────────────────────────────────────────────────────

test('the credential table is unreachable by any client role', () => {
  const migration = readSource(MIGRATION);

  assert.match(migration, /enable row level security/);
  assert.match(
    migration,
    /revoke all on table public\.apple_auth_credentials from anon, authenticated/,
    'the privilege itself must be removed, not merely unmatched by policy',
  );
  assert.match(
    migration,
    /grant select, insert, update, delete on table public\.apple_auth_credentials to service_role/,
  );
  assert.ok(
    !/create policy/i.test(migration),
    'a policy on this table would create the client read path it exists to prevent',
  );
});

test('the table stores the encrypted envelope and no other Apple data', () => {
  const migration = readSource(MIGRATION);

  assert.match(migration, /encrypted_refresh_token text not null/);
  // The authorization code is single-use and spent at exchange; retaining it
  // would keep a live grant around for no purpose.
  assert.ok(
    !/authorization_code|identity_token|apple_email|apple_name/.test(migration),
    'nothing beyond the revocation token belongs in this table',
  );
  assert.match(
    migration,
    /check \(encrypted_refresh_token ~ '\^v1/,
    'a plaintext token must be rejected by the database itself',
  );
});

test('the credential cannot outlive its account', () => {
  const migration = readSource(MIGRATION);
  assert.match(migration, /references auth\.users \(id\) on delete cascade/);
});

test('the migration is forward-only and does not edit applied history', () => {
  const { execFileSync } = require('node:child_process');
  // Compare the branch point against the WORKING TREE, not against HEAD, so
  // this holds whether or not the change has been committed yet.
  const changed = execFileSync(
    'git',
    ['diff', '--name-only', 'origin/hotfix/ios-build29-appstore-readiness', '--', 'supabase/migrations'],
    { cwd: ROOT, encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean);

  assert.deepEqual(
    changed,
    ['supabase/migrations/20260810120000_apple_auth_credentials.sql'],
    'only the new migration may appear; a previously applied file must never be edited',
  );
});
