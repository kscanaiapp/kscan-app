const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type AuthUser = { id: string; email?: string };

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

async function requireUser(req: Request): Promise<AuthUser> {
  const authorization = req.headers.get('Authorization') ?? '';
  if (!authorization.toLowerCase().startsWith('bearer ')) {
    throw new Response(JSON.stringify({ error: 'Authentication required' }), { status: 401, headers: corsHeaders });
  }

  const supabaseUrl = env('SUPABASE_URL');
  const anonKey = env('SUPABASE_ANON_KEY');
  const authResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: anonKey,
      Authorization: authorization,
    },
  });

  if (!authResponse.ok) {
    throw new Response(JSON.stringify({ error: 'Authentication required' }), { status: 401, headers: corsHeaders });
  }

  return await authResponse.json();
}

async function rest(path: string, init: RequestInit = {}) {
  const supabaseUrl = env('SUPABASE_URL');
  const serviceRoleKey = env('SUPABASE_SERVICE_ROLE_KEY');
  return fetch(`${supabaseUrl}/rest/v1/${path}`, {
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
    const openRequestResponse = await rest(
      `deletion_requests?user_id=eq.${user.id}&status=in.(pending,processing)&select=id,status,requested_at&order=requested_at.desc&limit=1`,
      { method: 'GET' },
    );

    if (!openRequestResponse.ok) {
      return json({ error: 'Unable to check existing deletion requests' }, 500);
    }

    const openRequests = await openRequestResponse.json();
    if (openRequests.length > 0) {
      return json({
        status: 'already_requested',
        requested_at: openRequests[0].requested_at,
      });
    }

    const insertResponse = await rest('deletion_requests', {
      method: 'POST',
      body: JSON.stringify({
        user_id: user.id,
        status: 'pending',
        request_source: 'mobile_app',
        notes: 'User-initiated deletion request from K Scan AI mobile app.',
      }),
    });

    if (!insertResponse.ok) {
      const detail = await insertResponse.text();
      return json({ error: 'Unable to create deletion request', detail }, 500);
    }

    const [deletionRequest] = await insertResponse.json();

    await rest(`profiles?id=eq.${user.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        account_status: 'pending_deletion',
        deletion_requested_at: deletionRequest.requested_at,
      }),
    });

    // Production integration point:
    // enqueue confirmation email and downstream erasure workflow here. Actual
    // deletion should honor retention, fraud/security exceptions, and legal holds.
    return json({
      status: 'pending',
      request_id: deletionRequest.id,
      requested_at: deletionRequest.requested_at,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return json({ error: error instanceof Error ? error.message : 'Unexpected error' }, 500);
  }
});
