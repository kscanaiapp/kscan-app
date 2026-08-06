/**
 * BUG-12 regression: "Disable Shared Link" must only be offered when an
 * active shared link actually exists — never for a room that has never
 * been shared, and never while status is still unknown (loading/error).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  evaluateRoomShareRow,
  shouldOfferDisableSharedLink,
} = require('../services/roomShareState.ts');

const ROOT = path.resolve(__dirname, '..');
const NOW = new Date('2026-08-01T00:00:00.000Z').getTime();

// -- evaluateRoomShareRow -----------------------------------------------

test('no row at all (room never shared) is inactive', () => {
  const status = evaluateRoomShareRow(null, NOW);
  assert.equal(status.active, false);
  assert.equal(status.shareToken, null);
});

test('an active, non-revoked, non-expired row is active', () => {
  const status = evaluateRoomShareRow({
    is_active: true,
    revoked_at: null,
    expires_at: null,
    share_token: 'tok-1',
  }, NOW);
  assert.equal(status.active, true);
  assert.equal(status.shareToken, 'tok-1');
});

test('a revoked row is inactive even if is_active was left true', () => {
  const status = evaluateRoomShareRow({
    is_active: true,
    revoked_at: '2026-07-01T00:00:00.000Z',
    expires_at: null,
    share_token: 'tok-1',
  }, NOW);
  assert.equal(status.active, false);
  assert.equal(status.shareToken, null);
});

test('is_active: false is inactive regardless of other fields', () => {
  const status = evaluateRoomShareRow({
    is_active: false,
    revoked_at: null,
    expires_at: null,
    share_token: 'tok-1',
  }, NOW);
  assert.equal(status.active, false);
});

test('an expired row is inactive', () => {
  const status = evaluateRoomShareRow({
    is_active: true,
    revoked_at: null,
    expires_at: '2026-07-31T00:00:00.000Z', // before NOW
    share_token: 'tok-1',
  }, NOW);
  assert.equal(status.active, false);
});

test('a not-yet-expired row (expires_at in the future) is active', () => {
  const status = evaluateRoomShareRow({
    is_active: true,
    revoked_at: null,
    expires_at: '2026-12-31T00:00:00.000Z',
    share_token: 'tok-1',
  }, NOW);
  assert.equal(status.active, true);
});

// -- shouldOfferDisableSharedLink -----------------------------------------

test('destructive control is offered only for a confirmed active link', () => {
  assert.equal(shouldOfferDisableSharedLink(true), true);
});

test('destructive control is never offered for a room that has never been shared', () => {
  assert.equal(shouldOfferDisableSharedLink(false), false);
});

test('destructive control is never offered while status is unknown (loading or failed fetch)', () => {
  assert.equal(shouldOfferDisableSharedLink(null), false);
});

// -- Wiring: the room detail screen must actually use this gate --------------

test('room detail screen gates Disable Shared Link on confirmed active share, not on ownership alone', () => {
  const screen = fs.readFileSync(path.join(ROOT, 'app/dressing-rooms/[id].tsx'), 'utf8');
  assert.match(screen, /shouldOfferDisableSharedLink\(hasActiveShare\)/,
    'Disable Shared Link must be gated by real share-link state, not just canShareRoom');
  assert.match(screen, /getRoomShareStatus\(roomId\)/,
    'the screen must fetch authoritative share status on load');
  // hasActiveShare must default to unknown (null), not a boolean guess.
  assert.match(screen, /useState<boolean \| null>\(null\)/);
});

test('handleShareRoom marks the link active on success; handleRevokeShare marks it inactive', () => {
  const screen = fs.readFileSync(path.join(ROOT, 'app/dressing-rooms/[id].tsx'), 'utf8');
  const shareBlock = screen.match(/const handleShareRoom = async \(\) => \{[\s\S]*?\n  \};/)[0];
  assert.match(shareBlock, /setHasActiveShare\(true\)/);
  const revokeBlock = screen.match(/const handleRevokeShare = \(\) => \{[\s\S]*?\n  \};/)[0];
  assert.match(revokeBlock, /setHasActiveShare\(false\)/);
});
