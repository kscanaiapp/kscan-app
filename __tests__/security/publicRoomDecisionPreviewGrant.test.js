#!/usr/bin/env node
'use strict';

/**
 * AUD-P4-D: governance for public.get_public_room_decision_preview(text)'s
 * anonymous EXECUTE grant.
 *
 * Classification before this pass was
 * PUBLIC_ROOM_PREVIEW_GRANT=INTENDED_BUT_ALLOWLIST_STALE: staging allows anon
 * execution, three migrations say that is deliberate, but
 * security/scripts/anon-grant-guard.js did not record the decision, so the
 * drift guard would have flagged a legitimate grant (and, worse, the grant had
 * no recorded audit trail).
 *
 * These tests do not assume intent -- they prove it from source, and then prove
 * the three properties that make the grant safe to keep:
 *
 *   1. INTENT      three migrations grant/re-affirm anon EXECUTE on purpose,
 *                  and an unauthenticated screen actually calls it.
 *   2. SCOPE       exactly one function was added to the allowlist; no
 *                  wildcard, no second surface, no broadened grant.
 *   3. PRIVACY     the response carries no private-room or identity data, and
 *                  a caller cannot enumerate or reach a non-public room.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const { ANON_EXECUTE_ALLOWLIST } = require('../../security/scripts/anon-grant-guard');
const {
  detectUnintendedAnonGrants,
  detectStaleAllowlistEntries,
} = require('../../security/scripts/anon-grant-guard');

const FN = 'get_public_room_decision_preview';

// The creating migration and the later audit-hardening migration that owns the
// authoritative body. 20260808115735 is the privilege-boundary sweep.
const CREATING_MIGRATION = 'supabase/migrations/20260711000002_outfit_decision_rooms.sql';
const AUTHORITATIVE_MIGRATION =
  'supabase/migrations/20260712010000_audit_hardening_ai_stylist_stylechat.sql';
const BOUNDARY_MIGRATION = 'supabase/migrations/20260808115735_enforce_rpc_privilege_boundary.sql';

/** The authoritative function body: the last `create or replace` of it. */
function authoritativeBody() {
  const sql = read(AUTHORITATIVE_MIGRATION);
  const start = sql.lastIndexOf(`create or replace function public.${FN}(`);
  assert.ok(start > -1, `${AUTHORITATIVE_MIGRATION} must define ${FN}`);
  const end = sql.indexOf('\n$$;', start);
  assert.ok(end > start, 'function body must terminate');
  return sql.slice(start, end);
}

// ── 1. INTENT ────────────────────────────────────────────────────────────────

test('INTENT: the creating migration grants anon EXECUTE on the exact (text) signature', () => {
  const sql = read(CREATING_MIGRATION);
  assert.match(sql, new RegExp(`revoke all on function public\\.${FN}\\(text\\) from public`));
  assert.match(
    sql,
    new RegExp(`grant execute on function public\\.${FN}\\(text\\) to anon, authenticated`),
  );
});

test('INTENT: the audit-hardening pass re-affirmed the same anon grant rather than revoking it', () => {
  const sql = read(AUTHORITATIVE_MIGRATION);
  assert.match(
    sql,
    new RegExp(`grant execute on function public\\.${FN}\\(text\\) to anon, authenticated`),
  );
});

test('INTENT: the privilege-boundary sweep lists it as deliberately NOT revoked', () => {
  const sql = read(BOUNDARY_MIGRATION);
  const line = sql.split('\n').find((l) => /Deliberately NOT revoked/i.test(l) && l.includes(FN));
  assert.ok(line, `${BOUNDARY_MIGRATION} must name ${FN} as deliberately not revoked`);
});

test('INTENT: an unauthenticated public screen is the real caller', () => {
  // The client RPC call...
  assert.match(read('services/outfitDecisions.ts'), new RegExp(`supabase\\.rpc\\(\\s*'${FN}'`));
  // ...reached from the (public) route group, which needs no session.
  assert.ok(
    fs.existsSync(path.join(ROOT, 'app/(public)/rooms/[token].tsx')),
    'the unauthenticated public room screen must exist',
  );
  assert.match(read('app/(public)/rooms/[token].tsx'), new RegExp(FN));
});

// ── 2. SCOPE ─────────────────────────────────────────────────────────────────

test('SCOPE: exactly one function was added, and it is the intended one', () => {
  const sorted = [...ANON_EXECUTE_ALLOWLIST].sort();
  assert.deepEqual(sorted, ['get_item_reaction_counts', FN, 'get_public_room_preview']);
  assert.equal(new Set(ANON_EXECUTE_ALLOWLIST).size, ANON_EXECUTE_ALLOWLIST.length, 'no duplicates');
});

test('SCOPE: the allowlist contains no wildcard, pattern or schema-wide entry', () => {
  for (const entry of ANON_EXECUTE_ALLOWLIST) {
    assert.equal(typeof entry, 'string');
    assert.match(entry, /^[a-z0-9_]+$/, `${entry} must be a bare function name`);
    assert.doesNotMatch(entry, /[*%.]/, `${entry} must not be a wildcard or schema-qualified pattern`);
  }
});

test('SCOPE: adding the entry does not silence any other unintended anon grant', () => {
  const live = [
    { functionName: FN, anonCanExecute: true },
    { functionName: 'get_public_room_preview', anonCanExecute: true },
    { functionName: 'get_item_reaction_counts', anonCanExecute: true },
    // A neighbouring outfit-decision RPC must still be flagged if it ever
    // acquires anon EXECUTE -- the allowlist is per-function, not per-feature.
    { functionName: 'record_outfit_decision_vote', anonCanExecute: true },
    { functionName: 'ensure_privacy_settings', anonCanExecute: true },
  ];
  assert.deepEqual(detectUnintendedAnonGrants(live), [
    'record_outfit_decision_vote',
    'ensure_privacy_settings',
  ]);
});

