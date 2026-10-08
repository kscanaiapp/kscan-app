/**
 * Staging runtime probe for the `user_supplied_garment` source -- the request
 * the app sends when a customer taps "TRY IT ON" under a photo they gave Elise.
 *
 * TWO MODES, ONE RULE EACH.
 *
 *   runUserGarmentDryRun         ZERO SPEND. Every request it sends is refused
 *                                before the provider BY CONSTRUCTION, and the
 *                                function refuses to send one that is not (see
 *                                assertCannotReachProvider). It proves the
 *                                contract boundary: K+, the garment's own
 *                                bounds and recomputed hash, category
 *                                canonicalization, and the request-size
 *                                ceilings to the exact character.
 *
 *   runUserGarmentCertification  EXACTLY ONE request that can reach the paid
 *                                provider. One, with no retry of any kind:
 *                                MAX_REAL_VTO_PROVIDER_DISPATCHES is a hard cap
 *                                enforced in code, not a convention.
 *
 * HOW ACCEPTANCE IS PROVED WITHOUT SPENDING. vto-generate decides in a fixed
 * order: body ceiling -> identity -> account -> kill switch -> K+ -> garment
 * (bounds, then recomputed hash) -> eligibility (category) -> person input ->
 * provider -> K+ recheck -> reservation -> provider call. A refusal names the
 * step that refused. So:
 *
 *   - a VALID garment with an UNSUPPORTED category is refused as
 *     `unsupported_category`: that code can only be produced AFTER the garment
 *     was accepted, and BEFORE a reservation or the provider;
 *   - a valid garment with a SUPPORTED category and NO person is refused as
 *     `invalid_person_input` carrying the request's own id: accepted garment,
 *     accepted category, still before reservation and provider;
 *   - a body over the ceiling is refused as `invalid_person_input` carrying
 *     the id `unlabelled`, because that refusal happens before the body is
 *     read as a request at all.
 *
 * Nothing here logs a token, a payload or a response body. Evidence is status,
 * failure code, sizes and fingerprints.
 */
'use strict';

import { callVtoGenerate, request, edgeUrl } from './client.mjs';
import { buildFixture, fixtureEvidence, PERSON_FIXTURE_WIDTH, PERSON_FIXTURE_HEIGHT } from './fixtures.mjs';
import { computeVtoIdempotencyKey } from './idempotency.mjs';
import { sanitizeVtoResponse } from './report.mjs';
import { assertNotProductionUrl } from './auth.mjs';
import { sqlQuote } from './sql.mjs';
import {
  USER_GARMENT_SOURCE_TYPE,
  USER_GARMENT_HASH_VERSION,
  USER_GARMENT_MEDIA_PREFIX,
  GARMENT_PAYLOAD_MAX_CHARS,
  INLINE_GARMENT_MIN_BYTES,
  PERSON_PAYLOAD_MAX_CHARS,
  LEGACY_BODY_MAX_CHARS,
  INLINE_BODY_MAX_CHARS,
  LARGEST_ENCODABLE_GARMENT_BYTES,
  userGarmentFromBytes,
  jpegShapedBytes,
  personShapedDataUri,
  loadCommittedUserGarment,
  buildUserGarmentBody,
  padBodyToChars,
  userGarmentReservationIdentity,
  userGarmentEvidence,
} from './userGarment.mjs';
import {
  grantSyntheticKPlus,
  revokeSyntheticKPlus,
  readCanonicalKPlusAccess,
} from './userGarmentActor.mjs';

/** The hard cap on requests that may reach the paid provider, per run. */
export const MAX_REAL_VTO_PROVIDER_DISPATCHES = 1;

/** The real provider this certification is about. The probe never selects a
 *  provider -- the server's own feature control does -- it only refuses to
 *  spend its one request against anything else. */
export const EXPECTED_REAL_PROVIDER = 'ailabtools_tryon_clothes_pro';

/** Canonicalizes to `footwear`, which Virtual Try-On does not support. */
export const UNSUPPORTED_PROBE_CATEGORY = 'sneakers';
/** A label the app would never send but a person would type: it canonicalizes
 *  to the supported `top`. */
export const NON_CANONICAL_SUPPORTED_LABEL = 'Blouse';
const CERTIFICATION_CATEGORY = 'top';

