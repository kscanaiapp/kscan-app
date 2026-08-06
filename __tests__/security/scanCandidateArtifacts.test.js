#!/usr/bin/env node
'use strict';

/**
 * Coverage for the Candidate Artifact Exposure Gate classifier
 * (security/scripts/scan-candidate-artifacts.js). The core claim under test:
 * it must distinguish an expected staging anon/publishable key from a
 * confirmed private credential by decoding the JWT payload, not by pattern
 * shape alone (both are "eyJ..." to a generic detector).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  scan,
  summarize,
  classifyJwt,
  isTemplateEnvFile,
  PRODUCTION_PROJECT_REF,
  STAGING_PROJECT_REF,
} = require('../../security/scripts/scan-candidate-artifacts');

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fakeJwt(payload) {
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const sig = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH';
  return `${header}.${b64url(payload)}.${sig}`;
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-artifact-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('classifyJwt: staging anon JWT is ALLOW', () => {
  const token = fakeJwt({ role: 'anon', ref: STAGING_PROJECT_REF });
  const result = classifyJwt(token);
  assert.equal(result.verdict, 'ALLOW');
});

test('classifyJwt: service_role JWT is BLOCK regardless of project ref', () => {
  const token = fakeJwt({ role: 'service_role', ref: STAGING_PROJECT_REF });
  const result = classifyJwt(token);
  assert.equal(result.verdict, 'BLOCK');
  assert.equal(result.ruleId, 'SUPABASE_SERVICE_ROLE_JWT');
});

test('classifyJwt: any JWT referencing the production ref is BLOCK, even role=anon', () => {
  const token = fakeJwt({ role: 'anon', ref: PRODUCTION_PROJECT_REF });
  const result = classifyJwt(token);
  assert.equal(result.verdict, 'BLOCK');
  assert.equal(result.ruleId, 'PRODUCTION_JWT');
});

test('classifyJwt: anon JWT for an unrecognized ref is MANUAL_REVIEW, not silently allowed', () => {
  const token = fakeJwt({ role: 'anon', ref: 'some-other-project' });
  const result = classifyJwt(token);
  assert.equal(result.verdict, 'MANUAL_REVIEW');
});

test('classifyJwt: unparseable JWT-shaped token is MANUAL_REVIEW, not a crash', () => {
  const result = classifyJwt('not.a.jwt');
  assert.equal(result.verdict, 'MANUAL_REVIEW');
});

test('isTemplateEnvFile: real .env is not a template, .env.example is', () => {
  assert.equal(isTemplateEnvFile('.env'), false);
  assert.equal(isTemplateEnvFile('.env.production'), false);
  assert.equal(isTemplateEnvFile('.env.example'), true);
  assert.equal(isTemplateEnvFile('.env.sample'), true);
  assert.equal(isTemplateEnvFile('src/config.js'), true); // not an env file at all
});

test('scan+summarize: mixed fixture directory classifies each file correctly', () => {
  withTempDir((dir) => {
    fs.writeFileSync(
      path.join(dir, 'client-config.js'),
      `export const SUPABASE_ANON_KEY = "${fakeJwt({ role: 'anon', ref: STAGING_PROJECT_REF })}";\n`
    );
    fs.writeFileSync(
      path.join(dir, 'leaked-service-key.js'),
      `const key = "${fakeJwt({ role: 'service_role', ref: STAGING_PROJECT_REF })}";\n`
    );
    fs.writeFileSync(path.join(dir, 'openai-leak.js'), 'const k = "sk-abcdefghijklmnopqrstuvwx123456";\n');
    fs.writeFileSync(path.join(dir, 'prod-ref-leak.js'), `const url = "https://${PRODUCTION_PROJECT_REF}.supabase.co";\n`);
    fs.writeFileSync(path.join(dir, 'clean.js'), 'console.log(1);\n');
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=whatever\n');
    fs.writeFileSync(path.join(dir, '.env.example'), 'SECRET=changeme\n');

    const results = scan([dir]);
    const summary = summarize(results);

    assert.equal(summary.scannedFiles, 7);
    assert.equal(summary.allowedCount, 1, 'staging anon key should be the single ALLOW finding');
    // service_role JWT, openai key, prod ref, raw .env => 4 BLOCK findings
    assert.equal(summary.blockedCount, 4);
    assert.equal(summary.verdict, 'BLOCKED');

    const blockedRuleIds = summary.findings.filter((f) => f.verdict === 'BLOCK').map((f) => f.ruleId).sort();
    assert.deepEqual(blockedRuleIds, [
      'OPENAI_API_KEY',
      'PRODUCTION_PROJECT_REFERENCE',
      'RAW_ENV_FILE_IN_ARTIFACT',
      'SUPABASE_SERVICE_ROLE_JWT',
    ]);
  });
});

test('scan+summarize: a directory with no findings PASSes', () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'clean.js'), 'console.log("hello");\n');
    const summary = summarize(scan([dir]));
    assert.equal(summary.verdict, 'PASS');
    assert.equal(summary.blockedCount, 0);
  });
});

test('scan: never includes the raw matched secret value in a snippet', () => {
  withTempDir((dir) => {
    const secret = 'sk-abcdefghijklmnopqrstuvwx123456';
    fs.writeFileSync(path.join(dir, 'leak.js'), `const k = "${secret}";\n`);
    const results = scan([dir]);
    const summary = summarize(results);
    for (const finding of summary.findings) {
      assert.ok(!finding.snippet.includes(secret), 'snippet must not contain the raw secret value');
    }
  });
});
