// K+ entitlement store contract tests (Build 35 Phase A).
//
// The store's truth is the CANONICAL client state of
// types/kplusEntitlementContract.ts (resolved | resolving | unavailable |
// signed_out), read through services/kplus/kplusEntitlementReader.ts. The
// UI-facing snapshot every K+ surface already consumes is a projection of it.
//
// This file previously pinned the Build 34 behaviour where the CLIENT re-derived
// "active" from a raw user_entitlements row (status, revoked_at, expires_at).
// That read is gone: a store subscription or lifetime purchase is invisible to
// it. Each legacy test's INTENT is kept below -- the client never grants itself
// K+, revocation is never presented as active, a failed read is never Free, an
// actor change cannot resurrect old state -- but the evidence is now the server's
// summary, not a row the client interprets.
//
// Collaborators are scripted and time is fake (__tests__/helpers/
// kplusStoreHarness.js): no network, no Supabase, no real-clock races.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers/kplusStoreHarness');

const { build, resolved, unavailable, SIGNED_OUT, DAY } = h;

function boot(opts) {
  return h.loadKPlusStore(opts);
}

test('default snapshot is loading, and reset restores it', () => {
  const { store } = boot();
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'loading');
  store.resetKPlusEntitlementCache();
  assert.deepEqual(store.getKPlusEntitlementSnapshot(), store.DEFAULT_KPLUS_SNAPSHOT);
});

test('a free answer for an account that never held complimentary access resolves eligible', async () => {
  const { store, reader, clock } = boot();
  reader.answer(resolved(build.free(clock, { history: false })));
  await store.refreshKPlusEntitlement();
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'eligible');
});

test('a K+ answer resolves active, and carries its end date and display source', async () => {
  const { store, reader, clock } = boot();
  const s = build.complimentary(clock, 30);
  reader.answer(resolved(s));
  await store.refreshKPlusEntitlement();
  const snap = store.getKPlusEntitlementSnapshot();
  assert.equal(snap.state, 'active');
  assert.equal(snap.expiresAt, s.effectiveExpiresAt);
  assert.equal(snap.displaySource, 'complimentary');
  assert.equal(snap.isOpenEnded, false);
  store.__clearKPlusExpiryTimerForTests();
});

test('a free answer for an account whose complimentary access ended resolves expired, never active', async () => {
  const { store, reader, clock } = boot();
  reader.answer(resolved(build.free(clock, { history: true })));
  await store.refreshKPlusEntitlement();
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'expired');
});

test('a signed-out read resolves to unavailable, a failed read resolves to error (fail closed, never active, never free)', async () => {
  const a = boot();
  a.reader.answer(SIGNED_OUT);
  await a.store.refreshKPlusEntitlement();
  assert.equal(a.store.getKPlusEntitlementSnapshot().state, 'unavailable');

  for (const reason of ['network', 'server_error', 'malformed_response']) {
    const b = boot();
    b.reader.answer(unavailable(reason));
    await b.store.refreshKPlusEntitlement();
    const state = b.store.getKPlusEntitlementSnapshot().state;
    assert.equal(state, 'error', reason);
    assert.notEqual(state, 'eligible');
    assert.notEqual(state, 'expired');
    assert.notEqual(state, 'active');
  }
});

test('a reader that throws is a failed read, never an unhandled rejection or a free answer', async () => {
  const { store, reader } = boot();
  reader.answer(new Error('boom'));
  await store.refreshKPlusEntitlement();
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'error');
});

test('resetKPlusEntitlementCache invalidates an in-flight refresh so a late response cannot resurrect a previous actor\'s state', async () => {
  const { store, reader, clock } = boot();
  const refreshPromise = store.refreshKPlusEntitlement();
  store.resetKPlusEntitlementCache(); // actor changed mid-flight
  reader.release(resolved(build.complimentary(clock, 120)));
  await refreshPromise;
  assert.deepEqual(store.getKPlusEntitlementSnapshot(), store.DEFAULT_KPLUS_SNAPSHOT);
  assert.equal(store.getKPlusEntitlementClientState().status, 'resolving');
});

// ── Lifetime ──────────────────────────────────────────────────────────────────

