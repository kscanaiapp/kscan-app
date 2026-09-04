/**
 * staging-dryrun mode (spec Phase 5 / §9). Drives the real deployed
 * vto-generate against a controlled fixture that is guaranteed to fail
 * media validation BEFORE any AILabTools submit — auth, entitlement,
 * reservation, provider-adapter and release wiring are all exercised for
 * real; REAL PROVIDER SUBMIT stays 0 for the whole run.
 */
'use strict';

import { callVtoGenerate } from './client.mjs';
import { computeVtoIdempotencyKey } from './idempotency.mjs';
import { buildVtoFixtures, fixtureEvidence } from './fixtures.mjs';
import { sanitizeVtoResponse } from './report.mjs';
import { sqlQuote } from './sql.mjs';

/** A public, pinned-commit, non-image URL: passes topology validation
 *  (public HTTPS host, default port, no credentials) but is not an image,
 *  so the provider adapter's own content-type check rejects it BEFORE any
 *  submit is sent — the non-billable, pre-submit path spec §9.3 requires. */
const ZERO_SPEND_GARMENT_URL =
  'https://raw.githubusercontent.com/kscanaiapp/kscan-app/4af92f4c6fe9ecb4c5b1221c26e8dc465971d61d/package.json';

/** Passes no network hop at all — assertSafeRemoteMediaUrl rejects it as a
 *  string, synchronously, before any fetch. Used only for the "unsafe
 *  initial URL" negative control; never dialed. */
const UNSAFE_TOPOLOGY_GARMENT_URL = 'https://169.254.169.254/latest/meta-data/';

const CATEGORY = 'top';
const PRODUCT_REF = 'vto-e2e-fixture-product';

function baseBody({ garmentImageUrl, personDataUri, requestGeneration }) {
  return {
    requestId: `vto-e2e-${requestGeneration}`,
    origin: 'dev_harness',
    garment: { imageUrl: garmentImageUrl, category: CATEGORY, productRef: PRODUCT_REF },
    person: { dataUri: personDataUri },
    requestGeneration,
  };
}

function check(name, ok, detail) {
  return { name, ok, detail: detail ?? (ok ? 'pass' : 'unexpected result') };
}

async function vtoRequestRowCount(runSql, userId, idempotencyKey) {
  const rows = await runSql(
    `select count(*)::int as n from public.vto_generation_requests `
    + `where user_id = ${sqlQuote(userId)} and idempotency_key = ${sqlQuote(idempotencyKey)};`,
  );
  const row = Array.isArray(rows) ? rows[0] : rows;
  return Number(row?.n ?? 0);
}

/** The reservation's own recorded state, or null when no row exists. Used by
 *  the duplicate-suppression control to PROVE the precondition it depends on
 *  (an in_flight reservation) rather than assuming a prior request left one
 *  behind — see runDuplicateSuppressionControl. */
async function vtoReservationStatus(runSql, userId, idempotencyKey) {
  const rows = await runSql(
    `select status from public.vto_generation_requests `
    + `where user_id = ${sqlQuote(userId)} and idempotency_key = ${sqlQuote(idempotencyKey)} limit 1;`,
  );
  const row = Array.isArray(rows) ? rows[0] : rows;
  return typeof row?.status === 'string' ? row.status : null;
}

/** Calls release_vto_generation directly via the governed SQL session — the
 *  RPC is service_role-only and not reachable from a normal client request,
 *  so proving "second release is a no-op" and "foreign actor cannot release
 *  another actor's reservation" needs the same privileged path the RPC
 *  privilege matrix itself calls for (spec §5: "prefer a governed linked
 *  staging SQL session ... rather than exporting a service-role key"). */
async function callReleaseRpc(runSql, userId, idempotencyKey) {
  const rows = await runSql(
    `select public.release_vto_generation(${sqlQuote(userId)}, ${sqlQuote(idempotencyKey)}, null) as released;`,
  );
  const row = Array.isArray(rows) ? rows[0] : rows;
  const value = row?.released;
  return value === true || value === 't' || value === 'true';
}

