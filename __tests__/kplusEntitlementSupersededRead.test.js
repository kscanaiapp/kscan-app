// B41 consolidated K+ repair R-M4 (audit K-19).
//
// The store applies only the NEWEST refresh's answer. Before this repair a
// successful K+ answer from a superseded refresh was thrown away, so when the
// newest refresh then failed (network / server error) a confirmed member saw
// "We can't confirm your membership" although the server had just said K+.
//
// Now a superseded answer for the SAME actor becomes the last-known server
// summary when it is newer than the one held, and the existing bounded K+
// stand-in rule applies. Doctrine is unchanged: only a K+ answer may stand in
// for an unreadable one (never Free), and another actor's answer never leaks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers/kplusStoreHarness');

const { build, resolved, unavailable } = h;
const STORE = path.join(h.ROOT, 'services', 'kplus', 'kplusEntitlementStore.ts');
const flush = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r)); };

function mutate(from, to) {
  const src = fs.readFileSync(STORE, 'utf8');
  assert.ok(src.includes(from), `mutation anchor not found: ${from.slice(0, 60)}`);
  return { [STORE]: src.split(from).join(to) };
}

async function expectRed(fn, label) {
  let failure = null;
  try { await fn(); } catch (error) { failure = error; }
  assert.ok(failure, `${label}: the mutant was NOT caught`);
  assert.ok(failure instanceof assert.AssertionError, `${label}: crashed instead of failing: ${failure && failure.stack}`);
}

/** Two overlapping refreshes, both held. */
function twoReads(sources) {
  const env = h.loadKPlusStore({ sources });
  const first = env.store.refreshKPlusEntitlement();
  const second = env.store.refreshKPlusEntitlement();
  assert.equal(env.reader.heldCount(), 2);
  return { ...env, first, second };
}

async function supersededKPlusThenNewestFails(sources) {
  const env = twoReads(sources);
  const kplus = build.complimentary(env.clock, 30);
  env.reader.releaseAt(0, resolved(kplus)); // the older read answers K+ (superseded)
  await env.first;
  env.reader.releaseAt(0, unavailable('network')); // the newest read fails
  await env.second;
  return env;
}

test('R-M4: a superseded K+ answer stands in when the newest read then fails', async () => {
  const env = await supersededKPlusThenNewestFails();
  assert.equal(env.store.getKPlusEntitlementSnapshot().state, 'active');
  env.store.__clearKPlusExpiryTimerForTests();
});

test('R-M4: the newest read failing FIRST is re-evaluated when the older K+ answer lands', async () => {
  const env = twoReads();
  const kplus = build.complimentary(env.clock, 30);
  env.reader.releaseAt(1, unavailable('server_error')); // newest fails first
  await env.second;
  assert.equal(env.store.getKPlusEntitlementSnapshot().state, 'error');
  env.reader.releaseAt(0, resolved(kplus)); // the older K+ answer arrives late
  await env.first;
  await flush();
  assert.equal(env.store.getKPlusEntitlementSnapshot().state, 'active');
  env.store.__clearKPlusExpiryTimerForTests();
});

test('R-M4: a superseded FREE answer never stands in for an unreadable one', async () => {
  const env = twoReads();
  env.reader.releaseAt(0, resolved(build.free(env.clock, { history: false })));
  await env.first;
  env.reader.releaseAt(0, unavailable('network'));
  await env.second;
  assert.equal(env.store.getKPlusEntitlementSnapshot().state, 'error');
});

test('R-M4: a malformed newest answer never uses the superseded K+ answer', async () => {
  const env = twoReads();
  env.reader.releaseAt(0, resolved(build.complimentary(env.clock, 30)));
  await env.first;
  env.reader.releaseAt(0, unavailable('malformed_response'));
  await env.second;
  assert.equal(env.store.getKPlusEntitlementSnapshot().state, 'error');
  env.store.__clearKPlusExpiryTimerForTests();
});

test('R-M4: a prior actor\'s superseded K+ answer never reaches the next actor', async () => {
  const env = h.loadKPlusStore();
  const priorActorRead = env.store.refreshKPlusEntitlement();
  env.store.resetKPlusEntitlementCache(); // sign-out / actor change
  const nextActorRead = env.store.refreshKPlusEntitlement();
  env.reader.releaseAt(0, resolved(build.complimentary(env.clock, 30))); // prior actor's K+
  await priorActorRead;
  env.reader.releaseAt(0, unavailable('network')); // next actor's read fails
  await nextActorRead;
  assert.equal(env.store.getKPlusEntitlementSnapshot().state, 'error');
});

test('R-M4: an older answer arriving after a newer applied answer never replaces it', async () => {
  const env = twoReads();
  env.reader.releaseAt(1, resolved(build.free(env.clock, { history: false }))); // newest: Free (e.g. just revoked)
  await env.second;
  assert.equal(env.store.getKPlusEntitlementSnapshot().state, 'eligible');
  env.reader.releaseAt(0, resolved(build.complimentary(env.clock, 30))); // stale K+ from before
  await env.first;
  await flush();
  assert.equal(env.store.getKPlusEntitlementSnapshot().state, 'eligible');
  // And a later failing read must not resurrect the stale K+ either.
  env.reader.answer(unavailable('network'));
  await env.store.refreshKPlusEntitlement();
  assert.equal(env.store.getKPlusEntitlementSnapshot().state, 'error');
});

test('NC-R-M4: dropping the superseded answer, the actor check or the ordering check is caught', async () => {
  await expectRed(async () => {
    const env = await supersededKPlusThenNewestFails(mutate(
      "    if (generation !== actorGeneration || result.status !== 'resolved' || requestId <= lastServerSummaryRequestId) return;",
      '    return;',
    ));
    assert.equal(env.store.getKPlusEntitlementSnapshot().state, 'active');
  }, 'superseded answer dropped');
  await expectRed(async () => {
    const sources = mutate('    if (generation !== actorGeneration || result.status', '    if (result.status');
    const env = h.loadKPlusStore({ sources });
    const prior = env.store.refreshKPlusEntitlement();
    env.store.resetKPlusEntitlementCache();
    const next = env.store.refreshKPlusEntitlement();
    env.reader.releaseAt(0, resolved(build.complimentary(env.clock, 30)));
    await prior;
    env.reader.releaseAt(0, unavailable('network'));
    await next;
    assert.equal(env.store.getKPlusEntitlementSnapshot().state, 'error');
  }, 'cross-actor leak');
  await expectRed(async () => {
    const sources = mutate(" || requestId <= lastServerSummaryRequestId) return;", ') return;');
    const env = twoReads(sources);
    env.reader.releaseAt(1, resolved(build.free(env.clock, { history: false })));
    await env.second;
    env.reader.releaseAt(0, resolved(build.complimentary(env.clock, 30)));
    await env.first;
    env.reader.answer(unavailable('network'));
    await env.store.refreshKPlusEntitlement();
    assert.equal(env.store.getKPlusEntitlementSnapshot().state, 'error');
  }, 'stale answer replaced a newer one');
});
