#!/usr/bin/env node
'use strict';

/**
 * Live backend contract checks against K Scan AI Staging.
 *
 * These run over the public REST/Functions surface with the staging *anon* key
 * only — no service-role key, no privileged access, no writes. They assert the
 * parts of the rebuilt contract that a released client depends on:
 *
 *   - the anon role cannot read user-owned tables (RLS is actually on)
 *   - client-required RPCs are reachable and reject unauthenticated callers by
 *     policy rather than by "function not found"
 *   - Edge Function gateway authorization matches the deployed verify_jwt posture
 *   - the production-required Storage buckets resolve
 *
 * SKIPPED unless STAGING_CONTRACT_TESTS=1, because they need network. They are
 * deliberately read-only: nothing here inserts, updates, or deletes, and nothing
 * touches the Waitlist.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const STAGING_REF = 'yzqjvdfgefveprobvvyw';
const PRODUCTION_REF = 'wyyuqfdxucjksghsmhry';
const BASE = `https://${STAGING_REF}.supabase.co`;

const ANON = process.env.SUPABASE_STAGING_ANON_KEY || '';
const ENABLED = process.env.STAGING_CONTRACT_TESTS === '1' && ANON !== '';
const opts = { skip: ENABLED ? false : 'set STAGING_CONTRACT_TESTS=1 and SUPABASE_STAGING_ANON_KEY' };

/** Hard stop: these tests must never be pointed at production. */
test('the contract suite targets staging and cannot target production', () => {
  assert.equal(STAGING_REF, 'yzqjvdfgefveprobvvyw');
  assert.ok(!BASE.includes(PRODUCTION_REF), 'production must never be a test target');
  if (ANON) {
    // A Supabase anon key is a JWT whose `ref` claim names its project.
    const payload = JSON.parse(Buffer.from(ANON.split('.')[1], 'base64').toString('utf8'));
    assert.equal(payload.ref, STAGING_REF, 'anon key must belong to staging');
    assert.notEqual(payload.ref, PRODUCTION_REF);
  }
});

const headers = () => ({ apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' });

/** Tables the released client owns per-user. anon must never read them. */
const USER_OWNED_TABLES = [
  'profiles',
  'privacy_settings',
  'saved_scans',
  'looks',
  'look_items',
  'dressing_rooms',
  'dressing_room_items',
  'style_chat_sessions',
  'style_chat_messages',
  'inspiration_items',
  'user_stylist_preferences',
  'shared_room_memberships',
  'legal_acceptances',
  'deletion_requests',
];

for (const table of USER_OWNED_TABLES) {
  test(`RLS: anon cannot read ${table}`, opts, async () => {
    const res = await fetch(`${BASE}/rest/v1/${table}?select=*&limit=1`, { headers: headers() });
    if (res.status === 200) {
      const rows = await res.json();
      assert.deepEqual(rows, [], `anon read ${rows.length} row(s) from ${table}`);
    } else {
      assert.ok([401, 403, 404].includes(res.status), `${table} returned ${res.status}`);
    }
  });
}

/**
 * The Waitlist is protected data. anon must not be able to read it, and this
 * test never prints a row even if the assertion fails.
 */
test('RLS: anon cannot read the Waitlist', opts, async () => {
  const res = await fetch(`${BASE}/rest/v1/waitlist_signups?select=id&limit=1`, { headers: headers() });
  if (res.status === 200) {
    const rows = await res.json();
    assert.equal(rows.length, 0, 'anon could read Waitlist rows');
  } else {
    assert.ok([401, 403, 404].includes(res.status));
  }
});

/**
 * Client-required RPCs. A rebuilt backend that lost one would answer 404
 * "Could not find the function ... in the schema cache". Anything else — including
 * an authorization rejection — proves the RPC exists with a callable signature.
 */
const CLIENT_RPCS = [
  ['get_stylechat_daily_usage', {}],
  ['increment_style_chat_usage', {}],
  ['list_shared_rooms_for_me', {}],
  ['create_or_get_room_share', { p_room_id: '00000000-0000-4000-8000-000000000000' }],
  ['revoke_room_share', { p_room_id: '00000000-0000-4000-8000-000000000000' }],
  ['get_item_reaction_counts', { p_item_ids: [] }],
  ['get_outfit_decision_vote_counts', { p_group_id: '00000000-0000-4000-8000-000000000000' }],
  ['get_public_room_decision_preview', { p_share_token: 'nonexistent-token' }],
  ['join_room_via_share_token', { p_share_token: 'nonexistent-token' }],
  ['save_shared_room_for_me', { p_share_token: 'nonexistent-token' }],
  ['check_and_increment_stylechat_burst', { p_limit: 1 }],
  ['increment_stylechat_daily_usage', {}],
  ['increment_stylechat_daily_usage_idempotent', { p_operation_key: 'contract-probe' }],
  ['mark_elise_generation_generating', { p_operation_id: '00000000-0000-4000-8000-000000000000' }],
];

for (const [fn, body] of CLIENT_RPCS) {
  test(`RPC ${fn} exists and is callable`, opts, async () => {
    const res = await fetch(`${BASE}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    assert.ok(
      !/schema cache|does not exist|Could not find the function/i.test(text),
      `${fn} is missing from the rebuilt backend: ${text.slice(0, 200)}`,
    );
    assert.notEqual(res.status, 404, `${fn} returned 404`);
  });
}

/**
 * Edge Function gateway authorization. Every production function is deployed
 * with verify_jwt = true except the four that authenticate by signed token or
 * worker secret, so a call carrying no credential at all must be rejected at the
 * gateway for all of them.
 */
const EDGE_FUNCTIONS = [
  'scan-identify',
  'stylechat-generate',
  'style-outfit-generate',
  'stylist-speech',
  'shared-room-image-url',
  'nike-shoe-details',
  'tryon-clothes-pro',
  'search-vinted-secondhand',
  'product-search-deals',
  'kickscrew-sneaker-description',
  'handle-user-deletion',
  'privacy-data-export',
  'privacy-correction-request',
];

for (const fn of EDGE_FUNCTIONS) {
  test(`Edge Function ${fn}: unauthenticated call is rejected`, opts, async () => {
    const res = await fetch(`${BASE}/functions/v1/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 401, `${fn} allowed an unauthenticated call (${res.status})`);
  });

  test(`Edge Function ${fn}: deployed and responding`, opts, async () => {
    const res = await fetch(`${BASE}/functions/v1/${fn}`, {
      method: 'POST',
      headers: headers(),
      body: '{}',
    });
    // Anything but 404 proves the function is deployed; 4xx from its own
    // validation or auth logic is the healthy answer to an empty body.
    assert.notEqual(res.status, 404, `${fn} is not deployed`);
    assert.ok(res.status < 500, `${fn} returned ${res.status}`);
  });
}

/** Storage: the two production-required buckets must resolve. */
for (const bucket of ['style-library-images', 'legal-documents']) {
  test(`Storage bucket ${bucket} exists`, opts, async () => {
    const res = await fetch(`${BASE}/storage/v1/bucket/${bucket}`, { headers: headers() });
    assert.notEqual(res.status, 404, `${bucket} does not exist on staging`);
  });
}

/** Private bucket contents must not be listable or readable by anon. */
test('Storage: anon cannot read style-library-images objects', opts, async () => {
  const res = await fetch(`${BASE}/storage/v1/object/style-library-images/probe.jpg`, {
    headers: headers(),
  });
  assert.ok([400, 401, 403, 404].includes(res.status), `unexpected ${res.status}`);
});