/**
 * Failure codes that can only mean the request was never submitted to the
 * provider: vto-generate produces them before the adapter runs, and where the
 * adapter itself can return one (`unsupported_category`,
 * `invalid_person_input`, `invalid_garment_input`) it does so only on its own
 * pre-submit checks. Any other outcome of the one paid request -- success, a
 * provider-class failure, an ambiguous code such as `provider_unavailable` or
 * `rate_limited`, or no readable response at all -- is counted as a dispatch.
 * Pinned against the handler and the adapter by
 * __tests__/vtoE2eUserGarmentProbe.test.js.
 */
export const NOT_DISPATCHED_FAILURE_CODES = Object.freeze([
  'authorization_failed',
  'feature_disabled',
  'entitlement_required',
  'unsupported_category',
  'invalid_person_input',
  'invalid_garment_input',
  'quota_exhausted',
]);

function check(name, ok, detail) {
  return { name, ok, detail: detail ?? (ok ? 'pass' : 'unexpected result') };
}

function firstRow(rows) {
  return Array.isArray(rows) ? rows[0] : rows;
}

function describe(res) {
  return `httpStatus=${res?.status ?? 'none'} code=${res?.json?.error?.code ?? 'none'} `
    + `status=${res?.json?.status ?? 'none'} requestId=${res?.json?.requestId ?? 'none'}`;
}

function refusedAs(res, code, { status, requestId } = {}) {
  return Boolean(res)
    && res.json?.status === 'failed'
    && res.json?.error?.code === code
    && !res.json?.result
    && (status === undefined || res.status === status)
    && (requestId === undefined || res.json?.requestId === requestId);
}

/**
 * The zero-spend rule, enforced on every dry-run request before it is sent.
 * A body may go out only if it CANNOT reach the provider however the server
 * treats the rest of it: it names an unsupported category (refused at
 * eligibility), or it carries no person (refused at person input). Both
 * refusals sit before the reservation and the provider call.
 */
export function assertCannotReachProvider(body) {
  const unsupportedCategory = body?.garment?.category === UNSUPPORTED_PROBE_CATEGORY;
  const noPerson = !body || !('person' in body);
  if (!unsupportedCategory && !noPerson) {
    throw new Error('zero-spend guard: refusing to send a dry-run request that could reach the provider');
  }
}

async function actorReservationRows(runSql, userId) {
  const row = firstRow(await runSql(
    `select count(*) as n from public.vto_generation_requests where user_id = ${sqlQuote(userId)}::uuid;`,
  ));
  return Number(row?.n ?? 0);
}

/** The server's own feature control row, read (never written) so a run can
 *  say what staging was configured to do. Holds no credential. */
export async function readVtoFeatureControl(runSql) {
  const row = firstRow(await runSql(`select value from public.app_config where key = 'vto_generation';`));
  let value = row?.value ?? null;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { value = null; }
  }
  if (!value || typeof value !== 'object') return { readable: false, enabled: false, provider: null, supportedCategories: [] };
  return {
    readable: true,
    enabled: value.enabled === true,
    provider: typeof value.provider === 'string' ? value.provider : null,
    supportedCategories: Array.isArray(value.supportedCategories) ? value.supportedCategories.filter((c) => typeof c === 'string') : [],
  };
}

const DRY_RUN_SKIPPED = 'skipped -- an earlier prerequisite of this run did not hold';

/**
 * ZERO-SPEND contract probe. Returns the control outcomes plus the grant id it
 * holds (already revoked on the normal path) so the caller's cleanup can
 * revoke again through the authority if this function threw part-way.
 */
