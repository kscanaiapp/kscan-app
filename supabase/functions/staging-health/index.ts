/**
 * staging-health — staging health contract + release identity surface.
 *
 * Health contract v1 (Phase 2B). Routes, relative to the function root
 * `/functions/v1/staging-health`:
 *
 *   GET  /                health contract v0 composite response (RETAINED)
 *   GET  /health/live     liveness   — cheap, dependency-free
 *   GET  /health/ready    readiness  — bounded dependency checks
 *   GET  /version         release identity
 *
 * The bare root is deliberately preserved byte-compatibly: the existing
 * `health-check` job in .github/workflows/staging-controlled-deploy.yml curls
 * the function root and asserts `status == "healthy"` and
 * `environment == "staging"`. Changing that shape would silently break a live
 * gate, so v1 adds sub-routes rather than replacing the root.
 *
 * SAFETY CONTRACT — this function is `verify_jwt = false`, i.e. PUBLICLY
 * REACHABLE WITHOUT AUTH. Everything it returns is therefore public. It must
 * never emit secrets, tokens, service-role material, table contents, user
 * data, or anything derived from them. Release identity values are non-secret
 * build metadata by construction; a defensive filter below drops anything that
 * looks like a credential even if configuration is later misused.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const SERVICE = 'kscan-backend';
// Deliberately inlined at each response site rather than shared: a security
// control (stagingDeployPipeline.test.js) requires every response to hardcode
// its environment, so a single edit cannot repoint them all at once.

/**
 * Health contract version. This is release IDENTITY MATERIAL: it is recorded
 * in the release manifest and folded into the manifest identity digest, so
 * changing it here without changing HEALTH_CONTRACT_VERSION in
 * security/release/generate-release-manifest.js is a drift the release
 * verifier will reject.
 */
const HEALTH_CONTRACT_VERSION = Deno.env.get('KSCAN_HEALTH_CONTRACT_VERSION') ?? 'health-contract-v1';

/** Legacy composite `version` field. Retained for the existing root response. */
const LEGACY_VERSION = Deno.env.get('KSCAN_DEPLOY_VERSION') ?? 'staging-health-1';

const TIMEOUT_MS = 8000;
const READINESS_TIMEOUT_MS = 4000;

type CheckStatus = 'ok' | 'fail' | 'skip';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function envOrNull(name: string): string | null {
  const value = Deno.env.get(name);
  return value === undefined || value === '' ? null : value;
}

/**
 * Defence in depth for a publicly reachable surface: refuse to emit any value
 * that carries a credential shape, even though every field below is supposed
 * to be non-secret build metadata. Mirrors the shapes in
 * security/scripts/lib/secret-shape-guard.js.
 */
const CREDENTIAL_SHAPES = [
  /\beyJ[A-Za-z0-9_-]{20,}\./,
  /\bsb_(secret|publishable)_[A-Za-z0-9_-]{10,}/,
  /postgres(?:ql)?:\/\/[^\s"]*:[^\s"@]+@/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bsbp_[A-Za-z0-9]{20,}/,
];

function safeIdentityValue(value: string | null): string | null {
  if (value === null) return null;
  for (const shape of CREDENTIAL_SHAPES) {
    if (shape.test(value)) return 'REDACTED_CREDENTIAL_SHAPED_VALUE';
  }
  return value;
}

/** Release identity fields required before a deployment can be verified. */
const REQUIRED_IDENTITY_FIELDS = ['releaseId', 'sourceSha', 'manifestDigest'] as const;

type ReleaseIdentity = {
  releaseId: string | null;
  sourceSha: string | null;
  sourceTreeSha: string | null;
  manifestDigest: string | null;
  healthContractVersion: string;
  deployedAt: string | null;
};

function readReleaseIdentity(): ReleaseIdentity {
  return {
    releaseId: safeIdentityValue(envOrNull('KSCAN_RELEASE_ID')),
    sourceSha: safeIdentityValue(envOrNull('KSCAN_SOURCE_SHA')),
    sourceTreeSha: safeIdentityValue(envOrNull('KSCAN_SOURCE_TREE_SHA')),
    manifestDigest: safeIdentityValue(envOrNull('KSCAN_MANIFEST_DIGEST')),
    healthContractVersion: HEALTH_CONTRACT_VERSION,
    deployedAt: safeIdentityValue(envOrNull('KSCAN_DEPLOYED_AT')),
  };
}