test('LIFETIME: resolves active and open-ended, with no end date, and is never downgraded as time passes', async () => {
  const { store, reader, clock, timers } = boot();
  reader.answer(resolved(build.lifetime(clock)));
  await store.refreshKPlusEntitlement();
  let snap = store.getKPlusEntitlementSnapshot();
  assert.equal(snap.state, 'active');
  assert.equal(snap.isOpenEnded, true);
  assert.equal(snap.expiresAt, null, 'open-ended access has no end date');
  assert.equal(snap.displaySource, 'lifetime');
  assert.equal(timers.pending(), 0, 'open-ended access schedules no expiry boundary');
  // Years later, with no refresh: still the server's last answer, never a local expiry.
  clock.advance(5 * 365 * DAY);
  snap = store.getKPlusEntitlementSnapshot();
  assert.equal(snap.state, 'active', 'a lifetime purchase must not be treated as an expiring subscription');
});

test('LIFETIME + complimentary and subscription: the strongest source is presented, access stays open-ended', async () => {
  const { store, reader, clock } = boot();
  reader.answer(resolved(build.lifetime(clock, { complimentaryHistory: true })));
  await store.refreshKPlusEntitlement();
  const snap = store.getKPlusEntitlementSnapshot();
  assert.equal(snap.state, 'active');
  assert.equal(snap.displaySource, 'lifetime');
});

test('a refunded lifetime purchase with no other grant is a positively resolved FREE answer', async () => {
  const { store, reader, clock } = boot();
  reader.answer(resolved(build.lifetime(clock)));
  await store.refreshKPlusEntitlement();
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'active');
  reader.answer(resolved(build.free(clock, { history: false })));
  await store.refreshKPlusEntitlement();
  const state = store.getKPlusEntitlementSnapshot().state;
  assert.notEqual(state, 'active', 'the device follows the server: a refund ends access');
  assert.equal(state, 'eligible');
});

// ── The client never grants itself K+ ────────────────────────────────────────

test('CERT-CLIENT-001 (intent kept): a revoked grant is never presented as active -- the server answer decides, the client interprets no row', async () => {
  const { store, reader, clock } = boot();
  // A revocation recorded as revoked_at alone is, to the server, simply "free".
  reader.answer(resolved(build.free(clock, { history: true })));
  await store.refreshKPlusEntitlement();
  assert.notEqual(store.getKPlusEntitlementSnapshot().state, 'active');
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'expired');
});

test('CERT-CLIENT-001 (intent kept): activateKPlus never calls a revoked grant active, even when the re-read fails', async () => {
  const revokedRow = {
    entitlementKey: 'k_plus', status: 'active', grantReason: 'complimentary_early_access',
    campaignKey: 'kplus_early_access_2026', grantedAt: new Date(Date.now() - DAY).toISOString(),
    expiresAt: new Date(Date.now() + 120 * DAY).toISOString(), revokedAt: new Date().toISOString(), externalSyncStatus: 'synced',
  };
  const a = boot({ activation: h.createActivationClient({ ok: true, row: revokedRow }) });
  a.reader.answer(resolved(build.free(a.clock, { history: true })));
  assert.equal(await a.store.activateKPlus(), 'campaign_consumed');
  assert.notEqual(a.store.getKPlusEntitlementSnapshot().state, 'active');

  const b = boot({ activation: h.createActivationClient({ ok: true, row: revokedRow }) });
  b.reader.answer(unavailable('network'));
  assert.equal(await b.store.activateKPlus(), 'campaign_consumed', 'an unreadable re-read falls back to the server response, which says revoked');
  assert.notEqual(b.store.getKPlusEntitlementSnapshot().state, 'active', 'the activation response alone never sets the entitlement state');
});

test('the activation response never sets the entitlement state; only the canonical re-read does', async () => {
  const row = {
    entitlementKey: 'k_plus', status: 'active', grantReason: 'complimentary_early_access',
    campaignKey: 'kplus_early_access_2026', grantedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * DAY).toISOString(), revokedAt: null, externalSyncStatus: 'pending',
  };
  const { store, reader } = boot({ activation: h.createActivationClient({ ok: true, row }) });
  reader.answer(unavailable('network')); // the re-read cannot be completed
  const outcome = await store.activateKPlus();
  assert.equal(outcome, 'granted', 'the label comes from the server\'s own activation response');
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'error', 'but the device did not grant itself K+');
  assert.notEqual(store.getKPlusEntitlementSnapshot().state, 'active');
});

