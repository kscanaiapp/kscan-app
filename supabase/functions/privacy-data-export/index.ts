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
    headers: {
      apikey: env('SUPABASE_ANON_KEY'),
      Authorization: authorization,
    },
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
    const { createClient } = await import('npm:@supabase/supabase-js@2');
    const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const profile = await admin.from('profiles').select('account_status,account_locked_at').eq('id', user.id).maybeSingle();
    if (profile.error || !profile.data) {
      return json({ error: 'ACCOUNT_DEACTIVATED', code: 'ACCOUNT_DEACTIVATED' }, 403);
    }
    if (profile.data.account_status !== 'active' || profile.data.account_locked_at) {
      return json({ error: 'ACCOUNT_DEACTIVATED', code: 'ACCOUNT_DEACTIVATED' }, 403);
    }

    const manifest = {
      includes: [
        'profile account fields',
        'privacy settings',
        'linked style preferences and interaction data where retained',
        'derived fashion metadata where linked to the user and legally exportable',
      ],
      excludes_pending_legal_review: [
        'Style DNA vectors or embeddings',
        'security logs exempt from access where permitted',
        'aggregated or deidentified trend reports not linked to the user',
      ],
      raw_scan_storage_assumption: 'Raw scans are not exported unless the production storage map confirms they are retained and linked to the user.',
    };

    const response = await serviceRest('privacy_export_requests', {
      method: 'POST',
      body: JSON.stringify({
        user_id: user.id,
        status: 'pending',
        request_source: 'mobile_app',
        export_manifest: manifest,
      }),
    });

    if (!response.ok) return json({ error: 'Unable to create export request', detail: await response.text() }, 500);

    const [requestRow] = await response.json();
    return json({ status: 'pending', request_id: requestRow.id, requested_at: requestRow.requested_at, manifest });
  } catch (error) {
    if (error instanceof Response) return error;
    return json({ error: error instanceof Error ? error.message : 'Unexpected error' }, 500);
  }
});
