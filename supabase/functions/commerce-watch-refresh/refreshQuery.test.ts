// refreshQuery.test.ts — proving tests for hostile-audit repair DEF-WL-04.
//
// The defect: a Tier 1 refresh applied the MIN_REFRESH_INTERVAL_MS staleness
// predicate ONLY when no watchId was supplied. The Watch detail screen's
// REFRESH button always supplies one, so every tap reached a provider with no
// cooldown, and the endpoint's own `too_recent` reply became unreachable.
//
// These tests assert the predicate itself, not the prose around it. The
// MUTATION GUARD case is the one that would have failed before the repair.

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildDueWatchPath } from './refreshQuery.ts';

const USER = '11111111-2222-3333-4444-555555555555';
const WATCH = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CUTOFF = '2026-08-30T21:00:00.000Z';

Deno.test('MUTATION GUARD: a single-watch refresh is staleness-filtered, exactly like the batch', () => {
  const single = buildDueWatchPath(USER, CUTOFF, WATCH, 25);
  assert(
    single.includes(`or=(last_checked_at.is.null,last_checked_at.lt.${CUTOFF})`),
    'one-watch refresh must still respect the minimum refresh interval — this is DEF-WL-04',
  );
});

Deno.test('both shapes are scoped to the calling actor and to live, active watches', () => {
  for (const path of [buildDueWatchPath(USER, CUTOFF, WATCH, 25), buildDueWatchPath(USER, CUTOFF, null, 25)]) {
    assert(path.includes(`user_id=eq.${USER}`), 'must be actor-scoped');
    assert(path.includes('status=eq.active'), 'must exclude paused watches');
    assert(path.includes('deleted_at=is.null'), 'must exclude tombstoned watches');
  }
});

Deno.test('the single-watch shape pins the id and does not need a batch cap', () => {
  const single = buildDueWatchPath(USER, CUTOFF, WATCH, 25);
  assert(single.includes(`id=eq.${WATCH}`));
  assertEquals(single.includes('limit='), false);
});

Deno.test('the batch shape is capped and never pins an id', () => {
  const batch = buildDueWatchPath(USER, CUTOFF, null, 25);
  assert(batch.includes('limit=25'));
  assertEquals(batch.includes('&id=eq.'), false);
});

Deno.test('the two shapes differ ONLY in id-pinning versus capping', () => {
  const single = buildDueWatchPath(USER, CUTOFF, WATCH, 25);
  const batch = buildDueWatchPath(USER, CUTOFF, null, 25);
  assertEquals(
    single.replace(`&id=eq.${WATCH}`, ''),
    batch.replace('&limit=25', ''),
    'the trigger must never change which watches are eligible, only how many',
  );
});
