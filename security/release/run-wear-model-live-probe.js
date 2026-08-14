#!/usr/bin/env node
'use strict';

/**
 * Build 29 Closet V2 — wear-model live probe (staging only).
 *
 * S7A certified the S5 wear model against a from-zero local database and left
 * every staging runtime gate NOT TESTED. The only legitimate staging identities
 * are the pre-provisioned synthetic accounts whose credentials exist solely as
 * GitHub secrets, so CI is the only place this evidence can be produced.
 *
 * ── WHAT THIS CERTIFIES ─────────────────────────────────────────────────────
 *
 * The STAGING DATABASE's wear-history contract, exercised over PostgREST under
 * a real authenticated session:
 *
 *   * owner-scoped RLS on both wear tables, and the GRANT/REVOKE layer
 *   * the (user_id, client_id) unique index that makes a replayed wear
 *     collapse onto one row instead of counting twice
 *   * the (wear_event_id, source_item_id) unique index that stops a duplicated
 *     look payload producing two relationships for one garment
 *   * wardrobe_wear_events.saved_look_id ON DELETE SET NULL together with the
 *     identity CHECK — the DEF-S5-001 closure gate: deleting a worn Saved Look
 *     must SUCCEED, and its wear history must survive with saved_look_ref
 *     intact
 *   * that no Saved Look lifecycle operation writes wear history
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
 *
 * It does not load services/wearHistory.ts. This file executes with staging
 * credentials, so under the probe trust boundary established for the E4.1
 * probe it must run only reviewed default-branch code — never a dispatched
 * candidate's source. Loading the candidate's service module would reinstate
 * exactly the hole that boundary closed.
 *
 * Instead it issues the SAME requests that service issues, on the same wire
 * contract. That contract is not restated from memory: the helpers below are
 * exported and __tests__/wearModelLiveProbeContract.test.js asserts they agree
 * with services/wearHistory.ts. If the service's action-key derivation or
 * de-duplication ever changes without this probe following, that test fails on
 * the candidate branch — which is where the drift would be introduced.
 *
 * The service module's own logic is already covered by the local suite. What
 * was missing, and what this supplies, is proof that STAGING behaves the way
 * its structure claims.
 *
 * ── NOT A GENERAL TOOL ──────────────────────────────────────────────────────
 *
 * There is no input for a project ref, a URL, a table or a statement. Any
 * hosted target is asserted through security/scripts/lib/environment-authority.js,
 * which never accepts production and fails closed on a missing or unknown ref.
 * Creating Auth users is refused outright against any hosted project. The only
 * writes it can perform are the fixed fixtures below, each tagged `s7a_fixture`
 * with a per-run id and removed through the owning account's own session.
 *
 * Credentials arrive through the environment, are never an argv element, never
 * echoed, and never reach the report. Progress goes to stderr; stdout carries
 * booleans, counts and fixture ids only.
 */

const { createClient } = require('@supabase/supabase-js');
const authority = require('../scripts/lib/environment-authority.js');

// Held to services/wearHistory.ts by __tests__/wearModelLiveProbeContract.test.js.
const MAX_SNAPSHOT_CHARS = 80;
const MAX_ITEMS_PER_EVENT = 24;

// ── The wire contract, shared with services/wearHistory.ts ──────────────────
// Exported so the drift guard can hold them to the service's definitions.

function bounded(value, max = MAX_SNAPSHOT_CHARS) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

/**
 * Day-grained key. Two taps on the same garment on the same day are one wear.
 *
 * A plain slice, not a Date round-trip: the service slices the string it was
 * given, and callers always hand it an already-normalized UTC ISO string. A
 * round-trip here would agree on those and disagree on anything else, which is
 * the subtlest possible way for the probe to stop testing what it claims to.
 */
function wearDateKey(iso) {
  return iso.slice(0, 10);
}

function wearActionKey(input) {
  return `wear:${input.source}:${input.targetId}:${wearDateKey(input.wornAt)}`;
}

/** A garment counts exactly once per logical wear, first occurrence winning. */
function dedupeWearItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const id = bounded(item && item.sourceItemId, 128);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      sourceItemId: id,
      sourceType: bounded(item.sourceType, 40) || 'unknown',
      titleSnapshot: bounded(item.titleSnapshot),
      categorySnapshot: bounded(item.categorySnapshot, 40),
    });
    if (out.length >= MAX_ITEMS_PER_EVENT) break;
  }
  return out;
}