export async function runUserGarmentDryRun({
  base, publishableKey, accessToken, userId, runSql, runTag, grantKey,
  post = callVtoGenerate, postRaw = defaultPostRaw,
}) {
  assertNotProductionUrl(base);
  const results = [];
  const state = { grantId: null, revoked: false };
  const sizeEvidence = {};

  const send = (body) => {
    assertCannotReachProvider(body);
    return post({ base, publishableKey, accessToken, body, timeoutMs: 90_000 });
  };
  let sequence = 0;
  const nextIds = (label) => {
    sequence += 1;
    // Every request id starts with the run tag, so the log audit can find
    // exactly this run's lines and nobody else's.
    return { requestId: `${runTag}-${sequence}-${label}`.slice(0, 64), requestGeneration: `${runTag}-ug-${sequence}`.slice(0, 64) };
  };

  const committed = loadCommittedUserGarment();
  const person = buildFixture({
    seedLabel: `kscan-vto-user-garment-person:${runTag}`,
    width: PERSON_FIXTURE_WIDTH,
    height: PERSON_FIXTURE_HEIGHT,
  });
  const refusedByCategory = (garment, label, personDataUri = person.dataUri, extra = {}) => buildUserGarmentBody({
    ...nextIds(label), origin: 'elise', garment, category: UNSUPPORTED_PROBE_CATEGORY, personDataUri, extra,
  });

  // -- K+ is decided by the canonical authority, and nothing else ----------
  const beforeGrant = await send(refusedByCategory(committed, 'no-kplus'));
  results.push(check(
    'no K+ grant -> entitlement_required before any garment work',
    refusedAs(beforeGrant, 'entitlement_required', { status: 403 }),
    describe(beforeGrant),
  ));

  const grant = await grantSyntheticKPlus(runSql, userId, grantKey);
  state.grantId = grant.grantId;
  const activeAfterGrant = grant.grantId ? await readCanonicalKPlusAccess(runSql, userId) : false;
  const granted = grant.outcome === 'granted' && grant.accessAfter && activeAfterGrant;
  results.push(check(
    'K+ granted through the canonical authority (grant_kplus_complimentary); the server predicate reads active',
    granted,
    `outcome=${grant.outcome} reason=${grant.reason ?? 'none'} accessAfter=${grant.accessAfter} kplus_has_active_entitlement=${activeAfterGrant}`,
  ));

  if (!granted) {
    for (const name of DRY_RUN_GRANTED_CONTROL_NAMES) results.push(check(name, false, DRY_RUN_SKIPPED));
  } else {
    // -- An accepted garment, proved without a reservation -----------------
    const acceptedIds = nextIds('accepted');
    const accepted = await send(buildUserGarmentBody({
      ...acceptedIds, origin: 'elise', garment: committed, category: NON_CANONICAL_SUPPORTED_LABEL,
    }));
    results.push(check(
      DRY_RUN_GRANTED_CONTROL_NAMES[0],
      refusedAs(accepted, 'invalid_person_input', { status: 422, requestId: acceptedIds.requestId }),
      `${describe(accepted)} (garment bounds + recomputed hash passed, "${NON_CANONICAL_SUPPORTED_LABEL}" canonicalized to a supported category, refused only for the absent person)`,
    ));

    // -- Origin is a label: it changes nothing ------------------------------
    const originOutcomes = [];
    for (const origin of ['dev_harness', 'commerce_product', 'not-a-known-origin']) {
      const ids = nextIds('origin');
      const res = await send(buildUserGarmentBody({
        ...ids, origin, garment: committed, category: NON_CANONICAL_SUPPORTED_LABEL,
      }));
      originOutcomes.push({ origin, same: refusedAs(res, 'invalid_person_input', { status: 422, requestId: ids.requestId }), seen: describe(res) });
    }
    results.push(check(
      DRY_RUN_GRANTED_CONTROL_NAMES[1],
      originOutcomes.every((entry) => entry.same),
      originOutcomes.map((entry) => `${entry.origin}: ${entry.seen}`).join(' | '),
    ));

    // -- The garment is validated on its own bytes --------------------------
    const flipped = committed.contentHash.replace(/^./, (c) => (c === '0' ? '1' : '0'));
    const nonJpeg = Buffer.from(jpegShapedBytes(4096, 'not-jpeg'));
    nonJpeg[0] = 0x89; nonJpeg[1] = 0x50; nonJpeg[2] = 0x4e; nonJpeg[3] = 0x47;
    const nonJpegGarment = userGarmentFromBytes(nonJpeg);
    const pngLabelled = { ...committed, dataUri: committed.dataUri.replace(USER_GARMENT_MEDIA_PREFIX, 'data:image/png;base64,') };
    const malformed = { ...committed, dataUri: `${committed.dataUri.slice(0, -8)}****${committed.dataUri.slice(-4)}` };
    const tooSmall = userGarmentFromBytes(jpegShapedBytes(INLINE_GARMENT_MIN_BYTES - 1, 'too-small'));
    const overEncoded = userGarmentFromBytes(jpegShapedBytes(LARGEST_ENCODABLE_GARMENT_BYTES + 3, 'over-encoded'));
    const garmentRefusals = [
      [DRY_RUN_GRANTED_CONTROL_NAMES[2], { ...committed, source: { ...committed.source, contentHash: flipped } }],
      [DRY_RUN_GRANTED_CONTROL_NAMES[3], { ...committed, source: { ...committed.source, contentHashVersion: 'sha256-unknown-v0' } }],
      [DRY_RUN_GRANTED_CONTROL_NAMES[4], pngLabelled],
      [DRY_RUN_GRANTED_CONTROL_NAMES[5], malformed],
      [DRY_RUN_GRANTED_CONTROL_NAMES[6], nonJpegGarment],
      [DRY_RUN_GRANTED_CONTROL_NAMES[7], tooSmall],
      [DRY_RUN_GRANTED_CONTROL_NAMES[8], overEncoded],
    ];
    for (const [name, garment] of garmentRefusals) {
      // Unsupported category AND an invalid garment: the garment is checked
      // first, so `invalid_garment_input` here is the garment's own refusal.
      const res = await send(refusedByCategory(garment, 'garment'));
      results.push(check(name, refusedAs(res, 'invalid_garment_input', { status: 422 }), describe(res)));
    }
    sizeEvidence.overEncodedGarmentChars = overEncoded.dataUri.length;

    // -- A request that is not JSON gets nowhere ----------------------------
    const raw = await postRaw({ base, publishableKey, accessToken, rawBody: '{"garment":{"source":' });
    results.push(check(
      DRY_RUN_GRANTED_CONTROL_NAMES[9],
      raw.status >= 400 && raw.status < 500 && raw.json?.status === 'failed' && !raw.json?.result,
      describe(raw),
    ));

    // -- Request size, to the exact character -------------------------------
    const ordinary = await send(refusedByCategory(committed, 'size-ordinary'));
    sizeEvidence.ordinary = { garment: userGarmentEvidence(committed), person: fixtureEvidence(person) };
    results.push(check(
      DRY_RUN_GRANTED_CONTROL_NAMES[10],
      refusedAs(ordinary, 'unsupported_category', { status: 422 }),
      `${describe(ordinary)} garmentBytes=${committed.byteLength}`,
    ));

    const largeGarment = userGarmentFromBytes(jpegShapedBytes(1_500_000, 'large'));
    const largeBody = refusedByCategory(largeGarment, 'size-large', personShapedDataUri(1_200_023, 'large'));
    const large = await send(largeBody);
    sizeEvidence.largeBodyChars = JSON.stringify(largeBody).length;
    results.push(check(
      DRY_RUN_GRANTED_CONTROL_NAMES[11],
      refusedAs(large, 'unsupported_category', { status: 422 }),
      `${describe(large)} bodyChars=${sizeEvidence.largeBodyChars}`,
    ));

    const maxGarment = userGarmentFromBytes(jpegShapedBytes(LARGEST_ENCODABLE_GARMENT_BYTES, 'ceiling'));
    const maxPerson = personShapedDataUri(PERSON_PAYLOAD_MAX_CHARS - 1, 'ceiling');
    const atCeilingBody = padBodyToChars(refusedByCategory(maxGarment, 'size-ceiling', maxPerson), INLINE_BODY_MAX_CHARS);
    const atCeiling = await send(atCeilingBody);
    sizeEvidence.ceiling = {
      bodyChars: JSON.stringify(atCeilingBody).length,
      contractCeilingChars: INLINE_BODY_MAX_CHARS,
      garmentChars: maxGarment.dataUri.length,
      garmentCeilingChars: GARMENT_PAYLOAD_MAX_CHARS,
      garmentBytes: maxGarment.byteLength,
      personChars: maxPerson.length,
    };
    const atCeilingOk = refusedAs(atCeiling, 'unsupported_category', { status: 422 });
    results.push(check(DRY_RUN_GRANTED_CONTROL_NAMES[12], atCeilingOk, `${describe(atCeiling)} bodyChars=${sizeEvidence.ceiling.bodyChars}`));

    const overCeilingBody = padBodyToChars(refusedByCategory(maxGarment, 'size-over', maxPerson), INLINE_BODY_MAX_CHARS + 1);
    const overCeiling = await send(overCeilingBody);
    const overCeilingOk = refusedAs(overCeiling, 'invalid_person_input', { status: 422, requestId: 'unlabelled' });
    results.push(check(DRY_RUN_GRANTED_CONTROL_NAMES[13], overCeilingOk, `${describe(overCeiling)} bodyChars=${INLINE_BODY_MAX_CHARS + 1}`));
    sizeEvidence.nearCeilingRuntimeProof = atCeilingOk && overCeilingOk ? 'PASS' : 'FAIL';

    // The larger ceiling is bought only by NAMING the inline source.
    const legacyIds = nextIds('size-legacy');
    const legacyBody = padBodyToChars({
      ...legacyIds,
      origin: 'commerce_product',
      garment: { imageUrl: 'https://example.com/garment.jpg', category: UNSUPPORTED_PROBE_CATEGORY, productRef: 'vto-user-garment-probe-legacy' },
      person: { dataUri: maxPerson },
    }, LEGACY_BODY_MAX_CHARS + 1);
    const legacy = await send(legacyBody);
    results.push(check(
      DRY_RUN_GRANTED_CONTROL_NAMES[14],
      refusedAs(legacy, 'invalid_person_input', { status: 422, requestId: 'unlabelled' }),
      `${describe(legacy)} bodyChars=${LEGACY_BODY_MAX_CHARS + 1}`,
    ));

    // -- Revocation through the authority takes effect ----------------------
    const revoke = await revokeSyntheticKPlus(runSql, userId, grant.grantId);
    state.revoked = revoke.outcome === 'revoked';
    const activeAfterRevoke = await readCanonicalKPlusAccess(runSql, userId);
    results.push(check(
      DRY_RUN_GRANTED_CONTROL_NAMES[15],
      revoke.outcome === 'revoked' && !revoke.accessAfter && !activeAfterRevoke,
      `outcome=${revoke.outcome} accessAfter=${revoke.accessAfter} kplus_has_active_entitlement=${activeAfterRevoke}`,
    ));
    const afterRevoke = await send(refusedByCategory(committed, 'revoked'));
    results.push(check(
      DRY_RUN_GRANTED_CONTROL_NAMES[16],
      refusedAs(afterRevoke, 'entitlement_required', { status: 403 }),
      describe(afterRevoke),
    ));
  }

  // -- Nothing was reserved, so nothing was spent ----------------------------
  const reservationRows = await actorReservationRows(runSql, userId);
  results.push(check(
    'zero spend: the actor holds no reservation row after the whole run',
    reservationRows === 0,
    `vto_generation_requests rows for this actor = ${reservationRows}`,
  ));

  return {
    results,
    grantId: state.grantId,
    grantRevoked: state.revoked,
    sizeEvidence,
    realProviderSubmits: 0,
    paidGenerations: 0,
  };
}

