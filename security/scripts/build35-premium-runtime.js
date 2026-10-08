#!/usr/bin/env node
'use strict';

// Owner-authorized, Staging-only Build35 proof harness. No credential or JWT
// enters argv, a file, an artifact, or output. Commands arrive on stdin.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const readline = require('node:readline');
const { signInSyntheticUser, maskLine } = require('./synthetic-auth');
const { runModule } = require('../../__tests__/helpers/componentRenderer');
const ROOT = path.resolve(__dirname, '../..');
const URL = 'https://yzqjvdfgefveprobvvyw.supabase.co';
const PROJECT = 'yzqjvdfgefveprobvvyw';
const REPO = 'kscanaiapp/kscan-app';
const ledgerPath = path.join(ROOT, 'docs/audits/build35-premium-value-ledger.json');
const reportPath = path.join(ROOT, 'docs/audits/build35-premium-runtime.json');
const secretNames = ['STAGING_BUILD35_PREMIUM_EMAIL', 'STAGING_BUILD35_PREMIUM_PASSWORD'];
const masked = new Set();
const mask = value => {
  if (!value) return;
  masked.add(value); // Immediate redaction registration, before any use.
  if (process.env.GITHUB_ACTIONS === 'true') process.stderr.write(maskLine(value) + '\n');
};
const output = value => {
  let text = JSON.stringify(value);
  for (const value of masked) text = text.split(value).join('[MASKED]');
  process.stdout.write(text + '\n');
};
const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) :
  { environment: 'staging', startedAt: new Date().toISOString(), assertions: [] };
