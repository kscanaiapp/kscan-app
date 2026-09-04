#!/usr/bin/env node
'use strict';

/**
 * VTO E2E harness — contract-mode unit/negative controls (spec Phase 4.2
 * `contract` mode). No live staging mutation anywhere in this file.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

async function loadStagingTarget() {
  return import('../scripts/vto-e2e/lib/staging-target.mjs');
}
async function loadIdempotency() {
  return import('../scripts/vto-e2e/lib/idempotency.mjs');
}
async function loadReport() {
  return import('../scripts/vto-e2e/lib/report.mjs');
}
async function loadActors() {
  return import('../scripts/vto-e2e/lib/actors.mjs');
}
async function loadPersistence() {
  return import('../scripts/vto-e2e/lib/persistence.mjs');
}
async function loadCleanup() {
  return import('../scripts/vto-e2e/lib/cleanup.mjs');
}
async function loadFullcert() {
  return import('../scripts/vto-e2e/lib/fullcert.mjs');
}

// ── 9.1 Staging hard guard ───────────────────────────────────────────────

test('staging hard guard: explicitly rejects the production project ref', async () => {
  const { assertVtoStagingTarget, PRODUCTION_PROJECT_REF, StagingGuardError } = await loadStagingTarget();
  assert.throws(
    () => assertVtoStagingTarget({
      SUPABASE_STAGING_PROJECT_REF: PRODUCTION_PROJECT_REF,
      SUPABASE_STAGING_URL: `https://${PRODUCTION_PROJECT_REF}.supabase.co`,
      SUPABASE_STAGING_PUBLISHABLE_KEY: 'not-a-real-key',
    }),
    StagingGuardError,
  );
});

test('staging hard guard: rejects a URL naming the production ref even if SUPABASE_STAGING_PROJECT_REF lies', async () => {
  const { assertVtoStagingTarget, STAGING_PROJECT_REF, PRODUCTION_PROJECT_REF, StagingGuardError } = await loadStagingTarget();
  assert.throws(
    () => assertVtoStagingTarget({
      SUPABASE_STAGING_PROJECT_REF: STAGING_PROJECT_REF,
      SUPABASE_STAGING_URL: `https://${PRODUCTION_PROJECT_REF}.supabase.co`,
      SUPABASE_STAGING_PUBLISHABLE_KEY: 'not-a-real-key',
    }),
    StagingGuardError,
  );
});

test('staging hard guard: rejects an unrecognized/unknown project ref', async () => {
  const { assertVtoStagingTarget, StagingGuardError } = await loadStagingTarget();
  assert.throws(
    () => assertVtoStagingTarget({
      SUPABASE_STAGING_PROJECT_REF: 'totallyunknownref00',
      SUPABASE_STAGING_URL: 'https://totallyunknownref00.supabase.co',
      SUPABASE_STAGING_PUBLISHABLE_KEY: 'not-a-real-key',
    }),
    StagingGuardError,
  );
});

test('staging hard guard: accepts only the exact governed staging target', async () => {
  const { assertVtoStagingTarget, STAGING_PROJECT_REF } = await loadStagingTarget();
  const result = assertVtoStagingTarget({
    SUPABASE_STAGING_PROJECT_REF: STAGING_PROJECT_REF,
    SUPABASE_STAGING_URL: `https://${STAGING_PROJECT_REF}.supabase.co`,
    SUPABASE_STAGING_PUBLISHABLE_KEY: 'not-a-real-key',
  });
  assert.equal(result.projectRef, STAGING_PROJECT_REF);
});

test('staging hard guard: a service-role key supplied where publishable is expected is refused', async () => {
  const { assertVtoStagingTarget, STAGING_PROJECT_REF, StagingGuardError } = await loadStagingTarget();
  // A JWT-shaped fixture carrying role=service_role — decodeJwtClaims inside
  // assertStagingTarget inspects this without any network call.
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ role: 'service_role', ref: STAGING_PROJECT_REF })).toString('base64url');
  const fakeServiceRoleJwt = `${header}.${payload}.fakesignature`;
  assert.throws(
    () => assertVtoStagingTarget({
      SUPABASE_STAGING_PROJECT_REF: STAGING_PROJECT_REF,
      SUPABASE_STAGING_URL: `https://${STAGING_PROJECT_REF}.supabase.co`,
      SUPABASE_STAGING_PUBLISHABLE_KEY: fakeServiceRoleJwt,
    }),
    StagingGuardError,
  );
});

// ── Idempotency key mirror stays byte-for-byte in agreement with the
//    server (supabase/functions/vto-generate/vtoReservation.ts) ─────────

test('idempotency key: deterministic for identical inputs', async () => {
  const { computeVtoIdempotencyKey } = await loadIdempotency();
  const input = { userId: 'u1', productRef: 'p1', garmentImageUrl: 'https://x/g.png', personDataUri: 'data:image/png;base64,AAAA', requestGeneration: 'gen-1' };
  assert.equal(computeVtoIdempotencyKey(input), computeVtoIdempotencyKey({ ...input }));
});

test('idempotency key: differs when requestGeneration differs (explicit Retry is a new intent)', async () => {
  const { computeVtoIdempotencyKey } = await loadIdempotency();
  const base = { userId: 'u1', productRef: 'p1', garmentImageUrl: 'https://x/g.png', personDataUri: 'data:image/png;base64,AAAA' };
  const keyA = await computeVtoIdempotencyKey({ ...base, requestGeneration: 'gen-1' });
  const keyB = await computeVtoIdempotencyKey({ ...base, requestGeneration: 'gen-2' });
  assert.notEqual(keyA, keyB);
});

test('idempotency key: an invalid requestGeneration falls back to the same "default" identity as an absent one', async () => {
  const { computeVtoIdempotencyKey } = await loadIdempotency();
  const base = { userId: 'u1', productRef: 'p1', garmentImageUrl: 'https://x/g.png', personDataUri: 'data:image/png;base64,AAAA' };
  const absent = computeVtoIdempotencyKey({ ...base });
  const invalid = computeVtoIdempotencyKey({ ...base, requestGeneration: 'has spaces!!' });
  assert.equal(absent, invalid);
});

test('idempotency key: is a 64-character lowercase hex sha256 digest', async () => {
  const { computeVtoIdempotencyKey } = await loadIdempotency();
  const key = computeVtoIdempotencyKey({ userId: 'u1', productRef: 'p1', garmentImageUrl: 'https://x/g.png', personDataUri: 'data:image/png;base64,AAAA', requestGeneration: 'gen-1' });
  assert.match(key, /^[0-9a-f]{64}$/);
});

// ── Report hygiene (spec §18): hashes/sizes/status only, never payloads ──

test('report sanitizer strips the result data URI down to size/type/hash-adjacent evidence only', async () => {
  const { sanitizeVtoResponse } = await loadReport();
  const fakeDataUri = `data:image/png;base64,${Buffer.from('not a real png but plausible bytes').toString('base64')}`;
  const response = {
    status: 200,
    json: {
      status: 'success',
      provider: 'ailabtools_tryon_clothes_pro',
      result: { dataUri: fakeDataUri, mediaType: 'image/png', width: 512, height: 768, isAiVisualization: true, latencyMs: 1234 },
    },
  };
  const evidence = sanitizeVtoResponse(response);
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes('data:image'), false);
  assert.equal(serialized.includes(fakeDataUri), false);
  assert.equal(evidence.result.hasNonEmptyMedia, true);
  assert.equal(evidence.provider, 'ailabtools_tryon_clothes_pro');
});

test('report hygiene guard rejects a report carrying a forbidden key (token/jwt/secret/taskId/dataUri) at any depth', async () => {
  const { assertReportSafe } = await loadReport();
  assert.throws(() => assertReportSafe({ ok: true, nested: { accessToken: 'sekrit' } }), /forbidden key/);
  assert.throws(() => assertReportSafe({ providerTaskId: 'abc123' }), /forbidden key/);
  assert.throws(() => assertReportSafe({ result: { dataUri: 'data:image/png;base64,AAA' } }), /forbidden key/);
  // A clean report must not throw.
  assert.doesNotThrow(() => assertReportSafe({ ok: true, httpStatus: 200, byteLength: 512 }));
});

// ── Actor plan: unique ids between categories, no cross-role collision ──

test('actor plan builds three distinct roles with distinct emails and passwords', async () => {
  const { buildActorPlan, ACTOR_ROLES } = await loadActors();
  const plan = buildActorPlan('contract-actor-check');
  assert.deepEqual(Object.keys(plan).sort(), [...ACTOR_ROLES].sort());
  const emails = Object.values(plan).map((a) => a.email);
  assert.equal(new Set(emails).size, emails.length);
  const passwords = Object.values(plan).map((a) => a.password);
  assert.equal(new Set(passwords).size, passwords.length);
});

test('actor plan is stable for a given run tag (so cleanup mode can re-derive it) but distinct across run tags', async () => {
  const { buildActorPlan } = await loadActors();
  const planA1 = buildActorPlan('same-tag');
  const planA2 = buildActorPlan('same-tag');
  assert.deepEqual(Object.values(planA1).map((a) => a.email), Object.values(planA2).map((a) => a.email));
  const planB = buildActorPlan('different-tag');
  assert.notDeepEqual(Object.values(planA1).map((a) => a.email), Object.values(planB).map((a) => a.email));
});

// ── committedGarmentUrl: only an exact commit SHA is accepted ────────────

test('committedGarmentUrl refuses a branch name or short SHA — only an exact 40-hex commit', async () => {
  const { committedGarmentUrl } = await loadFullcert();
  assert.throws(() => committedGarmentUrl('main'));
  assert.throws(() => committedGarmentUrl('4af92f4'));
  assert.throws(() => committedGarmentUrl(''));
  assert.doesNotThrow(() => committedGarmentUrl('4af92f4c6fe9ecb4c5b1221c26e8dc465971d61d'));
});

test('committedGarmentUrl points at raw.githubusercontent.com under this exact repo', async () => {
  const { committedGarmentUrl } = await loadFullcert();
  const url = committedGarmentUrl('4af92f4c6fe9ecb4c5b1221c26e8dc465971d61d');
  assert.equal(url, 'https://raw.githubusercontent.com/kscanaiapp/kscan-app/4af92f4c6fe9ecb4c5b1221c26e8dc465971d61d/scripts/vto-e2e/fixtures/garment.png');
});

// ── Mock-provider guard (spec §11): source-level only, staging untouched ─

// ── Persistence diff (spec §13): only a genuine increase counts as a write ─

test('diffPersistence: no change anywhere reports NO for closet/dressing-room/saved-scan', async () => {
  const { diffPersistence } = await loadPersistence();
  const before = { closet: 2, dressingRoom: 1, savedScan: 5 };
  const after = { closet: 2, dressingRoom: 1, savedScan: 5 };
  assert.deepEqual(diffPersistence(before, after), {
    autoClosetWrite: 'NO', autoDressingRoomWrite: 'NO', autoSavedScanWrite: 'NO',
  });
});

test('diffPersistence: an increase in any table reports YES for that table only', async () => {
  const { diffPersistence } = await loadPersistence();
  const before = { closet: 0, dressingRoom: 0, savedScan: 0 };
  const after = { closet: 1, dressingRoom: 0, savedScan: 0 };
  assert.deepEqual(diffPersistence(before, after), {
    autoClosetWrite: 'YES', autoDressingRoomWrite: 'NO', autoSavedScanWrite: 'NO',
  });
});

test('diffPersistence: a DECREASE is not reported as a write (never flips YES on removal)', async () => {
  const { diffPersistence } = await loadPersistence();
  const before = { closet: 3, dressingRoom: 0, savedScan: 0 };
  const after = { closet: 1, dressingRoom: 0, savedScan: 0 };
  assert.equal(diffPersistence(before, after).autoClosetWrite, 'NO');
});

// ── Cleanup evidence (spec §14): clean only when every actor has zero residual rows ─

test('allActorsClean: true only when every actor in the evidence has residual === 0', async () => {
  const { allActorsClean } = await loadCleanup();
  assert.equal(allActorsClean({
    ACTIVE_KPLUS: { residual: 0, clean: true },
    NEVER_ENTITLED: { residual: 0, clean: true },
  }), true);
  assert.equal(allActorsClean({
    ACTIVE_KPLUS: { residual: 0, clean: true },
    NEVER_ENTITLED: { residual: 1, clean: false },
  }), false);
  // An empty evidence object (no actors ever provisioned) is vacuously clean.
  assert.equal(allActorsClean({}), true);
});

test('mock-provider guard: provider=mock with VTO_ALLOW_MOCK_PROVIDER absent resolves to provider_unavailable (source-level, no staging mutation)', () => {
  // resolveVtoProvider lives in Deno TS (supabase/functions/vto-generate/
  // providers/index.ts) and is already covered by that module's own Deno
  // test suite (providers/index.test.ts equivalents under vtoGuards.test.ts /
  // vtoPaidBoundary.test.ts). This harness asserts the SOURCE TEXT invariant
  // holds — the guard clause exists and is unconditional — as a contract-mode
  // pin, without re-implementing a Deno runtime here and without ever
  // setting VTO_ALLOW_MOCK_PROVIDER on staging.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'functions', 'vto-generate', 'providers', 'index.ts'),
    'utf8',
  );
  assert.match(src, /VTO_ALLOW_MOCK_PROVIDER.*!==\s*'true'/s);
  assert.match(src, /reason:\s*'provider_unavailable'/);
});