async function callReserveRpc(runSql, userId, idempotencyKey) {
  await runSql(
    `select * from public.reserve_vto_generation(${sqlQuote(userId)}, ${sqlQuote(idempotencyKey)}, 10, 5);`,
  );
}

/** The requirements VTO-CERT-012 enforces, named so the control can report
 *  exactly which one failed and so none can be quietly dropped: the list is
 *  pinned by an integrity test, and every entry must be evaluated below. */
export const REQ = Object.freeze({
  SEEDED_IN_FLIGHT: 'reservation is in_flight before the HTTP request',
  HTTP_429: 'HTTP 429',
  CODE_RATE_LIMITED: 'error.code = rate_limited',
  NO_PROVIDER_RESULT: 'suppressed response carries no provider result',
  RESERVATION_SURVIVES: 'the prior reservation survives the suppression',
  SINGLE_ROW: 'exactly one reservation row for the identity',
  RIGHTFUL_RELEASE: 'rightful actor releases the pre-seeded reservation',
  ROW_GONE: 'reservation row is gone after release',
});

export const DUPLICATE_CONTROL_REQUIREMENTS = Object.freeze(Object.values(REQ));

export const DUPLICATE_CONTROL_NAME = 'rapid duplicate: one reservation authority, duplicate suppressed';

/**
 * VTO-CERT-012 — duplicate suppression, proved DETERMINISTICALLY.
 *
 * DEFECT THIS REPLACES (staging-dryrun run vto-dryrun-20260904T191038Z-3a3db107,
 * authority 3c00804: 12/13 controls passed, this one failed). The previous
 * control raced two independent HTTP requests carrying the same identity and
 * required exactly one `invalid_garment_input` and exactly one `rate_limited`.
 * The zero-spend fixture deliberately fails media validation and RELEASES its
 * reservation on the way out, so whether the second request sees an in-flight
 * row is a function of scheduling, not of correctness: it can fail a correct
 * implementation and — with the opposite interleaving — pass a broken one.
 * A nondeterministic control cannot be release authority in either direction.
 *
 * THE REPAIR. Make the PREREQUISITE deterministic while leaving the behaviour
 * under test entirely on the real product path. The reservation this request
 * must collide with is seeded ahead of time through the same governed
 * reserve_vto_generation RPC the Edge function itself calls, and is PROVEN to
 * be `in_flight` before a single normal, authenticated HTTP request is issued
 * against the real deployed vto-generate. Nothing about the HTTP path is
 * simulated, stubbed or bypassed.
 *
 * WHY 429 HERE CAN ONLY MEAN `reservation_duplicate`. `stage` is a log field,
 * not part of the governed response body (vtoHandler.ts::fail emits only
 * `{ requestId, status, error: { code, retryable } }`), and BOTH
 * `reservation_duplicate` and `reservation_quota` surface as
 * rate_limited/429 — so the code alone cannot separate them. The RPC ordering
 * does: reserve_vto_generation checks the existing row FIRST and returns
 * `duplicate` for an in-flight reservation inside its lease, before it ever
 * counts the day's attempts against the cap. With a reservation proven
 * `in_flight` immediately beforehand, `quota_exceeded` is unreachable for this
 * request, so a rate_limited/429 is necessarily the duplicate branch.
 *
 * WHY IT ALSO PROVES KEY AGREEMENT. The seeded identity is computed by the
 * harness's own mirror of buildVtoIdempotencyKey. If that mirror ever drifted
 * from the server's derivation the seeded row would not be the one the request
 * reserves under, the request would proceed to the adapter and return 422 —
 * so this control fails closed on key drift rather than silently testing
 * nothing.
 *
 * ZERO SPEND. A suppressed duplicate returns before provider resolution ever
 * submits, so no provider work and no paid request can occur on this path;
 * the control additionally asserts the response body carries no provider
 * result. Injectable `postVtoGenerate` exists solely so
 * __tests__/vtoE2eHarnessIntegrity.test.js can drive this exact function
 * against a modelled backend and its broken mutations — the live harness
 * always uses the real client.
 */
