#!/usr/bin/env node
// @ts-check
'use strict';

/**
 * Governed E4.1 Room Intelligence staging live probe.
 *
 * WHY THIS EXISTS: every other E4.1 gate is a source test. Source tests prove
 * the manifest is built correctly from evidence they themselves supply; they
 * cannot prove that a real authenticated request, against a real Dressing Room,
 * through the deployed function, produces a grounded answer. Room Intelligence
 * is the one Build 29 feature whose correctness lives in the interaction
 * between authorization, the manifest and the model — so it is the one that
 * source tests certify least.
 *
 * This probe exercises the real path end to end:
 *
 *   synthetic authenticated user
 *          -> owned / shared Dressing Room fixture
 *          -> authorized room + item references
 *          -> deployed stylechat-generate
 *          -> server-authoritative room manifest
 *          -> Gemini
 *          -> behavioural assertions
 *
 * FAIL-CLOSED BY CONSTRUCTION:
 *   - the project ref is asserted through environment-authority.js, never an
 *     input, so a typo cannot point this at production;
 *   - the Supabase URL is asserted not-production by the same helper the other
 *     governed probes use;
 *   - the function path is a literal string;
 *   - fixtures are created under an obvious synthetic marker and torn down;
 *   - evidence is a narrow allowlist, and is privacy-asserted before emission.
 *
 * WHAT IT NEVER EMITS: raw prompts, raw model responses, image bytes, signed
 * URLs, tokens, emails, or room contents. Behavioural comparison happens in
 * memory; only PASS/FAIL and safe reason codes leave this process.
 */

const authority = require('../scripts/lib/environment-authority.js');
const { assertNotProductionUrl, signInSyntheticUser, maskLine } = require('../scripts/synthetic-auth');
const assertions = require('./e41-behavior-assertions.js');
const matrix = require('./e41-behavior-matrix.js');

const { assertExpectedEnvironment } = authority;

const STYLECHAT_PATH = '/functions/v1/stylechat-generate';
const REST_PATH = '/rest/v1';

/** Marks every row this probe creates, so cleanup can never over-reach. */
const SYNTHETIC_MARKER = 'e41-probe';

/**
 * The certification fixture.
 *
 * Chosen so incorrect behaviour is DETECTABLE: four clearly distinct roles, one
 * per structural slot, with no accessory. That makes "what is missing" a real
 * question with a defensible answer either way, and makes any accessory the
 * model asserts as present an unambiguous foreign item.
 */
const FIXTURE_ITEMS = Object.freeze([
  { key: 'blazer', title: `Navy blazer (${SYNTHETIC_MARKER})`, category: 'outerwear', subtype: 'blazer', colors: ['navy'], materials: ['wool'] },
  { key: 'shirt', title: `White fitted shirt (${SYNTHETIC_MARKER})`, category: 'tops', subtype: 'shirt', colors: ['white'], materials: ['cotton'] },
  { key: 'trousers', title: `Dark straight-leg trousers (${SYNTHETIC_MARKER})`, category: 'bottoms', subtype: 'trousers', colors: ['charcoal'], materials: ['wool'] },
  { key: 'loafers', title: `Black leather loafers (${SYNTHETIC_MARKER})`, category: 'footwear', subtype: 'loafers', colors: ['black'], materials: ['leather'] },
]);

const REQUIRED_ENV_VARS = Object.freeze([
  'SUPABASE_STAGING_PROJECT_REF',
  'SUPABASE_STAGING_URL',
  'SUPABASE_STAGING_PUBLISHABLE_KEY',
  'STAGING_SYNTHETIC_ACTIVE_EMAIL',
  'STAGING_SYNTHETIC_ACTIVE_PASSWORD',
]);

/** Defence in depth. The primary control is emitting only allowlisted fields. */
const FORBIDDEN_EVIDENCE_PATTERNS = Object.freeze([
  /^data:/i,
  /^ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}$/,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  /^sbp_[a-f0-9]{40}$/,
  /https:\/\/[^\s]*token=/i,
]);

class E41ProbeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'E41ProbeError';
    this.code = code || 'UNKNOWN';
  }
}

function normalizeBase(url) {
  return String(url).replace(/\/+$/, '');
}

/** Literal path join. No input can change which function runs. */
function buildStyleChatUrl(supabaseUrl) {
  return `${normalizeBase(supabaseUrl)}${STYLECHAT_PATH}`;
}

function assertEvidencePrivacy(value) {
  if (typeof value === 'string') {
    for (const pattern of FORBIDDEN_EVIDENCE_PATTERNS) {
      if (pattern.test(value)) {
        throw new E41ProbeError(
          `evidence privacy assertion rejected a field value (matched ${pattern})`,
          'EVIDENCE_PRIVACY_VIOLATION',
        );
      }
    }
  } else if (Array.isArray(value)) {
    value.forEach(assertEvidencePrivacy);
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach(assertEvidencePrivacy);
  }
}

function findMissingEnvVars(env) {
  return REQUIRED_ENV_VARS.filter((name) => !env[name]);
}

