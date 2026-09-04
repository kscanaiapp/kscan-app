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

  // ── Rapid duplicate: same actor, same requestGeneration, same intent ───
  if (tokens.ACTIVE_KPLUS) {
    const dupGen = `${runTag}-active-dup`;
    const dupBody = baseBody({ garmentImageUrl: ZERO_SPEND_GARMENT_URL, personDataUri, requestGeneration: dupGen });
    const [dupA, dupB] = await Promise.all([
      callVtoGenerate({ base, publishableKey, accessToken: tokens.ACTIVE_KPLUS, body: dupBody }),
      callVtoGenerate({ base, publishableKey, accessToken: tokens.ACTIVE_KPLUS, body: dupBody }),
    ]);
    const codes = [dupA.json?.error?.code, dupB.json?.error?.code];
    const oneReachedProvider = codes.filter((c) => c === 'invalid_garment_input').length === 1;
    const oneSuppressed = codes.filter((c) => c === 'rate_limited').length === 1;
    results.push(check(
      'rapid duplicate: one reservation authority, duplicate suppressed',
      oneReachedProvider && oneSuppressed,
      `codes=${JSON.stringify(codes)}`,
    ));
  } else {
    results.push(check('rapid duplicate: one reservation authority, duplicate suppressed', false, 'skipped — ACTIVE_KPLUS actor did not authenticate'));
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
