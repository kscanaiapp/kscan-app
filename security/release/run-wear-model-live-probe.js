#!/usr/bin/env node
'use strict';

/**
 * Build 29 Closet V2 — wear-model live probe (staging only).
 *
 * S7A certified the S5 wear model against a from-zero local database and left
 * every staging runtime gate NOT TESTED, because the only legitimate staging
 * identities are the pre-provisioned synthetic accounts whose credentials live
 * as GitHub secrets. This closes that gap from inside CI.
 *
 * WHAT MAKES THIS EVIDENCE RATHER THAN A SIMULATION
 * -------------------------------------------------
 * It drives the REAL services/wearHistory.ts — transpiled and loaded through
 * the same pattern __tests__/wearHistoryContract.test.js uses — with a REAL
 * authenticated Supabase session injected in place of the app's client. RLS,
 * the GRANT/REVOKE layer and the FK/CHECK behaviour are all enforced by
 * PostgREST and Postgres, not stubbed. A pass here means the product path
 * works on staging, not that a re-implementation of it does.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not a general-purpose Supabase mutation tool. There is no input for a
 * project ref, a URL, a table or a statement. The target is asserted against
 * security/scripts/lib/environment-authority.js, which never accepts
 * production. The only writes it can perform are the fixed wear/look/scan
 * fixtures below, every one tagged with `s7a_fixture` and a per-run id, and
 * every one removed through the owner's own authenticated session at the end.
 *
 * IDENTITY
 * --------
 * Against staging it signs in as EXISTING accounts only — it never creates an
 * Auth user. `provision` mode exists for a local from-zero database and is
 * refused outright when the target is not localhost.
 *
 * SECRETS
 * -------
 * Credentials arrive through the environment, are never an argv element,
 * never echoed, and never written to the report. The report carries booleans,
 * counts, and non-sensitive identifiers only.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createClient } = require('@supabase/supabase-js');
const ts = require('typescript');
const authority = require('../scripts/lib/environment-authority.js');

const ROOT = path.resolve(__dirname, '..', '..');

// ── Target resolution: fixed, asserted, fail-closed ─────────────────────────

const MODE = process.env.KSCAN_WEAR_PROBE_MODE === 'provision' ? 'provision' : 'existing';
const API_URL = process.env.SUPABASE_STAGING_URL || process.env.KSCAN_WEAR_PROBE_URL || '';
const ANON_KEY =
  process.env.SUPABASE_STAGING_PUBLISHABLE_KEY || process.env.KSCAN_WEAR_PROBE_ANON_KEY || '';
const PROJECT_REF = process.env.SUPABASE_STAGING_PROJECT_REF || '';

const isLocalTarget = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(API_URL);

function fail(code, message) {
  process.stdout.write(JSON.stringify({ operational_failure: true, code, message }, null, 2) + '\n');
  process.exit(2);
}

if (!API_URL || !ANON_KEY) {
  fail('MISSING_TARGET', 'SUPABASE_STAGING_URL and SUPABASE_STAGING_PUBLISHABLE_KEY are required');
}

if (isLocalTarget) {
  // A local from-zero database has no project ref to assert. The URL shape is
  // the assertion: it cannot be a hosted project, so it cannot be production.
  if (MODE !== 'provision') {
    // existing-user mode against local is allowed, just unusual; nothing to assert.
  }
} else {
  // Any hosted target must resolve to staging through the shared authority.
  // A missing, malformed or unknown ref throws here rather than passing.
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
const FIXTURE_MARKER = 's7a_fixture';
const MARK = { [FIXTURE_MARKER]: true, run: RUN };
const today = new Date().toISOString().slice(0, 10);

const results = [];
let failed = 0;
function check(id, ok, detail) {
  results.push({ id, ok, detail });
  if (ok === false) failed++;
  const label = ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL';
  console.error(label + '  ' + id + (detail ? '  — ' + detail : ''));
}

// ── Load the real service module with a real client injected ────────────────

function loadTsModule(relativePath, requireMap) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    __DEV__: false,
    console,
    exports: mod.exports,
    module: mod,
    require: (s) => {
      if (s in requireMap) return requireMap[s];
      throw new Error('Unexpected import in ' + relativePath + ': ' + s);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return mod.exports;
}

function newClient() {
  return createClient(API_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Role A is the ACTIVE synthetic account: `looks` and `saved_scans` both carry
 * an account-status guard, so a pending/locked identity cannot exercise them.
 * Role B is only ever used to prove it CANNOT reach A's rows, which any
 * authenticated identity can demonstrate regardless of account status.
 */