export async function runDuplicateSuppressionControl({
  base, publishableKey, accessToken, userId, personDataUri, runTag, runSql,
  postVtoGenerate = callVtoGenerate,
}) {
  const dupGen = `${runTag}-active-dup`;
  // (1) A fresh identity used for nothing else in this run.
  const dupKey = computeVtoIdempotencyKey({
    userId, productRef: PRODUCT_REF, garmentImageUrl: ZERO_SPEND_GARMENT_URL, personDataUri, requestGeneration: dupGen,
  });

  let seededStatus = null;
  let httpStatus = null;
  let httpCode = null;
  let carriedProviderResult = null;
  let statusAfterHttp = null;
  let rowsAfterHttp = null;
  let released = null;
  let rowsAfterRelease = null;

  try {
    // (2) Reserve that exact identity through the governed RPC path, and
    // (3) prove the reservation is genuinely in_flight before any HTTP.
    await callReserveRpc(runSql, userId, dupKey);
    seededStatus = await vtoReservationStatus(runSql, userId, dupKey);

    // (4) ONE normal authenticated request through the real vto-generate,
    // under the SAME identity. Never simulated, never bypassed.
    const res = await postVtoGenerate({
      base, publishableKey, accessToken,
      body: baseBody({ garmentImageUrl: ZERO_SPEND_GARMENT_URL, personDataUri, requestGeneration: dupGen }),
    });
    httpStatus = res.status;
    httpCode = res.json?.error?.code ?? null;
    // (8) A suppressed duplicate is refused before provider work: the body
    // must carry no generation result at all.
    carriedProviderResult = Boolean(res.json?.result);

    // The suppression must be a REFUSAL, not a release: the prior
    // reservation is still the one authority and there is still exactly one
    // row for this identity.
    statusAfterHttp = await vtoReservationStatus(runSql, userId, dupKey);
    rowsAfterHttp = await vtoRequestRowCount(runSql, userId, dupKey);
  } finally {
    // (6) Release the pre-seeded reservation as the RIGHTFUL actor, and
    // (7) verify the row is gone. Always attempted, so a failure earlier in
    // the control can never leave residue behind for cleanup to trip on.
    try {
      released = await callReleaseRpc(runSql, userId, dupKey);
      rowsAfterRelease = await vtoRequestRowCount(runSql, userId, dupKey);
    } catch {
      released = null;
      rowsAfterRelease = null;
    }
  }

  // (5) HTTP 429 + rate_limited, on a proven in_flight prerequisite. Every
  // requirement is named and evaluated INDIVIDUALLY rather than collapsed
  // into one boolean, so a failing run says which one was not met — and so
  // a requirement silently disappearing from this control is itself
  // detectable (see the DUPLICATE_CONTROL_REQUIREMENTS guard in
  // __tests__/vtoE2eHarnessIntegrity.test.js).
  const met = {
    [REQ.SEEDED_IN_FLIGHT]: seededStatus === 'in_flight',
    [REQ.HTTP_429]: httpStatus === 429,
    [REQ.CODE_RATE_LIMITED]: httpCode === 'rate_limited',
    [REQ.NO_PROVIDER_RESULT]: carriedProviderResult === false,
    [REQ.RESERVATION_SURVIVES]: statusAfterHttp === 'in_flight',
    [REQ.SINGLE_ROW]: rowsAfterHttp === 1,
    [REQ.RIGHTFUL_RELEASE]: released === true,
    [REQ.ROW_GONE]: rowsAfterRelease === 0,
  };
  const unmet = DUPLICATE_CONTROL_REQUIREMENTS.filter((name) => !met[name]);

  return check(
    DUPLICATE_CONTROL_NAME,
    unmet.length === 0,
    `seededStatus=${seededStatus ?? 'absent'} httpStatus=${httpStatus ?? 'none'} code=${httpCode ?? 'none'} `
    + `providerResult=${carriedProviderResult} statusAfterHttp=${statusAfterHttp ?? 'absent'} rowsAfterHttp=${rowsAfterHttp} `
    + `rightfulRelease=${released} rowsAfterRelease=${rowsAfterRelease} unmet=${JSON.stringify(unmet)} `
    + '(an in_flight reservation makes reserve_vto_generation return duplicate before it counts quota, '
    + 'so a 429 here is necessarily stage=reservation_duplicate, never reservation_quota)',
  );
}

