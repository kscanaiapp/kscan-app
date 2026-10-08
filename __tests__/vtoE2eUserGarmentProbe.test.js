#!/usr/bin/env node
'use strict';

/**
 * VTO E2E harness -- the `user_supplied_garment` staging probe.
 *
 * No live staging access anywhere in this file. The probe is driven against a
 * faithful in-process model of vto-generate's decision order and of the
 * canonical K+ authority, then against deliberately broken versions of both,
 * so every control is shown to PASS on a correct backend and to FAIL on the
 * defect it exists to catch.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const loadGarment = () => import('../scripts/vto-e2e/lib/userGarment.mjs');
const loadActor = () => import('../scripts/vto-e2e/lib/userGarmentActor.mjs');
const loadProbe = () => import('../scripts/vto-e2e/lib/userGarmentProbe.mjs');
const loadAudit = () => import('../scripts/vto-e2e/lib/logAudit.mjs');
const loadRun = () => import('../scripts/vto-e2e/run.mjs');
const loadIdempotency = () => import('../scripts/vto-e2e/lib/idempotency.mjs');
const loadSchema = () => import('../scripts/vto-e2e/lib/report-schema.mjs');
const loadValidate = () => import('../scripts/vto-e2e/validate-report.mjs');
const loadGuard = () => import('../scripts/vto-e2e/lib/workflow-guard.mjs');
const loadReport = () => import('../scripts/vto-e2e/lib/report.mjs');

const STAGING = 'https://yzqjvdfgefveprobvvyw.supabase.co';
const PRODUCTION = 'https://wyyuqfdxucjksghsmhry.supabase.co';
const RUN_TAG = 'vto-ug-dryrun-20261007T000000Z-abcd1234';
const USER_ID = '11111111-2222-4333-8444-555555555555';
const REAL_PROVIDER = 'ailabtools_tryon_clothes_pro';

const NEW_LIB_FILES = [
  'scripts/vto-e2e/lib/userGarment.mjs',
  'scripts/vto-e2e/lib/userGarmentActor.mjs',
  'scripts/vto-e2e/lib/userGarmentProbe.mjs',
  'scripts/vto-e2e/lib/logAudit.mjs',
];

// ── A faithful model of the deployed backend ─────────────────────────────
//
// vto-generate's decision ORDER is the thing the probe's zero-spend argument
// rests on, so the model reproduces that order exactly (vtoHandler.ts), with
// the garment checks of vtoUserSuppliedGarment.ts. `defects` switches on one
// specific wrong behaviour at a time.

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function modelResolveGarment(garment, defects) {
  const source = garment?.source;
  if (!source || source.type !== 'user_supplied_garment') return 'garment_source_shape';
  if (source.contentHashVersion !== 'sha256-normalized-v1') return 'garment_hash_version';
  if (typeof source.contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(source.contentHash)) return 'garment_hash_shape';
  const dataUri = garment.dataUri;
  if (typeof dataUri !== 'string' || !dataUri) return 'garment_media_missing';
  if (!defects.noEncodedCeiling && dataUri.length > 3_000_000) return 'garment_media_too_large';
  const prefix = 'data:image/jpeg;base64,';
  if (!dataUri.startsWith(prefix)) return 'garment_media_type';
  const base64 = dataUri.slice(prefix.length);
  if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return 'garment_media_encoding';
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length < 1024) return 'garment_media_too_small';
  if (bytes.length > 2_250_000) return 'garment_media_too_large';
  if (!defects.noJpegCheck && (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff)) return 'garment_media_not_jpeg';
  if (bytes.toString('base64') !== base64) return 'garment_media_noncanonical';
  if (!defects.trustsHash && sha256Hex(base64) !== source.contentHash) return 'garment_hash_mismatch';
  return null;
}

function modelCanonicalCategory(value) {
  const lower = String(value ?? '').toLowerCase();
  if (/\b(shirts?|blouses?|tops?)\b/.test(lower)) return 'top';
  if (/\b(sneakers?|shoes?)\b/.test(lower)) return 'footwear';
  return lower;
}

async function createBackend(defects = {}, options = {}) {
  const { computeVtoIdempotencyKey } = await loadIdempotency();
  const state = {
    kplusActive: false,
    grants: new Map(), // grantId -> { revoked }
    reservations: new Map(), // idempotencyKey -> status
    userExists: true,
    mirrorRows: 0,
    providerDispatches: 0,
    httpRequests: 0,
    sql: [],
    bodies: [],
    featureControl: options.featureControl ?? {
      schemaVersion: 1, enabled: true, provider: REAL_PROVIDER, supportedCategories: ['top', 'outerwear', 'blazer', 'dress'],
    },
  };
  const inlineCeiling = defects.inlineCeiling ?? 5_008_192;
  const legacyCeiling = 2_008_192;

  const failed = (status, code, requestId) => ({
    status, headers: {}, json: { requestId, status: 'failed', error: { code, retryable: false } }, textLength: 0,
  });

  function respond(raw) {
    state.httpRequests += 1;
    if (!defects.noBodyCeiling && raw.length > inlineCeiling) return failed(422, 'invalid_person_input', 'unlabelled');
    let body = {};
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed;
    } catch { body = {}; }
    state.bodies.push(body);
    const namesInline = body.garment?.source?.type === 'user_supplied_garment';
    if (!namesInline && raw.length > legacyCeiling) return failed(422, 'invalid_person_input', 'unlabelled');
    const requestId = typeof body.requestId === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(body.requestId.trim())
      ? body.requestId.trim() : 'unlabelled';

    if (!state.featureControl.enabled) return failed(403, 'feature_disabled', requestId);
    if (!defects.noKPlus && !state.kplusActive) return failed(403, 'entitlement_required', requestId);

    let contentHash = null;
    if (namesInline) {
      if (defects.originGate && body.origin !== 'elise') return failed(422, 'invalid_garment_input', requestId);
      if (modelResolveGarment(body.garment, defects)) return failed(422, 'invalid_garment_input', requestId);
      contentHash = body.garment.source.contentHash;
    } else if (typeof body.garment?.imageUrl !== 'string' || !body.garment.imageUrl.startsWith('https://')) {
      return failed(422, 'invalid_garment_input', requestId);
    }

    const canonical = modelCanonicalCategory(body.garment?.category);
    if (!defects.noCategoryCheck && !state.featureControl.supportedCategories.includes(canonical)) {
      return failed(422, 'unsupported_category', requestId);
    }

    const personDataUri = typeof body.person?.dataUri === 'string' ? body.person.dataUri : '';
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(personDataUri) || personDataUri.length > 2_000_000) {
      return failed(422, 'invalid_person_input', requestId);
    }
    if (options.lateFailure === 'entitlement_required') return failed(403, 'entitlement_required', requestId);

    const key = computeVtoIdempotencyKey({
      userId: USER_ID,
      productRef: `user_supplied_garment:${contentHash}`,
      garmentImageUrl: `user_supplied_garment/sha256-normalized-v1/${contentHash}`,
      personDataUri,
      requestGeneration: body.requestGeneration,
    });
    state.reservations.set(key, 'in_flight');
    state.providerDispatches += 1;
    if (options.providerOutcome === 'failure') {
      state.reservations.set(key, 'failed');
      return failed(502, 'generation_failed', requestId);
    }
    state.reservations.set(key, 'succeeded');
    return {
      status: 200,
      headers: {},
      textLength: 0,
      json: {
        requestId,
        status: 'success',
        garmentSource: {
          type: 'user_supplied_garment',
          contentHash: defects.echoesWrongHash ? '0'.repeat(64) : contentHash,
          contentHashVersion: 'sha256-normalized-v1',
        },
        provider: state.featureControl.provider,
        result: {
          dataUri: `data:image/jpeg;base64,${Buffer.from('synthetic-result').toString('base64')}`,
          mediaType: 'image/jpeg',
          width: 768,
          height: 1024,
          isAiVisualization: true,
          latencyMs: 9000,
        },
      },
    };
  }

  const post = async ({ body }) => respond(JSON.stringify(body));
  const postRaw = async ({ rawBody }) => respond(rawBody);

  const runSql = async (sql) => {
    state.sql.push(sql);
    if (sql.includes('to_regprocedure')) return [{ grant_fn: !defects.authorityAbsent, revoke_fn: true, predicate_fn: true }];
    if (sql.includes('grant_kplus_complimentary(')) {
      if (options.grantRejected) return [{ result: { outcome: 'rejected', reason: 'account_not_active' } }];
      const grantId = crypto.randomUUID();
      state.grants.set(grantId, { revoked: false });
      state.kplusActive = true;
      // The CLI hands a jsonb column back as text on one of its paths.
      return [{ result: JSON.stringify({ outcome: 'granted', grantId, accessBefore: false, accessAfter: true }) }];
    }
    if (sql.includes('revoke_kplus_grant(')) {
      const grantId = /'([0-9a-f-]{36})'::uuid\) as result/.exec(sql)?.[1];
      const grant = state.grants.get(grantId);
      if (!grant) return [{ result: { outcome: 'rejected', reason: 'grant_not_found' } }];
      if (grant.revoked) return [{ result: { outcome: 'already_revoked', grantId } }];
      grant.revoked = true;
      state.mirrorRows += 1;
      if (!defects.revokeDoesNothing) state.kplusActive = false;
      return [{ result: { outcome: 'revoked', grantId, accessBefore: true, accessAfter: defects.revokeDoesNothing === true } }];
    }
    if (sql.includes('kplus_has_active_entitlement(')) return [{ active: state.kplusActive }];
    if (sql.includes('select id from public.kplus_entitlement_grants')) {
      return [...state.grants].filter(([, g]) => !g.revoked).map(([id]) => ({ id }));
    }
    if (sql.includes('from public.app_config')) return [{ value: state.featureControl }];
    if (sql.includes("to_regclass('public.kplus_revenuecat_mirror_queue')")) return [{ present: true }];
    if (sql.includes('from public.kplus_revenuecat_mirror_queue')) return [{ n: state.mirrorRows }];
    if (sql.startsWith('delete from public.vto_generation_requests')) {
      if (defects.cleanupLeavesReservations) return [];
      state.reservations.clear();
      return [];
    }
    if (sql.startsWith('delete from auth.users')) {
      // The schema's ON DELETE CASCADE, modelled.
      state.userExists = false;
      state.grants.clear();
      state.mirrorRows = 0;
      state.kplusActive = false;
      return [];
    }
    if (sql.includes('as auth_users')) {
      return [{
        auth_users: state.userExists ? 1 : 0,
        vto_generation_requests: state.reservations.size,
        kplus_grants: state.grants.size,
        kplus_grants_unrevoked: [...state.grants.values()].filter((g) => !g.revoked).length,
        user_entitlements: 0,
      }];
    }
    if (sql.includes('select status from public.vto_generation_requests')) {
      const key = /idempotency_key = '([0-9a-f]{64})'/.exec(sql)?.[1];
      return state.reservations.has(key) ? [{ status: state.reservations.get(key) }] : [];
    }
    if (sql.includes('count(*) as n from public.vto_generation_requests')) return [{ n: state.reservations.size }];
    throw new Error(`model backend: unrecognised SQL: ${sql.slice(0, 80)}`);
  };

  return { state, post, postRaw, runSql };
}

async function dryRunAgainst(defects = {}, options = {}) {
  const { runUserGarmentDryRun } = await loadProbe();
  const { userGarmentGrantKey } = await loadActor();
  const backend = await createBackend(defects, options);
  const result = await runUserGarmentDryRun({
    base: STAGING, publishableKey: 'publishable', accessToken: 'model-session', userId: USER_ID,
    runSql: backend.runSql, runTag: RUN_TAG, grantKey: userGarmentGrantKey(RUN_TAG),
    post: backend.post, postRaw: backend.postRaw,
  });
  return { ...backend, result };
}

async function certifyAgainst(defects = {}, options = {}, overrides = {}) {
  const { runUserGarmentCertification } = await loadProbe();
  const { userGarmentGrantKey } = await loadActor();
  const backend = await createBackend(defects, options);
  let posts = 0;
  const post = overrides.post ?? backend.post;
  const result = await runUserGarmentCertification({
    base: STAGING, publishableKey: 'publishable', accessToken: 'model-session', userId: USER_ID,
    runSql: backend.runSql, runTag: 'vto-ug-cert-20261007T000000Z-abcd1234',
    grantKey: userGarmentGrantKey('vto-ug-cert-20261007T000000Z-abcd1234'),
    post: async (args) => { posts += 1; return post(args); },
  });
  return { ...backend, result, posts: () => posts };
}

const failedNames = (results) => results.filter((entry) => !entry.ok).map((entry) => entry.name);

// ── Request material ──────────────────────────────────────────────────────

test('contract parity: every bound the probe mirrors equals the server contract', async () => {
  const garment = await loadGarment();
  const contract = read('supabase/functions/vto-generate/vtoContract.ts');
  const numeric = (name) => {
    const match = new RegExp(`export const ${name} = ([0-9_]+);`).exec(contract);
    assert.ok(match, `vtoContract.ts must declare ${name} as a literal`);
    return Number(match[1].replace(/_/g, ''));
  };
  assert.equal(garment.GARMENT_PAYLOAD_MAX_CHARS, numeric('VTO_GARMENT_PAYLOAD_MAX_CHARS'));
  assert.equal(garment.INLINE_GARMENT_MIN_BYTES, numeric('VTO_INLINE_GARMENT_MIN_BYTES'));
  assert.equal(garment.INLINE_GARMENT_MAX_BYTES, numeric('VTO_INLINE_GARMENT_MAX_BYTES'));
  assert.equal(garment.PERSON_PAYLOAD_MAX_CHARS, numeric('VTO_PERSON_PAYLOAD_MAX_CHARS'));
  assert.equal(garment.REQUEST_ENVELOPE_MAX_CHARS, numeric('VTO_REQUEST_ENVELOPE_MAX_CHARS'));
  // The two ceilings are sums on the server; the mirror must be the same sums.
  assert.match(contract, /export const VTO_REQUEST_BODY_MAX_CHARS =\s*VTO_PERSON_PAYLOAD_MAX_CHARS \+ VTO_REQUEST_ENVELOPE_MAX_CHARS;/);
  assert.match(contract, /export const VTO_INLINE_GARMENT_REQUEST_BODY_MAX_CHARS =\s*VTO_REQUEST_BODY_MAX_CHARS \+ VTO_GARMENT_PAYLOAD_MAX_CHARS;/);
  assert.equal(garment.LEGACY_BODY_MAX_CHARS, 2_008_192);
  assert.equal(garment.INLINE_BODY_MAX_CHARS, 5_008_192);
  assert.match(contract, new RegExp(`VTO_USER_SUPPLIED_GARMENT_SOURCE_TYPE = '${garment.USER_GARMENT_SOURCE_TYPE}'`));
  assert.match(contract, new RegExp(`VTO_GARMENT_CONTENT_HASH_VERSION = '${garment.USER_GARMENT_HASH_VERSION}'`));
  assert.match(contract, /VTO_INLINE_GARMENT_MEDIA_TYPES = \['image\/jpeg'\]/);
  assert.equal(garment.USER_GARMENT_MEDIA_PREFIX, 'data:image/jpeg;base64,');
});

test('the reservation identity the probe looks up is the one the server derives', async () => {
  const { userGarmentReservationIdentity } = await loadGarment();
  const resolver = read('supabase/functions/vto-generate/vtoUserSuppliedGarment.ts');
  assert.match(resolver, /productRef: `\$\{VTO_USER_SUPPLIED_GARMENT_SOURCE_TYPE\}:\$\{contentHash\}`/);
  assert.match(resolver, /`\$\{VTO_USER_SUPPLIED_GARMENT_SOURCE_TYPE\}\/\$\{VTO_GARMENT_CONTENT_HASH_VERSION\}\/\$\{contentHash\}`/);
  const handler = read('supabase/functions/vto-generate/vtoHandler.ts');
  assert.match(handler, /suppliedGarment\?\.mediaIdentity \?\? ownedGarment\?\.mediaIdentity \?\? eligibility\.garmentImageUrl/);
  const hash = 'ab'.repeat(32);
  assert.deepEqual(userGarmentReservationIdentity(hash), {
    productRef: `user_supplied_garment:${hash}`,
    garmentImageUrl: `user_supplied_garment/sha256-normalized-v1/${hash}`,
  });
});

test('the committed garment is a real JPEG, synthetic, metadata-free, and exactly the file its record describes', async () => {
  const { loadCommittedUserGarment } = await loadGarment();
  const garment = loadCommittedUserGarment();
  const bytes = fs.readFileSync(path.join(ROOT, 'scripts/vto-e2e/fixtures/user-garment.jpg'));
  const record = JSON.parse(read('scripts/vto-e2e/fixtures/user-garment.fixture.json'));
  assert.equal(garment.committed, true);
  assert.deepEqual([bytes[0], bytes[1], bytes[2]], [0xff, 0xd8, 0xff]);
  assert.deepEqual([bytes[bytes.length - 2], bytes[bytes.length - 1]], [0xff, 0xd9], 'a complete JPEG ends with end-of-image');
  assert.equal(bytes.includes(Buffer.from('Exif')), false, 'no EXIF segment');
  assert.equal(bytes.includes(Buffer.from('http://ns.adobe.com/xap')), false, 'no XMP segment');
  assert.equal(garment.contentHash, record.contentHash);
  // The fingerprint is over the canonical Base64 TEXT, exactly as the server recomputes it.
  assert.equal(garment.contentHash, sha256Hex(bytes.toString('base64')));
  assert.match(record.description, /Synthetic/);
  assert.match(record.description, /No person/);
  // A realistic normalized upload: hundreds of KB, well inside the bound.
  assert.ok(garment.byteLength > 200_000 && garment.byteLength < 1_000_000, `byteLength=${garment.byteLength}`);
  assert.equal(modelResolveGarment(garment, {}), null, 'the faithful resolver model accepts it');
});

test('a swapped or truncated fixture is refused rather than sent', async () => {
  const { loadCommittedUserGarment } = await loadGarment();
  const real = fs.readFileSync(path.join(ROOT, 'scripts/vto-e2e/fixtures/user-garment.jpg'));
  const tampered = Buffer.from(real);
  tampered[tampered.length - 100] ^= 0xff;
  const fsWith = (image) => ({
    readFileSync: (file, encoding) => (String(file).endsWith('.json') ? fs.readFileSync(file, encoding) : image),
  });
  assert.throws(() => loadCommittedUserGarment(fsWith(tampered)), /does not match its record/);
  assert.throws(() => loadCommittedUserGarment(fsWith(real.subarray(0, real.length - 10))), /does not match its record/);
});

test('size builders land exactly where the contract boundary is', async () => {
  const garment = await loadGarment();
  const largest = garment.userGarmentFromBytes(garment.jpegShapedBytes(garment.LARGEST_ENCODABLE_GARMENT_BYTES, 'x'));
  assert.ok(largest.dataUri.length <= garment.GARMENT_PAYLOAD_MAX_CHARS);
  assert.ok(largest.byteLength <= garment.INLINE_GARMENT_MAX_BYTES);
  const over = garment.userGarmentFromBytes(garment.jpegShapedBytes(garment.LARGEST_ENCODABLE_GARMENT_BYTES + 3, 'x'));
  assert.ok(over.dataUri.length > garment.GARMENT_PAYLOAD_MAX_CHARS);
  assert.equal(modelResolveGarment(largest, {}), null);
  assert.equal(modelResolveGarment(over, {}), 'garment_media_too_large');

  const person = garment.personShapedDataUri(garment.PERSON_PAYLOAD_MAX_CHARS - 1, 'x');
  assert.equal(person.length, garment.PERSON_PAYLOAD_MAX_CHARS - 1);
  assert.match(person.slice(0, 40), /^data:image\/jpeg;base64,[A-Za-z0-9+/]+$/);
  assert.throws(() => garment.personShapedDataUri(garment.PERSON_PAYLOAD_MAX_CHARS, 'x'), /multiple of 4/);

  const body = { requestId: 'r', origin: 'elise', garment: { category: 'sneakers' } };
  for (const target of [500, 4096, 100_000]) {
    assert.equal(JSON.stringify(garment.padBodyToChars(body, target)).length, target);
  }
  assert.throws(() => garment.padBodyToChars(body, 10), /over the 10 target/);
  // Deterministic: the same seed is the same bytes.
  assert.ok(garment.jpegShapedBytes(4096, 'seed').equals(garment.jpegShapedBytes(4096, 'seed')));
  assert.equal(garment.jpegShapedBytes(4096, 'seed').equals(garment.jpegShapedBytes(4096, 'other')), false);
});

test('the request body carries only the fields the source defines: no URL, no product reference, no device-local id', async () => {
  const { buildUserGarmentBody, loadCommittedUserGarment } = await loadGarment();
  const garment = loadCommittedUserGarment();
  const body = buildUserGarmentBody({
    requestId: 'r', origin: 'elise', garment, category: 'top', personDataUri: 'data:image/png;base64,AAAA', requestGeneration: 'g',
  });
  assert.deepEqual(Object.keys(body.garment).sort(), ['category', 'dataUri', 'source']);
  assert.deepEqual(Object.keys(body.garment.source).sort(), ['contentHash', 'contentHashVersion', 'type']);
  const noPerson = buildUserGarmentBody({ requestId: 'r', origin: 'elise', garment, category: 'top', requestGeneration: 'g' });
  assert.equal('person' in noPerson, false);
});

// ── The zero-spend dry run ────────────────────────────────────────────────

test('dry run: every control PASSES against a faithful backend, with zero provider dispatches and zero reservations', async () => {
  const { DRY_RUN_CONTROL_COUNT, DRY_RUN_GRANTED_CONTROL_NAMES } = await loadProbe();
  const { state, result } = await dryRunAgainst();
  assert.deepEqual(failedNames(result.results), []);
  assert.equal(result.results.length, DRY_RUN_CONTROL_COUNT);
  assert.equal(DRY_RUN_CONTROL_COUNT, 20);
  for (const name of DRY_RUN_GRANTED_CONTROL_NAMES) {
    assert.equal(result.results.filter((entry) => entry.name === name).length, 1, `exactly one control named: ${name}`);
  }
  assert.equal(new Set(result.results.map((entry) => entry.name)).size, result.results.length, 'control names are unique');
  assert.equal(state.providerDispatches, 0);
  assert.equal(state.reservations.size, 0);
  assert.equal(result.realProviderSubmits, 0);
  assert.equal(result.paidGenerations, 0);
  assert.equal(result.grantRevoked, true);
  assert.equal(result.sizeEvidence.nearCeilingRuntimeProof, 'PASS');
  assert.equal(result.sizeEvidence.ceiling.bodyChars, 5_008_192, 'the ceiling control sends a body of EXACTLY the contract ceiling');
  assert.equal(result.sizeEvidence.ceiling.garmentChars, 2_999_999);
  assert.ok(result.sizeEvidence.largeBodyChars > 3_000_000);
});

test('dry run: is deterministic -- the same backend yields the identical verdicts', async () => {
  const first = (await dryRunAgainst()).result.results.map((entry) => [entry.name, entry.ok]);
  const second = (await dryRunAgainst()).result.results.map((entry) => [entry.name, entry.ok]);
  assert.deepEqual(first, second);
});

test('dry run: no request it sends could reach the provider, even on a backend that checks nothing', async () => {
  // Every gate that normally refuses these requests is switched off. If any
  // dry-run body were dispatchable, this backend would dispatch it.
  const { state } = await dryRunAgainst({
    noKPlus: true, trustsHash: true, noJpegCheck: true, noEncodedCeiling: true, noBodyCeiling: true,
  });
  assert.equal(state.providerDispatches, 0);
  assert.equal(state.reservations.size, 0);
  assert.ok(state.bodies.length >= 18, 'sanity: the run really sent its requests');
  for (const body of state.bodies) {
    const refusedByCategory = body.garment?.category === 'sneakers';
    const refusedByPerson = !('person' in body);
    assert.ok(refusedByCategory || refusedByPerson, `dispatchable dry-run body: ${JSON.stringify(Object.keys(body))}`);
  }
});

test('dry run: the zero-spend guard refuses a dispatchable body, and nothing reaches `post` except through it', async () => {
  const { assertCannotReachProvider } = await loadProbe();
  const dispatchable = { garment: { category: 'top' }, person: { dataUri: 'data:image/png;base64,AAAA' } };
  assert.throws(() => assertCannotReachProvider(dispatchable), /zero-spend guard/);
  assert.doesNotThrow(() => assertCannotReachProvider({ garment: { category: 'sneakers' }, person: { dataUri: 'x' } }));
  assert.doesNotThrow(() => assertCannotReachProvider({ garment: { category: 'top' } }));

  const source = read('scripts/vto-e2e/lib/userGarmentProbe.mjs');
  const dryRun = source.slice(source.indexOf('export async function runUserGarmentDryRun'), source.indexOf('export const DRY_RUN_GRANTED_CONTROL_NAMES'));
  assert.equal((dryRun.match(/\bpost\(/g) ?? []).length, 1, 'the dry run calls `post` in exactly one place');
  assert.match(dryRun, /const send = \(body\) => \{\s*assertCannotReachProvider\(body\);\s*return post\(/);
});

const DEFECTS = [
  ['a backend that does not enforce K+', { noKPlus: true }, ['no K+ grant -> entitlement_required before any garment work', 'revoked K+ -> entitlement_required']],
  ['a backend that believes the supplied hash', { trustsHash: true }, ['content hash that does not match the bytes -> invalid_garment_input']],
  ['a backend that does not check the JPEG signature', { noJpegCheck: true }, ['payload labelled JPEG that is not one -> invalid_garment_input']],
  ['a backend with no encoded-size ceiling', { noEncodedCeiling: true }, ['garment over the encoded-size ceiling -> invalid_garment_input']],
  ['a backend that authorizes on origin', { originGate: true }, ['origin is bounded metadata: every origin label gets the identical outcome']],
  ['a backend with no body ceiling', { noBodyCeiling: true }, ['request body one character over the inline ceiling is refused before it is read']],
  ['a backend whose ceiling is below the contract', { inlineCeiling: 4_000_000 }, ['request body EXACTLY at the inline ceiling is accepted at the contract boundary']],
  ['a revocation that does not take effect', { revokeDoesNothing: true }, [
    'K+ revoked through the canonical authority (revoke_kplus_grant); the server predicate reads inactive',
    'revoked K+ -> entitlement_required',
  ]],
];

for (const [label, defects, expected] of DEFECTS) {
  test(`dry run MUTATION: ${label} -> exactly the controls that own that defect FAIL`, async () => {
    const { result } = await dryRunAgainst(defects);
    assert.deepEqual(failedNames(result.results).sort(), [...expected].sort());
  });
}

test('dry run MUTATION: a ceiling defect is reported as NEAR_CEILING_RUNTIME_PROOF=FAIL, not folded into a pass', async () => {
  assert.equal((await dryRunAgainst({ inlineCeiling: 4_000_000 })).result.sizeEvidence.nearCeilingRuntimeProof, 'FAIL');
  assert.equal((await dryRunAgainst({ noBodyCeiling: true })).result.sizeEvidence.nearCeilingRuntimeProof, 'FAIL');
});

test('dry run: when the grant is refused, every dependent control is reported failed under its own name -- none is silently skipped', async () => {
  const { DRY_RUN_CONTROL_COUNT, DRY_RUN_GRANTED_CONTROL_NAMES } = await loadProbe();
  const { state, result } = await dryRunAgainst({}, { grantRejected: true });
  assert.equal(result.results.length, DRY_RUN_CONTROL_COUNT);
  for (const name of DRY_RUN_GRANTED_CONTROL_NAMES) {
    assert.equal(result.results.find((entry) => entry.name === name)?.ok, false);
  }
  assert.equal(state.providerDispatches, 0);
});

// ── The one paid request ──────────────────────────────────────────────────

test('certification: a faithful backend yields PASS with exactly one request, one dispatch and a settled reservation', async () => {
  const { MAX_REAL_VTO_PROVIDER_DISPATCHES } = await loadProbe();
  assert.equal(MAX_REAL_VTO_PROVIDER_DISPATCHES, 1);
  const { state, result, posts } = await certifyAgainst();
  assert.deepEqual(failedNames(result.results), []);
  assert.equal(result.finalResultValidation, 'PASS');
  assert.equal(posts(), 1);
  assert.equal(result.requestsSent, 1);
  assert.equal(result.budgetUsed, 1);
  assert.equal(result.paidRetryAttempted, false);
  assert.equal(state.providerDispatches, 1);
  assert.equal(result.reservationSettlement, 'succeeded');
  assert.equal(result.dispatchClassification, 'dispatched');
  assert.deepEqual(result.proof, {
    AUTHENTICATED_ACTOR: 'PASS',
    CANONICAL_KPLUS: 'PASS',
    VTO_FEATURE_CONTROL: 'PASS',
    USER_SUPPLIED_GARMENT_SOURCE: 'PASS',
    GARMENT_PAYLOAD_ACCEPTED: 'PASS',
    SERVER_CATEGORY_CANONICALIZATION: 'PASS',
    HASH_CORRELATION: 'PASS',
    QUOTA_RESERVATION: 'PASS',
    PROVIDER_DISPATCH: 1,
    PROVIDER_RESULT_NONEMPTY: 'PASS',
    RESULT_CONTRACT_VALID: 'PASS',
    NO_RAW_IMAGE_LOGGING: 'PENDING_LOG_AUDIT',
  });
  // What was sent is what the app sends: origin elise, the committed garment.
  const sent = state.bodies[0];
  assert.equal(sent.origin, 'elise');
  assert.equal(sent.garment.category, 'top');
  assert.equal(sent.garment.source.contentHash, result.garmentEvidence.contentHash);
  assert.equal(result.garmentEvidence.committedFixture, true);
  assert.ok(sent.requestId.startsWith('vto-ug-cert-20261007T000000Z-abcd1234'));
});

test('certification: the grant is requested through the canonical authority, time-boxed, and nothing else writes K+', async () => {
  const { state } = await certifyAgainst();
  const grants = state.sql.filter((sql) => sql.includes('grant_kplus_complimentary('));
  assert.equal(grants.length, 1);
  assert.match(grants[0], /^select public\.grant_kplus_complimentary\('[0-9a-f-]{36}'::uuid, 'promotional', 'vto-user-garment:[A-Za-z0-9_.:-]+', 'build35-elise-contextual-vto', null, now\(\) \+ interval '30 minutes', 'k_plus'\) as result;$/);
  for (const sql of state.sql) {
    assert.doesNotMatch(sql, /\b(insert\s+into|update|delete\s+from)\b[^;]*\b(user_entitlements|kplus_entitlement_|kplus_revenuecat_)/i, sql);
  }
});

const NOT_SENT = [
  ['feature control disabled', { featureControl: { schemaVersion: 1, enabled: false, provider: REAL_PROVIDER, supportedCategories: ['top'] } }],
  ['feature control names the development mock', { featureControl: { schemaVersion: 1, enabled: true, provider: 'mock', supportedCategories: ['top'] } }],
  ['feature control does not support the category', { featureControl: { schemaVersion: 1, enabled: true, provider: REAL_PROVIDER, supportedCategories: ['dress'] } }],
  ['the canonical grant is refused', { grantRejected: true }],
];

for (const [label, options] of NOT_SENT) {
  test(`certification: ${label} -> NOTHING is sent and the budget is untouched`, async () => {
    const { state, result, posts } = await certifyAgainst({}, options);
    assert.equal(posts(), 0);
    assert.equal(result.requestsSent, 0);
    assert.equal(result.budgetUsed, 0);
    assert.equal(result.proof.PROVIDER_DISPATCH, 0);
    assert.equal(result.dispatchClassification, 'not_sent');
    assert.equal(result.finalResultValidation, 'FAIL');
    assert.equal(state.providerDispatches, 0);
    // It reports the configuration it found; it never changes it.
    assert.equal(state.sql.some((sql) => /\b(insert|update|delete)\b[^;]*app_config/i.test(sql)), false);
  });
}

test('certification: a provider failure spends the budget and is NEVER retried', async () => {
  const { state, result, posts } = await certifyAgainst({}, { providerOutcome: 'failure' });
  assert.equal(posts(), 1, 'exactly one request, no retry');
  assert.equal(state.providerDispatches, 1);
  assert.equal(result.budgetUsed, 1);
  assert.equal(result.dispatchClassification, 'counted_as_dispatched');
  assert.equal(result.paidRetryAttempted, false);
  assert.equal(result.finalResultValidation, 'FAIL');
  assert.equal(result.reservationSettlement, 'failed');
  assert.equal(result.proof.QUOTA_RESERVATION, 'FAIL');
  assert.equal(result.proof.PROVIDER_RESULT_NONEMPTY, 'FAIL');
});

test('certification: a client timeout or transport error is counted as a dispatch and is NEVER retried', async () => {
  for (const name of ['AbortError', 'TypeError']) {
    let calls = 0;
    const { result } = await certifyAgainst({}, {}, {
      post: async () => { calls += 1; const err = new Error('no response'); err.name = name; throw err; },
    });
    assert.equal(calls, 1);
    assert.equal(result.requestsSent, 1);
    assert.equal(result.budgetUsed, 1);
    assert.equal(result.dispatchClassification, 'counted_as_dispatched');
    assert.equal(result.finalResultValidation, 'FAIL');
    assert.equal(result.proof.AUTHENTICATED_ACTOR, 'FAIL', 'no response establishes nothing');
  }
});

test('certification: a refusal before the provider leaves the budget unused', async () => {
  const { state, result, posts } = await certifyAgainst({}, { lateFailure: 'entitlement_required' });
  assert.equal(posts(), 1);
  assert.equal(state.providerDispatches, 0);
  assert.equal(result.budgetUsed, 0);
  assert.equal(result.dispatchClassification, 'refused_before_provider');
  assert.equal(result.proof.PROVIDER_DISPATCH, 0);
  assert.equal(result.proof.CANONICAL_KPLUS, 'FAIL');
  assert.equal(result.finalResultValidation, 'FAIL');
});

test('certification MUTATION: a response that echoes a different fingerprint fails HASH_CORRELATION', async () => {
  const { result } = await certifyAgainst({ echoesWrongHash: true });
  assert.equal(result.proof.HASH_CORRELATION, 'FAIL');
  assert.equal(result.finalResultValidation, 'FAIL');
  assert.deepEqual(failedNames(result.results), ['the response names the neutral source and the fingerprint the garment was sent under']);
});

test('the not-dispatched codes are exactly those the handler and the adapter can only produce before a submit', async () => {
  const { NOT_DISPATCHED_FAILURE_CODES } = await loadProbe();
  const handler = read('supabase/functions/vto-generate/vtoHandler.ts');
  const afterGenerate = handler.slice(handler.indexOf('// -- 9. Generate, bounded'));
  assert.ok(afterGenerate.length > 500, 'sanity: the generate section was found');
  for (const code of NOT_DISPATCHED_FAILURE_CODES) {
    assert.doesNotMatch(afterGenerate, new RegExp(`fail\\('${code}'`), `the handler must not produce ${code} once generation has begun`);
  }
  // Where the adapter itself returns one of these, it must say the vendor never got a job.
  const adapter = read('supabase/functions/vto-generate/providers/aiLabToolsProvider.ts');
  const returns = [...adapter.matchAll(/failure: '([a-z_]+)'/g)];
  assert.ok(returns.length >= 8, 'sanity: the adapter failure returns were found');
  for (const match of returns) {
    if (!NOT_DISPATCHED_FAILURE_CODES.includes(match[1])) continue;
    // The whole returned object: from this field to the statement's end.
    const statement = adapter.slice(match.index, adapter.indexOf('};', match.index));
    assert.match(statement, /billable: false/, `adapter returns ${match[1]} without billable:false: ${statement}`);
  }
  // The two ambiguous codes stay counted as a dispatch.
  assert.equal(NOT_DISPATCHED_FAILURE_CODES.includes('provider_unavailable'), false);
  assert.equal(NOT_DISPATCHED_FAILURE_CODES.includes('rate_limited'), false);
});

// ── Production is refused ─────────────────────────────────────────────────

test('production is refused before anything is sent or queried', async () => {
  const { runUserGarmentDryRun, runUserGarmentCertification } = await loadProbe();
  const { runUserGarmentLogAudit } = await loadAudit();
  let touched = 0;
  const args = {
    base: PRODUCTION, publishableKey: 'k', accessToken: 't', userId: USER_ID, runTag: RUN_TAG, grantKey: 'k',
    runSql: async () => { touched += 1; return []; },
    post: async () => { touched += 1; return {}; },
    postRaw: async () => { touched += 1; return {}; },
  };
  await assert.rejects(() => runUserGarmentDryRun(args), /production/);
  await assert.rejects(() => runUserGarmentCertification(args), /production/);
  await assert.rejects(() => runUserGarmentLogAudit({
    projectRef: 'wyyuqfdxucjksghsmhry', supabaseUrl: PRODUCTION, managementCredential: 'm',
    since: '2026-10-07T00:00:00Z', until: '2026-10-07T00:10:00Z', runMarker: RUN_TAG,
    fetchImpl: async () => { touched += 1; return { ok: true, json: async () => ({ result: [] }) }; },
  }), /production/);
  assert.equal(touched, 0);
});

test('the run modes assert the staging target themselves -- a production env is a StagingGuardError', async () => {
  const run = await loadRun();
  const keys = ['SUPABASE_STAGING_PROJECT_REF', 'SUPABASE_STAGING_URL', 'SUPABASE_STAGING_PUBLISHABLE_KEY'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    process.env.SUPABASE_STAGING_PROJECT_REF = 'wyyuqfdxucjksghsmhry';
    process.env.SUPABASE_STAGING_URL = PRODUCTION;
    process.env.SUPABASE_STAGING_PUBLISHABLE_KEY = 'not-a-real-key';
    const guard = (err) => err.name === 'StagingGuardError';
    await assert.rejects(() => run.runStagingUserGarmentDryRunMode({ runTag: RUN_TAG }), guard);
    await assert.rejects(() => run.runStagingUserGarmentCertificationMode({ runTag: RUN_TAG }), guard);
    await assert.rejects(() => run.runStagingUserGarmentLogAuditMode({
      runTag: RUN_TAG, auditedRunTag: RUN_TAG, since: '2026-10-07T00:00:00Z', until: '2026-10-07T00:10:00Z', expectDispatches: 0,
    }), guard);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
});

// ── K+ only through the canonical authority ───────────────────────────────

test('no new harness module writes an entitlement table: K+ is granted and revoked only through the canonical functions', () => {
  for (const rel of NEW_LIB_FILES) {
    const src = read(rel);
    const literals = src.match(/`[^`]*`/gs) ?? [];
    for (const literal of literals) {
      assert.doesNotMatch(
        literal,
        /\b(insert\s+into|update|delete\s+from|truncate)\b[^;`]*\b(user_entitlements|kplus_entitlement_\w*|kplus_revenuecat_\w*|kplus_offer_\w*)\b/i,
        `${rel} writes an entitlement table: ${literal}`,
      );
      assert.doesNotMatch(literal, /\bapp_config\b[^;`]*\bset\b|\b(insert\s+into|update|delete\s+from)\b[^;`]*\bapp_config\b/i, `${rel} writes app_config`);
    }
    assert.doesNotMatch(src, /seedVtoEntitlement/, `${rel} must not use the entitlement-table seeder`);
    assert.doesNotMatch(src, /import\s*\{[^}]*\brunSupabase\b[^}]*\}\s*from/, `${rel} must go through lib/sql.mjs`);
    assert.doesNotMatch(src, /function sqlQuote/, `${rel} must not define a private sqlQuote`);
    assert.doesNotMatch(src, /revenuecat\.com|api\.revenuecat/i, `${rel} must not contact RevenueCat`);
  }
  for (const rel of ['scripts/vto-e2e/lib/userGarmentActor.mjs', 'scripts/vto-e2e/lib/userGarmentProbe.mjs']) {
    assert.match(read(rel), /import \{ sqlQuote \} from '\.\/sql\.mjs';/);
  }
  // The only rows this probe deletes are its own actor's quota rows and identity.
  const actor = read('scripts/vto-e2e/lib/userGarmentActor.mjs');
  const deletes = [...actor.matchAll(/`(delete from [^`]*)`/g)].map((m) => m[1]);
  assert.deepEqual(deletes, [
    'delete from public.vto_generation_requests where user_id = ${sqlQuote(userId)}::uuid;',
    'delete from auth.users where id = ${sqlQuote(userId)}::uuid;',
  ]);
});

test('the grant source and grant key are values the canonical authority accepts', async () => {
  const actor = await loadActor();
  const migration = read('supabase/migrations/20260915030553_kplus_entitlement_authority.sql');
  const fn = migration.slice(migration.indexOf('create or replace function public.grant_kplus_complimentary('));
  const sources = /p_source not in \(([^)]*)\)/.exec(fn);
  assert.ok(sources, 'the authority must enumerate its complimentary sources');
  const allowed = [...sources[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(allowed.includes(actor.SYNTHETIC_KPLUS_GRANT_SOURCE), `${actor.SYNTHETIC_KPLUS_GRANT_SOURCE} not in ${allowed}`);
  const keyPattern = /p_grant_key !~ '([^']+)'/.exec(fn);
  assert.ok(keyPattern);
  assert.match(actor.userGarmentGrantKey(RUN_TAG), new RegExp(keyPattern[1]));
  const campaignPattern = /p_campaign_id !~ '([^']+)'/.exec(fn);
  assert.ok(campaignPattern);
  assert.match(actor.SYNTHETIC_KPLUS_GRANT_CAMPAIGN, new RegExp(campaignPattern[1]));
  assert.throws(() => actor.userGarmentGrantKey('bad tag with spaces'), /valid K\+ grant key/);
  assert.ok(actor.SYNTHETIC_KPLUS_GRANT_MINUTES > 0 && actor.SYNTHETIC_KPLUS_GRANT_MINUTES <= 60, 'the grant is short-lived');
  // The signatures the presence check names are the ones the migration grants to service_role.
  assert.match(migration, /grant execute on function public\.grant_kplus_complimentary\(uuid, text, text, text, timestamptz, timestamptz, text\) to service_role;/);
  assert.match(migration, /grant execute on function public\.revoke_kplus_grant\(uuid, uuid\) to service_role;/);
});

test('grant/revoke SQL binds every value as an inert literal -- a hostile id cannot become syntax', async () => {
  const actor = await loadActor();
  const hostile = "x'; drop table public.kplus_entitlement_grants; --";
  const captured = [];
  const runSql = async (sql) => { captured.push(sql); return [{ result: { outcome: 'rejected', reason: 'unknown_user' }, active: false }]; };
  const grant = await actor.grantSyntheticKPlus(runSql, hostile, actor.userGarmentGrantKey(RUN_TAG));
  assert.equal(grant.outcome, 'rejected');
  assert.equal(grant.grantId, null);
  await actor.readCanonicalKPlusAccess(runSql, hostile);
  const quoted = "'x''; drop table public.kplus_entitlement_grants; --'";
  assert.equal(captured.length, 2);
  for (const sql of captured) {
    assert.ok(sql.includes(quoted), sql);
    // Outside the one literal the hostile text became, the statement is intact:
    // a single terminator, at the end, and no comment marker.
    const outside = sql.replace(quoted, '<ID>');
    assert.equal((outside.match(/;/g) ?? []).length, 1, outside);
    assert.ok(outside.endsWith(';'));
    assert.equal(outside.includes('--'), false);
    assert.doesNotMatch(outside, /drop table/i);
  }
  await assert.rejects(() => actor.grantSyntheticKPlus(runSql, USER_ID, "bad'key"), /invalid K\+ grant key/);
  await assert.rejects(() => actor.revokeSyntheticKPlus(runSql, USER_ID, "not-a-uuid'; --"), /needs a grant id/);
});

test('an unreadable authority result is never read as a grant', async () => {
  const actor = await loadActor();
  for (const row of [undefined, {}, { result: 'not json' }, { result: 42 }, { result: { outcome: 'granted', grantId: 'not-a-uuid', accessAfter: true } }]) {
    const grant = await actor.grantSyntheticKPlus(async () => [row], USER_ID, actor.userGarmentGrantKey(RUN_TAG));
    assert.equal(grant.grantId, null);
  }
  const absent = await actor.canonicalKPlusAuthorityPresent(async () => [{ grant_fn: false, revoke_fn: true, predicate_fn: true }]);
  assert.equal(absent.all, false);
});

// ── Own namespace, own ledger ─────────────────────────────────────────────

test('the probe actor lives in its own namespace and is provisioned without any entitlement write', async () => {
  const actor = await loadActor();
  const older = await import('../scripts/vto-e2e/lib/actors.mjs');
  assert.notEqual(actor.USER_GARMENT_ACTOR_EMAIL_DOMAIN, older.VTO_E2E_ACTOR_EMAIL_DOMAIN);
  const built = actor.buildUserGarmentActor(RUN_TAG);
  assert.equal(built.email, `${RUN_TAG}.kplus@${actor.USER_GARMENT_ACTOR_EMAIL_DOMAIN}`);
  assert.equal(Object.values(older.buildActorPlan(RUN_TAG)).some((entry) => entry.email === built.email), false);

  const sql = [];
  const logged = [];
  const provisioned = await actor.provisionUserGarmentActor({
    base: STAGING, publishableKey: 'k', runTag: RUN_TAG,
    runSql: async (statement) => { sql.push(statement); return []; },
    signUp: async () => ({ ok: true, userId: USER_ID, emailConfirmed: false }),
    signIn: async () => ({ ok: true, accessToken: 'session-value-for-the-test' }),
    log: (line) => logged.push(line),
  });
  assert.equal(provisioned.accessToken, 'session-value-for-the-test');
  assert.deepEqual(logged, ['::add-mask::session-value-for-the-test'], 'the session is masked the moment it exists');
  assert.equal(sql.length, 1, 'only the email confirmation');
  assert.match(sql[0], /^update auth\.users set email_confirmed_at = now\(\)/);
  assert.equal(JSON.stringify(provisioned.evidence).includes('session-value-for-the-test'), false);
  assert.equal(JSON.stringify(provisioned.evidence).includes(built.password), false);
});

test('a provisioning failure after signup still leaves the identity findable for cleanup', async () => {
  const actor = await loadActor();
  const provisioned = await actor.provisionUserGarmentActor({
    base: STAGING, publishableKey: 'k', runTag: RUN_TAG,
    runSql: async () => { throw new Error('transient SQL failure'); },
    signUp: async () => ({ ok: true, userId: USER_ID, emailConfirmed: false }),
    signIn: async () => ({ ok: true, accessToken: 'unused' }),
    log: () => {},
  });
  assert.equal(provisioned.actor.userId, USER_ID);
  assert.equal(provisioned.accessToken, null);
  assert.equal(provisioned.evidence.provisioningFailed, true);
});

test('cleanup ledger: revoke through the authority FIRST, then quota rows, then the identity; clean only with zero residual', async () => {
  const actor = await loadActor();
  const { state, runSql } = await createBackend();
  const grant = await actor.grantSyntheticKPlus(runSql, USER_ID, actor.userGarmentGrantKey(RUN_TAG));
  state.reservations.set('a'.repeat(64), 'succeeded');
  state.sql.length = 0;

  // The run "crashed" before it could record the grant id: cleanup finds it itself.
  const ledger = await actor.cleanupUserGarmentActor(runSql, { userId: USER_ID });
  assert.deepEqual(ledger.steps.map((entry) => entry.step), [
    'read pre-state',
    'revoke K+ through the canonical authority',
    "delete this actor's quota rows",
    "delete this actor's identity",
    'read post-state',
  ]);
  assert.equal(ledger.steps[1].detail, 'revoked');
  const order = state.sql.map((sql) => (sql.includes('revoke_kplus_grant(') ? 'revoke'
    : sql.startsWith('delete from public.vto_generation_requests') ? 'quota'
      : sql.startsWith('delete from auth.users') ? 'identity' : null)).filter(Boolean);
  assert.deepEqual(order, ['revoke', 'quota', 'identity']);
  assert.ok(state.sql.find((sql) => sql.includes('revoke_kplus_grant(')).includes(grant.grantId));
  assert.equal(ledger.preState.kplusGrantsUnrevoked, 1);
  assert.deepEqual(ledger.postState, {
    authUsers: 0, vtoGenerationRequests: 0, kplusGrants: 0, kplusGrantsUnrevoked: 0, userEntitlements: 0, revenueCatMirrorQueueRows: 0,
  });
  assert.equal(ledger.residual, 0);
  assert.equal(ledger.clean, true);
  const summary = actor.summarizeUserGarmentCleanup(ledger);
  assert.deepEqual(
    { users: summary.usersRemaining, entitlements: summary.entitlementsRemaining, requests: summary.vtoRequestsRemaining, clean: summary.clean },
    { users: 0, entitlements: 0, requests: 0, clean: true },
  );
});

test('cleanup ledger MUTATION: residue, or a failed step, is never reported clean', async () => {
  const actor = await loadActor();
  const leaky = await createBackend({ cleanupLeavesReservations: true });
  leaky.state.reservations.set('b'.repeat(64), 'succeeded');
  const dirty = await actor.cleanupUserGarmentActor(leaky.runSql, { userId: USER_ID });
  assert.equal(dirty.clean, false);
  assert.equal(dirty.residual, 1);
  assert.equal(actor.summarizeUserGarmentCleanup(dirty).vtoRequestsRemaining, 1);

  const broken = await createBackend();
  const failing = async (sql) => {
    if (sql.startsWith('delete from public.vto_generation_requests')) throw new Error('statement failed');
    return broken.runSql(sql);
  };
  const ledger = await actor.cleanupUserGarmentActor(failing, { userId: USER_ID });
  assert.equal(ledger.steps.find((entry) => entry.step === "delete this actor's quota rows").ok, false);
  assert.equal(ledger.steps.find((entry) => entry.step === "delete this actor's identity").ok, true, 'later steps still run');
  assert.equal(ledger.clean, false, 'a failed step is never clean, even with zero residual');

  assert.equal(actor.summarizeUserGarmentCleanup(null).clean, true, 'no identity was ever created');
});

test('cleanup mode recovers a user-garment run by tag through its own ledger', () => {
  const run = read('scripts/vto-e2e/run.mjs');
  const cleanup = run.slice(run.indexOf('async function runCleanupMode'), run.indexOf('async function main'));
  assert.match(cleanup, /buildUserGarmentActor\(runTag\)\.email/);
  assert.match(cleanup, /cleanupUserGarmentActor\(runSqlViaSupabaseCli, \{ userId: row\.id \}\)/);
  assert.match(cleanup, /userGarmentLedger === null \|\| userGarmentLedger\.clean/);
  assert.ok(cleanup.indexOf('assertVtoStagingTarget()') < cleanup.indexOf('buildUserGarmentActor(runTag)'), 'the target is asserted first');
});

// ── Log audit ─────────────────────────────────────────────────────────────

const CLEAN_LINES = [
  `{"event":"vto_generate_start","ts":"2026-10-07T00:00:01.000Z","requestId":"${RUN_TAG}-cert","uid":"1111","origin":"elise","provider":"${REAL_PROVIDER}","slot":"top","category":"top","inputBucket":"256k_1m"}`,
  `{"event":"vto_generate_succeeded","ts":"2026-10-07T00:00:12.000Z","requestId":"${RUN_TAG}-cert","uid":"1111","origin":"elise","provider":"${REAL_PROVIDER}","slot":"top","category":"top","latencyMs":11000,"outputBytes":412000,"billedUnits":1}`,
  'POST | 200 | https://yzqjvdfgefveprobvvyw.supabase.co/functions/v1/vto-generate',
  'booted (time: 31ms)',
];

test('log audit: clean lines produce zero hits and only bounded fields of this run\'s events', async () => {
  const { scanLogLines, FORBIDDEN_LOG_RULES } = await loadAudit();
  const hash = 'c'.repeat(64);
  const scan = scanLogLines(CLEAN_LINES, { contentHash: hash, runMarker: RUN_TAG });
  assert.equal(scan.linesScanned, 4);
  assert.equal(scan.hits.length, FORBIDDEN_LOG_RULES.length + 1);
  assert.deepEqual(scan.hits.filter((hit) => hit.matches > 0), []);
  assert.equal(scan.runEvents.length, 2);
  assert.deepEqual(scan.runEvents[0], {
    event: 'vto_generate_start', origin: 'elise', provider: REAL_PROVIDER, slot: 'top', category: 'top', inputBucket: '256k_1m',
  });
  assert.equal('uid' in scan.runEvents[0], false);
  assert.equal('requestId' in scan.runEvents[0], false);
});

test('log audit: each kind of forbidden content is caught', async () => {
  const { scanLogLines } = await loadAudit();
  const hash = 'c'.repeat(64);
  const jpegBase64 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(300)]).toString('base64');
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlLXZhbHVl'].join('.');
  const cases = [
    ['data URI', '{"event":"x","personDataUri":"data:image/png;base64,AAAA"}'],
    ['Base64 image payload (a run of 256+ Base64 characters)', `{"event":"x","body":"${'A'.repeat(300)}"}`],
    ['JPEG or PNG magic bytes in Base64', `{"event":"x","body":"${jpegBase64.slice(0, 60)}"}`],
    ['JSON Web Token', `authorization header was ${jwt}`],
    ['bearer credential', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345'],
    ['provider credential header', '{"headers":{"x-rapidapi-key":"redacted"}}'],
    ['Supabase secret key', 'using sb_secret_abcdefgh12345678'],
    ['the garment content fingerprint', `{"event":"x","productRef":"user_supplied_garment:${hash}"}`],
  ];
  for (const [rule, line] of cases) {
    const scan = scanLogLines([...CLEAN_LINES, line], { contentHash: hash, runMarker: RUN_TAG });
    const hit = scan.hits.find((entry) => entry.id === rule);
    assert.ok(hit, `rule exists: ${rule}`);
    assert.ok(hit.matches >= 1, `rule "${rule}" must catch: ${line.slice(0, 60)}`);
  }
});

function logFetch(pagesBySource, { rejectTableShape = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const sql = url.searchParams.get('sql');
    const tableShape = url.pathname.endsWith('/logs.all');
    calls.push({ path: url.pathname, sql, since: url.searchParams.get('iso_timestamp_start'), credential: init.headers.Authorization });
    if (tableShape && rejectTableShape) return { ok: false, status: 400, json: async () => ({}) };
    const source = /function_edge_logs/.test(sql) ? 'function_edge_logs' : 'function_logs';
    const pages = pagesBySource[source] ?? [[]];
    const index = calls.filter((c) => c.sql === sql && c.path === url.pathname).length - 1;
    return { ok: true, status: 200, json: async () => ({ result: pages[Math.min(index, pages.length - 1)] }) };
  };
  return { fetchImpl, calls };
}

const row = (index, message) => ({ id: `row-${index}`, timestamp: 1_791_331_200_000_000 + index * 1000, event_message: message });

test('log audit: PASSES on a clean window that contains the run and exactly the expected dispatch', async () => {
  const { runUserGarmentLogAudit } = await loadAudit();
  const { fetchImpl, calls } = logFetch({
    function_logs: [CLEAN_LINES.slice(0, 2).map((line, i) => row(i, line))],
    function_edge_logs: [[row(10, CLEAN_LINES[2])]],
  });
  const audit = await runUserGarmentLogAudit({
    projectRef: 'yzqjvdfgefveprobvvyw', supabaseUrl: STAGING, managementCredential: 'management-value',
    since: '2026-10-07T00:00:00.000Z', until: '2026-10-07T00:05:00.000Z', runMarker: RUN_TAG,
    contentHash: 'c'.repeat(64), expectDispatches: 1, fetchImpl,
  });
  assert.deepEqual(failedNames(audit.results), []);
  assert.equal(audit.dispatchesLogged, 1);
  assert.equal(audit.serverLoggedCategory, 'top');
  assert.equal(audit.serverLoggedSlot, 'top');
  assert.equal(audit.serverLoggedProvider, REAL_PROVIDER);
  assert.equal(audit.linesScanned, 3);
  // Evidence is counts and bounded fields: never a log line, never the credential.
  const serialized = JSON.stringify(audit);
  assert.equal(serialized.includes('management-value'), false);
  assert.equal(serialized.includes('supabase.co/functions'), false);
  assert.ok(calls.every((call) => call.credential === 'Bearer management-value'));
  assert.ok(calls.every((call) => /^select (id, )?timestamp, event_message from /.test(call.sql)), 'only plain windowed reads are sent');
});

test('log audit: is NOT vacuous -- a window that does not contain the run FAILS, as does a wrong dispatch count', async () => {
  const { runUserGarmentLogAudit } = await loadAudit();
  const base = {
    projectRef: 'yzqjvdfgefveprobvvyw', supabaseUrl: STAGING, managementCredential: 'm',
    since: '2026-10-07T00:00:00.000Z', until: '2026-10-07T00:05:00.000Z', runMarker: RUN_TAG, contentHash: 'c'.repeat(64),
  };
  const empty = await runUserGarmentLogAudit({ ...base, expectDispatches: 0, fetchImpl: logFetch({}).fetchImpl });
  assert.deepEqual(failedNames(empty.results), ['the window contains this run (its own request ids appear in the function logs)']);

  const lines = { function_logs: [CLEAN_LINES.slice(0, 2).map((line, i) => row(i, line))] };
  const wrongCount = await runUserGarmentLogAudit({ ...base, expectDispatches: 0, fetchImpl: logFetch(lines).fetchImpl });
  assert.deepEqual(failedNames(wrongCount.results), ['the server logged exactly 0 provider dispatch(es) for this run']);

  await assert.rejects(() => runUserGarmentLogAudit({ ...base, runMarker: '', expectDispatches: 0, fetchImpl: logFetch({}).fetchImpl }), /audit-run-tag/);
  await assert.rejects(() => runUserGarmentLogAudit({ ...base, since: 'yesterday', expectDispatches: 0, fetchImpl: logFetch({}).fetchImpl }), /ISO timestamp/);
  await assert.rejects(() => runUserGarmentLogAudit({ ...base, managementCredential: '', expectDispatches: 0, fetchImpl: logFetch({}).fetchImpl }), /management credential/);
});

test('log audit: a leaked payload in the window FAILS the audit and the line itself is never returned', async () => {
  const { runUserGarmentLogAudit } = await loadAudit();
  const leak = `{"event":"debug","requestId":"${RUN_TAG}-cert","garment":"data:image/jpeg;base64,${'Q'.repeat(400)}"}`;
  const { fetchImpl } = logFetch({ function_logs: [[...CLEAN_LINES.slice(0, 2), leak].map((line, i) => row(i, line))] });
  const audit = await runUserGarmentLogAudit({
    projectRef: 'yzqjvdfgefveprobvvyw', supabaseUrl: STAGING, managementCredential: 'm',
    since: '2026-10-07T00:00:00.000Z', until: '2026-10-07T00:05:00.000Z', runMarker: RUN_TAG,
    contentHash: 'c'.repeat(64), expectDispatches: 1, fetchImpl,
  });
  assert.deepEqual(failedNames(audit.results).sort(), [
    'no Base64 image payload (a run of 256+ Base64 characters) in any log line',
    'no data URI in any log line',
  ]);
  assert.equal(JSON.stringify(audit).includes('QQQQ'), false);
});

test('log audit: pages through a full window, falls back to the second query shape, and never claims a read it could not finish', async () => {
  const { fetchLogLines } = await loadAudit();
  const full = Array.from({ length: 1000 }, (_, i) => row(i, `line ${i}`));
  const tail = [row(999, 'line 999'), row(1000, 'line 1000'), row(1001, 'line 1001')];
  const paged = logFetch({ function_logs: [full, tail] });
  const read1 = await fetchLogLines({
    projectRef: 'p', managementCredential: 'm', source: 'function_logs',
    since: '2026-10-07T00:00:00.000Z', until: '2026-10-07T00:05:00.000Z', fetchImpl: paged.fetchImpl,
  });
  assert.equal(read1.complete, true);
  assert.equal(read1.lines.length, 1002, 'the overlapping row is not double-counted');
  assert.equal(read1.shape, 'table');
  assert.notEqual(paged.calls[1].since, paged.calls[0].since, 'the second page starts where the first ended');

  const fallback = logFetch({ function_logs: [[row(1, 'only line')]] }, { rejectTableShape: true });
  const read2 = await fetchLogLines({
    projectRef: 'p', managementCredential: 'm', source: 'function_logs',
    since: '2026-10-07T00:00:00.000Z', until: '2026-10-07T00:05:00.000Z', fetchImpl: fallback.fetchImpl,
  });
  assert.equal(read2.shape, 'source-column');
  assert.equal(read2.complete, true);

  // Every page is the same saturated page: the cursor cannot advance.
  const stuck = logFetch({ function_logs: [full] });
  const read3 = await fetchLogLines({
    projectRef: 'p', managementCredential: 'm', source: 'function_logs',
    since: '2026-10-07T00:00:00.000Z', until: '2026-10-07T00:05:00.000Z', fetchImpl: stuck.fetchImpl,
  });
  assert.equal(read3.complete, false);

  const failing = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(() => fetchLogLines({
    projectRef: 'p', managementCredential: 'm', source: 'function_logs',
    since: '2026-10-07T00:00:00.000Z', until: '2026-10-07T00:05:00.000Z', fetchImpl: failing,
  }), /log query .* failed with status 500/);
});

// ── Artifact hygiene, schema and spend ────────────────────────────────────

test('the artifact is refused if it would carry a payload or a credential', async () => {
  const { assertArtifactCarriesNoPayload } = await loadRun();
  const { writeReport } = await loadReport();
  assert.throws(() => assertArtifactCarriesNoPayload({ controls: [{ detail: 'data:image/jpeg;base64,AAAA' }] }), /data URI/);
  assert.throws(() => assertArtifactCarriesNoPayload({ note: `Bearer ${'a'.repeat(40)}` }), /bearer credential/);
  // A real certification outcome passes both hygiene gates, fingerprint included.
  const { result } = await certifyAgainst();
  const artifact = { mode: 'staging-user-garment-certification', controls: result.results, proof: result.proof, responseEvidence: result.evidence, garmentEvidence: result.garmentEvidence };
  assert.doesNotThrow(() => assertArtifactCarriesNoPayload(artifact));
  assert.doesNotThrow(() => writeReport({ ...result, results: undefined }));
  assert.equal(JSON.stringify(result).includes('model-session'), false, 'the session never reaches the outcome');
  assert.equal(/data:image\//.test(JSON.stringify(result)), false, 'no payload reaches the outcome');
});

function userGarmentReport(overrides = {}) {
  return {
    runId: 'vto-ug-cert-20261007T000000Z-abcd1234',
    projectRef: 'yzqjvdfgefveprobvvyw',
    mode: 'staging-user-garment-certification',
    authoritySha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    controls: [{ name: 'example', ok: true, detail: 'pass' }],
    providerSubmits: 1,
    paidRequests: 1,
    cleanupStatus: { usersRemaining: 0, entitlementsRemaining: 0, vtoRequestsRemaining: 0, clean: true },
    verdict: 'PASS',
    ...overrides,
  };
}

function tempReport(obj) {
  const p = path.join(os.tmpdir(), `vto-e2e-ug-artifact-${crypto.randomUUID()}.json`);
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

test('validator: the paid user-garment mode may report its ONE request; nothing may report two', async () => {
  const { validateReportFile } = await loadValidate();
  const { PAID_MODES, MAX_PROVIDER_SUBMITS_PER_RUN } = await loadSchema();
  assert.deepEqual([...PAID_MODES], ['staging-full-certification', 'staging-user-garment-certification']);
  assert.equal(MAX_PROVIDER_SUBMITS_PER_RUN, 1);

  assert.equal(validateReportFile(tempReport(userGarmentReport())).code, 'VALID');
  assert.equal(validateReportFile(tempReport(userGarmentReport({ providerSubmits: 0, paidRequests: 0 }))).code, 'VALID');
  for (const mode of PAID_MODES) {
    assert.equal(validateReportFile(tempReport(userGarmentReport({ mode, providerSubmits: 2 }))).code, 'SPEND', mode);
    assert.equal(validateReportFile(tempReport(userGarmentReport({ mode, paidRequests: 2 }))).code, 'SPEND', mode);
    assert.equal(validateReportFile(tempReport(userGarmentReport({ mode, providerSubmits: -1 }))).code, 'SPEND', mode);
  }
  for (const mode of ['staging-user-garment-dryrun', 'staging-user-garment-log-audit', 'staging-dryrun', 'cleanup', 'contract']) {
    assert.equal(validateReportFile(tempReport(userGarmentReport({ mode }))).code, 'SPEND', `${mode} is zero-spend`);
    assert.equal(validateReportFile(tempReport(userGarmentReport({ mode, providerSubmits: 0, paidRequests: 0 }))).code, 'VALID', mode);
  }
  assert.equal(validateReportFile(tempReport(userGarmentReport({ verdict: 'FAIL' }))).code, 'VERDICT');
  assert.equal(validateReportFile(tempReport(userGarmentReport({ mode: 'staging-user-garment-nonsense' }))).code, 'STRUCTURAL');
});

// ── Workflow ──────────────────────────────────────────────────────────────

function workflowJob(yaml, name) {
  const start = yaml.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `job ${name} exists`);
  const rest = yaml.slice(start + 1);
  const next = /\n {2}[a-zA-Z0-9_-]+:\n/.exec(rest.slice(rest.indexOf('\n')));
  const body = next ? rest.slice(0, rest.indexOf('\n') + next.index) : rest;
  // Job-level comments sit between jobs and describe the NEXT one.
  return body.split('\n').filter((line) => !/^ {2}#/.test(line)).join('\n');
}

test('workflow: the three user-garment jobs are dispatch-only, staging-scoped, single-flight and artifact-validated', async () => {
  const { checkConcurrencyContract, checkWorkflowPipefailSafety, LIVE_STAGING_JOBS } = await loadGuard();
  const yaml = read('.github/workflows/vto-e2e.yml');
  assert.equal(checkConcurrencyContract(yaml).ok, true);
  assert.equal(checkWorkflowPipefailSafety(yaml).ok, true);
  for (const mode of ['staging-user-garment-dryrun', 'staging-user-garment-certification', 'staging-user-garment-log-audit']) {
    assert.ok(LIVE_STAGING_JOBS.includes(mode));
    assert.match(yaml, new RegExp(`\\n {10}- ${mode}\\n`), `${mode} is a selectable mode`);
    const job = workflowJob(yaml, mode);
    assert.match(job, /github\.event_name == 'workflow_dispatch'/);
    assert.match(job, new RegExp(`github\\.event\\.inputs\\.mode == '${mode}'`));
    assert.match(job, /\n {4}environment: staging\n/);
    assert.match(job, /group: vto-e2e-certification\n\s+cancel-in-progress: false/);
    assert.match(job, new RegExp(`--mode=${mode}[\\s\\S]*\\| tee `));
    assert.match(job, new RegExp(`VTO_E2E_EXPECT_MODE: ${mode}\\n`));
    assert.match(job, /VTO_E2E_EXPECT_AUTHORITY_SHA: \$\{\{ github\.sha \}\}/);
    assert.match(job, /node scripts\/vto-e2e\/validate-report\.mjs /);
    assert.match(job, /if: always\(\)\n\s+uses: actions\/upload-artifact@/);
    assert.doesNotMatch(job, /SERVICE_ROLE|RAPIDAPI|REVENUECAT|PRODUCTION/i, 'no production, provider or RevenueCat credential is wired in');
  }
});

test('workflow: the paid job needs explicit confirmation and refuses to be re-run', () => {
  const yaml = read('.github/workflows/vto-e2e.yml');
  const job = workflowJob(yaml, 'staging-user-garment-certification');
  assert.match(job, /github\.event\.inputs\.confirm_paid_certification == 'YES'/);
  const steps = [...job.matchAll(/\n {6}- name: (.+)\n/g)].map((m) => m[1]);
  assert.equal(steps[0], 'Refuse a re-run', 'the re-run refusal is the FIRST step, before anything is installed or sent');
  assert.match(job, /RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}/);
  assert.match(job, /if \[ "\$RUN_ATTEMPT" != "1" \]; then[\s\S]*?exit 2/);
  // The zero-spend and read-only jobs carry no paid confirmation gate of their own to satisfy.
  assert.doesNotMatch(workflowJob(yaml, 'staging-user-garment-dryrun'), /confirm_paid_certification/);
  // Dispatch text reaches the audit through the environment, never spliced into the script.
  const audit = workflowJob(yaml, 'staging-user-garment-log-audit');
  assert.match(audit, /AUDIT_RUN_TAG: \$\{\{ github\.event\.inputs\.run_tag \}\}/);
  assert.match(audit, /--audit-run-tag="\$AUDIT_RUN_TAG"/);
  const auditStep = audit.slice(audit.indexOf('- name: Run harness staging-user-garment-log-audit mode'), audit.indexOf('- name: Validate report'));
  const auditScript = auditStep.slice(auditStep.indexOf('run: |'));
  assert.ok(auditScript.includes('--expect-dispatches="$AUDIT_EXPECT_DISPATCHES"'), 'sanity: the audit script body was found');
  assert.doesNotMatch(auditScript, /\$\{\{ github\.event\.inputs\./);
  assert.doesNotMatch(audit, /supabase link/, 'the read-only audit runs no SQL');
});

test('both mutating modes publish the window and run tag the log audit needs', () => {
  const run = read('scripts/vto-e2e/run.mjs');
  for (const fn of ['runStagingUserGarmentDryRunMode', 'runStagingUserGarmentCertificationMode']) {
    const start = run.indexOf(`async function ${fn}`);
    const body = run.slice(start, run.indexOf('\nasync function ', start + 20));
    assert.match(body, /logAuditWindow: \{ since: [^,]+, until: [^,]+, runTag \}/, fn);
    assert.match(body, /return assertArtifactCarriesNoPayload\(\{/, `${fn} writes its artifact through the payload gate`);
  }
});

test('contract mode runs this file, so the probe\'s own controls gate every push', () => {
  const run = read('scripts/vto-e2e/run.mjs');
  const contract = run.slice(run.indexOf('async function runContractMode'), run.indexOf('async function runStagingDryRunMode'));
  assert.match(contract, /__tests__\/vtoE2eUserGarmentProbe\.test\.js/);
});
