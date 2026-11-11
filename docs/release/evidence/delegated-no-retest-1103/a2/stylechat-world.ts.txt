/**
 * Audit lane A2 batch 3: a synthetic world around the REAL stylechat-generate Edge handler.
 *
 * - Deno.serve is captured so the actual `index.ts` handler runs unmodified.
 * - globalThis.fetch is replaced: no packet leaves the process. Supabase Auth, PostgREST,
 *   RPC and Gemini are scripted. Every call is recorded for side-effect assertions.
 * - The table stubs apply ONLY the filters the handler itself puts in the query
 *   (eq.user_id etc.). They deliberately do NOT emulate RLS, so a removed handler-side
 *   ownership filter is observable (mutation-tested in the ledger).
 *
 * A mock is not a live provider and this is not a deployed function.
 */

export const HOST = 'https://stylechat-a2-fixture.invalid';
export const ACTOR_A = '00000000-0000-4000-8000-0000000000a1';
export const ACTOR_B = '00000000-0000-4000-8000-0000000000b2';
export const SESSION_A = '11111111-1111-4111-8111-1111111111a1';
export const SESSION_B = '11111111-1111-4111-8111-1111111111b2';
export const GEMINI_KEY = 'synthetic-gemini-key-do-not-leak';
export const TOKEN_A = 'synthetic-token-A';
export const TOKEN_B = 'synthetic-token-B';

export type Call = { url: URL; method: string; headers: Headers; body: string };

export interface World {
  tokens: Record<string, string>; // bearer token -> user id
  sessions: Record<string, string>; // session id -> owner user id
  profileStatus: Record<string, string>; // user id -> account_status
  consent: boolean;
  authStatus: number; // when not 200 every /auth/v1/user returns this
  rpc: Record<string, (body: Record<string, unknown>, call: Call) => Response>;
  gemini: (n: number, body: Record<string, unknown>, call: Call) => Response | Promise<Response>;
  tables: Record<string, (call: Call) => Response | null>; // optional per-table override
  calls: Call[];
  geminiCalls: number;
  logs: string[];
  fastTimeout: boolean; // scale the 12s Gemini attempt timeout to 25ms (timeout cell only)
}

export function okJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export function geminiText(text: string, extra: Record<string, unknown> = {}): Response {
  return okJson({
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { totalTokenCount: 42 },
    ...extra,
  });
}

export const GOOD_REPLY = 'Pair the navy blazer with a crisp white tee and tailored grey trousers for a clean, polished look.';

export function newWorld(): World {
  return {
    tokens: { [TOKEN_A]: ACTOR_A, [TOKEN_B]: ACTOR_B },
    sessions: { [SESSION_A]: ACTOR_A, [SESSION_B]: ACTOR_B },
    profileStatus: { [ACTOR_A]: 'active', [ACTOR_B]: 'active' },
    consent: true,
    authStatus: 200,
    rpc: {
      check_and_increment_stylechat_burst: () => okJson([{ allowed: true, retry_after_seconds: 0 }]),
      increment_stylechat_daily_usage: () => okJson([{ messages_used: 1, messages_limit: 25, limit_reached: false }]),
      increment_stylechat_daily_usage_idempotent: () =>
        okJson([{ messages_used: 1, messages_limit: 25, limit_reached: false, duplicate_request: false }]),
      has_active_k_plus: () => okJson(false),
    },
    gemini: () => geminiText(GOOD_REPLY),
    tables: {},
    calls: [],
    geminiCalls: 0,
    logs: [],
    fastTimeout: false,
  };
}

const ENV_NAMES = [
  'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'GEMINI_API_KEY',
];

export interface Harness {
  world: World;
  invoke: (init: { token?: string | null; body?: unknown; rawBody?: string; headers?: Record<string, string>; method?: string }) => Promise<Response>;
  restore: () => void;
  gemini: () => Call[];
  rpcCalls: (name?: string) => Call[];
  writes: () => Call[];
  outboundHosts: () => string[];
}

let cachedHandler: ((req: Request) => Promise<Response>) | undefined;

