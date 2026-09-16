// Build 33 backend repair -- Finding C (B33-STO-002): orphan-owner media reconciliation.
//
// WHY THIS IS A SEPARATE FUNCTION AND NOT PART OF process-account-deletions
//
// Storage objects carry no foreign key to auth.users. When an account's Auth row
// goes away, the 51 user-scoped public tables cascade and deletion_requests.user_id
// is set to NULL, but storage.objects rows simply stay behind with `owner` pointing
// at a user id that no longer resolves.
//
// Production holds 7 such objects across 4 vanished owners. They exist because the
// Auth users were deleted OUTSIDE the governed worker path -- every one of those
// deletion_requests rows still shows attempt_count = 0, worker_id null, and no purge
// state transition -- so deleteOwnedStorage never ran for them. Their prefixes are
// `scans` and `inspirations`, both already covered by the deployed worker's prefix
// templates, so prefix coverage was never the gap.
//
// This is why the newer retained-owner-media work queue (20260831140000) does not
// address it: that mechanism is for objects a SUCCESSFUL purge deliberately retained
// because a surviving transferred room still referenced them, and the worker enqueues
// those prefixes at the end of the purge. Nothing was ever enqueued here, because no
// purge ever ran. A queue cannot service rows that were never written.
//
// Hardening process-account-deletions cannot prevent this either: the failure happens
// when Auth deletion bypasses the worker entirely. The only durable defence is periodic
// reconciliation against the one signal that survives -- storage.objects.owner failing
// to resolve -- which is what this function does. Keeping it standalone means it shares
// no code with the deletion worker and cannot alter account-deletion semantics.
//
// SAFETY MODEL
//
// * Secret-gated. Requires ORPHAN_MEDIA_SWEEP_SECRET via x-orphan-sweep-secret or
//   Bearer, compared in constant time. The anon key is explicitly rejected.
// * Dry-run unless BOTH app_config flags say otherwise. Deploying this function
//   changes nothing until someone deliberately flips orphan_media_sweep_enabled on
//   and orphan_media_sweep_dry_run off.
// * Candidate selection is entirely server-side, in list_orphan_owner_media. This
//   function never chooses what to delete and never accepts a caller-supplied path,
//   so a client can never nominate another user's media for deletion.
// * Fails closed. Any error enumerating candidates or verifying references aborts
//   before a single delete. Any shortfall in a removal batch aborts the run.
// * Bounded. At most MAX_OBJECTS_PER_RUN objects per invocation; the response
//   reports whether more remain.
// * Idempotent. Re-running after a successful sweep finds nothing.
// * Logs are sanitized: counts, byte totals and 8-character owner prefixes only.
//   No object paths and no user ids are emitted.

const BUCKET = 'style-library-images';
const PAGE_SIZE = 500;
const MAX_OBJECTS_PER_RUN = 1000;
const REMOVE_BATCH_SIZE = 100;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-orphan-sweep-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function envOptional(name: string): string | null {
  const value = Deno.env.get(name)?.trim();
  return value ? value : null;
}

function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }));
}

function alertEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ severity: 'alert', event: `ALERT_${event}`, ts: new Date().toISOString(), ...fields }));
}

// Constant-time comparison. Length is compared first and a mismatch returns early --
// the secret's length is not a useful oracle, and the byte loop must not run over
// mismatched buffers.
export function secretsMatch(provided: string, expected: string): boolean {
  const enc = new TextEncoder();
  const a = enc.encode(provided);
  const b = enc.encode(expected);
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}

function requireSweepAuth(req: Request): void {
  const expected = envOptional('ORPHAN_MEDIA_SWEEP_SECRET');
  if (!expected) throw json({ error: 'Sweep secret not configured' }, 503);

  const headerSecret = req.headers.get('x-orphan-sweep-secret')?.trim();
  const auth = req.headers.get('Authorization') ?? '';
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice('bearer '.length).trim() : '';
  const provided = headerSecret || bearer;

  if (!provided) {
    logEvent('sweep_auth_rejected', { reason: 'missing' });
    throw json({ error: 'Unauthorized' }, 401);
  }
  // A caller holding only the publishable anon key must never pass as the worker.
  const anon = envOptional('SUPABASE_ANON_KEY');
  if (anon && provided === anon) {
    logEvent('sweep_auth_rejected', { reason: 'anon_key' });
    throw json({ error: 'Unauthorized' }, 401);
  }
  if (!secretsMatch(provided, expected)) {
    logEvent('sweep_auth_rejected', { reason: 'mismatch' });
    throw json({ error: 'Unauthorized' }, 401);
  }
}

