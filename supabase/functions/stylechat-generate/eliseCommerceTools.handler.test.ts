/**
 * OC-01 × Corporate Intelligence v2 flag matrix (Addendum A10) on the REAL
 * stylechat-generate handler (captured from Deno.serve). Synthetic auth,
 * consent, quota, Gemini (planner + reply), Serper and the reference-store
 * RPCs. No network permission; any unexpected external call is recorded.
 */
import assert from 'node:assert/strict';
import { _resetRegistryCacheForTests, CI_V2_CORPORATE_CHARTER_TEXT, CI_V2_KILL_SWITCH_ENV, CI_V2_MASTER_ENV } from './corporateIntelligenceV2.ts';
import { OC01_ACTOR_ALLOWLIST_ENV, OC01_KILL_SWITCH_ENV, OC01_MASTER_ENV, OC01_PRODUCTS_CONTRACT } from './eliseCommerceTools.ts';
import { _resetShoppingCache } from '../scan-identify/shoppingProvider.ts';

const ORIGIN = 'https://oc01-fixture.invalid';
const ACTOR = '00000000-0000-4000-8000-0000000000c1';
const SESSION = '11111111-1111-4111-8111-1111111111c1';
const CAP = { 'X-KScan-Client-Capabilities': OC01_PRODUCTS_CONTRACT };
const T = { sanitizeOps: false, sanitizeResources: false };

type Body = { system_instruction?: { parts?: { text?: string }[] }; contents?: { role: string; parts: { text?: string }[] }[]; generationConfig?: Record<string, unknown> };
const state = {
  planner: [] as Body[],
  replies: [] as Body[],
  plannerOut: { action: 'find', item_type: 'outerwear', subtype: 'bomber', material: 'leather' } as Record<string, unknown>,
  replyText: 'These leather bombers from Nordline are a strong match; wear one with dark denim and white sneakers.',
  serper: 0,
  stored: [] as unknown[],
  external: [] as string[],
  logs: [] as string[],
};

let handler: ((req: Request) => Promise<Response>) | undefined;
const realLog = console.log;

async function boot() {
  if (handler) return handler;
  for (const [k, v] of Object.entries({ SUPABASE_URL: ORIGIN, SUPABASE_ANON_KEY: 'synthetic', SUPABASE_SERVICE_ROLE_KEY: 'synthetic', GEMINI_API_KEY: 'synthetic', SHOPPING_SERPER_API_KEY: 'synthetic', SHOPPING_BRAVE_API_KEY: 'synthetic' })) Deno.env.set(k, v);
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.host === 'generativelanguage.googleapis.com') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Body;
      if (body.generationConfig?.responseSchema) {
        state.planner.push(body);
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(state.plannerOut) }] } }], usageMetadata: { promptTokenCount: 310, candidatesTokenCount: 24 } });
      }
      state.replies.push(body);
      return Response.json({ candidates: [{ content: { parts: [{ text: state.replyText }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 60 } });
    }
    if (url.host === 'google.serper.dev') {
      state.serper++;
      return Response.json({ shopping: [1, 2, 3].map((i) => ({ title: `Black leather bomber jacket ${i}`, link: `https://www.nordline.shop/p/${i}`, source: 'Nordline', price: '$89.00', currency: 'USD', imageUrl: `https://cdn.nordline.shop/${i}.jpg` })) });
    }
    if (url.origin !== ORIGIN) {
      state.external.push(url.host);
      return Response.json({ error: 'external_call_denied' }, { status: 503 });
    }
    switch (url.pathname) {
      case '/auth/v1/user':
        return Response.json({ id: ACTOR, aud: 'authenticated', role: 'authenticated', is_anonymous: false, app_metadata: { provider: 'email' } });
      case '/rest/v1/profiles':
        return Response.json([{ id: ACTOR, account_status: 'active', account_locked_at: null }]);
      case '/rest/v1/legal_acceptances':
        return Response.json([{ user_id: ACTOR, acceptance_type: 'ai_processing', policy_version: 'v2_google_gemini' }]);
      case '/rest/v1/ai_processing_permissions':
        return Response.json([{ user_id: ACTOR, policy_version: 'v2_google_gemini', granted: true }]);
      case '/rest/v1/style_chat_sessions':
        return Response.json([{ id: SESSION, user_id: ACTOR }]);
      case '/rest/v1/discovery_brands':
        return Response.json([{ name: 'Maison Obscura' }]);
      case '/rest/v1/rpc/elise_commerce_refs_load':
        return Response.json([]);
      case '/rest/v1/rpc/elise_commerce_refs_store':
        state.stored.push(JSON.parse(String(init?.body ?? '{}')));
        return Response.json(3);
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      return Response.json([{ allowed: true, limit_reached: false, messages_used: 1, messages_limit: 20, reset_at: null, retry_after_seconds: 0 }]);
    }
    return Response.json([]);
  };
  Object.defineProperty(Deno, 'serve', {
    configurable: true,
    value: (a: unknown, b: unknown) => {
      handler = (typeof a === 'function' ? a : b) as typeof handler;
      return { finished: Promise.resolve(), shutdown: async () => {} };
    },
  });
  await import('./index.ts');
  return handler!;
}