test('SCOPE: the new entry is not stale -- it is flagged if the live grant disappears', () => {
  const stillGranted = [
    { functionName: FN, anonCanExecute: true },
    { functionName: 'get_public_room_preview', anonCanExecute: true },
    { functionName: 'get_item_reaction_counts', anonCanExecute: true },
  ];
  assert.deepEqual(detectStaleAllowlistEntries(stillGranted), []);

  const revokedLive = stillGranted.map((g) => (g.functionName === FN ? { ...g, anonCanExecute: false } : g));
  assert.deepEqual(detectStaleAllowlistEntries(revokedLive), [FN]);
});

test('SCOPE: the manifest records the grant as INTENTIONALLY_PUBLIC with its evidence', () => {
  const manifest = JSON.parse(read('security/perimeter/public-ingress-manifest.json'));
  const surface = manifest.surfaces.find((s) => s.name === FN);
  assert.ok(surface, 'the manifest must carry a surface entry for the newly allowlisted RPC');
  assert.equal(surface.type, 'supabase_rpc');
  assert.equal(surface.riskClassification, 'INTENTIONALLY_PUBLIC');
  assert.equal(surface.dbWrite, false);
  assert.equal(surface.storageWrite, false);
  assert.match(surface.evidenceSource, /outfit_decision_rooms\.sql/);
});

// ── 3. PRIVACY ───────────────────────────────────────────────────────────────

test('PRIVACY: the share token is regex-validated before any table is touched', () => {
  const body = authoritativeBody();
  const guardIdx = body.indexOf("!~ '^[A-Za-z0-9_-]+$'");
  const firstSelectIdx = body.indexOf('from public.room_shares');
  assert.ok(guardIdx > -1, 'the token must be regex-validated');
  assert.ok(firstSelectIdx > -1, 'the room must be resolved through room_shares');
  assert.ok(guardIdx < firstSelectIdx, 'validation must precede the first query');
  assert.match(body, /return jsonb_build_object\('status', 'malformed'\)/);
});

test('PRIVACY: a room is reachable ONLY through a live, non-revoked, unexpired view share', () => {
  const body = authoritativeBody();
  const lookup = body.slice(body.indexOf('from public.room_shares'), body.indexOf('if target_room_id is null'));
  for (const predicate of [
    "rs.share_token = normalized_token",
    "rs.access_level = 'view'",
    'rs.is_active = true',
    'rs.revoked_at is null',
    "rs.expires_at is null or rs.expires_at > now()",
  ]) {
    assert.ok(lookup.includes(predicate), `share lookup must require: ${predicate}`);
  }
  // Every later query is scoped to the room the share resolved to.
  assert.match(body, /where g\.dressing_room_id = target_room_id/);
});

test('PRIVACY: a caller cannot enumerate rooms -- an unusable token is a generic unavailable', () => {
  const body = authoritativeBody();
  assert.match(body, /if target_room_id is null then\s*\n\s*return jsonb_build_object\('status', 'unavailable'\)/);
  // Only three statuses exist, and none distinguishes "no such room" from
  // "room exists but the share is revoked/expired/not a view share".
  const statuses = [...body.matchAll(/'status',\s*'([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual([...new Set(statuses)], ['available', 'malformed', 'unavailable']);
});

test('PRIVACY: no owner, voter or account identity is ever returned', () => {
  const body = authoritativeBody();
  // Votes are aggregates only.
  assert.match(body, /'voteCount',\s*\(\s*\n?\s*select count\(\*\)/);
  for (const forbidden of [
    'user_id',
    'owner_id',
    'auth.uid',
    'email',
    'display_name',
    'avatar_url',
    'v.voter',
    'profiles',
  ]) {
    assert.ok(!body.includes(forbidden), `the response must not expose ${forbidden}`);
  }
});

test('PRIVACY: free text is HTML-stripped, length-capped, and the result is bounded', () => {
  const body = authoritativeBody();
  // Every user-authored string goes through the same strip + truncate shape.
  const stripped = [...body.matchAll(/left\(regexp_replace\(/g)];
  assert.ok(stripped.length >= 6, 'every free-text field must be HTML-stripped and truncated');
  assert.ok(!/regexp_replace\([^)]*\)\s*as\s+raw/.test(body), 'no raw passthrough');
  // Bounded fan-out: groups, options, items.
  assert.match(body, /order by g\.created_at desc\s*\n\s*limit 10/);
  assert.match(body, /order by o\.sort_order asc, o\.created_at asc\s*\n\s*limit 3/);
  assert.match(body, /order by oi\.sort_order asc, oi\.created_at asc\s*\n\s*limit 6/);
});

test('PRIVACY: image URLs are scheme-restricted, never echoed raw', () => {
  assert.match(
    authoritativeBody(),
    /case when oi\.image_url ~\* '\^https\?:\/\/' then oi\.image_url else null end/,
  );
});

test('PRIVACY: the function stays a read-only SECURITY DEFINER with a pinned search_path', () => {
  const body = authoritativeBody();
  assert.match(body, /\bstable\b/);
  assert.match(body, /security definer/);
  assert.match(body, /set search_path = public/);
  for (const write of ['insert into', 'update ', 'delete from']) {
    assert.ok(!body.includes(write), `a preview must never ${write.trim()}`);
  }
});