async function identity(role) {
  const c = newClient();
  if (MODE === 'existing') {
    const email = process.env['KSCAN_WEAR_PROBE_EMAIL_' + role];
    const password = process.env['KSCAN_WEAR_PROBE_PASSWORD_' + role];
    if (!email || !password) return { c, id: null, skipped: 'no credential supplied for identity ' + role };
    const { data, error } = await c.auth.signInWithPassword({ email, password });
    // error.message is a Supabase auth status string, never the credential.
    if (error) return { c, id: null, skipped: 'sign-in failed for ' + role + ': ' + error.message };
    return { c, id: data.user.id };
  }
  const email = 's7a-' + role.toLowerCase() + '-' + RUN + '@kscan-test.invalid';
  const password = 'S7a!' + RUN + '!' + role;
  const { data, error } = await c.auth.signUp({ email, password });
  if (error) return { c, id: null, skipped: 'signup failed for ' + role + ': ' + error.message };
  if (!data.session) {
    const { data: s, error: e2 } = await c.auth.signInWithPassword({ email, password });
    if (e2) return { c, id: null, skipped: 'sign-in failed for ' + role + ': ' + e2.message };
    return { c, id: s.user.id };
  }
  return { c, id: data.user.id };
}

async function countEvents(c, userId) {
  const { count } = await c.from('wardrobe_wear_events').select('id', { count: 'exact', head: true }).eq('user_id', userId);
  return count ?? 0;
}
async function countItems(c, userId) {
  const { count } = await c.from('wardrobe_wear_event_items').select('id', { count: 'exact', head: true }).eq('user_id', userId);
  return count ?? 0;
}

