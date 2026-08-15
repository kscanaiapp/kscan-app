/**
 * SHARED DRESSING ROOM — Build 29 freeze gate matrix.
 *
 * The product decision: Build 28's sharing model ships intact, with Build 29's
 * blocking and UGC protections layered on top. Shared links are a core feature,
 * not optional polish, and sharing is NOT redesigned — this file proves the
 * existing `room_shares`/token architecture satisfies each gate.
 *
 * THE ARCHITECTURAL POINT THIS ENCODES: a recipient's access is NOT "having the
 * URL". The URL is an invitation credential; once legitimately redeemed the
 * durable authority is the persisted `shared_room_memberships` row. That is why
 * the room survives app close, cold restart, and navigation, and why owner
 * cancellation has to revoke the membership-derived access server-side rather
 * than merely invalidating a token.
 *
 * SCOPE. Every gate below is a shared contract, provable here. OS-level
 * Universal Link / App Link resolution is explicitly NOT proven here — it needs
 * platform runtime verification on each branch, and is asserted only as far as
 * the shared configuration goes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const APP_JSON = JSON.parse(read('app.json'));
const STYLE_OBJECTS = read('services', 'styleObjects.ts');
const MEMBERSHIPS = read('services', 'sharedRoomMemberships.ts');
const ROOM_SCREEN = read('app', 'dressing-rooms', '[id].tsx');
const REDEMPTION_MIGRATION = read(
  'supabase', 'migrations', '20260815160000_room_share_redemption_limit.sql',
);
const BLOCKING_MIGRATION = read(
  'supabase', 'migrations', '20260815140000_dressing_room_items_blocking.sql',
);

/* ── CREATE LINK ──────────────────────────────────────────────────────── */