/** The controls that run only once K+ is granted. Named in one place so a
 *  skipped run reports the same identities a full one does, and so the matrix
 *  is pinned by __tests__/vtoE2eUserGarmentProbe.test.js. */
export const DRY_RUN_GRANTED_CONTROL_NAMES = Object.freeze([
  'valid garment + non-canonical supported category label is ACCEPTED (refused only at person input, before any reservation)',
  'origin is bounded metadata: every origin label gets the identical outcome',
  'content hash that does not match the bytes -> invalid_garment_input',
  'unknown content hash version -> invalid_garment_input',
  'unsupported media type (PNG label) -> invalid_garment_input',
  'malformed Base64 -> invalid_garment_input',
  'payload labelled JPEG that is not one -> invalid_garment_input',
  'decoded garment under the minimum byte bound -> invalid_garment_input',
  'garment over the encoded-size ceiling -> invalid_garment_input',
  'malformed (non-JSON) body -> refused, no result',
  'ordinary request body is accepted at the contract boundary',
  'large request body is accepted at the contract boundary',
  'request body EXACTLY at the inline ceiling is accepted at the contract boundary',
  'request body one character over the inline ceiling is refused before it is read',
  'the larger ceiling is bought only by naming the inline source (legacy ceiling + 1 refused)',
  'K+ revoked through the canonical authority (revoke_kplus_grant); the server predicate reads inactive',
  'revoked K+ -> entitlement_required',
]);

