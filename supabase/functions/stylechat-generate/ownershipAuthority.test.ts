/**
 * INT-KPLUS-001 — canonical ownership authority.
 *
 * Only a live public.user_closet_items row belonging to the CURRENT actor may
 * produce actorRelationship 'owned'. Saved scans, inspiration uploads, shared
 * items and commerce results are represented honestly and can never be promoted
 * to owned — including through the legacy `closet_item` transport label.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveClosetItem,
  resolveEvidenceResource,
  resolveScanOwnership,
  resolveSharedRoomItem,
  type EliseResourceDataSource,
} from './eliseResourceResolvers.ts';

type Resolution = Awaited<ReturnType<typeof resolveClosetItem>>;
type VerifiedResolution = Extract<Resolution, { status: 'verified' }>;

/** Narrow to the verified arm so relationship/sourceType are readable. */
function verified(r: Resolution, label = ''): VerifiedResolution {
  assert.equal(r.status, 'verified', label || JSON.stringify(r));
  return r as VerifiedResolution;
}

const ACTOR = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ID = '33333333-3333-4333-8333-333333333333';

function source(over: Partial<EliseResourceDataSource> = {}): EliseResourceDataSource {
  return {
    fetchUserClosetItem: async () => null,
    fetchSavedScan: async () => null,
    fetchInspirationItem: async () => null,
    fetchDressingRoom: async () => null,
    fetchDressingRoomItem: async () => null,
    fetchSharedRoomAccess: async () => null,
    ...over,
  };
}

const closetRow = (over: Record<string, unknown> = {}) => ({
  id: ID,
  user_id: ACTOR,
  title: 'Navy blazer',
  category: 'outerwear',
  clothing_type: 'blazer',
  subtype: 'single-breasted',
  brand: 'Theory',
  primary_color: 'navy',
  secondary_colors: ['gold'],
  material: ['wool'],
  storage_bucket: 'style-library-images',
  storage_path: ACTOR + '/closet/' + ID + '-primary.jpg',
  deleted_at: null,
  ...over,
});

const scanRow = (over: Record<string, unknown> = {}) => ({
  id: ID,
  user_id: ACTOR,
  title: 'Scanned coat',
  storage_bucket: 'style-library-images',
  storage_path: ACTOR + '/scan.jpg',
  ...over,
});

const inspirationRow = (over: Record<string, unknown> = {}) => ({
  id: ID,
  user_id: ACTOR,
  note: 'Runway look',
  category: 'dress',
  color: 'red',
  material: 'silk',
  silhouette: 'a-line',
  ...over,
});

// ── The one path that MAY establish ownership ────────────────────────────────

test('a live user_closet_items row for the current actor IS owned', async () => {
  const r = await resolveClosetItem(
    source({ fetchUserClosetItem: async () => closetRow() }),
    ACTOR,
    ID,
  );
  const v = verified(r);
  assert.equal(v.actorRelationship, 'owned');
  assert.equal(v.sourceType, 'user_closet_item');
  assert.equal(v.trust, 'server_verified');
  // Canonical taxonomy columns must survive, not be silently dropped.
  assert.deepEqual(v.metadata?.colors, ['navy', 'gold']);
  assert.deepEqual(v.metadata?.materials, ['wool']);
  assert.equal(v.metadata?.brand, 'Theory');
});

// ── Nothing else may ─────────────────────────────────────────────────────────

test('saved_scan is scanned, NEVER owned — even via the legacy closet_item transport', async () => {
  const r = await resolveClosetItem(
    source({ fetchSavedScan: async () => scanRow() }),
    ACTOR,
    ID,
  );
  const v = verified(r);
  assert.notEqual(v.actorRelationship, 'owned');
  assert.equal(v.actorRelationship, 'scanned');
  assert.equal(v.sourceType, 'saved_scan');
});

test('inspiration_item is saved, NEVER owned — even via the legacy closet_item transport', async () => {
  const r = await resolveClosetItem(
    source({ fetchInspirationItem: async () => inspirationRow() }),
    ACTOR,
    ID,
  );
  const v = verified(r);
  assert.notEqual(v.actorRelationship, 'owned');
  assert.equal(v.actorRelationship, 'saved');
  assert.equal(v.sourceType, 'inspiration_item');
});

test('shared room items stay shared, never owned', async () => {
  const r = await resolveSharedRoomItem(
    source({
      fetchSharedRoomAccess: async () => ({ active: true, expired: false }),
      fetchDressingRoomItem: async () => ({ id: ID, dressing_room_id: OTHER, title: 'Coat' }),
    }),
    ACTOR,
    OTHER,
    ID,
  );
  const v = verified(r);
  assert.equal(v.actorRelationship, 'shared');
  assert.notEqual(v.actorRelationship, 'owned');
});

