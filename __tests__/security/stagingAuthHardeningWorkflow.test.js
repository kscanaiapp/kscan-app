/**
 * Contract for the staging auth-hardening workflow.
 *
 * This workflow holds a Supabase Management API token and writes to a LIVE Auth
 * configuration. That is exactly the kind of capability that starts as "flip one
 * safety setting" and drifts into a general-purpose config writer, so the
 * narrowness is asserted rather than merely intended:
 *
 *   * one allowlisted field, one allowed value;
 *   * staging only, production an explicit deny;
 *   * manual dispatch only — never scheduled, never on push;
 *   * a typed confirmation string;
 *   * the token is never echoed and never passed on a command line;
 *   * the result is re-read and verified rather than trusted from the PATCH.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOW_PATH = path.join(
  __dirname,
  '..',
  '..',
  '.github',
  'workflows',
  'staging-auth-hardening.yml',
);

const STAGING_REF = 'yzqjvdfgefveprobvvyw';
const PRODUCTION_REF = 'wyyuqfdxucjksghsmhry';

const source = fs.readFileSync(WORKFLOW_PATH, 'utf8');

test('it is manual-dispatch only — never scheduled, never on push', () => {
  assert.match(source, /workflow_dispatch:/);
  assert.ok(!/^\s*schedule:/m.test(source), 'a live auth-config writer must not run on a schedule');
  assert.ok(!/^\s*push:/m.test(source), 'must not run on push');
  assert.ok(!/^\s*pull_request:/m.test(source), 'must not run on pull_request');
});

test('it requires a typed confirmation string', () => {
  assert.match(source, /CONFIRMATION:\s*HARDEN-STAGING-AUTH/);
  assert.match(source, /inputs\.confirm/);
  assert.match(source, /Refusing/);
});

test('it binds the protected staging environment', () => {
  assert.match(source, /environment:\s*staging/);
});

test('staging is a literal and production is explicitly denied', () => {
  assert.match(source, new RegExp(`STAGING_REF:\\s*${STAGING_REF}`));
  assert.match(source, new RegExp(`PRODUCTION_REF:\\s*${PRODUCTION_REF}`));
  assert.match(source, /if \[ "\$\{STAGING_REF\}" = "\$\{PRODUCTION_REF\}" \]/);
  assert.ok(
    !new RegExp(`projects/${PRODUCTION_REF}`).test(source),
    'the production project must never appear in an API path',
  );
});

test('exactly one auth field is written, and only to true', () => {
  const patchBodies = source.match(/--data '(\{[^']*\})'/g) || [];
  assert.equal(patchBodies.length, 1, 'exactly one request body may be sent');
  assert.match(patchBodies[0], /\{"password_hibp_enabled":true\}/);

  // No other auth field may be named anywhere in a write position.
  for (const forbidden of [
    'site_url',
    'uri_allow_list',
    'jwt_exp',
    'mailer_autoconfirm',
    'disable_signup',
    'external_',
    'sms_',
    'password_min_length',
  ]) {
    assert.ok(!source.includes(forbidden), `${forbidden} must not be touched`);
  }
});

test('only PATCH and GET are used — never DELETE or PUT', () => {
  assert.match(source, /--request PATCH/);
  assert.ok(!/--request (DELETE|PUT|POST)/.test(source), 'no destructive or creating verbs');
});

test('the access token is never echoed and never passed on a command line', () => {
  const NEWLINE = String.fromCharCode(10);
  const echoedToken = source
    .split(NEWLINE)
    .filter((line) => line.includes('echo'))
    .filter((line) => line.includes('$SUPABASE_ACCESS_TOKEN') || line.includes('${SUPABASE_ACCESS_TOKEN'));
  assert.deepEqual(echoedToken, [], 'the token must never be expanded into stdout');
  assert.ok(
    !/--header\s+['"]Authorization: Bearer \$/.test(source),
    'token must not be an inline curl argument',
  );
  assert.match(source, /--header @"\$\{HDR\}"/, 'token is passed via @file');
  assert.match(source, /trap 'rm -f "\$\{HDR\}"[^']*' EXIT/, 'the header file is always removed');
});

test('a missing token fails closed', () => {
  assert.match(source, /if \[ -z "\$\{SUPABASE_ACCESS_TOKEN:-\}" \]/);
});

test('the outcome is re-read and verified, not trusted from the PATCH response', () => {
  assert.match(source, /VERIFY_CODE=/);
  assert.match(source, /if \[ "\$\{AFTER\}" != "true" \]/);
});

test('it takes no write permissions it does not need', () => {
  assert.match(source, /permissions:\s*\n\s*contents:\s*read/);
});