function flags(ci: 'off' | 'on' | 'kill', oc: 'off' | 'on' | 'kill' | 'not_cohort') {
  for (const k of [CI_V2_MASTER_ENV, CI_V2_KILL_SWITCH_ENV, OC01_MASTER_ENV, OC01_KILL_SWITCH_ENV, OC01_ACTOR_ALLOWLIST_ENV]) Deno.env.delete(k);
  if (ci !== 'off') Deno.env.set(CI_V2_MASTER_ENV, 'true');
  if (ci === 'kill') Deno.env.set(CI_V2_KILL_SWITCH_ENV, 'true');
  if (oc !== 'off') Deno.env.set(OC01_MASTER_ENV, 'true');
  if (oc === 'on' || oc === 'kill') Deno.env.set(OC01_ACTOR_ALLOWLIST_ENV, ACTOR);
  if (oc === 'kill') Deno.env.set(OC01_KILL_SWITCH_ENV, 'true');
}

async function send(message: string, headers: Record<string, string> = {}) {
  const invoke = await boot();
  _resetShoppingCache();
  _resetRegistryCacheForTests();
  Object.assign(state, { planner: [], replies: [], serper: 0, stored: [], external: [], logs: [] });
  console.log = (...args: unknown[]) => { state.logs.push(args.map(String).join(' ')); };
  try {
    const res = await invoke(new Request(`${ORIGIN}/functions/v1/stylechat-generate`, {
      method: 'POST',
      headers: { Authorization: 'Bearer synthetic-verified-user', apikey: 'synthetic', 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ sessionId: SESSION, message, requestId: 'req-oc01-fixed-0001' }),
    }));
    return { status: res.status, json: await res.json(), planner: [...state.planner], replies: [...state.replies], serper: state.serper, stored: [...state.stored], external: [...state.external], logs: [...state.logs] };
  } finally {
    console.log = realLog;
  }
}

const sys = (b: Body) => b.system_instruction?.parts?.[0]?.text ?? '';
const lastUser = (b: Body) => [...(b.contents ?? [])].reverse().find((c) => c.role === 'user')?.parts?.[0]?.text ?? '';
const oc01Logs = (logs: string[]) => logs.filter((l) => l.includes('[stylechat-generate] oc01 %s')).map((l) => JSON.parse(l.slice(l.indexOf('{'))));

Deno.test('OFF/OFF: legacy Elise — no planner, no provider, no new fields, capability changes nothing', T, async () => {
  flags('off', 'off');
  const plain = await send('Find me a leather bomber jacket');
  const withCap = await send('Find me a leather bomber jacket', CAP);
  for (const r of [plain, withCap]) {
    assert.equal(r.status, 200);
    assert.equal(r.planner.length, 0);
    assert.equal(r.serper, 0);
    assert.equal('commerceResults' in r.json, false);
    assert.equal(oc01Logs(r.logs).length, 0, 'flag OFF emits nothing');
  }
  assert.equal(sys(withCap.replies[0]), sys(plain.replies[0]), 'system text byte-identical');
  assert.deepEqual(withCap.replies[0].contents, plain.replies[0].contents, 'turns byte-identical');
  assert.deepEqual(Object.keys(withCap.json).sort(), Object.keys(plain.json).sort());
});

Deno.test('OFF/ON: independent read-only shopping with cards; CI-v2 charter absent', T, async () => {
  flags('off', 'on');
  const r = await send('Find me a leather bomber jacket', CAP);
  assert.equal(r.status, 200);
  assert.equal(r.planner.length, 1, 'exactly one planner call');
  assert.equal(r.serper, 1);
  assert.equal(r.json.commerceResults.version, OC01_PRODUCTS_CONTRACT);
  assert.equal(r.json.commerceResults.status, 'ready');
  assert.equal(r.json.commerceResults.products.length, 3);
  assert.equal(r.json.message.content, state.replyText);
  assert.ok(!sys(r.replies[0]).includes(CI_V2_CORPORATE_CHARTER_TEXT));
  assert.match(sys(r.replies[0]), /Product tools \(server-verified for this turn\)/);
  assert.match(lastUser(r.replies[0]), /<commerce_context/);
  assert.doesNotMatch(lastUser(r.replies[0]), /https:\/\/www\.nordline/, 'model never receives destinations');
  assert.doesNotMatch(JSON.stringify(r.planner[0]), /nordline\.shop|p_[a-f0-9-]{36}/);
  assert.equal(r.stored.length, 1, 'references persisted server-side once');
  assert.deepEqual(r.external, []);
  const [log] = oc01Logs(r.logs);
  assert.equal(log.clientStatus, 'ready');
  assert.equal(log.cohort, 'allowlist');
});