/** Mirrors the service: parse-and-normalize, falling back to now. */
function isoOrNow(value) {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}

module.exports = { wearActionKey, wearDateKey, dedupeWearItems, bounded, isoOrNow };

// A require() from the drift-guard test must not execute the probe.
if (require.main !== module) return;

// ── Target resolution: fixed, asserted, fail-closed ─────────────────────────

const MODE = process.env.KSCAN_WEAR_PROBE_MODE === 'provision' ? 'provision' : 'existing';
const API_URL = process.env.SUPABASE_STAGING_URL || process.env.KSCAN_WEAR_PROBE_URL || '';
const ANON_KEY =
  process.env.SUPABASE_STAGING_PUBLISHABLE_KEY || process.env.KSCAN_WEAR_PROBE_ANON_KEY || '';
const PROJECT_REF = process.env.SUPABASE_STAGING_PROJECT_REF || '';

const isLocalTarget = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(API_URL);

const results = [];
let failed = 0;

function check(id, ok, detail) {
  results.push({ id, ok, detail });
  if (ok === false) failed++;
  const label = ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL';
  console.error(label + '  ' + id + (detail ? '  — ' + detail : ''));
}

function emit(extra) {
  process.stdout.write(
    JSON.stringify(
      {
        target: isLocalTarget ? 'local' : 'staging',
        project_ref: isLocalTarget ? null : PROJECT_REF,
        mode: MODE,
        run_id: process.env.KSCAN_WEAR_PROBE_RUN_ID || null,
        fixture_marker: 's7a_fixture',
        results,
        ...extra,
      },
      null,
      2,
    ) + '\n',
  );
}

function fail(code, message) {
  emit({ operational_failure: true, code, message });
  process.exit(2);
}

if (!API_URL || !ANON_KEY) {
  fail('MISSING_TARGET', 'SUPABASE_STAGING_URL and SUPABASE_STAGING_PUBLISHABLE_KEY are required');
}

if (!isLocalTarget) {
  try {
    authority.assertExpectedEnvironment('staging', PROJECT_REF);
  } catch (e) {
    fail('ENVIRONMENT_AUTHORITY', 'refusing non-staging target: ' + e.message);
  }
  if (!API_URL.includes(PROJECT_REF)) {
    fail('TARGET_MISMATCH', 'SUPABASE_STAGING_URL does not belong to the asserted staging ref');
  }
  if (MODE === 'provision') {
    fail('PROVISION_REFUSED', 'provision mode creates Auth users and is refused against a hosted project');
  }
}

const RUN = process.env.KSCAN_WEAR_PROBE_RUN_ID || 's7b' + process.pid;
const MARK = { s7a_fixture: true, run: RUN };