function restHeaders(publishableKey, accessToken, extra) {
  const headers = {
    apikey: publishableKey,
    'Content-Type': 'application/json',
    ...(extra || {}),
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return headers;
}

// ── Fixture lifecycle ───────────────────────────────────────────────────────

/**
 * Creates the room through the normal authenticated REST path, under the
 * caller's own RLS. Deliberately NOT service-role SQL: a fixture built by
 * bypassing RLS would not prove the same rows are reachable by the user the
 * probe then authenticates as.
 */
async function createRoomFixture(ctx) {
  const roomRes = await ctx.fetchImpl(`${ctx.restBase}/dressing_rooms`, {
    method: 'POST',
    headers: restHeaders(ctx.publishableKey, ctx.accessToken, { Prefer: 'return=representation' }),
    body: JSON.stringify({ user_id: ctx.actorId, name: `E4.1 certification (${SYNTHETIC_MARKER})` }),
  });
  if (!roomRes.ok) {
    throw new E41ProbeError(`fixture room creation failed (${roomRes.status})`, 'FIXTURE_FAILURE');
  }
  const rooms = await roomRes.json().catch(() => null);
  const roomId = Array.isArray(rooms) ? rooms[0]?.id : rooms?.id;
  if (!roomId) throw new E41ProbeError('fixture room id missing', 'FIXTURE_FAILURE');

  const items = [];
  for (const spec of FIXTURE_ITEMS) {
    const res = await ctx.fetchImpl(`${ctx.restBase}/dressing_room_items`, {
      method: 'POST',
      headers: restHeaders(ctx.publishableKey, ctx.accessToken, { Prefer: 'return=representation' }),
      body: JSON.stringify({
        dressing_room_id: roomId,
        title: spec.title,
        category: spec.category,
        source_type: SYNTHETIC_MARKER,
        // snapshot_payload is the server-authoritative descriptive source the
        // resolver reads, so the fixture's truth lives here rather than in
        // anything the probe later sends as a client claim.
        snapshot_payload: {
          subtype: spec.subtype,
          colors: spec.colors,
          materials: spec.materials,
        },
      }),
    });
    if (!res.ok) {
      throw new E41ProbeError(`fixture item creation failed (${res.status})`, 'FIXTURE_FAILURE');
    }
    const rows = await res.json().catch(() => null);
    const itemId = Array.isArray(rows) ? rows[0]?.id : rows?.id;
    if (!itemId) throw new E41ProbeError('fixture item id missing', 'FIXTURE_FAILURE');
    items.push({ ...spec, itemId, roomId });
  }
  return { roomId, items };
}

/** Removes only rows this probe created, identified by the room it owns. */
async function destroyRoomFixture(ctx, roomId) {
  if (!roomId) return false;
  try {
    const res = await ctx.fetchImpl(
      `${ctx.restBase}/dressing_rooms?id=eq.${encodeURIComponent(roomId)}`,
      {
        method: 'DELETE',
        headers: restHeaders(ctx.publishableKey, ctx.accessToken, { Prefer: 'return=minimal' }),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/** Removes a single item so the stale-item invariant can be exercised. */
async function removeFixtureItem(ctx, itemId) {
  const res = await ctx.fetchImpl(
    `${ctx.restBase}/dressing_room_items?id=eq.${encodeURIComponent(itemId)}`,
    {
      method: 'DELETE',
      headers: restHeaders(ctx.publishableKey, ctx.accessToken, { Prefer: 'return=minimal' }),
    },
  );
  return res.ok;
}

// ── The single request primitive ────────────────────────────────────────────

/**
 * One StyleChat turn.
 *
 * `attachmentOverrides` exists for the client-metadata attack scenarios: it
 * sends deliberately false descriptive fields alongside a genuine reference, so
 * the probe can prove the server's values win.
 */
async function askElise(ctx, options) {
  const { message, items, sessionId, attachmentOverrides, unauthenticated, roomIdOverride } = options;

  const visualContext = items && items.length
    ? {
      source: 'dressing_room',
      visualContext: {
        source: 'dressing_room',
        roomId: roomIdOverride || items[0].roomId,
        itemId: items[0].itemId,
        ...(attachmentOverrides || {}),
      },
    }
    : null;

  const body = {
    message,
    sessionId: sessionId || undefined,
    contractVersion: '2',
    ...(visualContext ? { activeContext: visualContext } : {}),
  };

  const headers = unauthenticated
    ? { apikey: ctx.publishableKey, 'Content-Type': 'application/json' }
    : restHeaders(ctx.publishableKey, ctx.accessToken);

  const startedAt = Date.now();
  const res = await ctx.fetchImpl(ctx.styleChatUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const elapsedMs = Date.now() - startedAt;

  let payload = null;
  try {
    payload = JSON.parse(await res.text());
  } catch {
    payload = null;
  }

  return {
    httpStatus: res.status,
    elapsedMs,
    // Kept in memory for assertions only; never emitted.
    text: payload?.message?.content ?? '',
    servedModel: payload?.message?.model ?? null,
    contractVersion: payload?.contractVersion ?? null,
    capabilities: payload?.capabilities ?? null,
    attachmentsResolved: payload?.attachmentsResolved ?? null,
    sessionId: payload?.sessionId ?? sessionId ?? null,
    ok: res.ok,
  };
}

// ── Orchestration ───────────────────────────────────────────────────────────

/**
 * Runs the whole matrix against a live staging deployment.
 *
 * Fails closed in order, BEFORE any network call: environment authority, then
 * production-URL rejection, then credentials. A typo must not be able to point
 * this at production, and a missing secret must not produce a green run that
 * silently tested nothing.
 */
async function run(env, fetchImpl) {
  const environment = env || process.env;
  const doFetch = fetchImpl || fetch;

  assertExpectedEnvironment('staging', environment.SUPABASE_STAGING_PROJECT_REF);
  assertNotProductionUrl(environment.SUPABASE_STAGING_URL);

  const missing = findMissingEnvVars(environment);
  if (missing.length) {
    throw new E41ProbeError(
      `missing required environment: ${missing.join(', ')}`,
      'ENVIRONMENT_FAILURE',
    );
  }

  const signIn = await signInSyntheticUser(
    environment.SUPABASE_STAGING_URL,
    environment.SUPABASE_STAGING_PUBLISHABLE_KEY,
    environment.STAGING_SYNTHETIC_ACTIVE_EMAIL,
    environment.STAGING_SYNTHETIC_ACTIVE_PASSWORD,
    doFetch,
  );
  // Registers the token with the masker so it can never appear in output.
  if (signIn.accessToken) process.stderr.write(`${maskLine(signIn.accessToken)}\n`);
  if (!signIn.ok) {
    throw new E41ProbeError(`synthetic sign-in failed: ${signIn.error}`, 'AUTH_FAILURE');
  }

  const ctx = {
    fetchImpl: doFetch,
    publishableKey: environment.SUPABASE_STAGING_PUBLISHABLE_KEY,
    accessToken: signIn.accessToken,
    restBase: `${normalizeBase(environment.SUPABASE_STAGING_URL)}${REST_PATH}`,
    styleChatUrl: buildStyleChatUrl(environment.SUPABASE_STAGING_URL),
  };

  const actorId = await getActorId(ctx, environment.SUPABASE_STAGING_URL);
  ctx.actorId = actorId;

  let fixture = null;
  const groups = {};
  try {
    fixture = await createRoomFixture(ctx);
    const ask = (options) => askElise(ctx, options);

    const owned = await matrix.runOwnedRoomMatrix(ask, fixture.items);
    groups.owned_room = owned.results;
    groups.v2_contract = matrix.assertV2Contract(owned.contractSample);
    groups.grounding = await matrix.runClientMetadataAttack(ask, fixture.items);
    groups.authorization = await matrix.runAuthorizationMatrix(ask, fixture.items);
    groups.prompt_security = await matrix.runPromptInjectionMatrix(ask, fixture.items);

    // Multi-turn runs LAST: it removes a fixture item, so anything after it
    // would be reasoning about a different room than it thinks.
    const multiTurn = await matrix.runMultiTurnMatrix(
      ask,
      fixture.items,
      (item) => removeFixtureItem(ctx, item.itemId),
    );
    groups.multi_turn = multiTurn.results;

    const summary = matrix.summarize(groups);
    const report = {
      targetEnvironment: 'staging',
      functionInvoked: 'stylechat-generate',
      authenticatedRequest: true,
      syntheticFixture: { marker: SYNTHETIC_MARKER, itemCount: fixture.items.length },
      latency: assertions.summarizeLatency(owned.latencies),
      groups,
      summary,
    };
    assertEvidencePrivacy(report);
    return report;
  } finally {
    // Cleanup must run even when the matrix throws, or a failed run leaves a
    // room behind that the next run would trip over.
    if (fixture) await destroyRoomFixture(ctx, fixture.roomId);
  }
}

/** Resolves the authenticated actor id. Never logged. */
async function getActorId(ctx, supabaseUrl) {
  const res = await ctx.fetchImpl(`${normalizeBase(supabaseUrl)}/auth/v1/user`, {
    headers: restHeaders(ctx.publishableKey, ctx.accessToken),
  });
  if (!res.ok) throw new E41ProbeError(`actor lookup failed (${res.status})`, 'AUTH_FAILURE');
  const body = await res.json().catch(() => null);
  if (!body?.id) throw new E41ProbeError('actor id missing', 'AUTH_FAILURE');
  return body.id;
}

module.exports = {
  run,
  getActorId,
  SYNTHETIC_MARKER,
  FIXTURE_ITEMS,
  REQUIRED_ENV_VARS,
  FORBIDDEN_EVIDENCE_PATTERNS,
  E41ProbeError,
  buildStyleChatUrl,
  assertEvidencePrivacy,
  findMissingEnvVars,
  restHeaders,
  createRoomFixture,
  destroyRoomFixture,
  removeFixtureItem,
  askElise,
  assertNotProductionUrl,
  assertExpectedEnvironment,
  signInSyntheticUser,
  maskLine,
};