test('commerce / text_scan / upload resolve no ownership resource at all', async () => {
  for (const sourceType of ['commerce_product', 'text_scan', 'uploaded_image'] as const) {
    const r = await resolveEvidenceResource({
      data: source({ fetchUserClosetItem: async () => closetRow() }),
      actorId: ACTOR,
      sourceType,
      scanId: ID,
      itemId: ID,
      roomId: null,
      sourceId: ID,
    });
    assert.equal(r.status, 'invalid_reference', sourceType);
    assert.equal((r as { actorRelationship?: string }).actorRelationship, undefined, sourceType);
  }
});

// ── Actor / lifecycle / forgery ──────────────────────────────────────────────

test('another user closet row is unauthorized, not owned', async () => {
  const r = await resolveClosetItem(
    source({ fetchUserClosetItem: async () => closetRow({ user_id: OTHER }) }),
    ACTOR,
    ID,
  );
  assert.equal(r.status, 'unauthorized');
});

test('a soft-deleted closet row is not a live possession', async () => {
  for (const over of [
    { deleted_at: '2026-08-01T00:00:00Z' },
    { is_deleted: true },
    { status: 'deleted' },
  ]) {
    const r = await resolveClosetItem(
      source({ fetchUserClosetItem: async () => closetRow(over) }),
      ACTOR,
      ID,
    );
    assert.equal(r.status, 'not_found', JSON.stringify(over));
  }
});

test('a forged / non-UUID id never resolves', async () => {
  const forged: Array<string | null> = ['', 'not-a-uuid', 'x\' or 1=1--', '../../etc/passwd', null];
  for (const bad of forged) {
    const r = await resolveClosetItem(
      source({ fetchUserClosetItem: async () => closetRow() }),
      ACTOR,
      bad,
    );
    assert.equal(r.status, 'invalid_reference', String(bad));
  }
});

test('an id that matches nothing anywhere is not_found, not owned', async () => {
  const r = await resolveClosetItem(source(), ACTOR, ID);
  assert.equal(r.status, 'not_found');
});

// ── Transport-label spoofing ─────────────────────────────────────────────────

test('a client declaring user_closet_item over a SAVED SCAN id cannot make it owned', async () => {
  const r = await resolveEvidenceResource({
    data: source({ fetchSavedScan: async () => scanRow() }),
    actorId: ACTOR,
    sourceType: 'user_closet_item',
    scanId: null,
    itemId: ID,
    roomId: null,
    sourceId: ID,
  });
  const v = verified(r);
  assert.equal(v.actorRelationship, 'scanned');
  assert.notEqual(v.actorRelationship, 'owned');
});

test('a client declaring user_closet_item over an INSPIRATION id cannot make it owned', async () => {
  const r = await resolveEvidenceResource({
    data: source({ fetchInspirationItem: async () => inspirationRow() }),
    actorId: ACTOR,
    sourceType: 'user_closet_item',
    scanId: null,
    itemId: ID,
    roomId: null,
    sourceId: ID,
  });
  const v = verified(r);
  assert.equal(v.actorRelationship, 'saved');
  assert.notEqual(v.actorRelationship, 'owned');
});

test('the canonical Closet wins when an id somehow exists in more than one table', async () => {
  const r = await resolveClosetItem(
    source({
      fetchUserClosetItem: async () => closetRow(),
      fetchInspirationItem: async () => inspirationRow(),
      fetchSavedScan: async () => scanRow(),
    }),
    ACTOR,
    ID,
  );
  const v = verified(r);
  assert.equal(v.actorRelationship, 'owned');
  assert.equal(v.sourceType, 'user_closet_item');
});

test('FAIL CLOSED: with no canonical Closet reader wired, nothing can be owned', async () => {
  const legacyOnly: EliseResourceDataSource = {
    fetchSavedScan: async () => scanRow(),
    fetchInspirationItem: async () => null,
    fetchDressingRoom: async () => null,
    fetchDressingRoomItem: async () => null,
    fetchSharedRoomAccess: async () => null,
  };
  const r = await resolveClosetItem(legacyOnly, ACTOR, ID);
  const v = verified(r);
  assert.notEqual(v.actorRelationship, 'owned');
  assert.equal(v.actorRelationship, 'scanned');
});

test('resolveScanOwnership itself can never emit owned', async () => {
  const r = await resolveScanOwnership(
    source({ fetchSavedScan: async () => scanRow() }),
    ACTOR,
    ID,
    'recent_scan',
  );
  const v = verified(r);
  assert.equal(v.actorRelationship, 'scanned');
  assert.notEqual(v.actorRelationship, 'owned');
});