function save() {
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
}
function before(type, resource, pre, change, reason, disposition = 'DELETE_SYNTHETIC_FIXTURE') {
  const entry = { type, keyOrResource: resource, preWriteState: pre, intendedChange: change,
    reason, timestamp: new Date().toISOString(), ownerScope: 'Build35 premium-value dedicated synthetic actor',
    postLaneDisposition: disposition, outcome: 'PENDING' };
  ledger.writes.push(entry); save(); return entry;
}
function done(entry, outcome = 'APPLIED') { entry.outcome = outcome; save(); }
function check(name, pass, metadata = {}) {
  const assertion = { name, pass: pass === true, ...metadata, at: new Date().toISOString() };
  report.assertions.push(assertion); save(); output(assertion);
  if (!pass) throw new Error('assertion_failed');
}
let pub, service, token, actor, grant, sessionId, packingPlan;
let secretsStored = [];
let client, ownedIds = [];
function modules() {
  const { createClient } = require('@supabase/supabase-js');
  client = createClient(URL, pub, { accessToken: async () => token, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const auth = { getSession: async () => {
    const user = await request('/auth/v1/user');
    return { data: { session: { user } } };
  }};
  // The real client transports all REST/function calls. Only its native app
  // session boundary is adapted to this harness's fresh in-memory session.
  const transport = { from: client.from.bind(client), functions: client.functions, auth };
  const types = runModule('types/packing.ts');
  const packing = runModule('services/packing/packingClient.ts', {
    '../supabaseClient': { supabase: transport }, '../../types/packing': types,
  });
  const watch = runModule('services/watchlist/watchlistClient.ts', {
    '../supabaseClient': { supabase: transport },
    '../authenticatedFunctionSession': { resolveAuthenticatedFunctionSession: async () => {
      const user = await request('/auth/v1/user'); return { ok: Boolean(user.id === actor) };
    } }, './watchlistAvailability': { resolveWatchlistAvailable: () => true },
  });
  return { packing, watch, transport };
}
async function request(route, { method = 'GET', body, elevated = false } = {}) {
  const key = elevated ? service : pub;
  const response = await fetch(URL + route, { method, headers: {
    apikey: key, Authorization: `Bearer ${elevated ? service : token || pub}`,
    'Content-Type': 'application/json', Prefer: 'return=representation',
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json().catch(() => null);
  // Never return error text: Auth errors can repeat a login identifier.
  if (!response.ok) throw Object.assign(new Error('http_rejected'), { status: response.status, code: data?.code });
  return data;
}
async function summary() {
  const contract = runModule('types/kplusEntitlementContract.ts');
  const reader = runModule('services/kplus/kplusEntitlementReader.ts', {
    '../supabaseClient': { supabase: {} }, '../../types/kplusEntitlementContract': contract,
  });
  return reader.readKPlusEntitlementSummary({ auth: { getSession: async () => ({ data: { session: { user: { id: actor } } } }) },
    rpc: async () => ({ data: await request('/rest/v1/rpc/get_my_kplus_entitlement_summary', { method: 'POST', body: {} }), error: null }) });
}
async function setup() {
  if (actor) throw new Error('already_initialized');
  // Capture CLI stdout in memory; do not pipe key output to this terminal.
  const cli = path.join(process.env.APPDATA, 'npm/node_modules/supabase/dist/supabase.js');
  const keys = JSON.parse(execFileSync(process.execPath, [cli, 'projects', 'api-keys', '--project-ref', PROJECT, '--reveal', '--output', 'json'], { stdio: ['ignore', 'pipe', 'pipe'] }));
  pub = keys.find(k => k.type === 'publishable' && !k.disabled)?.api_key || keys.find(k => k.name === 'anon')?.api_key;
  service = keys.find(k => k.name === 'service_role')?.api_key;
  mask(pub); mask(service);
  if (!pub || !service) throw new Error('governed_keys_unavailable');
  const email = `synthetic-build35-premium-${crypto.randomUUID()}@kscan-test.invalid`;
  const password = crypto.randomBytes(32).toString('base64url');
  mask(email); mask(password);
  for (const [index, value] of [email, password].entries()) {
    const entry = before('github_environment_secret', `staging/${secretNames[index]}`, 'absent', 'store dedicated login', 'governed auth access');
    execFileSync('gh.exe', ['secret', 'set', secretNames[index], '--env', 'staging', '--repo', REPO], { input: value, stdio: ['pipe', 'pipe', 'pipe'] });
    secretsStored.push(secretNames[index]); done(entry);
  }
  const signupEntry = before('auth_signup', 'dedicated Build35 synthetic actor', 'absent', 'public signup with client-safe key', 'isolated real auth fixture');
  const signup = await request('/auth/v1/signup', { method: 'POST', body: { email, password } });
  mask(signup.access_token); mask(signup.refresh_token);
  actor = signup.user?.id || signup.id;
  if (!actor) throw new Error('signup_missing_actor');
  report.actorId = actor; done(signupEntry);
  const grantKey = `build35-premium-${crypto.randomUUID()}`;
  const entry = before('canonical_complimentary_grant', grantKey, 'canonical FREE', 'temporary K+ expires in four hours', 'premium runtime proof', 'RESTORE');
  const result = await request('/rest/v1/rpc/grant_kplus_complimentary', { method: 'POST', elevated: true,
    body: { p_user_id: actor, p_source: 'promotional', p_grant_key: grantKey, p_campaign_id: 'build35-premium-value', p_expires_at: new Date(Date.now() + 4 * 3600000).toISOString() } });
  grant = result.grantId; report.grantId = grant; done(entry);
  const auth = await signInSyntheticUser(URL, pub, email, password);
  if (!auth.ok) throw Object.assign(new Error('governed_signin_failed'), { status: auth.status });
  mask(auth.accessToken); token = auth.accessToken;
  const canonical = await summary();
  check('governed_actor_canonical_active', canonical.status === 'resolved' && canonical.summary.access === 'k_plus');
  modules();
  output({ ready: true, tokenPersistence: false, sharedActorChanged: false });
}
async function packingFixture() {
  const canonical = await summary();
  check('packing_fixture_canonical_active', canonical.summary?.access === 'k_plus');
  const contract = runModule('services/closet/closetSyncContract.ts');
  const facts = runModule('services/closet/closetFactsSync.ts', {
    '../supabaseClient': { supabase: client }, './closetSyncContract': contract,
  });
  const fixtures = [
    ['White cotton shirt', 'Tops', 'shirt', 'white'], ['Navy cotton tee', 'Tops', 't-shirt', 'navy'],
    ['Black wool trousers', 'Bottoms', 'trousers', 'black'], ['Blue denim jeans', 'Bottoms', 'jeans', 'blue'],
    ['Black leather sneakers', 'Shoes', 'sneakers', 'black'], ['Tan trench coat', 'Outerwear', 'coat', 'tan'],
    ['Grey crewneck sweater', 'Tops', 'sweater', 'grey'],
  ];
  for (const [title, category, clothingType, primaryColor] of fixtures) {
    const id = crypto.randomUUID();
    const entry = before('closet_synthetic_facts', id, 'absent', 'insert bounded synthetic owned facts via existing facts client', 'Packing ownership fixture');
    const result = await facts.insertCloudClosetItem(id, { title, category, clothingType, primaryColor, schemaVersion: 2, origin: 'direct_intake', material: ['cotton'] });
    check('synthetic_owned_fact_inserted', result.ok === true);
    ownedIds.push(result.serverId); done(entry);
  }
  sessionId = crypto.randomUUID();
  const entry = before('style_chat_synthetic_session', sessionId, 'absent', 'create dedicated synthetic session', 'existing Packing request contract');
  await request('/rest/v1/style_chat_sessions', { method: 'POST', body: { id: sessionId, user_id: actor, title: 'Build35 synthetic packing proof' } }); done(entry);
}
async function packingProof() {
  if (!sessionId) throw new Error('fixture_required');
  const { packing } = modules();
  const trip = { destination: 'New York', startDate: '2026-10-20', endDate: '2026-10-23', tripType: 'city', activities: ['casual_day', 'dinner'], note: '' };
  for (const operation of ['generate', 'refine_pack_light']) {
    if (operation !== 'generate' && !packingPlan) break;
    const used = ledger.runtimeAttempts.filter(a => a.feature === 'packing' && a.dispatched === 'YES').length;
    if (used >= ledger.packingProviderLimit) throw new Error('budget_exhausted');
    const entry = before('packing_runtime_quota', actor, 'synthetic quota only', 'existing burst/daily quota may increment', operation);
    const attempt = { number: used + 1, timestamp: new Date().toISOString(), feature: 'packing', operation, dispatched: 'YES', outcome: 'PENDING', failureClass: null };
    ledger.runtimeAttempts.push(attempt); save();
    const result = await packing.requestPackingPlan({ sessionId, trip, ...(operation !== 'generate' ? { constraints: { packLight: true, notes: ['Pack lighter while keeping dinner coverage.'] } } : {}) });
    attempt.outcome = result.status; attempt.failureClass = result.errorCode; done(entry);
    check(`packing_${operation}`, result.status === 'success' && Boolean(result.plan), { status: result.status, errorCode: result.errorCode });
    check(`packing_${operation}_owned_only`, result.plan.packedItems.every(item => ownedIds.includes(item.itemId.replace(/^closet:/, ''))), { itemCount: result.plan.packedItems.length, outfitCount: result.plan.outfits.length });
    packingPlan = result.plan;
  }
}
async function watchProof() {
  const { watch } = modules();
  const listing = { productUrl: 'https://www.kickscrew.com/products/nike-air-force-1-07-white-cw2288-111', title: "Nike Air Force 1 Low '07 Triple White", price: 'USD 391.95', source: 'kickscrew', type: 'retail' };
  const entry = before('watch_synthetic_create', 'dedicated actor / public Kicks Crew listing CW2288-111', 'absent', 'create just_watching, push disabled', 'real tracking proof');
  const created = await watch.createWatch({ listing, watchIntent: 'just_watching' });
  check('watch_create', created.ok, { reason: created.reason || null }); done(entry);
  report.watchId = created.data.id; save();
  const read = await watch.fetchWatchlist();
  check('watch_owner_read', read.ok && read.data.some(w => w.id === created.data.id && w.canonicalUrl === listing.productUrl));
  const used = ledger.runtimeAttempts.filter(a => a.feature === 'watchlist' && a.dispatched === 'YES').length;
  if (used >= ledger.watchlistForcedRefreshLimit) throw new Error('budget_exhausted');
  const refreshEntry = before('watch_refresh_state_and_event', created.data.id, 'new synthetic Watch', 'one bounded real provider refresh; push disabled', 'tracking price observation');
  const attempt = { number: used + 1, timestamp: new Date().toISOString(), feature: 'watchlist', operation: 'manual_single_watch_refresh', dispatched: 'YES', outcome: 'PENDING', failureClass: null };
  ledger.runtimeAttempts.push(attempt); save();
  const refreshed = await watch.refreshWatches(created.data.id);
  attempt.outcome = refreshed.ok ? 'completed' : 'failed'; attempt.failureClass = refreshed.reason || null; done(refreshEntry);
  check('watch_refresh_transport', refreshed.ok, { reason: refreshed.reason || null });
  const observed = await watch.fetchWatch(created.data.id);
  check('watch_price_observation', observed.ok && observed.data.lastStatus === 'available' && Number.isFinite(observed.data.currentPriceAmount), { lastStatus: observed.data?.lastStatus || null, lastCheckedPresent: Boolean(observed.data?.lastCheckedAt) });
}
async function cleanup() {
  if (grant && actor) {
    const entry = before('canonical_grant_revoke', grant, 'temporary K+ active', 'revoke through trusted RPC', 'fixture cleanup', 'RESTORE');
    await request('/rest/v1/rpc/revoke_kplus_grant', { method: 'POST', elevated: true, body: { p_user_id: actor, p_grant_id: grant } });
    done(entry); grant = null;
    const canonical = await summary();
    check('canonical_free_after_revoke', canonical.status === 'resolved' && canonical.summary.access === 'free');
  }
  if (actor) {
    const entry = before('auth_admin_delete', actor, 'dedicated synthetic fixtures', 'delete actor and cascaded fixtures', 'owner-authorized fixture cleanup');
    await request(`/auth/v1/admin/users/${actor}`, { method: 'DELETE', elevated: true });
    done(entry); actor = null;
  }
  for (const name of secretsStored) {
    const entry = before('github_environment_secret_delete', `staging/${name}`, 'dedicated login stored', 'delete synthetic login secret', 'fixture cleanup');
    execFileSync('gh.exe', ['secret', 'delete', name, '--env', 'staging', '--repo', REPO], { stdio: ['ignore', 'pipe', 'pipe'] }); done(entry);
  }
  secretsStored = []; token = null;
  report.cleanedAt = new Date().toISOString(); save(); output({ cleaned: true });
}
const commands = { setup, packingFixture, packingProof, watchProof, summary: async () => { const s = await summary(); output({ status: s.status, access: s.summary?.access }); }, cleanup };
const rl = readline.createInterface({ input: process.stdin });
(async () => {
  try { for await (const line of rl) {
    try {
      const input = JSON.parse(line);
      if (input.command === 'exit') { await cleanup(); rl.close(); break; }
      if (!commands[input.command]) throw new Error('unsupported_command');
      await commands[input.command]();
    } catch (error) { output({ error: 'proof_command_failed', failureClass: error.message === 'assertion_failed' ? 'assertion_failed' : 'boundary_rejected', status: error.status || null, code: error.code || null }); }
  } } finally {
    // An EOF or interrupted command stream must not silently strand fixtures.
    if (actor || grant || secretsStored.length) await cleanup();
  }
})().catch(() => { output({ error: 'harness_failed' }); process.exitCode = 1; });