/** Total controls a complete dry run reports. */
export const DRY_RUN_CONTROL_COUNT = DRY_RUN_GRANTED_CONTROL_NAMES.length + 3;

async function defaultPostRaw({ base, publishableKey, accessToken, rawBody }) {
  return request(edgeUrl(base, 'vto-generate'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: publishableKey,
      'Content-Type': 'application/json',
    },
    body: rawBody,
    timeoutMs: 60_000,
  });
}

function durationBucket(ms) {
  if (ms < 5_000) return 'under_5s';
  if (ms < 15_000) return '5s_15s';
  if (ms < 30_000) return '15s_30s';
  if (ms < 45_000) return '30s_45s';
  if (ms < 90_000) return '45s_90s';
  return 'over_90s';
}

async function reservationStatus(runSql, userId, idempotencyKey) {
  const row = firstRow(await runSql(
    `select status from public.vto_generation_requests `
    + `where user_id = ${sqlQuote(userId)}::uuid and idempotency_key = ${sqlQuote(idempotencyKey)};`,
  ));
  return typeof row?.status === 'string' ? row.status : null;
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

/**
 * THE ONE PAID REQUEST.
 *
 * Everything that can be established without spending is established first
 * and, if any of it does not hold, the function returns WITHOUT sending: the
 * budget is untouched and the reason is in the report. Once the request is
 * sent it is never sent again -- not on a timeout, not on a 5xx, not on a
 * failed assertion.
 */
export async function runUserGarmentCertification({
  base, publishableKey, accessToken, userId, runSql, runTag, grantKey,
  post = callVtoGenerate, timeoutMs = 120_000, now = () => Date.now(),
}) {
  assertNotProductionUrl(base);
  const results = [];
  const proof = {
    AUTHENTICATED_ACTOR: 'FAIL',
    CANONICAL_KPLUS: 'FAIL',
    VTO_FEATURE_CONTROL: 'FAIL',
    USER_SUPPLIED_GARMENT_SOURCE: 'FAIL',
    GARMENT_PAYLOAD_ACCEPTED: 'FAIL',
    SERVER_CATEGORY_CANONICALIZATION: 'FAIL',
    HASH_CORRELATION: 'FAIL',
    QUOTA_RESERVATION: 'FAIL',
    PROVIDER_DISPATCH: 0,
    PROVIDER_RESULT_NONEMPTY: 'FAIL',
    RESULT_CONTRACT_VALID: 'FAIL',
    // Decided by the separate log audit, which can be re-run at no cost.
    NO_RAW_IMAGE_LOGGING: 'PENDING_LOG_AUDIT',
  };
  const outcome = {
    results,
    proof,
    grantId: null,
    requestsSent: 0,
    budgetUsed: 0,
    dispatchClassification: 'not_sent',
    paidRetryAttempted: false,
    finalResultValidation: 'FAIL',
    reservationSettlement: null,
    httpStatusClass: null,
    totalRequestDurationBucket: null,
    requestIdSent: null,
    windowStartedAt: new Date(now()).toISOString(),
    windowEndedAt: null,
    evidence: null,
    featureControl: null,
    garmentEvidence: null,
    personEvidence: null,
  };
  const finish = () => {
    outcome.windowEndedAt = new Date(now()).toISOString();
    return outcome;
  };

  // -- Preconditions: none of this spends ------------------------------------
  const garment = loadCommittedUserGarment();
  outcome.garmentEvidence = userGarmentEvidence(garment);
  const person = buildFixture({
    seedLabel: `kscan-vto-user-garment-cert-person:${runTag}`,
    width: PERSON_FIXTURE_WIDTH,
    height: PERSON_FIXTURE_HEIGHT,
  });
  outcome.personEvidence = fixtureEvidence(person);

  const featureControl = await readVtoFeatureControl(runSql);
  outcome.featureControl = featureControl;
  const controlReady = featureControl.readable && featureControl.enabled
    && featureControl.provider === EXPECTED_REAL_PROVIDER
    && featureControl.supportedCategories.includes(CERTIFICATION_CATEGORY);
  results.push(check(
    'staging feature control: enabled, names the real provider, supports the category (read only -- never changed by this probe)',
    controlReady,
    `readable=${featureControl.readable} enabled=${featureControl.enabled} provider=${featureControl.provider ?? 'none'} `
    + `supportedCategories=${JSON.stringify(featureControl.supportedCategories)}`,
  ));
  if (!controlReady) return finish();

  const grant = await grantSyntheticKPlus(runSql, userId, grantKey);
  outcome.grantId = grant.grantId;
  const active = grant.grantId ? await readCanonicalKPlusAccess(runSql, userId) : false;
  const granted = grant.outcome === 'granted' && grant.accessAfter && active;
  results.push(check(
    'K+ granted through the canonical authority (grant_kplus_complimentary); the server predicate reads active',
    granted,
    `outcome=${grant.outcome} reason=${grant.reason ?? 'none'} accessAfter=${grant.accessAfter} kplus_has_active_entitlement=${active}`,
  ));
  if (!granted) return finish();

  // -- The request -----------------------------------------------------------
  const requestId = `${runTag}-cert`.slice(0, 64);
  const requestGeneration = `${runTag}-ug-cert`.slice(0, 64);
  const body = buildUserGarmentBody({
    requestId, origin: 'elise', garment, category: CERTIFICATION_CATEGORY, personDataUri: person.dataUri, requestGeneration,
  });
  outcome.requestIdSent = requestId;
  outcome.requestBodyChars = JSON.stringify(body).length;

  let dispatches = 0;
  const dispatchOnce = (args) => {
    if (dispatches >= MAX_REAL_VTO_PROVIDER_DISPATCHES) {
      throw new Error('hard cap: this run has already sent its one request that can reach the provider');
    }
    dispatches += 1;
    return post(args);
  };

  const startedAt = now();
  let response = null;
  let transportError = null;
  try {
    response = await dispatchOnce({ base, publishableKey, accessToken, body, timeoutMs });
  } catch (err) {
    // No readable response. The request left this process, so it is counted.
    transportError = err?.name === 'AbortError' ? 'client_timeout' : 'transport_error';
  }
  outcome.requestsSent = dispatches;
  outcome.totalRequestDurationBucket = durationBucket(now() - startedAt);

  const json = response?.json ?? null;
  const failureCode = typeof json?.error?.code === 'string' ? json.error.code : null;
  const evidence = response ? sanitizeVtoResponse(response) : { httpStatus: null, status: null, errorCode: transportError };
  const echoedSource = json?.garmentSource && typeof json.garmentSource === 'object' ? json.garmentSource : null;
  evidence.requestIdEchoed = json?.requestId === requestId;
  evidence.garmentSource = echoedSource ? {
    type: typeof echoedSource.type === 'string' ? echoedSource.type : null,
    contentHash: typeof echoedSource.contentHash === 'string' ? echoedSource.contentHash : null,
    contentHashVersion: typeof echoedSource.contentHashVersion === 'string' ? echoedSource.contentHashVersion : null,
  } : null;
  outcome.evidence = evidence;
  outcome.httpStatusClass = response ? `${Math.floor(response.status / 100)}xx` : null;

  const succeeded = Boolean(response) && response.status >= 200 && response.status < 300 && evidence.status === 'success';
  const notDispatched = Boolean(response) && !succeeded && NOT_DISPATCHED_FAILURE_CODES.includes(failureCode);
  outcome.dispatchClassification = succeeded ? 'dispatched' : notDispatched ? 'refused_before_provider' : 'counted_as_dispatched';
  outcome.budgetUsed = notDispatched ? 0 : 1;
  proof.PROVIDER_DISPATCH = outcome.budgetUsed;

  // -- What the response and the database establish ---------------------------
  // A refusal that does not carry this request's own id happened before the
  // body was read as a request, so it establishes nothing about identity.
  const pastIdentity = Boolean(response) && evidence.requestIdEchoed && failureCode !== 'authorization_failed';
  proof.AUTHENTICATED_ACTOR = pastIdentity ? 'PASS' : 'FAIL';
  proof.VTO_FEATURE_CONTROL = pastIdentity && failureCode !== 'feature_disabled' ? 'PASS' : 'FAIL';
  proof.CANONICAL_KPLUS = pastIdentity && !['feature_disabled', 'entitlement_required'].includes(failureCode) ? 'PASS' : 'FAIL';

  const sourceEchoed = evidence.garmentSource?.type === USER_GARMENT_SOURCE_TYPE;
  const hashEchoed = evidence.garmentSource?.contentHash === garment.contentHash
    && evidence.garmentSource?.contentHashVersion === USER_GARMENT_HASH_VERSION;
  proof.USER_SUPPLIED_GARMENT_SOURCE = succeeded && sourceEchoed ? 'PASS' : 'FAIL';
  proof.GARMENT_PAYLOAD_ACCEPTED = succeeded ? 'PASS' : 'FAIL';
  // A request under `top` only generates if the server's own eligibility
  // authority resolved it to a supported slot; the canonical category the
  // server logged for this request id is read back by the log audit.
  proof.SERVER_CATEGORY_CANONICALIZATION = succeeded ? 'PASS' : 'FAIL';

  const identity = userGarmentReservationIdentity(garment.contentHash);
  const idempotencyKey = computeVtoIdempotencyKey({
    userId, productRef: identity.productRef, garmentImageUrl: identity.garmentImageUrl,
    personDataUri: person.dataUri, requestGeneration,
  });
  outcome.reservationSettlement = await reservationStatus(runSql, userId, idempotencyKey);
  // The row is found under an identity the harness derived from the garment's
  // own fingerprint, so finding it is itself the correlation.
  proof.HASH_CORRELATION = succeeded && hashEchoed && outcome.reservationSettlement !== null ? 'PASS' : 'FAIL';
  proof.QUOTA_RESERVATION = outcome.reservationSettlement === 'succeeded' ? 'PASS' : 'FAIL';

  const result = evidence.result ?? null;
  proof.PROVIDER_RESULT_NONEMPTY = succeeded && result?.hasNonEmptyMedia === true ? 'PASS' : 'FAIL';
  const contractValid = succeeded
    && evidence.requestIdEchoed
    && evidence.provider === EXPECTED_REAL_PROVIDER
    && result?.isAiVisualization === true
    && typeof result?.mediaType === 'string' && result.mediaType.startsWith('image/')
    && isPositiveInteger(result?.width) && isPositiveInteger(result?.height);
  proof.RESULT_CONTRACT_VALID = contractValid ? 'PASS' : 'FAIL';

  results.push(check('exactly one request sent; no retry of any kind', dispatches === 1, `requestsSent=${dispatches} paidRetryAttempted=false`));
  results.push(check(
    'authenticated K+ actor -> deployed vto-generate -> real provider: success',
    succeeded,
    succeeded ? `httpStatus=${response.status} status=success provider=${evidence.provider}` : JSON.stringify({ ...evidence, result: undefined }),
  ));
  results.push(check(
    'the response names the neutral source and the fingerprint the garment was sent under',
    sourceEchoed && hashEchoed,
    `garmentSource.type=${evidence.garmentSource?.type ?? 'none'} hashMatchesFixture=${hashEchoed}`,
  ));
  results.push(check(
    'the reservation is settled succeeded under the identity derived from the garment fingerprint (direct DB proof)',
    proof.QUOTA_RESERVATION === 'PASS',
    `vto_generation_requests.status = ${JSON.stringify(outcome.reservationSettlement)}`,
  ));
  results.push(check(
    'the result is a non-empty, well-formed AI visualization from the expected provider',
    proof.PROVIDER_RESULT_NONEMPTY === 'PASS' && contractValid,
    result ? `mediaType=${result.mediaType} width=${result.width} height=${result.height} approxResultBytes=${result.approxResultBytes}` : 'no result',
  ));

  outcome.finalResultValidation = results.every((entry) => entry.ok) ? 'PASS' : 'FAIL';
  return finish();
}