Deno.test('ON/OFF: new company voice without retrieval', T, async () => {
  flags('on', 'off');
  const r = await send('What goes with a navy blazer?', CAP);
  assert.equal(r.status, 200);
  assert.equal(r.planner.length, 0);
  assert.ok(sys(r.replies[0]).includes(CI_V2_CORPORATE_CHARTER_TEXT));
  assert.equal('commerceResults' in r.json, false);
});

Deno.test('ON/ON: company voice + retrieval + cards; merchant named by the model passes the CI-03 finalizer', T, async () => {
  flags('on', 'on');
  const r = await send('Find me a leather bomber jacket', CAP);
  assert.equal(r.status, 200);
  const s = sys(r.replies[0]);
  assert.ok(s.includes(CI_V2_CORPORATE_CHARTER_TEXT));
  assert.match(s, /Product tools \(server-verified for this turn\)/);
  assert.ok(s.indexOf(CI_V2_CORPORATE_CHARTER_TEXT) < s.indexOf('Product tools'), 'corporate rules precede persona + tool guidance');
  assert.match(lastUser(r.replies[0]), /<commerce_context/);
  assert.equal(r.json.commerceResults.status, 'ready');
  assert.equal(r.json.message.content, state.replyText, 'CI-03 accepted the server-held merchant label');
  const ci = r.logs.filter((l) => l.includes('ci_v2 %s')).map((l) => JSON.parse(l.slice(l.indexOf('{'))));
  assert.equal(ci.at(-1).validator, 'accept');
});

Deno.test('ON/ON: a model-invented price claim is rejected by CI-03; cards stay server-authored', T, async () => {
  flags('on', 'on');
  const previous = state.replyText;
  state.replyText = 'The Nordline bomber is only $59 today and in stock.';
  try {
    const r = await send('Find me a leather bomber jacket', CAP);
    assert.notEqual(r.json.message.content, state.replyText);
    assert.doesNotMatch(r.json.message.content, /\$59|in stock/);
    assert.equal(r.json.commerceResults.products[0].listedPrice, '$89.00');
  } finally {
    state.replyText = previous;
  }
});

Deno.test('released client (no capability), out-of-cohort actor and kill switch all take the legacy path', T, async () => {
  for (const [oc, extra] of [['on', {}], ['not_cohort', CAP], ['kill', CAP]] as const) {
    flags('off', oc);
    const r = await send('Find me a leather bomber jacket', extra);
    assert.equal(r.planner.length, 0, oc);
    assert.equal(r.serper, 0, oc);
    assert.equal('commerceResults' in r.json, false, oc);
  }
});

Deno.test('unsupported action is declined with no planner/provider call and a closed card status', T, async () => {
  flags('on', 'on');
  const r = await send('Buy it for me now', CAP);
  assert.equal(r.planner.length, 0);
  assert.equal(r.serper, 0);
  assert.equal(r.json.commerceResults.status, 'unsupported_action');
  assert.match(sys(r.replies[0]), /cannot do that in this release/);
});

Deno.test('ordinary styling message with OC-01 ON costs nothing extra', T, async () => {
  flags('off', 'on');
  const r = await send('What should I wear to a summer wedding?', CAP);
  assert.equal(r.planner.length, 0);
  assert.equal(r.serper, 0);
  assert.equal('commerceResults' in r.json, false);
  assert.equal(oc01Logs(r.logs)[0].preFilter, 'none');
});

Deno.test('review P2-1: an unsafe why_this_works explanation is dropped on a product turn', T, async () => {
  flags('off', 'on');
  const previous = state.replyText;
  state.replyText = '<content>These bombers suit a clean weekend look.</content><why_this_works>At $49 and in stock, it is a steal.</why_this_works>';
  try {
    const r = await send('Find me a leather bomber jacket', CAP);
    assert.equal(r.json.message.content, 'These bombers suit a clean weekend look.');
    assert.equal('why_this_works' in r.json.message, false);
  } finally {
    state.replyText = previous;
  }
});