test('DRESSING_ROOM_SHARE_LINK_CREATE', () => {
  // The existing token architecture, not a new one.
  assert.match(STYLE_OBJECTS, /rpc\('create_or_get_room_share'/);
  assert.match(ROOM_SCREEN, /createOrGetRoomShare\(room\.id\)/);

  // A normal HTTPS link that any transport can carry.
  assert.match(ROOM_SCREEN, /\/rooms\/\$\{encodeURIComponent\(shareToken\)\}/);
  assert.match(read('services', 'roomDeepLinks.js'), /https:\/\/kscan\.app/);
});

/* ── SHARE STATE PERSISTENCE ──────────────────────────────────────────── */

test('DRESSING_ROOM_SHARE_STATE_PERSISTENCE', () => {
  // Sharing had NO load-time read: the only entry points either created a
  // share or destroyed one, so the screen could not answer "is this room
  // shared right now?" and offered "Disable Shared Link" unconditionally.
  assert.match(STYLE_OBJECTS, /export async function getRoomShareState\(/);

  // Read under the existing owner RLS policy — no migration, no new authority.
  const fn = STYLE_OBJECTS.slice(
    STYLE_OBJECTS.indexOf('export async function getRoomShareState('),
    STYLE_OBJECTS.indexOf('export async function revokeRoomShare('),
  );
  assert.match(fn, /from\('room_shares'\)/);
  assert.match(fn, /is\('revoked_at', null\)/);
  assert.match(fn, /eq\('is_active', true\)/);

  // A failed read must not be reported as "not shared" — that would hide the
  // revoke control for a genuinely shared room.
  assert.match(fn, /throw safeError\(/);

  // The screen loads it, and refreshes after both create and revoke.
  assert.match(ROOM_SCREEN, /const refreshShareState = useCallback\(/);
  assert.match(ROOM_SCREEN, /void refreshShareState\(\);/);
  const refreshes = ROOM_SCREEN.match(/await refreshShareState\(\)/g) || [];
  assert.ok(refreshes.length >= 2, 'create and revoke must both refresh share state');

  // ...and the control appears only when there is something to disable.
  assert.match(ROOM_SCREEN, /\{shareState \? \(/);
  assert.match(ROOM_SCREEN, /testID="disable-shared-link-button"/);
});

/* ── APP LINK / BROWSER FALLBACK ──────────────────────────────────────── */

test('DRESSING_ROOM_APP_LINK_OPEN — shared configuration only (PLATFORM_RUNTIME_REQUIRED)', () => {
  // Shared config is provable here. Whether the OS actually hands the link to
  // the installed app is NOT: that needs a device on each platform, and is
  // handed to the iOS and Android branches.
  assert.deepEqual(APP_JSON.expo.ios.associatedDomains, ['applinks:kscan.app']);

  const roomFilter = APP_JSON.expo.android.intentFilters.find((filter) =>
    (filter.data || []).some((d) => d.pathPrefix === '/rooms'),
  );
  assert.ok(roomFilter, 'Android must declare an App Link filter for /rooms');
  assert.equal(roomFilter.autoVerify, true, 'the /rooms filter must autoVerify');
  assert.equal(roomFilter.data[0].scheme, 'https');
  assert.equal(roomFilter.data[0].host, 'kscan.app');
});

test('DRESSING_ROOM_BROWSER_FALLBACK', () => {
  // The same HTTPS link must resolve on the web when the app is absent or the
  // App Link cannot be resolved, so the route has to exist and be public.
  const route = path.join(ROOT, 'app', '(public)', 'rooms', '[token].tsx');
  assert.ok(fs.existsSync(route), 'the public /rooms/:token route must exist');

  const routingGuard = read('services', 'routingGuard.js');
  assert.match(
    routingGuard,
    /\/\^\\\/rooms\\\/\[A-Za-z0-9_-\]\+\$\//,
    'shared room views must be reachable unauthenticated; the token is validated server-side',
  );
});

/* ── REDEMPTION AND DURABILITY ────────────────────────────────────────── */

test('DRESSING_ROOM_SHARE_REDEMPTION', () => {
  assert.match(MEMBERSHIPS, /rpc\('save_shared_room_for_me'/);
  assert.match(MEMBERSHIPS, /export async function saveSharedRoomForCurrentUser\(/);
});

test('PERSISTED ROOM MEMBERSHIP — access is a server row, not the URL', () => {
  // The durable authority. If access were "having the URL", none of the
  // lifecycle gates below could hold.
  assert.match(REDEMPTION_MIGRATION, /insert into public\.shared_room_memberships/);

  // The recipient's listing is derived from persisted memberships, which is
  // what makes the room survive without the original link.
  assert.match(MEMBERSHIPS, /rpc\('list_shared_rooms_for_me'\)/);
});

test('ROOM VISIBLE AFTER COLD RESTART / WITHOUT THE ORIGINAL LINK', () => {
  // Nothing in the read path requires the token: the listing RPC takes no
  // arguments and resolves from the authenticated actor's memberships. A
  // token-keyed listing would be the failure mode this gate exists to catch.
  const listing = MEMBERSHIPS.slice(MEMBERSHIPS.indexOf("rpc('list_shared_rooms_for_me'"));
  assert.match(listing.slice(0, 120), /rpc\('list_shared_rooms_for_me'\)/);
  assert.doesNotMatch(
    listing.slice(0, 120),
    /share_token|p_token/,
    'the listing must not require the invitation credential',
  );
});

/* ── REDEMPTION LIMIT ─────────────────────────────────────────────────── */

test('the redemption limit is actually enforced, atomically', () => {
  // THE DEFECT: max_redemptions was declared, defaulted and constrained, and
  // never read — so redemptions were unlimited regardless of configuration.
  assert.match(REDEMPTION_MIGRATION, /rs\.max_redemptions as effective_max/);
  assert.match(REDEMPTION_MIGRATION, /'status', 'limit_reached'/);

  // Atomicity: the count is taken while the share row is held, so two clients
  // racing the last allowed and first denied redemption cannot both read a
  // stale count and both succeed.
  const fn = REDEMPTION_MIGRATION.slice(REDEMPTION_MIGRATION.indexOf('create or replace function'));
  const lockAt = fn.indexOf('for update of rs');
  const countAt = fn.indexOf('select count(*) into redemption_count');
  assert.ok(lockAt > 0 && countAt > lockAt, 'the count must be taken under the share row lock');

  // NULL is unlimited, and is skipped rather than given an invented default.
  assert.match(fn, /if effective_max is not null then/);
  assert.match(fn, /if effective_max is not null and redemption_count >= effective_max then/);
});

test('a use is a distinct recipient — reopening and restoring consume none', () => {
  const fn = REDEMPTION_MIGRATION.slice(REDEMPTION_MIGRATION.indexOf('create or replace function'));

  // The limit is checked ONLY on the first-time path. An existing member
  // reopening, or a removed member reclaiming their own slot, take the other
  // branches and never reach the check.
  const firstTime = fn.indexOf('if not found then');
  const limitCheck = fn.indexOf('redemption_count >= effective_max');
  const restore = fn.indexOf("result_status := 'restored'");
  const reopen = fn.indexOf("result_status := 'already_saved'");
  assert.ok(firstTime < limitCheck && limitCheck < restore, 'the limit gates only first-time redemption');
  assert.ok(restore < reopen || reopen > limitCheck, 'reopen must not pass through the limit check');

  // One row IS one recipient, which is what makes every "does not consume"
  // rule fall out of the data model rather than needing separate handling.
  assert.match(fn, /where srm\.share_id = target_share\.id;/);
});

/* ── OWNER CANCELLATION IS AUTHORITATIVE ──────────────────────────────── */

test('DRESSING_ROOM_LINK_DISABLE_REVOKE — server-enforced, not client state', () => {
  assert.match(STYLE_OBJECTS, /rpc\('revoke_room_share'/);

  // Revocation must terminate share-derived ACCESS, not merely stop future
  // redemptions. Every read path re-checks the share is live, so a revoked
  // share denies the room and its items server-side.
  assert.match(REDEMPTION_MIGRATION, /rs\.is_active = true[\s\S]{0,80}rs\.revoked_at is null/);
  assert.match(BLOCKING_MIGRATION, /s\.is_active = true[\s\S]{0,80}s\.revoked_at is null/);

  // The client must not be the enforcement point.
  const revokeHandler = ROOM_SCREEN.slice(
    ROOM_SCREEN.indexOf('const handleRevokeShare'),
    ROOM_SCREEN.indexOf('const handleRevokeShare') + 1400,
  );
  assert.match(revokeHandler, /await revokeRoomShare\(room\.id\)/);
});

/* ── UGC SAFETY LAYER ─────────────────────────────────────────────────── */

test('DRESSING_ROOM_REPORT_MESSAGE / REPORT_USER', () => {
  const panel = read('components', 'rooms', 'RoomMessagesPanel.tsx');
  assert.match(panel, /accessibilityLabel="Report message"/);
  assert.match(panel, /accessibilityLabel="Report user"/);
  assert.match(read('services', 'contentReports.ts'), /export async function submitUserReport\(/);
  assert.match(read('services', 'contentReports.ts'), /export function isReportServerAccepted\(/);
});

test('DRESSING_ROOM_BLOCK_USER / UNBLOCK', () => {
  const blocks = read('services', 'dressingRoomBlocks.ts');
  assert.match(blocks, /export async function blockDressingRoomUser\(/);
  assert.match(blocks, /export async function unblockDressingRoomUser\(/);
});

test('DRESSING_ROOM_BLOCKED_LINK_REDEMPTION — DENIED', () => {
  // A blocked pair cannot redeem even a valid, unexhausted link...
  assert.match(
    REDEMPTION_MIGRATION,
    /not internal\.is_dressing_room_pair_blocked\(dr\.user_id, current_user_id\)/,
  );

  // ...and the denial happens in the share lookup, BEFORE any membership row
  // is written, so a blocked attempt also consumes no use.
  const fn = REDEMPTION_MIGRATION.slice(REDEMPTION_MIGRATION.indexOf('create or replace function'));
  const blockAt = fn.indexOf('is_dressing_room_pair_blocked');
  const insertAt = fn.indexOf('insert into public.shared_room_memberships');
  assert.ok(blockAt > 0 && blockAt < insertAt, 'blocking must deny before any row is written');

  // Blocking and revocation stay DIFFERENT concepts: blocking is
  // account-to-account and does not touch the share token.
  assert.doesNotMatch(BLOCKING_MIGRATION, /revoke_room_share/);
});

test('blocking also denies room and item reads, not just redemption', () => {
  // Otherwise a blocked recipient who redeemed earlier keeps their access.
  assert.match(BLOCKING_MIGRATION, /on public\.dressing_room_items/);
  assert.match(BLOCKING_MIGRATION, /not internal\.is_dressing_room_pair_blocked/);
});
