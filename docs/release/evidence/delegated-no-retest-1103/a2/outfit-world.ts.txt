/**
 * Audit lane A2 batch 4: a synthetic world around the REAL style-outfit-generate Edge handler.
 *
 * - Deno.serve is captured so the actual `index.ts` handler runs unmodified.
 * - globalThis.fetch is replaced: no packet leaves the process. Supabase Auth, PostgREST (closet,
 *   saved_scans, inspiration_items, profiles, consent), the two quota RPCs and Gemini are scripted.
 * - The table stubs apply ONLY the filters the handler puts in the query (user_id=eq., deleted_at=is.null).
 *   They deliberately do NOT emulate RLS, so a removed handler-side ownership filter is observable.
 *
 * A mock is not a live provider and this is not a deployed function.
 */
import { ACTOR_A, ACTOR_B, GEMINI_KEY, HOST, TOKEN_A, TOKEN_B, geminiText, okJson, type Call } from './stylechat-world.ts';

export { ACTOR_A, ACTOR_B, GEMINI_KEY, HOST, TOKEN_A, TOKEN_B, geminiText, okJson };
export type { Call };

export type Row = Record<string, unknown>;

export const id = (p: string, n: number) => `${p}-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const A_TOP = id('aaaaaaaa', 1);
export const A_BOTTOM = id('aaaaaaaa', 2);
export const A_SHOES = id('aaaaaaaa', 3);
export const A_COAT = id('aaaaaaaa', 4);
export const A_TOP2 = id('aaaaaaaa', 5);
export const B_TOP = id('bbbbbbbb', 1);
export const B_BOTTOM = id('bbbbbbbb', 2);
export const B_SHOES = id('bbbbbbbb', 3);
export const B_COAT = id('bbbbbbbb', 4);
export const INVENTED = id('cccccccc', 9);

export function closetRow(userId: string, rowId: string, clothingType: string, extra: Row = {}): Row {
  return {
    id: rowId, user_id: userId, title: clothingType + ' title', category: clothingType, clothing_type: clothingType,
    subtype: null, brand: null, primary_color: 'navy', material: ['cotton'], deleted_at: null, updated_at: '2026-11-01T00:00:00Z', ...extra,
  };
}

export interface OutfitWorld {
  tokens: Record<string, string>;
  profileStatus: Record<string, string>;
  consent: boolean;
  authStatus: number;
  closet: Row[]; // global table; handler-side filters only
  scans: Row[];
  inspirations: Row[];
  rpc: Record<string, (body: Record<string, unknown>, call: Call) => Response>;
  gemini: (n: number, body: Record<string, unknown>, call: Call) => Response | Promise<Response>;
  tables: Record<string, (call: Call) => Response | null>;
  calls: Call[];
  geminiCalls: number;
  logs: string[];
  fastTimeout: boolean; // scale the 15s Gemini attempt timeout to 25ms (timeout cell only)
}

/** A provider reply that names real pool ids as one complete reliable outfit. */
export function outfitReply(ids: string[], over: Row = {}): Response {
  return geminiText(JSON.stringify({
    outfits: [{
      variation: 'reliable',
      itemRefs: ids.map((sourceId) => ({ sourceType: 'closet_item', sourceId })),
      reason: 'Navy top, trousers and sneakers read clean and easy.',
      confidence: 'high', ...over,
    }],
  }));
}

export function newWorld(): OutfitWorld {
  return {
    tokens: { [TOKEN_A]: ACTOR_A, [TOKEN_B]: ACTOR_B },
    profileStatus: { [ACTOR_A]: 'active', [ACTOR_B]: 'active' },
    consent: true,
    authStatus: 200,
    closet: [
      closetRow(ACTOR_A, A_TOP, 'T-Shirt'),
      closetRow(ACTOR_A, A_BOTTOM, 'Pants'),
      closetRow(ACTOR_A, A_SHOES, 'Sneakers'),
      closetRow(ACTOR_A, A_COAT, 'Blazer'),
      closetRow(ACTOR_A, A_TOP2, 'Sweater'),
      closetRow(ACTOR_B, B_TOP, 'T-Shirt', { brand: 'B_PRIVATE_BRAND' }),
      closetRow(ACTOR_B, B_BOTTOM, 'Pants'),
      closetRow(ACTOR_B, B_SHOES, 'Sneakers'),
      closetRow(ACTOR_B, B_COAT, 'Blazer'),
    ],
    scans: [],
    inspirations: [],
    rpc: {
      check_and_increment_style_outfit_burst: () => okJson([{ allowed: true, retry_after_seconds: 0 }]),
      increment_style_outfit_daily_usage: () => okJson([{ generations_used: 1, generations_limit: 10, limit_reached: false }]),
    },
    gemini: () => outfitReply([A_TOP, A_BOTTOM, A_SHOES]),
    tables: {},
    calls: [],
    geminiCalls: 0,
    logs: [],
    fastTimeout: false,
  };
}

const ENV_NAMES = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'GEMINI_API_KEY', 'STYLE_OUTFIT_AI_ENABLED', 'STYLE_OUTFIT_BURST_LIMIT_PER_MINUTE', 'STYLE_OUTFIT_DAILY_LIMIT', 'STYLE_OUTFIT_GEMINI_MODEL'];

export interface Harness {
  world: OutfitWorld;
  invoke: (init: { token?: string | null; body?: unknown; rawBody?: string; headers?: Record<string, string>; method?: string }) => Promise<Response>;
  restore: () => void;
  gemini: () => Call[];
  rpcCalls: (name?: string) => Call[];
  writes: () => Call[];
  outboundHosts: () => string[];
}

let cachedHandler: ((req: Request) => Promise<Response>) | undefined;

export async function startHarness(world: OutfitWorld, env: Record<string, string> = {}): Promise<Harness> {
  const saved = [...ENV_NAMES, ...Object.keys(env)].map((n) => [n, Deno.env.get(n)] as const);
  const originalFetch = globalThis.fetch;
  const originalServe = Object.getOwnPropertyDescriptor(Deno, 'serve');
  const originalSetTimeout = globalThis.setTimeout;
  const consoleSaved = { log: console.log, warn: console.warn, error: console.error };
  for (const n of ENV_NAMES) Deno.env.delete(n);
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
          new Promise<Response>((_, rej) => { signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))); }),
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
    // Apply ONLY the filters the handler put in the query.
    const filtered = (all: Row[]) => {
      let r = all;
      if (url.searchParams.has('user_id')) r = r.filter((x) => String(x.user_id) === q('user_id'));
      if (url.searchParams.get('deleted_at') === 'is.null') r = r.filter((x) => x.deleted_at == null);
      return r;
    };
    if (method !== 'GET' && method !== 'HEAD') return okJson([], 201);
    if (table === 'profiles') {
      const pid = q('id');
      return okJson([{ id: pid, account_status: world.profileStatus[pid] ?? 'active', account_locked_at: null }]);
    }
    if (table === 'legal_acceptances') {
      const u = q('user_id');
      return okJson(world.consent ? [{ user_id: u, acceptance_type: 'ai_processing', policy_version: 'v2_google_gemini' }] : []);
    }
    if (table === 'ai_processing_permissions') {
      const u = q('user_id');
      return okJson(world.consent ? [{ user_id: u, policy_version: 'v2_google_gemini', granted: true }] : []);
    }
    if (table === 'user_closet_items') return okJson(filtered(world.closet));
    if (table === 'saved_scans') return okJson(filtered(world.scans));
    if (table === 'inspiration_items') return okJson(filtered(world.inspirations));
    return okJson([]);
  }) as typeof fetch;

  // Optionally scale the 15s Gemini attempt timeout so a hung provider is observable in ~25ms.
  globalThis.setTimeout = ((fn: TimerHandler, ms?: number, ...rest: unknown[]) =>
    originalSetTimeout(fn as () => void, ms === 15_000 && world.fastTimeout ? 25 : ms, ...rest)) as typeof setTimeout;

  Object.defineProperty(Deno, 'serve', {
    configurable: true,
    value: (a: unknown, b: unknown) => {
      cachedHandler = (typeof a === 'function' ? a : b) as typeof cachedHandler;
      return { finished: Promise.resolve(), shutdown: async () => {} };
    },
  });
  if (!cachedHandler) await import('../../supabase/functions/style-outfit-generate/index.ts');
  if (!cachedHandler) throw new Error('real Edge handler was not captured');
  const handler = cachedHandler;

  return {
    world,
    async invoke({ token = TOKEN_A, body, rawBody, headers = {}, method = 'POST' }) {
      const h: Record<string, string> = { 'Content-Type': 'application/json', apikey: 'synthetic-anon', ...headers };
      if (token !== null) h.Authorization = `Bearer ${token}`;
      return await handler(new Request(`${HOST}/functions/v1/style-outfit-generate`, {
        method, headers: h, body: method === 'GET' ? undefined : (rawBody ?? JSON.stringify(body)),
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

/** A valid unversioned style_item request anchored on actor A's top. */
export function outfitBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { mode: 'style_item', contractVersion: '1', anchorItem: { sourceType: 'closet_item', sourceId: A_TOP }, maximumOutfits: 1, ...over };
}
