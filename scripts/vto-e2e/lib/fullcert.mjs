/**
 * staging-full-certification mode (spec Phase 12). Issues exactly ONE
 * valid billable VTO request against the real deployed vto-generate, using
 * the real AILabTools provider. No automatic retry, no valid-fixture
 * duplicate race — the idempotency race was already exercised in
 * staging-dryrun against the zero-spend fixture, never against this one.
 */
'use strict';

import { callVtoGenerate } from './client.mjs';
import { buildFixture, PERSON_FIXTURE_WIDTH, PERSON_FIXTURE_HEIGHT } from './fixtures.mjs';
import { sanitizeVtoResponse } from './report.mjs';
import { computeVtoIdempotencyKey } from './idempotency.mjs';

const CATEGORY = 'top';
const PRODUCT_REF = 'vto-e2e-full-certification-product';

/**
 * Builds the committed-asset garment URL for a given commit SHA. The asset
 * itself (scripts/vto-e2e/fixtures/garment.png) is a deterministic,
 * synthetic, non-personal 300x300 PNG committed alongside this harness —
 * see fixtures/garment.fixture.json for its seed/hash evidence. It is
 * fetched over plain public raw.githubusercontent.com, exactly the same
 * governed-asset pattern spec §9.3 recommends for the zero-spend fixture,
 * just pointed at a real image this time.
 */
export function committedGarmentUrl(commitSha, repo = 'kscanaiapp/kscan-app') {
  if (!commitSha || !/^[0-9a-f]{40}$/i.test(commitSha)) {
    throw new Error('committedGarmentUrl requires an exact 40-hex-character commit SHA — never a branch name');
  }
  return `https://raw.githubusercontent.com/${repo}/${commitSha}/scripts/vto-e2e/fixtures/garment.png`;
}

function check(name, ok, detail) {
  return { name, ok, detail: detail ?? (ok ? 'pass' : 'unexpected result') };
}

function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Direct DB proof that the reservation this call took was settled
 *  'succeeded' — never inferred from the HTTP response alone. */
async function reservationStatus(runSql, userId, idempotencyKey) {
  const rows = await runSql(
    `select status from public.vto_generation_requests `
    + `where user_id = ${sqlQuote(userId)} and idempotency_key = ${sqlQuote(idempotencyKey)};`,
  );
  const row = Array.isArray(rows) ? rows[0] : rows;
  return row?.status ?? null;
}

/**
 * @param {number} durationBucketMs - caller-supplied bucket width for the
 *   "TOTAL REQUEST DURATION BUCKET" evidence field (never the raw wall
 *   clock alone, which is meaningless without a scale).
 */
function durationBucket(ms) {
  if (ms < 5_000) return 'under_5s';
  if (ms < 15_000) return '5s_15s';
  if (ms < 30_000) return '15s_30s';
  if (ms < 45_000) return '30s_45s';
  return 'over_45s';
}

export async function runVtoFullCertification({ base, publishableKey, accessToken, userId, runSql, commitSha, runTag, timeoutMs = 55_000 }) {
  const person = buildFixture({
    seedLabel: `kscan-vto-e2e-fullcert-person:${runTag}`,
    width: PERSON_FIXTURE_WIDTH,
    height: PERSON_FIXTURE_HEIGHT,
  });
  const garmentImageUrl = committedGarmentUrl(commitSha);
  const requestGeneration = `${runTag}-fullcert-one-shot`;

  const body = {
    requestId: `vto-e2e-fullcert-${runTag}`,
    origin: 'dev_harness',
    garment: { imageUrl: garmentImageUrl, category: CATEGORY, productRef: PRODUCT_REF },
    person: { dataUri: person.dataUri },
    // A generation never reused by any other mode's requestGeneration value,
    // so this is unambiguously ONE fresh paid intent, not a replay.
    requestGeneration,
  };

  const startedAt = Date.now();
  const response = await callVtoGenerate({ base, publishableKey, accessToken, body, timeoutMs });
  const durationMs = Date.now() - startedAt;

  const evidence = sanitizeVtoResponse(response);
  const success = response.status >= 200 && response.status < 300
    && evidence.status === 'success'
    && evidence.provider === 'ailabtools_tryon_clothes_pro'
    && Boolean(evidence.result?.hasNonEmptyMedia)
    && evidence.result?.isAiVisualization === true;

  const results = [
    check('authenticated active K+ actor -> deployed vto-generate', true, `httpStatus=${response.status}`),
    check(
      'real happy path: success contract satisfied',
      success,
      success ? 'HTTP 2xx, status=success, provider=ailabtools_tryon_clothes_pro, non-empty sanitized media' : JSON.stringify(evidence),
    ),
  ];

  let settlementStatus = null;
  if (userId && runSql) {
    const idempotencyKey = computeVtoIdempotencyKey({
      userId, productRef: PRODUCT_REF, garmentImageUrl, personDataUri: person.dataUri, requestGeneration,
    });
    settlementStatus = await reservationStatus(runSql, userId, idempotencyKey);
    results.push(check(
      'reservation settled succeeded (direct DB proof, not inferred from the HTTP response)',
      settlementStatus === 'succeeded',
      `vto_generation_requests.status = ${JSON.stringify(settlementStatus)}`,
    ));
  }

  return {
    results,
    requestsSent: 1,
    httpStatusClass: `${Math.floor(response.status / 100)}xx`,
    totalRequestDurationBucket: durationBucket(durationMs),
    finalResultValidation: success && settlementStatus === 'succeeded' ? 'PASS' : 'FAIL',
    reservationSettlement: settlementStatus,
    paidRetryAttempted: false,
    evidence,
  };
}