function newClient() {
  return createClient(API_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Identity A must be the ACTIVE synthetic account: `looks` and `saved_scans`
 * both carry an account-status guard, so a pending/locked identity cannot
 * create the fixtures. Identity B exists only to prove it CANNOT reach A's
 * rows, which the wear tables let any authenticated identity demonstrate.
 */
async function identity(role) {
  const c = newClient();
  if (MODE === 'existing') {
    const email = process.env['KSCAN_WEAR_PROBE_EMAIL_' + role];
    const password = process.env['KSCAN_WEAR_PROBE_PASSWORD_' + role];
    if (!email || !password) return { c, id: null, skipped: 'no credential supplied for identity ' + role };
    const { data, error } = await c.auth.signInWithPassword({ email, password });
    // error.message is an auth status string, never the credential.
    if (error) return { c, id: null, skipped: 'sign-in failed for ' + role + ': ' + error.message };
    return { c, id: data.user.id };
  }
  const email = 's7a-' + role.toLowerCase() + '-' + RUN + '@kscan-test.invalid';
  const password = 'S7a!' + RUN + '!' + role;
  const { data, error } = await c.auth.signUp({ email, password });
  if (error) return { c, id: null, skipped: 'signup failed for ' + role + ': ' + error.message };
  if (data.session) return { c, id: data.user.id };
  const { data: s, error: e2 } = await c.auth.signInWithPassword({ email, password });
  if (e2) return { c, id: null, skipped: 'sign-in failed for ' + role + ': ' + e2.message };
  return { c, id: s.user.id };
}

/**
 * The write path under test, byte-for-byte the shape services/wearHistory.ts
 * puts on the wire: one upsert onto (user_id, client_id) for the event, then
 * one upsert onto (user_id, client_id) per garment with the key scoped by
 * event. Idempotency and duplicate collapse are decided by the DATABASE's
 * unique indexes, which is exactly what this probe exists to certify.
 */
async function writeWear(client, userId, input) {
  const items = dedupeWearItems(input.items);
  if (items.length === 0) return { ok: false, reason: 'invalid_input' };

  const wornAt = isoOrNow(input.wornAt);
  const clientId =
    bounded(input.actionKey, 200) ||
    wearActionKey({ source: input.source, targetId: input.targetId, wornAt });

  const { data: eventRow, error: eventError } = await client
    .from('wardrobe_wear_events')
    .upsert(
      {
        user_id: userId,
        client_id: clientId,
        source_item_id: input.sourceItemId,
        saved_look_id: input.savedLookId,
        saved_look_ref: input.savedLookRef,
        worn_at: wornAt,
      },
      { onConflict: 'user_id,client_id' },
    )
    .select('id, worn_at, saved_look_id, saved_look_ref, source_item_id, created_at, updated_at')
    .single();

  if (eventError || !eventRow) {
    return { ok: false, reason: 'network', error: eventError && eventError.message };
  }

  const eventId = String(eventRow.id);
  const { error: itemsError } = await client.from('wardrobe_wear_event_items').upsert(
    items.map((item) => ({
      user_id: userId,
      wear_event_id: eventId,
      client_id: clientId + '#' + item.sourceItemId,
      source_item_id: item.sourceItemId,
      source_type: item.sourceType || 'unknown',
      title_snapshot: item.titleSnapshot,
      category_snapshot: item.categorySnapshot,
    })),
    { onConflict: 'user_id,client_id' },
  );

  if (itemsError) return { ok: false, reason: 'network', error: itemsError.message };

  const deduplicated =
    typeof eventRow.created_at === 'string' &&
    typeof eventRow.updated_at === 'string' &&
    eventRow.created_at !== eventRow.updated_at;

  return { ok: true, deduplicated, eventId, clientId, itemCount: items.length };
}

const logItemWear = (client, userId, item, options = {}) =>
  writeWear(client, userId, {
    source: 'item',
    targetId: bounded(item.sourceItemId, 128),
    items: [item],
    sourceItemId: bounded(item.sourceItemId, 128),
    savedLookId: options.savedLookId || null,
    savedLookRef: options.savedLookId || null,
    wornAt: options.wornAt,
  });

const logLookWear = (client, userId, lookId, items, options = {}) =>
  writeWear(client, userId, {
    source: 'saved_look',
    targetId: lookId,
    items,
    sourceItemId: null,
    savedLookId: lookId,
    savedLookRef: lookId,
    wornAt: options.wornAt,
  });

async function countEvents(c, userId) {
  const { count } = await c.from('wardrobe_wear_events').select('id', { count: 'exact', head: true }).eq('user_id', userId);
  return count || 0;
}
async function countItems(c, userId) {
  const { count } = await c.from('wardrobe_wear_event_items').select('id', { count: 'exact', head: true }).eq('user_id', userId);
  return count || 0;
}

async function main() {
  const A = await identity('A');
  if (!A.id) {
    emit({ operational_failure: true, code: 'NO_PRIMARY_IDENTITY', message: A.skipped });
    process.exit(3);
  }
  const B = await identity('B');
  console.error('IDENTITY A=' + A.id.slice(0, 8) + ' B=' + (B.id ? B.id.slice(0, 8) : 'none'));

  const base = { e: await countEvents(A.c, A.id), i: await countItems(A.c, A.id) };
  console.error('BASELINE events=' + base.e + ' relations=' + base.i);

  // ── A. Saved Look != wear ────────────────────────────────────────────────
  const lookId = crypto.randomUUID();
  const beforeLook = { e: await countEvents(A.c, A.id), i: await countItems(A.c, A.id) };
  const ins = await A.c.from('looks').insert({
    id: lookId,
    user_id: A.id,
    title: 'S7A fixture look ' + RUN,
    description: JSON.stringify(MARK),
  });
  if (ins.error) {
    emit({ operational_failure: true, code: 'NO_LOOK_FIXTURE', message: ins.error.message });
    process.exit(3);
  }
  await A.c.from('looks').update({ title: 'S7A fixture look ' + RUN + ' (edited)' }).eq('id', lookId);
  await A.c.from('looks').select('*').eq('id', lookId).single();
  const afterLook = { e: await countEvents(A.c, A.id), i: await countItems(A.c, A.id) };
  check('SAVED_LOOK_NOT_WEAR_RUNTIME',
    afterLook.e === beforeLook.e && afterLook.i === beforeLook.i,
    'create+edit+open Saved Look: events ' + beforeLook.e + '->' + afterLook.e
      + ', relations ' + beforeLook.i + '->' + afterLook.i + ' (delta 0 required)');

  // ── B. Item wear ─────────────────────────────────────────────────────────
  const itemId = 's7a-item-' + RUN + '-1';
  const r1 = await logItemWear(A.c, A.id, {
    sourceItemId: itemId, sourceType: 'saved_scan',
    titleSnapshot: 'S7A Navy Blazer', categorySnapshot: 'outerwear',
  });
  const aEv = await A.c.from('wardrobe_wear_events').select('id, source_item_id').eq('user_id', A.id).eq('client_id', r1.clientId);
  const aItems = await A.c.from('wardrobe_wear_event_items').select('id').eq('user_id', A.id).eq('source_item_id', itemId);
  check('WEAR_ITEM_RUNTIME',
    r1.ok === true && (aEv.data || []).length === 1 && (aItems.data || []).length === 1
      && aEv.data[0].source_item_id === itemId,
    'ok=' + r1.ok + ' events=' + (aEv.data || []).length + ' relations=' + (aItems.data || []).length
      + ' source_item_id=' + (aEv.data && aEv.data[0] && aEv.data[0].source_item_id === itemId ? 'set' : 'WRONG'));

  // ── C. Idempotency ───────────────────────────────────────────────────────
  const r1b = await logItemWear(A.c, A.id, {
    sourceItemId: itemId, sourceType: 'saved_scan',
    titleSnapshot: 'S7A Navy Blazer', categorySnapshot: 'outerwear',
  });
  const aEv2 = await A.c.from('wardrobe_wear_events').select('id').eq('user_id', A.id).eq('client_id', r1.clientId);
  const aItems2 = await A.c.from('wardrobe_wear_event_items').select('id').eq('user_id', A.id).eq('source_item_id', itemId);
  check('WEAR_IDEMPOTENCY_RUNTIME',
    r1b.ok === true && (aEv2.data || []).length === 1 && (aItems2.data || []).length === 1
      && aEv2.data[0].id === aEv.data[0].id && r1b.deduplicated === true,
    'replayed identical action -> events=' + (aEv2.data || []).length
      + ' relations=' + (aItems2.data || []).length
      + ' sameEventRow=' + (aEv2.data[0].id === aEv.data[0].id) + ' deduplicated=' + r1b.deduplicated);

  // ── D. Outfit wear ───────────────────────────────────────────────────────
  const g1 = 's7a-look-item-' + RUN + '-1';
  const g2 = 's7a-look-item-' + RUN + '-2';
  const r2 = await logLookWear(A.c, A.id, lookId, [
    { sourceItemId: g1, sourceType: 'saved_scan', titleSnapshot: 'S7A Silk Shirt', categorySnapshot: 'tops' },
    { sourceItemId: g2, sourceType: 'saved_scan', titleSnapshot: 'S7A Wool Trouser', categorySnapshot: 'bottoms' },
    { sourceItemId: g2, sourceType: 'saved_scan', titleSnapshot: 'S7A Wool Trouser (duplicate payload)', categorySnapshot: 'bottoms' },
  ]);
  const lookEv = await A.c.from('wardrobe_wear_events').select('id, source_item_id, saved_look_id, saved_look_ref').eq('user_id', A.id).eq('saved_look_id', lookId);
  const lookEventId = lookEv.data && lookEv.data[0] && lookEv.data[0].id;
  const lookItems = lookEventId
    ? await A.c.from('wardrobe_wear_event_items').select('id, title_snapshot').eq('wear_event_id', lookEventId)
    : { data: [] };
  check('WEAR_LOOK_RUNTIME',
    r2.ok === true && (lookEv.data || []).length === 1 && (lookItems.data || []).length === 2
      && lookEv.data[0].source_item_id === null && lookEv.data[0].saved_look_ref === lookId,
    'ok=' + r2.ok + ' topLevelEvents=' + (lookEv.data || []).length
      + ' relationsPerUniqueGarment=' + (lookItems.data || []).length + '/2 (3 supplied, duplicate collapsed)'
      + ' source_item_id=' + String(lookEv.data[0].source_item_id)
      + ' saved_look_ref=' + (lookEv.data[0].saved_look_ref === lookId ? 'set' : 'MISSING'));

  // ── RLS runtime: owner ───────────────────────────────────────────────────
  const ownRead = await A.c.from('wardrobe_wear_event_items').select('id').eq('user_id', A.id);
  check('RLS_RUNTIME_OWNER',
    !ownRead.error && (ownRead.data || []).length === base.i + 3,
    'owner reads own relations under RLS: ' + (ownRead.data || []).length + '/' + (base.i + 3)
      + ', error=' + (ownRead.error ? ownRead.error.message : 'none'));

  // ── RLS runtime: cross-user ──────────────────────────────────────────────
  if (!B.id) {
    check('RLS_RUNTIME_CROSS_USER', null, 'NOT TESTED — NO SAFE SECOND ACTIVE TEST IDENTITY (' + B.skipped + ')');
  } else {
    const bReadEvents = await B.c.from('wardrobe_wear_events').select('id').eq('user_id', A.id);
    const bReadItems = await B.c.from('wardrobe_wear_event_items').select('id').eq('user_id', A.id);
    const bUpdate = await B.c.from('wardrobe_wear_event_items').update({ title_snapshot: 'hijacked' }).eq('user_id', A.id).select('id');
    const bDelItems = await B.c.from('wardrobe_wear_event_items').delete().eq('user_id', A.id).select('id');
    const bDelEvents = await B.c.from('wardrobe_wear_events').delete().eq('user_id', A.id).select('id');
    const intact = await A.c.from('wardrobe_wear_event_items').select('id, title_snapshot').eq('user_id', A.id);
    const untampered = !(intact.data || []).some((r) => r.title_snapshot === 'hijacked');
    check('RLS_RUNTIME_CROSS_USER',
      (bReadEvents.data || []).length === 0 && (bReadItems.data || []).length === 0
        && (bUpdate.data || []).length === 0 && (bDelItems.data || []).length === 0
        && (bDelEvents.data || []).length === 0
        && (intact.data || []).length === base.i + 3 && untampered,
      'B reads A: events=' + (bReadEvents.data || []).length + ' relations=' + (bReadItems.data || []).length
        + ' | B writes A: updated=' + (bUpdate.data || []).length
        + ' deletedRelations=' + (bDelItems.data || []).length
        + ' deletedEvents=' + (bDelEvents.data || []).length
        + ' | A intact=' + (intact.data || []).length + '/' + (base.i + 3) + ' untampered=' + untampered);
  }

  // ── E. Saved Look deletion after wear — the DEF-S5-001 closure gate ──────
  const del = await A.c.from('looks').delete().eq('id', lookId).select('id');
  const afterEv = await A.c.from('wardrobe_wear_events').select('id, saved_look_id, saved_look_ref').eq('id', lookEventId).maybeSingle();
  const afterItems = await A.c.from('wardrobe_wear_event_items').select('id, title_snapshot').eq('wear_event_id', lookEventId);
  const lookGone = await A.c.from('looks').select('id').eq('id', lookId);
  check('SAVED_LOOK_DELETE_AFTER_WEAR',
    !del.error && (del.data || []).length === 1 && (lookGone.data || []).length === 0
      && !!afterEv.data && afterEv.data.saved_look_id === null
      && afterEv.data.saved_look_ref === lookId && (afterItems.data || []).length === 2,
    'deleteError=' + (del.error ? del.error.message : 'none')
      + ' lookRowsDeleted=' + (del.data || []).length
      + ' lookStillPresent=' + ((lookGone.data || []).length !== 0)
      + ' | eventSurvives=' + !!afterEv.data
      + ' saved_look_id=' + String(afterEv.data && afterEv.data.saved_look_id)
      + ' saved_look_ref=' + (afterEv.data && afterEv.data.saved_look_ref === lookId ? 'PRESERVED' : 'LOST')
      + ' relationsSurvive=' + (afterItems.data || []).length + '/2'
      + ' snapshots=' + JSON.stringify((afterItems.data || []).map((r) => r.title_snapshot).sort()));

  // ── F. Source item deletion after wear ───────────────────────────────────
  const scanId = crypto.randomUUID();
  const scanIns = await A.c.from('saved_scans').insert({
    id: scanId, user_id: A.id, title: 'S7A fixture scan ' + RUN,
    analysis_result: MARK, products: [], source: 'mobile',
    saved_at: new Date().toISOString(), metadata: MARK,
  }).select('id');
  if (scanIns.error) {
    check('ITEM_DELETE_AFTER_WEAR', null, 'NOT TESTED — cannot create source item fixture: ' + scanIns.error.message);
  } else {
    const rF = await logItemWear(A.c, A.id, {
      sourceItemId: scanId, sourceType: 'saved_scan',
      titleSnapshot: 'S7A Deletable Coat', categorySnapshot: 'outerwear',
    });
    // saved_scans is soft-delete by design: SELECT/INSERT/UPDATE policies and
    // deliberately no client DELETE. Removing it any other way would test a
    // path the product does not have.
    const rm = await A.c.from('saved_scans').update({ deleted_at: new Date().toISOString() }).eq('id', scanId).select('id');
    const survEv = await A.c.from('wardrobe_wear_events').select('id').eq('user_id', A.id).eq('source_item_id', scanId);
    const survIt = await A.c.from('wardrobe_wear_event_items').select('id, title_snapshot').eq('user_id', A.id).eq('source_item_id', scanId);
    check('ITEM_DELETE_AFTER_WEAR',
      rF.ok === true && !rm.error && (rm.data || []).length === 1
        && (survEv.data || []).length === 1 && (survIt.data || []).length === 1
        && survIt.data[0].title_snapshot === 'S7A Deletable Coat',
      'wearOk=' + rF.ok + ' sourceRemoved=' + (rm.data || []).length
        + ' | eventSurvives=' + (survEv.data || []).length
        + ' relationSurvives=' + (survIt.data || []).length
        + ' snapshotIntact=' + (survIt.data[0] && survIt.data[0].title_snapshot === 'S7A Deletable Coat'));
  }

  // ── Cleanup: this run's fixtures only, via the owner's own session ───────
  const createdEventIds = [aEv.data && aEv.data[0] && aEv.data[0].id, lookEventId].filter(Boolean);
  let removedRelations = 0;
  let removedEvents = 0;
  const c1 = await A.c.from('wardrobe_wear_event_items').delete().eq('user_id', A.id).like('source_item_id', '%' + RUN + '%').select('id');
  removedRelations += (c1.data || []).length;
  const c2 = await A.c.from('wardrobe_wear_event_items').delete().eq('user_id', A.id).eq('source_item_id', scanId).select('id');
  removedRelations += (c2.data || []).length;
  const c3 = await A.c.from('wardrobe_wear_events').delete().eq('user_id', A.id).like('client_id', '%' + RUN + '%').select('id');
  removedEvents += (c3.data || []).length;
  const c4 = await A.c.from('wardrobe_wear_events').delete().eq('user_id', A.id).eq('source_item_id', scanId).select('id');
  removedEvents += (c4.data || []).length;
  const c5 = await A.c.from('wardrobe_wear_events').delete().eq('user_id', A.id).in('id', createdEventIds).select('id');
  removedEvents += (c5.data || []).length;
  const c6 = await A.c.from('looks').delete().eq('id', lookId).select('id');

  const residEv = await countEvents(A.c, A.id);
  const residIt = await countItems(A.c, A.id);

  const cleanup = {
    removed_relations: removedRelations,
    removed_events: removedEvents,
    removed_looks: (c6.data || []).length,
    saved_scan_fixture: scanIns.error ? 'not created' : 'soft-deleted (no client DELETE policy)',
    residual_events: residEv,
    residual_relations: residIt,
    baseline_events: base.e,
    baseline_relations: base.i,
    returned_to_baseline: residEv === base.e && residIt === base.i,
  };
  console.error('CLEANUP ' + JSON.stringify(cleanup));

  const verdict = failed === 0
    ? 'WEAR_MODEL_RUNTIME_VERIFICATION=PASS'
    : 'WEAR_MODEL_RUNTIME_VERIFICATION=FAIL';
  console.error(verdict);
  emit({ cleanup, verdict, failed_checks: failed });
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  emit({ operational_failure: true, code: 'HARNESS_ERROR', message: String(e && e.message ? e.message : e) });
  process.exit(4);
});
