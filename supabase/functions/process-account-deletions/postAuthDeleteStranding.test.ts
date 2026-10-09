/**
 * DEL-01 -- behavioural tests for the purge worker's handling of failures that
 * happen AFTER the Auth user has been deleted.
 *
 * ROOT CAUSE UNDER TEST. `deletion_requests.user_id` is `ON DELETE SET NULL`
 * to auth.users, so the instant `auth.admin.deleteUser()` succeeds the request
 * row's user_id becomes NULL. Every request the worker can claim is found by
 * joining `profiles` on `user_id`, and the crash-recovery reconcile only looks
 * at `status = 'purging'`. A request that is rescheduled as `deactivated` with
 * `user_id IS NULL` is therefore matched by NOTHING, forever -- and the user
 * uuid that RevenueCat retirement needs existed only in the worker's memory.
 *
 * These tests drive the REAL worker module (`./index.ts`) through its real
 * `Deno.serve` handler. Nothing is asserted by grepping source text: every
 * network call (PostgREST, Auth admin, Storage, Functions, RevenueCat) lands on
 * an in-memory fake, and the fake models the three database behaviours the
 * defect depends on, taken from the migrations rather than invented:
 *   - claim_deletion_requests_for_purge  (20260723040000): joins profiles on a
 *     non-null user_id; reclaims `purging` only after the lease expires;
 *   - reconcile_orphaned_purging_requests (20260723040000): `purging` AND
 *     user_id IS NULL AND lease expired -> mark purged;
 *   - schedule_deletion_retry_or_fail    (20260723040000): back to
 *     `deactivated`, or `failed` once attempt_count >= p_max_attempts.
 * plus the ON DELETE SET NULL foreign key. The invariant asserted is
 * end-to-end: after the worker has been invoked enough times for every retry
 * and reconcile to have run, no request may be left stranded.
 *
 * The fake grants no real network, no Supabase project, no RevenueCat call.
 */
