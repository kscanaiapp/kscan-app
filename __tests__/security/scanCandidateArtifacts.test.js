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
  isCommentLine,
  isComparisonContextLine,
  pathSuffixKey,
  reconcileWithInternalAllowlist,
  mergeGitleaksFindings,
  mergeTrivyFindings,
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

test('isCommentLine: recognizes SQL, shell/env, and JS/TS comment markers', () => {
  assert.equal(isCommentLine('-- a sql comment'), true);
  assert.equal(isCommentLine('  # a shell/env comment'), true);
  assert.equal(isCommentLine('// a js comment'), true);
  assert.equal(isCommentLine('const x = 1;'), false);
});

test('isComparisonContextLine: recognizes classification/guard idioms, not bare literals', () => {
  assert.equal(isComparisonContextLine("if (url.includes('wyyuqfdxucjksghsmhry')) return 'production';"), true);
  assert.equal(isComparisonContextLine('const url = "https://wyyuqfdxucjksghsmhry.supabase.co";'), false);
});

test('scan: PRODUCTION_PROJECT_REFERENCE is exempt in a migration-comment context (found live in this repo)', () => {
  withTempDir((dir) => {
    fs.writeFileSync(
      path.join(dir, 'migration.sql'),
      `-- Production (${PRODUCTION_PROJECT_REF}, read-only) defines exactly two buckets:\ncreate table foo (id uuid primary key);\n`
    );
    const summary = summarize(scan([dir]));
    assert.equal(summary.blockedCount, 0);
  });
});

test('scan: PRODUCTION_PROJECT_REFERENCE is exempt in a comparison/classification guard (found live in this repo)', () => {
  withTempDir((dir) => {
    fs.writeFileSync(
      path.join(dir, 'guard.ts'),
      `if (url.includes('${PRODUCTION_PROJECT_REF}')) return 'production';\n`
    );
    const summary = summarize(scan([dir]));
    assert.equal(summary.blockedCount, 0);
  });
});

test('scan: PRODUCTION_PROJECT_REFERENCE still blocks a bare literal target (the real eas.json finding)', () => {
  withTempDir((dir) => {
    fs.writeFileSync(
      path.join(dir, 'eas.json'),
      `{"env": {"EXPO_PUBLIC_SUPABASE_URL": "https://${PRODUCTION_PROJECT_REF}.supabase.co"}}\n`
    );
    const summary = summarize(scan([dir]));
    assert.equal(summary.blockedCount, 1);
    assert.equal(summary.findings[0].ruleId, 'PRODUCTION_PROJECT_REFERENCE');
  });
});

// ── Reconciliation with generic scanners (2026-08-06 regression) ────────────
//
// Gitleaks/Trivy pattern-match JWTs with no payload awareness, so every
// legitimate JWT this repo ships (eas.json's staging anon keys, and the
// production key inside eas.json's own build.production profile) was
// independently re-flagged BLOCK by them even after kscan-supabase-jwt-classifier
// correctly ALLOWed the identical token -- meaning the gate could never pass
// on any candidate that includes eas.json. Confirmed against the real
// Candidate Artifact Exposure Gate run on PR #56 (run 31111682509): 8 of 12
// findings were exactly this double-count before the fix.

test('pathSuffixKey: normalizes differing scan-root prefixes to the same key', () => {
  assert.equal(
    pathSuffixKey('candidate-artifacts/generated-config/eas.json', 23),
    pathSuffixKey('generated-config/eas.json', 23),
  );
});

test('pathSuffixKey: a different line number never collides', () => {
  assert.notEqual(
    pathSuffixKey('generated-config/eas.json', 23),
    pathSuffixKey('generated-config/eas.json', 24),
  );
});

test('pathSuffixKey: missing path or line returns null, never a falsy-but-matchable string', () => {
  assert.equal(pathSuffixKey(null, 23), null);
  assert.equal(pathSuffixKey('generated-config/eas.json', null), null);
});

test('reconcileWithInternalAllowlist: downgrades a generic jwt/jwt-token BLOCK to ALLOW when the classifier already ALLOWed the same file+line', () => {
  const internal = [
    {
      detector: 'kscan-supabase-jwt-classifier',
      verdict: 'ALLOW',
      ruleId: 'STAGING_ANON_JWT',
      path: 'candidate-artifacts/generated-config/eas.json',
      line: 23,
    },
  ];
  const external = [
    { ruleId: 'jwt', verdict: 'BLOCK', detector: 'gitleaks', description: 'Uncovered a JSON Web Token', path: 'candidate-artifacts/generated-config/eas.json', line: 23 },
    { ruleId: 'jwt-token', verdict: 'BLOCK', detector: 'trivy', description: 'JWT token', path: 'generated-config/eas.json', line: 23 },
  ];
  const reconciled = reconcileWithInternalAllowlist(external, internal);
  assert.ok(reconciled.every((f) => f.verdict === 'ALLOW'));
  assert.ok(reconciled.every((f) => f.description.includes('reconciled')));
});

