import {
  rateLimitedResponse,
  reservePrivacyRequestRateLimit,
} from '../_shared/privacyRequestRateLimit.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function env(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function requireUser(req: Request) {
  const authorization = req.headers.get('Authorization') ?? '';
  if (!authorization.toLowerCase().startsWith('bearer ')) {
    throw new Response(JSON.stringify({ error: 'Authentication required' }), { status: 401, headers: corsHeaders });
  }

  const response = await fetch(`${env('SUPABASE_URL')}/auth/v1/user`, {
    headers: { apikey: env('SUPABASE_ANON_KEY'), Authorization: authorization },
  });

  if (!response.ok) {
    throw new Response(JSON.stringify({ error: 'Authentication required' }), { status: 401, headers: corsHeaders });
  }

  return await response.json();
}

async function serviceRest(path: string, init: RequestInit = {}) {
  const serviceRoleKey = env('SUPABASE_SERVICE_ROLE_KEY');
  return fetch(`${env('SUPABASE_URL')}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(init.headers ?? {}),
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const user = await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const requestedChanges = body?.requested_changes;

    if (!requestedChanges || typeof requestedChanges !== 'object' || Array.isArray(requestedChanges)) {
      return json({ error: 'requested_changes object is required' }, 400);
    }

    const rate = await reservePrivacyRequestRateLimit(user.id, 'privacy_correction');
    if (!rate.allowed) {
      return rateLimitedResponse(corsHeaders, rate.retry_after_seconds);
    }

    const response = await serviceRest('privacy_correction_requests', {
      method: 'POST',
      body: JSON.stringify({
        user_id: user.id,
        status: 'pending',
        request_source: 'mobile_app',
        requested_changes: requestedChanges,
      }),
    });

    if (!response.ok) return json({ error: 'Unable to create correction request', detail: await response.text() }, 500);

    const [requestRow] = await response.json();
    return json({ status: 'pending', request_id: requestRow.id, requested_at: requestRow.requested_at });
  } catch (error) {
    if (error instanceof Response) return error;
    return json({ error: error instanceof Error ? error.message : 'Unexpected error' }, 500);
  }
});