async function rest(path: string, init: RequestInit = {}): Promise<Response> {
  const serviceRoleKey = env('SUPABASE_SERVICE_ROLE_KEY');
  return fetch(`${env('SUPABASE_URL')}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

async function readAppConfigFlag(key: string): Promise<boolean> {
  const response = await rest(`app_config?key=eq.${encodeURIComponent(key)}&select=value`, { method: 'GET' });
  // A flag that cannot be read is treated as OFF: an unreadable kill switch must
  // never be interpreted as permission to delete.
  if (!response.ok) return false;
  const rows = await response.json();
  if (!Array.isArray(rows) || !rows[0]?.value) return false;
  return Boolean(rows[0].value.enabled);
}

export interface OrphanCandidate {
  object_name: string;
  size_bytes: number;
  owner_prefix: string;
  created_at: string;
}

// Enumerates candidates by keyset pagination on object_name. Every page comes from
// list_orphan_owner_media, which applies the owner-unresolvable test AND the
// reference test in one snapshot. Any failure throws, so the caller deletes nothing.
export async function collectCandidates(
  callRpc: (after: string | null) => Promise<OrphanCandidate[]>,
  maxObjects = MAX_OBJECTS_PER_RUN,
): Promise<{ candidates: OrphanCandidate[]; hasMore: boolean }> {
  const candidates: OrphanCandidate[] = [];
  let after: string | null = null;

  while (candidates.length < maxObjects) {
    const page = await callRpc(after);
    if (!Array.isArray(page)) throw new Error('candidate enumeration returned a non-array');
    if (page.length === 0) return { candidates, hasMore: false };

    for (const row of page) {
      if (!row?.object_name) throw new Error('candidate enumeration returned a row without object_name');
      candidates.push(row);
    }
    after = page[page.length - 1].object_name;
    // A short page means the source is exhausted.
    if (page.length < PAGE_SIZE) return { candidates, hasMore: false };
  }
  return { candidates: candidates.slice(0, maxObjects), hasMore: true };
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    requireSweepAuth(req);

    const enabled = await readAppConfigFlag('orphan_media_sweep_enabled');
    const dryRunFlag = await readAppConfigFlag('orphan_media_sweep_dry_run');
    const envDryRun = (Deno.env.get('ORPHAN_MEDIA_SWEEP_DRY_RUN') ?? '').toLowerCase() === 'true';
    // Dry run unless every switch agrees otherwise.
    const dryRun = envDryRun || dryRunFlag || !enabled;

    const callRpc = async (after: string | null): Promise<OrphanCandidate[]> => {
      const response = await rest('rpc/list_orphan_owner_media', {
        method: 'POST',
        body: JSON.stringify({ p_bucket: BUCKET, p_limit: PAGE_SIZE, p_after: after }),
      });
      if (!response.ok) {
        // Fail closed: if candidacy (which includes the reference check) cannot be
        // determined, nothing is eligible for deletion.
        throw new Error(`candidate enumeration failed: ${response.status}`);
      }
      return await response.json();
    };

    const { candidates, hasMore } = await collectCandidates(callRpc);
    const totalBytes = candidates.reduce((sum, c) => sum + (Number(c.size_bytes) || 0), 0);
    const distinctOwners = new Set(candidates.map((c) => c.owner_prefix)).size;

    if (dryRun) {
      logEvent('orphan_sweep_dry_run', {
        bucket: BUCKET, candidates: candidates.length, distinctOwners, totalBytes, hasMore,
        killSwitchEnabled: enabled, dryRunFlag, envDryRun,
      });
      return json({
        mode: 'dry_run', bucket: BUCKET, killSwitchEnabled: enabled, dryRun: true,
        candidateCount: candidates.length, distinctOwners, totalBytes, hasMore,
        note: 'No object was deleted. Candidates are unreferenced objects whose owner no longer resolves.',
      });
    }

    const { createClient } = await import('npm:@supabase/supabase-js@2');
    const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const bucket = supabase.storage.from(BUCKET);

    let removed = 0;
    for (const batch of chunk(candidates.map((c) => c.object_name), REMOVE_BATCH_SIZE)) {
      const result = await bucket.remove(batch);
      if (result.error) {
        alertEvent('orphan_sweep_remove_failed', { bucket: BUCKET, requested: batch.length, removedSoFar: removed });
        throw new Error(`storage remove failed: ${result.error.message}`);
      }
      const removedCount = Array.isArray(result.data) ? result.data.length : 0;
      if (removedCount < batch.length) {
        // A partial removal means some objects are still present. Stop rather than
        // continue against an inconsistent storage state.
        alertEvent('orphan_sweep_partial_removal', {
          bucket: BUCKET, requested: batch.length, removed: removedCount, removedSoFar: removed,
        });
        throw new Error(`storage partial removal: ${batch.length - removedCount} object(s) not removed`);
      }
      removed += removedCount;
    }

    logEvent('orphan_sweep_complete', { bucket: BUCKET, removed, distinctOwners, totalBytes, hasMore });
    return json({ mode: 'live', bucket: BUCKET, removed, distinctOwners, totalBytes, hasMore });
  } catch (error) {
    if (error instanceof Response) return error;
    logEvent('orphan_sweep_error', { type: error instanceof Error ? error.name : 'unknown' });
    return json({ error: 'Sweep failed' }, 500);
  }
});