export async function runVtoStagingDryRun({ base, publishableKey, plan, tokens, runSql, runTag }) {
  const results = [];
  const fixtures = buildVtoFixtures(runTag);
  const personDataUri = fixtures.person.dataUri;
  const activeUserId = plan.ACTIVE_KPLUS?.userId ?? null;

  // ── ACTIVE K+ reaches reservation; non-billable pre-submit failure;
  //    quota released exactly once ───────────────────────────────────────
  let activeKey1 = null;
  if (tokens.ACTIVE_KPLUS && activeUserId) {
    const gen1 = `${runTag}-active-1`;
    activeKey1 = computeVtoIdempotencyKey({
      userId: activeUserId, productRef: PRODUCT_REF, garmentImageUrl: ZERO_SPEND_GARMENT_URL, personDataUri, requestGeneration: gen1,
    });
    const body1 = baseBody({ garmentImageUrl: ZERO_SPEND_GARMENT_URL, personDataUri, requestGeneration: gen1 });
    const res1 = await callVtoGenerate({ base, publishableKey, accessToken: tokens.ACTIVE_KPLUS, body: body1 });
    results.push(check(
      'ACTIVE K+ reaches reservation (non-billable pre-submit failure)',
      res1.status === 422 && res1.json?.error?.code === 'invalid_garment_input',
      `httpStatus=${res1.status} code=${res1.json?.error?.code ?? 'none'}`,
    ));

    const rowsAfter1 = await vtoRequestRowCount(runSql, activeUserId, activeKey1);
    results.push(check(
      'non-billable pre-submit failure -> quota released exactly once',
      rowsAfter1 === 0,
      `vto_generation_requests rows for key = ${rowsAfter1} (release_vto_generation deletes a first, non-billable attempt)`,
    ));

    // second release -> no second refund (idempotent no-op via the governed RPC path)
    const secondRelease = await callReleaseRpc(runSql, activeUserId, activeKey1);
    results.push(check(
      'second release -> no second refund',
      secondRelease === false,
      `release_vto_generation on an already-released key returned ${secondRelease}`,
    ));

    // retry after valid release -> may reserve again (same inputs, same
    // requestGeneration: had the row NOT been released this would come back
    // as a suppressed duplicate instead of a second independent 422).
    const gen1Retry = gen1; // deliberately the SAME identity as the released attempt
    const body1Retry = baseBody({ garmentImageUrl: ZERO_SPEND_GARMENT_URL, personDataUri, requestGeneration: gen1Retry });
    const res1Retry = await callVtoGenerate({ base, publishableKey, accessToken: tokens.ACTIVE_KPLUS, body: body1Retry });
    results.push(check(
      'retry after valid release -> may reserve again',
      res1Retry.status === 422 && res1Retry.json?.error?.code === 'invalid_garment_input',
      `httpStatus=${res1Retry.status} code=${res1Retry.json?.error?.code ?? 'none'} (rate_limited/duplicate here would mean the release did not take)`,
    ));
    const rowsAfterRetry = await vtoRequestRowCount(runSql, activeUserId, activeKey1);
    results.push(check('retry attempt also released cleanly', rowsAfterRetry === 0, `rows=${rowsAfterRetry}`));

    // foreign actor cannot release another actor's reservation. Reserve a
    // fresh key directly via the governed RPC path (bypassing HTTP, so the
    // row is provably still in_flight when the cross-actor release is
    // attempted), then attempt the release as NEVER_ENTITLED's user id.
    const foreignCheckKey = computeVtoIdempotencyKey({
      userId: activeUserId, productRef: PRODUCT_REF, garmentImageUrl: ZERO_SPEND_GARMENT_URL, personDataUri, requestGeneration: `${runTag}-foreign-check`,
    });
    await callReserveRpc(runSql, activeUserId, foreignCheckKey);
    const neverUserId = plan.NEVER_ENTITLED?.userId ?? null;
    if (neverUserId) {
      const foreignRelease = await callReleaseRpc(runSql, neverUserId, foreignCheckKey);
      results.push(check(
        "foreign actor cannot release another actor's reservation",
        foreignRelease === false,
        `release_vto_generation(foreign_user_id, active's key) returned ${foreignRelease}`,
      ));
    } else {
      results.push(check("foreign actor cannot release another actor's reservation", false, 'NEVER_ENTITLED actor unavailable to attempt the foreign release'));
    }
    // Clean up the RPC-reserved row with its OWN actor — proves the RPC path
    // itself still works correctly for the rightful owner, and leaves no
    // extra row behind for cleanup to trip on.
    const ownRelease = await callReleaseRpc(runSql, activeUserId, foreignCheckKey);
    results.push(check('rightful actor release succeeds after the foreign attempt failed', ownRelease === true, `release returned ${ownRelease}`));
  } else {
    for (const name of [
      'ACTIVE K+ reaches reservation (non-billable pre-submit failure)',
      'non-billable pre-submit failure -> quota released exactly once',
      'second release -> no second refund',
      'retry after valid release -> may reserve again',
      "foreign actor cannot release another actor's reservation",
    ]) {
      results.push(check(name, false, 'skipped — ACTIVE_KPLUS actor did not authenticate'));
    }
  }

  // ── NEVER ENTITLED / EXPIRED K+ denied before any provider work ────────
  for (const [role, label] of [['NEVER_ENTITLED', 'NEVER ENTITLED denied before provider work'], ['EXPIRED_KPLUS', 'EXPIRED K+ denied before provider work']]) {
    if (!tokens[role]) {
      results.push(check(label, false, `skipped — ${role} actor did not authenticate`));
      continue;
    }
    const gen = `${runTag}-${role.toLowerCase()}-1`;
    const body = baseBody({ garmentImageUrl: ZERO_SPEND_GARMENT_URL, personDataUri, requestGeneration: gen });
    const res = await callVtoGenerate({ base, publishableKey, accessToken: tokens[role], body });
    results.push(check(
      label,
      res.status === 403 && res.json?.error?.code === 'entitlement_required',
      `httpStatus=${res.status} code=${res.json?.error?.code ?? 'none'}`,
    ));
    const userId = plan[role]?.userId;
    if (userId) {
      const key = computeVtoIdempotencyKey({ userId, productRef: PRODUCT_REF, garmentImageUrl: ZERO_SPEND_GARMENT_URL, personDataUri, requestGeneration: gen });
      const rows = await vtoRequestRowCount(runSql, userId, key);
      results.push(check(`${role}: no reservation row created`, rows === 0, `rows=${rows}`));
    }
  }

  // ── Duplicate suppression: deterministic, pre-seeded in-flight reservation ─
  if (tokens.ACTIVE_KPLUS && activeUserId) {
    results.push(await runDuplicateSuppressionControl({
      base,
      publishableKey,
      accessToken: tokens.ACTIVE_KPLUS,
      userId: activeUserId,
      personDataUri,
      runTag,
      runSql,
    }));
  } else {
    results.push(check(DUPLICATE_CONTROL_NAME, false, 'skipped — ACTIVE_KPLUS actor did not authenticate'));
  }

  // ── Unsafe initial garment URL — rejected before any network access ────
  if (tokens.ACTIVE_KPLUS) {
    const gen = `${runTag}-unsafe-topology`;
    const body = baseBody({ garmentImageUrl: UNSAFE_TOPOLOGY_GARMENT_URL, personDataUri, requestGeneration: gen });
    const res = await callVtoGenerate({ base, publishableKey, accessToken: tokens.ACTIVE_KPLUS, body });
    results.push(check(
      'unsafe initial garment URL rejected before network access',
      res.status === 422 && res.json?.error?.code === 'invalid_garment_input',
      `httpStatus=${res.status} code=${res.json?.error?.code ?? 'none'}`,
    ));
  } else {
    results.push(check('unsafe initial garment URL rejected before network access', false, 'skipped — ACTIVE_KPLUS actor did not authenticate'));
  }

  return {
    results,
    fixturesEvidence: { person: fixtureEvidence(fixtures.person), garment: fixtureEvidence(fixtures.garment) },
    realProviderSubmits: 0,
    paidGenerations: 0,
  };
}