test('reconcileWithInternalAllowlist: leaves a generic jwt finding BLOCKED when no matching internal ALLOW exists at that file+line', () => {
  const internal = []; // classifier never ran, or found nothing at this location
  const external = [
    { ruleId: 'jwt', verdict: 'BLOCK', detector: 'gitleaks', description: 'Uncovered a JSON Web Token', path: 'some/other-file.js', line: 5 },
  ];
  const reconciled = reconcileWithInternalAllowlist(external, internal);
  assert.equal(reconciled[0].verdict, 'BLOCK');
});

test('reconcileWithInternalAllowlist: leaves a generic jwt finding BLOCKED when the classifier itself flagged that same location BLOCK (e.g. a real service-role leak)', () => {
  const internal = [
    {
      detector: 'kscan-supabase-jwt-classifier',
      verdict: 'BLOCK',
      ruleId: 'SUPABASE_SERVICE_ROLE_JWT',
      path: 'generated-config/eas.json',
      line: 50,
    },
  ];
  const external = [
    { ruleId: 'jwt', verdict: 'BLOCK', detector: 'gitleaks', description: 'Uncovered a JSON Web Token', path: 'candidate-artifacts/generated-config/eas.json', line: 50 },
  ];
  const reconciled = reconcileWithInternalAllowlist(external, internal);
  assert.equal(reconciled[0].verdict, 'BLOCK', 'a real leak must still block even if it happens to share a location with an unrelated classifier run');
});

test('reconcileWithInternalAllowlist: never touches a non-JWT external rule (e.g. a real Gitleaks AWS-key finding)', () => {
  const internal = [
    {
      detector: 'kscan-supabase-jwt-classifier',
      verdict: 'ALLOW',
      ruleId: 'STAGING_ANON_JWT',
      path: 'generated-config/eas.json',
      line: 23,
    },
  ];
  const external = [
    { ruleId: 'aws-access-key-id', verdict: 'BLOCK', detector: 'gitleaks', description: 'AWS key', path: 'generated-config/eas.json', line: 23 },
  ];
  const reconciled = reconcileWithInternalAllowlist(external, internal);
  assert.equal(reconciled[0].verdict, 'BLOCK');
});

test('end-to-end: the real PR #56 gitleaks+trivy fixture no longer blocks once merged with the internal scan of the actual eas.json', () => {
  withTempDir((dir) => {
    fs.mkdirSync(path.join(dir, 'candidate-artifacts', 'generated-config'), { recursive: true });
    const easJsonPath = path.join(__dirname, '..', '..', 'eas.json');
    const destPath = path.join(dir, 'candidate-artifacts', 'generated-config', 'eas.json');
    fs.copyFileSync(easJsonPath, destPath);

    const results = scan([path.join(dir, 'candidate-artifacts')]);
    const summary = summarize(results);
    const internalJwtFindings = summary.findings.filter((f) => f.detector === 'kscan-supabase-jwt-classifier');
    assert.ok(internalJwtFindings.length > 0, 'the real eas.json must contain at least one JWT for this test to be meaningful');

    // Simulate exactly what CI's Gitleaks/Trivy would report for those same lines.
    const externalGitleaksLike = internalJwtFindings.map((f) => ({
      ruleId: 'jwt',
      verdict: 'BLOCK',
      severity: 'P0',
      detector: 'gitleaks',
      description: 'Uncovered a JSON Web Token',
      path: `candidate-artifacts/generated-config/eas.json`,
      line: f.line,
    }));

    const reconciled = reconcileWithInternalAllowlist(externalGitleaksLike, summary.findings);
    const stillBlocked = reconciled.filter((f) => f.verdict === 'BLOCK');
    assert.deepEqual(stillBlocked, [], 'every generic gitleaks jwt finding matching an internal ALLOW must be reconciled');
  });
});

test('mergeGitleaksFindings / mergeTrivyFindings: still parse real report shapes (unaffected by the reconciliation change)', () => {
  withTempDir((dir) => {
    const gitleaksPath = path.join(dir, 'gitleaks.json');
    const trivyPath = path.join(dir, 'trivy.json');
    fs.writeFileSync(gitleaksPath, JSON.stringify([{ RuleID: 'jwt', Description: 'x', File: 'a.js', StartLine: 1 }]));
    fs.writeFileSync(trivyPath, JSON.stringify({ Results: [{ Target: 'a.js', Secrets: [{ RuleID: 'jwt-token', Title: 'x', StartLine: 1 }] }] }));

    const g = mergeGitleaksFindings(gitleaksPath);
    const t = mergeTrivyFindings(trivyPath);
    assert.equal(g.length, 1);
    assert.equal(g[0].verdict, 'BLOCK');
    assert.equal(t.length, 1);
    assert.equal(t[0].verdict, 'BLOCK');
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