import { assert, assertEquals, assertNotEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

const SUPABASE_URL = 'https://fake-project.supabase.test';
const WORKER_SECRET = 'worker-secret-fixture-not-a-real-secret';
const USER_ID = '11111111-2222-4333-8444-555555555555';
const REQUEST_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SUBJECT_REF = '99999999-8888-4777-8666-555555555555';

type Lease = 'none' | 'live' | 'expired';

interface RequestRow {
  id: string;
  subject_ref: string;
  user_id: string | null;
  status: 'deactivated' | 'purging' | 'purged' | 'failed';
  attempt_count: number;
  worker_id: string | null;
  lease: Lease;
  backoffPending: boolean;
  failure_code: string | null;
  failure_message: string | null;
}

interface FakeOptions {
  /** HTTP statuses RevenueCat answers with, consumed in order; 200 afterwards. */
  revenueCatStatuses?: number[];
  /** Number of times the Auth admin delete answers 500 (user NOT deleted). */
  authDeleteFailures?: number;
  /** table -> row count the post-delete residual check will observe. */
  residualRowsAfterAuthDelete?: Record<string, number>;
  /** Number of times mark_deletion_request_purged answers HTTP 500. */
  markPurgedFailures?: number;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

class FakeBackend {
  row: RequestRow = {
    id: REQUEST_ID,
    subject_ref: SUBJECT_REF,
    user_id: USER_ID,
    status: 'deactivated',
    attempt_count: 0,
    worker_id: null,
    lease: 'none',
    backoffPending: false,
    failure_code: null,
    failure_message: null,
  };
  authUserExists = true;
  /** Ordered record of every side effect, so ordering can be asserted. */
  events: string[] = [];
  /** RevenueCat calls that reached the (fake) provider, with the status returned. */
  revenueCatCalls: Array<{ appUserId: string; status: number }> = [];
  /** Retry-RPC invocations, with the p_max_attempts the worker asked for. */
  retryCalls: Array<{ maxAttempts: unknown }> = [];

  private revenueCatStatuses: number[];
  private authDeleteFailures: number;
  private residual: Record<string, number>;
  private markPurgedFailures: number;

  constructor(options: FakeOptions = {}) {
    this.revenueCatStatuses = [...(options.revenueCatStatuses ?? [])];
    this.authDeleteFailures = options.authDeleteFailures ?? 0;
    this.residual = options.residualRowsAfterAuthDelete ?? {};
    this.markPurgedFailures = options.markPurgedFailures ?? 0;
  }

  /** Wall-clock passes: every lease expires and every retry backoff elapses. */
  advance(): void {
    if (this.row.lease === 'live') this.row.lease = 'expired';
    this.row.backoffPending = false;
  }

  get stranded(): boolean {
    return this.row.status === 'deactivated' && this.row.user_id === null;
  }

  private rpc(name: string, body: Record<string, unknown>): Response {
    const row = this.row;
    this.events.push(`rpc:${name}`);
    switch (name) {
      case 'reconcile_orphaned_purging_requests': {
        // purging AND user_id IS NULL AND lease expired -> mark purged.
        if (row.status === 'purging' && row.user_id === null && row.lease === 'expired') {
          row.status = 'purged';
          row.worker_id = null;
          row.lease = 'none';
          this.events.push('reconcile:closed');
          return jsonResponse([{ ...row }]);
        }
        return jsonResponse([]);
      }
      case 'claim_deletion_requests_for_purge': {
        const freshClaim =
          row.status === 'deactivated' &&
          row.user_id !== null && // join profiles on user_id
          !row.backoffPending &&
          (row.lease === 'none' || row.lease === 'expired');
        const staleReclaim = row.status === 'purging' && row.user_id !== null && row.lease === 'expired';
        if (!freshClaim && !staleReclaim) return jsonResponse([]);
        row.status = 'purging';
        row.attempt_count += 1;
        row.worker_id = String(body.p_worker_id);
        row.lease = 'live';
        row.failure_code = null;
        row.failure_message = null;
        return jsonResponse([
          {
            id: row.id,
            subject_ref: row.subject_ref,
            user_id: row.user_id,
            status: row.status,
            grace_period_ends_at: '2026-01-01T00:00:00.000Z',
            restored_at: null,
            purged_at: null,
            attempt_count: row.attempt_count,
          },
        ]);
      }
      case 'heartbeat_deletion_request_lease': {
        const ok = row.status === 'purging' && row.worker_id === body.p_worker_id && row.lease !== 'expired';
        if (ok) row.lease = 'live';
        return jsonResponse(ok);
      }
      case 'mark_deletion_request_purged': {
        if (this.markPurgedFailures > 0) {
          this.markPurgedFailures -= 1;
          return jsonResponse({ message: 'simulated mark-purged outage' }, 500);
        }
        const ok =
          row.status === 'purging' && (body.p_worker_id == null || row.worker_id === body.p_worker_id);
        if (ok) {
          row.status = 'purged';
          row.worker_id = null;
          row.lease = 'none';
          this.events.push('mark_purged:ok');
        }
        return jsonResponse(ok);
      }
      case 'schedule_deletion_retry_or_fail': {
        this.retryCalls.push({ maxAttempts: body.p_max_attempts });
        if (row.status !== 'purging' || row.worker_id !== body.p_worker_id) return jsonResponse(false);
        const maxAttempts = Math.max(
          1,
          Math.min(typeof body.p_max_attempts === 'number' ? body.p_max_attempts : 8, 20),
        );
        row.failure_code = String(body.p_failure_code ?? '');
        row.failure_message = String(body.p_failure_message ?? '');
        row.worker_id = null;
        row.lease = 'none';
        if (row.attempt_count >= maxAttempts) {
          row.status = 'failed';
        } else {
          row.status = 'deactivated';
          row.backoffPending = true;
        }
        this.events.push(`retry_scheduled:${row.status}`);
        return jsonResponse(true);
      }
      case 'claim_retained_owner_media_for_sweep':
        return jsonResponse([]);
      default:
        // append_deletion_state_transition, revoke_user_sessions,
        // record_retained_owner_media, settle_retained_owner_media, ...
        return jsonResponse(null);
    }
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const bodyText = method === 'GET' || method === 'HEAD' ? '' : await req.text();

    // RevenueCat (provider) -- the only host other than the fake Supabase.
    if (url.host === 'api.revenuecat.com') {
      const match = path.match(/\/customers\/([^/]+)\/actions\/revoke_granted_entitlement$/);
      const status = this.revenueCatStatuses.length > 0 ? this.revenueCatStatuses.shift()! : 200;
      this.revenueCatCalls.push({ appUserId: decodeURIComponent(match?.[1] ?? 'unmatched'), status });
      this.events.push(`rc:revoke:${status}`);
      return jsonResponse(status >= 200 && status < 300 ? {} : { message: 'provider says no' }, status);
    }
    if (url.host !== new URL(SUPABASE_URL).host) {
      throw new Error(`unexpected network host in test: ${url.host}`);
    }

    if (path.startsWith('/rest/v1/rpc/')) {
      const name = path.slice('/rest/v1/rpc/'.length);
      return this.rpc(name, bodyText ? JSON.parse(bodyText) : {});
    }

    if (path === '/rest/v1/app_config') {
      const key = url.searchParams.get('key')?.replace(/^eq\./, '');
      if (key === 'account_deletion_worker_enabled') return jsonResponse([{ value: { enabled: true } }]);
      if (key === 'account_deletion_worker_dry_run') return jsonResponse([{ value: { enabled: false } }]);
      return jsonResponse([]);
    }

    if (path === '/rest/v1/deletion_requests') {
      if (method === 'PATCH') {
        // The worker forcing user_id to NULL on the surviving row.
        this.row.user_id = null;
        this.events.push('patch:user_id_null');
        return new Response(null, { status: 204 });
      }
      if (method === 'GET') {
        return jsonResponse([{ ...this.row }]);
      }
    }

    if (path.startsWith('/rest/v1/')) {
      const table = path.slice('/rest/v1/'.length);
      if (method === 'HEAD') {
        // Residual verification counts. Only rows that survive the Auth delete
        // are non-zero; before the delete nothing here is read for a decision.
        const count = !this.authUserExists ? (this.residual[table] ?? 0) : 0;
        return new Response(null, { status: 200, headers: { 'content-range': `*/${count}` } });
      }
      if (method === 'DELETE') {
        return new Response(null, { status: 204, headers: { 'content-range': '*/0' } });
      }
      // dressing_rooms etc.: no shared rooms.
      return jsonResponse([]);
    }

    if (path.startsWith('/storage/v1/object/list/')) {
      return jsonResponse([]);
    }

    if (path === '/functions/v1/apple-revoke-credential') {
      this.events.push('apple:revoke');
      return jsonResponse({ status: 'no_credential' });
    }

    if (path.startsWith('/auth/v1/admin/users/') && method === 'DELETE') {
      if (this.authDeleteFailures > 0) {
        this.authDeleteFailures -= 1;
        this.events.push('auth:deleteUser:failed');
        return jsonResponse({ message: 'simulated gotrue outage', code: 'unexpected_failure' }, 500);
      }
      // The Auth user and its cascades are gone; the request row survives with
      // user_id set NULL by the ON DELETE SET NULL foreign key.
      this.authUserExists = false;
      this.row.user_id = null;
      this.events.push('auth:deleteUser');
      return jsonResponse({ id: USER_ID });
    }

    throw new Error(`unhandled fake request: ${method} ${path}`);
  };
}

// -- harness ---------------------------------------------------------------

type Handler = (req: Request) => Response | Promise<Response>;
let workerHandler: Handler | null = null;

async function loadWorkerHandler(): Promise<Handler> {
  if (workerHandler) return workerHandler;
  let captured: Handler | null = null;
  const descriptor = Object.getOwnPropertyDescriptor(Deno, 'serve');
  Object.defineProperty(Deno, 'serve', {
    configurable: true,
    writable: true,
    value: (handler: Handler) => {
      captured = handler;
      return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
    },
  });
  try {
    await import('./index.ts');
  } finally {
    if (descriptor) Object.defineProperty(Deno, 'serve', descriptor);
  }
  if (!captured) throw new Error('worker did not register a Deno.serve handler');
  workerHandler = captured;
  return captured;
}

const ENV: Record<string, string> = {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-fixture-not-a-real-key',
  ACCOUNT_DELETION_WORKER_SECRET: WORKER_SECRET,
  REVENUECAT_SYNC_ENABLED: 'true',
  REVENUECAT_SECRET_API_KEY: 'sk_test_fixture',
  REVENUECAT_PROJECT_ID: 'proj_test_fixture',
};
const ENV_UNSET = ['SUPABASE_ANON_KEY', 'DELETION_WORKER_DRY_RUN'];

async function withWorker(
  options: FakeOptions,
  body: (ctx: {
    fake: FakeBackend;
    invoke: () => Promise<{ status: number; json: Record<string, unknown> }>;
    logs: string[];
  }) => Promise<void>,
): Promise<void> {
  const handler = await loadWorkerHandler();
  const fake = new FakeBackend(options);

  const previousEnv: Record<string, string | undefined> = {};
  for (const key of [...Object.keys(ENV), ...ENV_UNSET]) previousEnv[key] = Deno.env.get(key);
  for (const [key, value] of Object.entries(ENV)) Deno.env.set(key, value);
  for (const key of ENV_UNSET) Deno.env.delete(key);

  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const realError = console.error;
  const logs: string[] = [];
  globalThis.fetch = fake.fetch as typeof fetch;
  console.log = (...args: unknown[]) => void logs.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => void logs.push(args.map(String).join(' '));

  try {
    await body({
      fake,
      logs,
      invoke: async () => {
        const response = await handler(
          new Request('https://worker.test/', {
            method: 'POST',
            headers: { 'x-deletion-worker-secret': WORKER_SECRET },
          }),
        );
        return { status: response.status, json: await response.json() };
      },
    });
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
    console.error = realError;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

// -- tests -----------------------------------------------------------------

Deno.test(
  'DEL-01: a RevenueCat 5xx must not strand the request after the Auth user is gone, and the mirror is still retired',
  async () => {
    await withWorker({ revenueCatStatuses: [503] }, async ({ fake, invoke }) => {
      await invoke();
      // Whatever the worker decided after the provider failure, it must not
      // have produced the unreachable state.
      assert(!fake.stranded, `request stranded: ${JSON.stringify(fake.row)}`);

      // Let every retry backoff and lease elapse, then keep invoking the worker
      // the way the scheduler does. The provider has recovered (200).
      for (let i = 0; i < 4; i += 1) {
        fake.advance();
        await invoke();
      }

      assertEquals(fake.row.status, 'purged', `request never settled: ${JSON.stringify(fake.row)}`);
      assertEquals(fake.authUserExists, false);
      const settled = fake.revenueCatCalls.filter((c) => c.status >= 200 && c.status < 300);
      assert(settled.length >= 1, 'the RevenueCat mirror was never retired successfully');
      for (const call of fake.revenueCatCalls) {
        assertEquals(call.appUserId, USER_ID, 'RevenueCat was asked about the wrong customer');
      }
    });
  },
);

Deno.test(
  'DEL-01: the RevenueCat mirror is retired for the real uuid BEFORE the Auth user is deleted',
  async () => {
    await withWorker({}, async ({ fake, invoke }) => {
      const { json } = await invoke();
      assertEquals(fake.row.status, 'purged');
      assertEquals((json.results as Array<{ status: string }>)[0].status, 'purged');

      const rc = fake.events.findIndex((e) => e.startsWith('rc:revoke'));
      const authDelete = fake.events.indexOf('auth:deleteUser');
      assertNotEquals(rc, -1, 'RevenueCat retire never ran');
      assertNotEquals(authDelete, -1, 'Auth delete never ran');
      assert(
        rc < authDelete,
        'RevenueCat retire must complete while the user uuid is still persisted, i.e. before the Auth delete',
      );
      assertEquals(fake.revenueCatCalls.length, 1);
      assertEquals(fake.revenueCatCalls[0].appUserId, USER_ID);
    });
  },
);

Deno.test(
  'DEL-01: residual rows found AFTER the Auth delete dead-letter the request with an operator alert, never strand it',
  async () => {
    await withWorker({ residualRowsAfterAuthDelete: { saved_scans: 2 } }, async ({ fake, invoke, logs }) => {
      await invoke();
      assert(!fake.stranded, `request stranded: ${JSON.stringify(fake.row)}`);
      assertEquals(fake.row.status, 'failed', 'residual user data must surface as a terminal, operator-visible state');
      assert(
        logs.some((l) => l.includes('purge_verification_failed')),
        'the residual-row alert must still be raised',
      );
      assert(
        logs.some((l) => l.includes('deletion_request_dead_lettered')),
        'a dead-lettered request must raise the operator alert',
      );
      // And it stays put: no later invocation may resurrect or strand it.
      for (let i = 0; i < 3; i += 1) {
        fake.advance();
        await invoke();
      }
      assertEquals(fake.row.status, 'failed');
    });
  },
);

Deno.test(
  'DEL-01: a mark-purged outage AFTER the Auth delete is closed out by crash-recovery reconcile, never rescheduled',
  async () => {
    await withWorker({ markPurgedFailures: 1 }, async ({ fake, invoke }) => {
      await invoke();
      assert(!fake.stranded, `request stranded: ${JSON.stringify(fake.row)}`);
      assert(
        !fake.events.some((e) => e.startsWith('retry_scheduled')),
        'the Auth user is gone, so the request must not be rescheduled for retry',
      );

      for (let i = 0; i < 3; i += 1) {
        fake.advance();
        await invoke();
      }
      assertEquals(fake.row.status, 'purged', `request never settled: ${JSON.stringify(fake.row)}`);
      assert(fake.events.includes('reconcile:closed'), 'the orphan reconcile must be what closes it out');
    });
  },
);

Deno.test(
  'DEL-01 regression: a failure BEFORE the Auth delete still reschedules, the request is reclaimed, and the purge completes',
  async () => {
    await withWorker({ authDeleteFailures: 1 }, async ({ fake, invoke }) => {
      await invoke();
      // The user still exists, so the normal durable retry path applies.
      assertEquals(fake.authUserExists, true);
      assertEquals(fake.row.status, 'deactivated');
      assertEquals(fake.row.user_id, USER_ID, 'the user link must survive a pre-delete failure');
      assertEquals(fake.row.backoffPending, true);
      assertEquals(fake.retryCalls.length, 1);

      fake.advance();
      await invoke();
      assertEquals(fake.row.status, 'purged');
      assertEquals(fake.authUserExists, false);
    });
  },
);