test('activateKPlus outcome mapping: granted, already_active, campaign_consumed, failed', async () => {
  const mk = (expiresInDays) => ({
    entitlementKey: 'k_plus', status: 'active', grantReason: 'complimentary_early_access',
    campaignKey: 'kplus_early_access_2026', grantedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + expiresInDays * DAY).toISOString(), revokedAt: null, externalSyncStatus: 'pending',
  });

  const granted = boot({ activation: h.createActivationClient({ ok: true, row: mk(30) }) });
  granted.reader.answer(resolved(build.complimentary(granted.clock, 30)));
  assert.equal(await granted.store.activateKPlus(), 'granted');
  assert.equal(granted.store.getKPlusEntitlementSnapshot().state, 'active');
  granted.store.__clearKPlusExpiryTimerForTests();

  const consumed = boot({ activation: h.createActivationClient({ ok: true, row: mk(-1) }) });
  consumed.reader.answer(resolved(build.free(consumed.clock, { history: true })));
  assert.equal(await consumed.store.activateKPlus(), 'campaign_consumed');

  const failed = boot({ activation: h.createActivationClient({ ok: false, reason: 'request_failed' }) });
  assert.equal(await failed.store.activateKPlus(), 'failed');
});

test('activateKPlus reports already_active on a second call once the store already observed an active grant (double-tap / re-open)', async () => {
  const row = {
    entitlementKey: 'k_plus', status: 'active', grantReason: 'complimentary_early_access',
    campaignKey: 'kplus_early_access_2026', grantedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10 * DAY).toISOString(), revokedAt: null, externalSyncStatus: 'synced',
  };
  const { store, reader, clock } = boot({ activation: h.createActivationClient({ ok: true, row }) });
  reader.answer(resolved(build.complimentary(clock, 10)), resolved(build.complimentary(clock, 10)));
  await store.refreshKPlusEntitlement();
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'active');
  assert.equal(await store.activateKPlus(), 'already_active');
  store.__clearKPlusExpiryTimerForTests();
});

test('an actor change while activation is re-reading discards the outcome (the answer belongs to the previous actor)', async () => {
  const row = {
    entitlementKey: 'k_plus', status: 'active', grantReason: 'complimentary_early_access',
    campaignKey: 'k', grantedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * DAY).toISOString(), revokedAt: null, externalSyncStatus: 'pending',
  };
  const { store, reader, clock } = boot({ activation: h.createActivationClient({ ok: true, row }) });
  const activation = store.activateKPlus();
  await h.flush(); // activation response is in; the re-read is now held open
  store.resetKPlusEntitlementCache(); // actor changed mid re-read
  reader.release(resolved(build.complimentary(clock, 30)));
  assert.equal(await activation, 'failed');
  assert.equal(store.getKPlusEntitlementSnapshot().state, 'loading');
});

// ── Static: the legacy read is gone and the doctrine is written down ─────────

const read = (...p) => fs.readFileSync(path.join(h.ROOT, ...p), 'utf8');

test('CERT-CLIENT-002: a consumed campaign is never announced or counted as an activation', () => {
  const sheet = read('components', 'kplus', 'KPlusEarlyAccessSheet.tsx');
  const consumedIdx = sheet.indexOf("outcome === 'campaign_consumed'");
  // #258 (merged ahead of this repair) renamed the sheet's telemetry
  // vocabulary repo-wide: kplus_activation_success -> kplus_activation_completed,
  // kplus_activation_failure -> kplus_activation_failed. This test asserts
  // against the current vocabulary, not the one CERT-CLIENT-002 was
  // originally written against.
  const successIdx = sheet.indexOf("emitKPlusEvent('kplus_activation_completed'");
  const announceIdx = sheet.indexOf("'K+ Early Access activated.'");
  assert.ok(consumedIdx > 0, 'campaign_consumed must be handled explicitly');
  assert.ok(consumedIdx < successIdx, 'it must short-circuit before the success event');
  assert.ok(consumedIdx < announceIdx, 'it must short-circuit before the success announcement');
  // and it must actually return, not fall through
  const block = sheet.slice(consumedIdx, successIdx);
  assert.match(block, /return;/, 'the consumed branch must return');
  assert.match(block, /kplus_activation_failed/, 'a consumed campaign is not a success event');
});

test('the Build 34 direct user_entitlements read is gone from the mobile client', () => {
  const client = read('services', 'kplus', 'kplusClient.ts');
  assert.doesNotMatch(client, /from\(['"]user_entitlements['"]\)/);
  assert.doesNotMatch(client, /fetchKPlusStatus/);
  const code = read('services', 'kplus', 'kplusEntitlementStore.ts').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(code, /fetchKPlusStatus|user_entitlements/);
});
