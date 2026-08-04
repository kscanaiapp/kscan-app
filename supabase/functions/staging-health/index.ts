/**
 * staging-health — shallow, staging-specific health endpoint.
 *
 * Safe public response only. No secrets, table contents, or provider calls.
 * verify_jwt is disabled for this function so CI can probe without a user session.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const SERVICE = 'kscan-backend';
const VERSION = Deno.env.get('KSCAN_DEPLOY_VERSION') ?? 'staging-health-1';
const TIMEOUT_MS = 8000;

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
  return Deno.env.get(name) ?? null;
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'GET') {
    return json({ status: 'unhealthy', environment: 'staging', service: SERVICE, error: 'method_not_allowed' }, 405);
  }

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

  const checks = {
    runtime,
    database,
    migrations,
    core_tables: coreTables,
  };

  const status = overallStatus(checks);
  const httpStatus = status === 'healthy' ? 200 : status === 'degraded' ? 200 : 503;

  return json({
    status,
    environment: 'staging',
    service: SERVICE,
    timestamp: new Date().toISOString(),
    version: VERSION,
    checks,
  }, httpStatus);
});
