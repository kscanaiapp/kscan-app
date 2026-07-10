import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type AuthUser = { id: string; email?: string };

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function shortUserId(userId: string) {
  return userId ? `${userId.slice(0, 8)}...` : 'unknown';
}

function isValidUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

async function requireUser(req: Request): Promise<AuthUser> {
  const authorization = req.headers.get('Authorization') ?? '';
  if (!authorization.toLowerCase().startsWith('bearer ')) {
    throw json({ error: 'Authentication required' }, 401);
  }

  const supabaseUrl = env('SUPABASE_URL');
  const anonKey = env('SUPABASE_ANON_KEY');
  const accessToken = authorization.slice('bearer '.length).trim();
  if (!accessToken) {
    throw json({ error: 'Authentication required' }, 401);
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });

  const { data: { user }, error } = await userClient.auth.getUser(accessToken);
  if (error || !user?.id || !isValidUuid(user.id)) {
    throw json({ error: 'Authentication required' }, 401);
  }

  return { id: user.id, email: user.email ?? undefined };
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

const deletionRequestNote = 'User-initiated deletion request from K Scan AI mobile app.';

function isMissingColumn(detail: string, column: string) {
  return detail.includes('PGRST204') && detail.includes(`'${column}' column`);
}

async function insertDeletionRequest(userId: string) {
  const requestSources = ['mobile_app', 'app'];
  const noteVariants = [
    { label: 'notes', body: { notes: deletionRequestNote } },
    { label: 'internal_notes', body: { internal_notes: deletionRequestNote } },
    { label: 'no note field', body: {} },
  ];
  const safeUserId = shortUserId(userId);

  // The intended release schema uses mobile_app + notes. Some beta-linked
  // projects still expose app/internal_notes, so try legacy-safe fallbacks
  // without changing schema or blocking request intake.
  for (const requestSource of requestSources) {
    for (const noteVariant of noteVariants) {
      const response = await rest('deletion_requests', {
        method: 'POST',
        body: JSON.stringify({
          user_id: userId,
          status: 'pending',
          request_source: requestSource,
          ...noteVariant.body,
        }),
      });

      if (response.ok) return response;

      const detail = await response.text();
      if (noteVariant.label !== 'no note field' && isMissingColumn(detail, noteVariant.label)) {
        console.warn(
          `[handle-user-deletion] deletion_requests.${noteVariant.label} unavailable; retrying intake uid=${safeUserId}`,
        );
        continue;
      }

      console.error(
        `[handle-user-deletion] deletion_request_insert_failed uid=${safeUserId} source=${requestSource} note=${noteVariant.label} status=${response.status}`,
      );
    }
  }

  return null;
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

    const insertResponse = await insertDeletionRequest(user.id);

    if (!insertResponse) {
      return json({ error: 'Unable to create deletion request' }, 500);
    }

    const [deletionRequest] = await insertResponse.json();

    const profileResponse = await rest(`profiles?id=eq.${user.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        account_status: 'pending_deletion',
        deletion_requested_at: deletionRequest.requested_at,
      }),
    });
    if (!profileResponse.ok) {
      console.warn(
        `[handle-user-deletion] profile_pending_update_failed uid=${shortUserId(user.id)} status=${profileResponse.status}`,
      );
    }

    // Request-based deletion model: an operator/service-role processor performs
    // final erasure within the documented SLA after fraud/security/legal review.
    return json({
      status: 'pending',
      request_id: deletionRequest.id,
      requested_at: deletionRequest.requested_at,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(
      `[handle-user-deletion] unexpected_error type=${error instanceof Error ? error.name : 'unknown'}`,
    );
    return json({ error: 'Unable to process deletion request' }, 500);
  }
});