export async function startHarness(world: World, env: Record<string, string> = {}): Promise<Harness> {
  const saved = [...ENV_NAMES, ...Object.keys(env)].map((n) => [n, Deno.env.get(n)] as const);
  const originalFetch = globalThis.fetch;
  const originalServe = Object.getOwnPropertyDescriptor(Deno, 'serve');
  const originalSetTimeout = globalThis.setTimeout;
  const consoleSaved = { log: console.log, warn: console.warn, error: console.error };
  Deno.env.set('SUPABASE_URL', HOST);
  Deno.env.set('SUPABASE_ANON_KEY', 'synthetic-anon');
  Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-service-role');
  Deno.env.set('GEMINI_API_KEY', GEMINI_KEY);
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);

  const sink = (...a: unknown[]) => { world.logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
  console.log = sink; console.warn = sink; console.error = sink;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : null;
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? req?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers ?? req?.headers ?? {});
    let body = '';
    if (typeof init?.body === 'string') body = init.body;
    else if (req && method !== 'GET') body = await req.clone().text();
    const call: Call = { url, method, headers, body };
    world.calls.push(call);
    const signal = init?.signal ?? req?.signal;

    if (url.hostname.endsWith('googleapis.com')) {
      world.geminiCalls += 1;
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(body); } catch { /* keep {} */ }
      const out = world.gemini(world.geminiCalls, parsed, call);
      if (out instanceof Promise) {
        return await Promise.race([
          out,
          new Promise<Response>((_, rej) => {
            signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
          }),
        ]);
      }
      return out;
    }
    if (url.origin !== HOST) return okJson({ error: 'external_call_denied' }, 503);

    if (url.pathname === '/auth/v1/user') {
      if (world.authStatus !== 200) return okJson({ code: world.authStatus, msg: 'auth_fixture_denied' }, world.authStatus);
      const token = (headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
      const uid = world.tokens[token];
      if (!uid) return okJson({ code: 401, msg: 'invalid JWT' }, 401);
      return okJson({ id: uid, aud: 'authenticated', role: 'authenticated', is_anonymous: false, app_metadata: { provider: 'email' } });
    }
    const rpcMatch = url.pathname.match(/^\/rest\/v1\/rpc\/(.+)$/);
    if (rpcMatch) {
      let parsed: Record<string, unknown> = {};
      try { parsed = body ? JSON.parse(body) : {}; } catch { /* keep {} */ }
      const fn = world.rpc[rpcMatch[1]];
      if (!fn) return okJson({ message: 'unscripted rpc ' + rpcMatch[1] }, 404);
      return fn(parsed, call);
    }
    const table = url.pathname.replace('/rest/v1/', '');
    const override = world.tables[table]?.(call);
    if (override) return override;
    const q = (k: string) => (url.searchParams.get(k) ?? '').replace(/^eq\./, '');
    const rows = (r: unknown[]) => {
      const wantsObject = (headers.get('accept') ?? '').includes('vnd.pgrst.object');
      if (!wantsObject) return okJson(r);
      return r.length === 1 ? okJson(r[0]) : okJson({ code: 'PGRST116', message: 'no rows' }, 406);
    };
    if (method !== 'GET' && method !== 'HEAD') return okJson([], 201);
    if (table === 'profiles') {
      const id = q('id');
      return okJson([{ id, account_status: world.profileStatus[id] ?? 'active', account_locked_at: null }]);
    }
    if (table === 'legal_acceptances') {
      const u = q('user_id');
      return okJson(world.consent ? [{ user_id: u, acceptance_type: 'ai_processing', policy_version: 'v2_google_gemini' }] : []);
    }
    if (table === 'ai_processing_permissions') {
      const u = q('user_id');
      return okJson(world.consent ? [{ user_id: u, policy_version: 'v2_google_gemini', granted: true }] : []);
    }
    if (table === 'style_chat_sessions') {
      const id = q('id');
      const owner = q('user_id');
      const hit = world.sessions[id] !== undefined && (owner === '' || world.sessions[id] === owner);
      return rows(hit ? [{ id }] : []);
    }
    return rows([]);
  }) as typeof fetch;

  // Optionally scale the Gemini attempt timeout so a hung provider is observable in ~25ms.
  globalThis.setTimeout = ((fn: TimerHandler, ms?: number, ...rest: unknown[]) =>
    originalSetTimeout(fn as () => void, ms === 12_000 && world.fastTimeout ? 25 : ms, ...rest)) as typeof setTimeout;

  Object.defineProperty(Deno, 'serve', {
    configurable: true,
    value: (a: unknown, b: unknown) => {
      cachedHandler = (typeof a === 'function' ? a : b) as typeof cachedHandler;
      return { finished: Promise.resolve(), shutdown: async () => {} };
    },
  });
  if (!cachedHandler) await import('../../supabase/functions/stylechat-generate/index.ts');
  if (!cachedHandler) throw new Error('real Edge handler was not captured');
  const handler = cachedHandler;

  return {
    world,
    async invoke({ token = TOKEN_A, body, rawBody, headers = {}, method = 'POST' }) {
      const h: Record<string, string> = { 'Content-Type': 'application/json', apikey: 'synthetic-anon', ...headers };
      if (token !== null) h.Authorization = `Bearer ${token}`;
      return await handler(new Request(`${HOST}/functions/v1/stylechat-generate`, {
        method,
        headers: h,
        body: method === 'GET' ? undefined : (rawBody ?? JSON.stringify(body)),
      }));
    },
    restore() {
      globalThis.fetch = originalFetch;
      globalThis.setTimeout = originalSetTimeout;
      console.log = consoleSaved.log; console.warn = consoleSaved.warn; console.error = consoleSaved.error;
      if (originalServe) Object.defineProperty(Deno, 'serve', originalServe);
      for (const [n, v] of saved) { if (v === undefined) Deno.env.delete(n); else Deno.env.set(n, v); }
    },
    gemini: () => world.calls.filter((c) => c.url.hostname.endsWith('googleapis.com')),
    rpcCalls: (name) => world.calls.filter((c) => c.url.pathname.startsWith('/rest/v1/rpc/') && (!name || c.url.pathname.endsWith('/' + name))),
    writes: () => world.calls.filter((c) => c.url.origin === HOST && c.method !== 'GET' && c.method !== 'HEAD' && !c.url.pathname.startsWith('/rest/v1/rpc/') && c.url.pathname !== '/auth/v1/user'),
    outboundHosts: () => [...new Set(world.calls.map((c) => c.url.hostname))],
  };
}

export function chatBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { sessionId: SESSION_A, message: 'What goes with a navy blazer?', requestId: 'req-a2-control', ...over };
}