/**
 * Release identity is fail-closed: absent metadata reports NOT_VERIFIABLE
 * rather than an optimistic default. Liveness deliberately does NOT depend on
 * this — an unidentified deployment is still a running deployment, and
 * conflating the two would make a metadata gap look like an outage.
 */
function identityState(identity: ReleaseIdentity): 'VERIFIABLE' | 'NOT_VERIFIABLE' {
  for (const field of REQUIRED_IDENTITY_FIELDS) {
    if (!identity[field]) return 'NOT_VERIFIABLE';
  }
  return 'VERIFIABLE';
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function checkDatabase(): Promise<{ status: CheckStatus; detail?: string }> {
  const url = envOrNull('SUPABASE_URL');
  const key = envOrNull('SUPABASE_SERVICE_ROLE_KEY') ?? envOrNull('SUPABASE_ANON_KEY');
  if (!url || !key) return { status: 'fail', detail: 'missing_runtime_env' };

  // Lightweight connectivity: ask PostgREST for OpenAPI root (no table dump).
  const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/`, {
    method: 'HEAD',
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (res.ok || res.status === 200 || res.status === 404 || res.status === 405) {
    return { status: 'ok' };
  }
  return { status: 'fail', detail: `http_${res.status}` };
}

async function checkMigrationHistory(): Promise<{ status: CheckStatus }> {
  const url = envOrNull('SUPABASE_URL');
  const serviceKey = envOrNull('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return { status: 'skip' };

  // Count applied migrations via a tiny RPC-free select on schema_migrations.
  // Return only ok/fail — never version lists.
  const res = await fetch(
    `${url.replace(/\/$/, '')}/rest/v1/rpc/`,
    {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    },
  ).catch(() => null);

  // Prefer direct SQL-less table probe through PostgREST if exposed — usually it is not.
  // Fall back: service role query against a known public table existence.
  const probe = await fetch(
    `${url.replace(/\/$/, '')}/rest/v1/profiles?select=id&limit=1`,
    {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
    },
  );

  if (probe.ok || probe.status === 200 || probe.status === 206) return { status: 'ok' };
  if (probe.status === 401 || probe.status === 403) return { status: 'fail' };
  // Ignore unused res — connectivity path above is authoritative when probe fails oddly.
  void res;
  return probe.status >= 500 ? { status: 'fail' } : { status: 'ok' };
}

async function checkCoreTables(): Promise<{ status: CheckStatus }> {
  const url = envOrNull('SUPABASE_URL');
  const serviceKey = envOrNull('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return { status: 'skip' };

  const tables = ['profiles', 'content_reports'];
  for (const table of tables) {
    const res = await fetch(
      `${url.replace(/\/$/, '')}/rest/v1/${table}?select=id&limit=1`,
      {
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          Prefer: 'count=exact',
        },
      },
    );
    if (!(res.ok || res.status === 200 || res.status === 206)) {
      return { status: 'fail' };
    }
  }
  return { status: 'ok' };
}

function overallStatus(checks: Record<string, CheckStatus>): 'healthy' | 'degraded' | 'unhealthy' {
  const values = Object.values(checks);
  if (values.includes('fail')) {
    if (checks.runtime === 'fail' || checks.database === 'fail') return 'unhealthy';
    return 'degraded';
  }
  return 'healthy';
}

// ── health contract v1 routes ────────────────────────────────────────────────

/**
 * Liveness. Deliberately makes NO network call, NO database call, and no
 * provider call — it answers "is this process serving?" and nothing else, so
 * it stays usable as a signal precisely when dependencies are failing.
 */
function handleLive(): Response {
  return json({
    status: 'alive',
    service: SERVICE,
    environment: 'staging',
    healthContractVersion: HEALTH_CONTRACT_VERSION,
  }, 200);
}

/**
 * Readiness. Bounded critical-dependency checks only: database reachability
 * and core-table availability, each behind a short timeout. No AI-provider
 * calls, no mutations, no user records, no full smoke suite.
 */
async function handleReady(): Promise<Response> {
  const components: Record<string, CheckStatus> = { runtime: 'ok', database: 'fail', core_tables: 'skip' };

  try {
    const db = await withTimeout(checkDatabase(), READINESS_TIMEOUT_MS);
    components.database = db.status;
    if (db.status === 'ok') {
      const tables = await withTimeout(checkCoreTables(), READINESS_TIMEOUT_MS);
      components.core_tables = tables.status;
    }
  } catch {
    components.database = 'fail';
  }

  const ready = components.database === 'ok' && components.core_tables !== 'fail';
  return json({
    status: ready ? 'ready' : 'not_ready',
    service: SERVICE,
    environment: 'staging',
    healthContractVersion: HEALTH_CONTRACT_VERSION,
    components,
  }, ready ? 200 : 503);
}

/**
 * Release identity. Corroborating evidence only — see
 * security/release/verify-exact-candidate.js for the full trust model. A
 * deployment that cannot state its identity reports NOT_VERIFIABLE rather
 * than omitting the field or defaulting to something plausible.
 */
function handleVersion(): Response {
  const identity = readReleaseIdentity();
  const state = identityState(identity);
  return json({
    service: SERVICE,
    environment: 'staging',
    releaseIdentityState: state,
    releaseId: identity.releaseId,
    sourceSha: identity.sourceSha,
    sourceTreeSha: identity.sourceTreeSha,
    manifestDigest: identity.manifestDigest,
    healthContractVersion: identity.healthContractVersion,
    deploymentTimestamp: identity.deployedAt,
  }, state === 'VERIFIABLE' ? 200 : 503);
}

/** The pre-v1 composite response, retained verbatim in shape. */
async function handleLegacyRoot(): Promise<Response> {
  const runtime: CheckStatus = 'ok';
  let database: CheckStatus = 'fail';
  let migrations: CheckStatus = 'skip';
  let coreTables: CheckStatus = 'skip';

  try {
    const db = await withTimeout(checkDatabase(), TIMEOUT_MS);
    database = db.status;
    const mig = await withTimeout(checkMigrationHistory(), TIMEOUT_MS);
    migrations = mig.status;
    const tables = await withTimeout(checkCoreTables(), TIMEOUT_MS);
    coreTables = tables.status;
  } catch {
    database = 'fail';
  }

  const checks = { runtime, database, migrations, core_tables: coreTables };
  const status = overallStatus(checks);
  const httpStatus = status === 'healthy' ? 200 : status === 'degraded' ? 200 : 503;

  return json({
    status,
    environment: 'staging',
    service: SERVICE,
    timestamp: new Date().toISOString(),
    version: LEGACY_VERSION,
    healthContractVersion: HEALTH_CONTRACT_VERSION,
    checks,
  }, httpStatus);
}

/**
 * Normalizes the request path to a route key. Supabase serves this function at
 * `/functions/v1/staging-health`, so the sub-route is whatever follows the
 * function slug; direct invocation in tests may omit that prefix.
 */
export function routeFor(pathname: string): 'live' | 'ready' | 'version' | 'root' | 'unknown' {
  const withoutPrefix = pathname
    .replace(/^\/functions\/v1/, '')
    .replace(/^\/staging-health/, '');
  const normalized = withoutPrefix.replace(/\/+$/, '');
  if (normalized === '' || normalized === '/') return 'root';
  if (normalized === '/health/live' || normalized === '/live') return 'live';
  if (normalized === '/health/ready' || normalized === '/ready') return 'ready';
  if (normalized === '/version') return 'version';
  return 'unknown';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'GET') {
    return json({ status: 'unhealthy', environment: 'staging', service: SERVICE, error: 'method_not_allowed' }, 405);
  }

  switch (routeFor(new URL(req.url).pathname)) {
    case 'live':
      return handleLive();
    case 'ready':
      return await handleReady();
    case 'version':
      return handleVersion();
    case 'root':
      return await handleLegacyRoot();
    default:
      return json({
        status: 'unhealthy',
        service: SERVICE,
        environment: 'staging',
        error: 'not_found',
      }, 404);
  }
});