function emit(extra) {
  const payload = {
    target: isLocalTarget ? 'local' : 'staging',
    project_ref: isLocalTarget ? null : PROJECT_REF,
    mode: MODE,
    run_id: RUN,
    fixture_marker: FIXTURE_MARKER,
    results,
    ...extra,
  };
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

async function main() {
  const A = await identity('A');
  if (!A.id) {
    emit({ operational_failure: true, code: 'NO_PRIMARY_IDENTITY', message: A.skipped });
    process.exit(3);
  }
  const B = await identity('B');
  console.error('IDENTITY A=' + A.id.slice(0, 8) + ' B=' + (B.id ? B.id.slice(0, 8) : 'none'));

  const wear = loadTsModule('services/wearHistory.ts', { './supabaseClient': { supabase: A.c } });

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
  const itemClientKey = 'wear:item:' + itemId + ':' + today;
  const r1 = await wear.logItemWear({
    sourceItemId: itemId, sourceType: 'saved_scan',
    titleSnapshot: 'S7A Navy Blazer', categorySnapshot: 'outerwear',
  });
  const aEv = await A.c.from('wardrobe_wear_events').select('id, source_item_id').eq('user_id', A.id).eq('client_id', itemClientKey);
  const aItems = await A.c.from('wardrobe_wear_event_items').select('id').eq('user_id', A.id).eq('source_item_id', itemId);
  check('WEAR_ITEM_RUNTIME',
    r1.ok === true && (aEv.data?.length ?? 0) === 1 && (aItems.data?.length ?? 0) === 1
      && aEv.data[0].source_item_id === itemId,
    'ok=' + r1.ok + ' events=' + (aEv.data?.length) + ' relations=' + (aItems.data?.length)
      + ' source_item_id=' + (aEv.data?.[0]?.source_item_id === itemId ? 'set' : 'WRONG'));

  // ── C. Idempotency ───────────────────────────────────────────────────────
  const r1b = await wear.logItemWear({
    sourceItemId: itemId, sourceType: 'saved_scan',
    titleSnapshot: 'S7A Navy Blazer', categorySnapshot: 'outerwear',
  });
  const aEv2 = await A.c.from('wardrobe_wear_events').select('id').eq('user_id', A.id).eq('client_id', itemClientKey);
  const aItems2 = await A.c.from('wardrobe_wear_event_items').select('id').eq('user_id', A.id).eq('source_item_id', itemId);
  check('WEAR_IDEMPOTENCY_RUNTIME',
    r1b.ok === true && (aEv2.data?.length ?? 0) === 1 && (aItems2.data?.length ?? 0) === 1
      && aEv2.data[0].id === aEv.data[0].id && r1b.deduplicated === true,
    'replayed identical action -> events=' + (aEv2.data?.length) + ' relations=' + (aItems2.data?.length)
      + ' sameEventRow=' + (aEv2.data?.[0]?.id === aEv.data?.[0]?.id) + ' deduplicated=' + r1b.deduplicated);

  // ── D. Outfit wear ───────────────────────────────────────────────────────
  const g1 = 's7a-look-item-' + RUN + '-1';
  const g2 = 's7a-look-item-' + RUN + '-2';
  const r2 = await wear.logLookWear(lookId, [
    { sourceItemId: g1, sourceType: 'saved_scan', titleSnapshot: 'S7A Silk Shirt', categorySnapshot: 'tops' },
    { sourceItemId: g2, sourceType: 'saved_scan', titleSnapshot: 'S7A Wool Trouser', categorySnapshot: 'bottoms' },
    { sourceItemId: g2, sourceType: 'saved_scan', titleSnapshot: 'S7A Wool Trouser (duplicate payload)', categorySnapshot: 'bottoms' },
  ]);
  const lookEv = await A.c.from('wardrobe_wear_events').select('id, source_item_id, saved_look_id, saved_look_ref').eq('user_id', A.id).eq('saved_look_id', lookId);
  const lookEventId = lookEv.data?.[0]?.id;
  const lookItems = lookEventId
    ? await A.c.from('wardrobe_wear_event_items').select('id, source_item_id, title_snapshot').eq('wear_event_id', lookEventId)
    : { data: [] };
  check('WEAR_LOOK_RUNTIME',
    r2.ok === true && (lookEv.data?.length ?? 0) === 1 && (lookItems.data?.length ?? 0) === 2
      && lookEv.data[0].source_item_id === null && lookEv.data[0].saved_look_ref === lookId,
    'ok=' + r2.ok + ' topLevelEvents=' + (lookEv.data?.length)
      + ' relationsPerUniqueGarment=' + (lookItems.data?.length) + '/2 (3 supplied, duplicate collapsed)'
      + ' source_item_id=' + String(lookEv.data?.[0]?.source_item_id)
      + ' saved_look_ref=' + (lookEv.data?.[0]?.saved_look_ref === lookId ? 'set' : 'MISSING'));

  // ── RLS runtime: owner ───────────────────────────────────────────────────
  const ownRead = await A.c.from('wardrobe_wear_event_items').select('id').eq('user_id', A.id);
  check('RLS_RUNTIME_OWNER',
    !ownRead.error && (ownRead.data?.length ?? 0) === base.i + 3,
    'owner reads own relations under RLS: ' + (ownRead.data?.length) + '/' + (base.i + 3)
      + ', error=' + (ownRead.error?.message ?? 'none'));

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
    const untampered = !(intact.data ?? []).some((r) => r.title_snapshot === 'hijacked');
    check('RLS_RUNTIME_CROSS_USER',
      (bReadEvents.data?.length ?? 0) === 0 && (bReadItems.data?.length ?? 0) === 0
        && (bUpdate.data?.length ?? 0) === 0 && (bDelItems.data?.length ?? 0) === 0
        && (bDelEvents.data?.length ?? 0) === 0
        && (intact.data?.length ?? 0) === base.i + 3 && untampered,
      'B reads A: events=' + (bReadEvents.data?.length) + ' relations=' + (bReadItems.data?.length)
        + ' | B writes A: updated=' + (bUpdate.data?.length) + ' deletedRelations=' + (bDelItems.data?.length)
        + ' deletedEvents=' + (bDelEvents.data?.length)
        + ' | A intact=' + (intact.data?.length) + '/' + (base.i + 3) + ' untampered=' + untampered);
  }

  // ── E. Saved Look deletion after wear — the DEF-S5-001 closure gate ──────
  const del = await A.c.from('looks').delete().eq('id', lookId).select('id');
  const afterEv = await A.c.from('wardrobe_wear_events').select('id, saved_look_id, saved_look_ref, source_item_id').eq('id', lookEventId).maybeSingle();
  const afterItems = await A.c.from('wardrobe_wear_event_items').select('id, title_snapshot').eq('wear_event_id', lookEventId);
  const lookGone = await A.c.from('looks').select('id').eq('id', lookId);
  check('SAVED_LOOK_DELETE_AFTER_WEAR',
    !del.error && (del.data?.length ?? 0) === 1 && (lookGone.data?.length ?? 0) === 0
      && !!afterEv.data && afterEv.data.saved_look_id === null
      && afterEv.data.saved_look_ref === lookId && (afterItems.data?.length ?? 0) === 2,
    'deleteError=' + (del.error?.message ?? 'none') + ' lookRowsDeleted=' + (del.data?.length)
      + ' lookStillPresent=' + ((lookGone.data?.length ?? 0) !== 0)
      + ' | eventSurvives=' + (!!afterEv.data)
      + ' saved_look_id=' + String(afterEv.data?.saved_look_id)
      + ' saved_look_ref=' + (afterEv.data?.saved_look_ref === lookId ? 'PRESERVED' : 'LOST')
      + ' relationsSurvive=' + (afterItems.data?.length) + '/2'
      + ' snapshots=' + JSON.stringify((afterItems.data ?? []).map((r) => r.title_snapshot).sort()));

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
    const rF = await wear.logItemWear({
      sourceItemId: scanId, sourceType: 'saved_scan',
      titleSnapshot: 'S7A Deletable Coat', categorySnapshot: 'outerwear',
    });
    // saved_scans is soft-delete by design: it carries SELECT/INSERT/UPDATE
    // policies and deliberately no client DELETE. Removing it any other way
    // would be testing a path the product does not have.
    const rm = await A.c.from('saved_scans').update({ deleted_at: new Date().toISOString() }).eq('id', scanId).select('id');
    const survEv = await A.c.from('wardrobe_wear_events').select('id').eq('user_id', A.id).eq('source_item_id', scanId);
    const survIt = await A.c.from('wardrobe_wear_event_items').select('id, title_snapshot').eq('user_id', A.id).eq('source_item_id', scanId);
    check('ITEM_DELETE_AFTER_WEAR',
      rF.ok === true && !rm.error && (rm.data?.length ?? 0) === 1
        && (survEv.data?.length ?? 0) === 1 && (survIt.data?.length ?? 0) === 1
        && survIt.data[0].title_snapshot === 'S7A Deletable Coat',
      'wearOk=' + rF.ok + ' sourceRemoved=' + (rm.data?.length)
        + ' | eventSurvives=' + (survEv.data?.length) + ' relationSurvives=' + (survIt.data?.length)
        + ' snapshotIntact=' + (survIt.data?.[0]?.title_snapshot === 'S7A Deletable Coat'));
  }

  // ── Cleanup: this run's fixtures only, via the owner's own session ───────
  const createdEventIds = [aEv.data?.[0]?.id, lookEventId].filter(Boolean);
  let removedRelations = 0;
  let removedEvents = 0;
  const c1 = await A.c.from('wardrobe_wear_event_items').delete().eq('user_id', A.id).like('source_item_id', '%' + RUN + '%').select('id');
  removedRelations += c1.data?.length ?? 0;
  const c2 = await A.c.from('wardrobe_wear_event_items').delete().eq('user_id', A.id).eq('source_item_id', scanId).select('id');
  removedRelations += c2.data?.length ?? 0;
  const c3 = await A.c.from('wardrobe_wear_events').delete().eq('user_id', A.id).like('client_id', '%' + RUN + '%').select('id');
  removedEvents += c3.data?.length ?? 0;
  const c4 = await A.c.from('wardrobe_wear_events').delete().eq('user_id', A.id).eq('source_item_id', scanId).select('id');
  removedEvents += c4.data?.length ?? 0;
  const c5 = await A.c.from('wardrobe_wear_events').delete().eq('user_id', A.id).in('id', createdEventIds).select('id');
  removedEvents += c5.data?.length ?? 0;
  const c6 = await A.c.from('looks').delete().eq('id', lookId).select('id');

  const residEv = await countEvents(A.c, A.id);
  const residIt = await countItems(A.c, A.id);

  const cleanup = {
    removed_relations: removedRelations,
    removed_events: removedEvents,
    removed_looks: c6.data?.length ?? 0,
    // saved_scans has no client DELETE policy; the fixture is left soft-deleted
    // and tagged, which is the supported end state rather than a leak.
    saved_scan_fixture: scanIns.error ? 'not created' : 'soft-deleted (no client DELETE policy)',
    residual_events: residEv,
    residual_relations: residIt,
    baseline_events: base.e,
    baseline_relations: base.i,
    returned_to_baseline: residEv === base.e && residIt === base.i,
  };
  console.error('CLEANUP ' + JSON.stringify(cleanup));

  const verdict = failed === 0 ? 'WEAR_MODEL_RUNTIME_VERIFICATION=PASS' : 'WEAR_MODEL_RUNTIME_VERIFICATION=FAIL';
  console.error(verdict);
  emit({ cleanup, verdict, failed_checks: failed });
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  emit({ operational_failure: true, code: 'HARNESS_ERROR', message: String(e && e.message ? e.message : e) });
  process.exit(4);
});
