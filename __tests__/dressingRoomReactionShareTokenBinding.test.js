/**
 * B34-FE-DR-001 — the public Dressing Room reaction-count client seam.
 *
 * THE CONTRACT THIS PINS. Staging migration 20260916233708
 * (`reaction_counts_bind_anonymous_share_token`, applied to
 * yzqjvdfgefveprobvvyw and confirmed live in `supabase_migrations.schema_migrations`)
 * DROPPED `public.get_item_reaction_counts(uuid[])` and replaced it with
 *
 *     public.get_item_reaction_counts(p_item_ids uuid[], p_share_token text default null)
 *
 * whose anonymous branch is gated on the token naming a LIVE share for that
 * room. Read back from staging with `pg_get_functiondef`:
 *
 *     when caller.uid is null then
 *       normalized_token.token is not null
 *       and exists (select 1 from public.room_shares rs
 *                    where rs.room_id = dr.id
 *                      and rs.share_token = normalized_token.token
 *                      and rs.is_active = true
 *                      and rs.revoked_at is null
 *                      and (rs.expires_at is null or rs.expires_at > now()))
 *     else
 *       (live shared_room_memberships row or can_access_room_messages(dr.id))
 *       and not internal.is_dressing_room_pair_blocked(dr.user_id, caller.uid)
 *
 * THE DEFECT. The client called the RPC with item ids only. For an anonymous
 * visitor — the entire audience of app/(public)/rooms/[token].tsx — the token
 * was therefore null, the predicate false for every item, and the RPC returned
 * NO ROWS. That is not an error path: `buildReactionCountsByItem` zero-fills
 * whatever the RPC omits, so every item on every public room rendered
 * 0/0/0/0 with no error state. Reactions are the point of sharing a room.
 *
 * WHAT IS MODELLED HERE. `makeBackend()` below is a transcription of the live
 * predicate above, not an approximation of it: same token-required-when-anon
 * rule, same liveness conjuncts, same "authenticated members do not need a
 * token" else-branch. The six regression scenarios §11 requires are executed
 * against it, so a client change that stops satisfying the real contract fails
 * here rather than on a device.
 *
 * WHAT THIS MUST NEVER DO. Nothing in this file may relax the backend
 * predicate to make a client call pass. The wrong/revoked/expired-token cases
 * below exist precisely to keep the client from being "fixed" by widening the
 * server's admission rule.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const ITEM_A = '11111111-1111-4111-8111-111111111111';
const ITEM_B = '22222222-2222-4222-8222-222222222222';
const LIVE_TOKEN = 'Live-Share_Token-01';
const OTHER_ROOM_TOKEN = 'Another-Room-Token';
const REVOKED_TOKEN = 'Revoked-Share-Token';
const EXPIRED_TOKEN = 'Expired-Share-Token';

const REACTION_TYPES = ['like', 'love', 'looking', 'thumbs_down'];

/**
 * The reaction rows that exist for the room under test. The backend returns a
 * full 4-row grid per admitted item (zero-filled), so a non-empty response is
 * unambiguous evidence the caller was ADMITTED, and an empty response is
 * unambiguous evidence it was REFUSED.
 */
const STORED = {
  [ITEM_A]: { like: 3, love: 1, looking: 0, thumbs_down: 0 },
  [ITEM_B]: { like: 0, love: 0, looking: 2, thumbs_down: 1 },
};

/** Live-share table for the room that owns ITEM_A / ITEM_B. */
const SHARES = [
  { token: LIVE_TOKEN, isActive: true, revoked: false, expired: false },
  { token: REVOKED_TOKEN, isActive: true, revoked: true, expired: false },
  { token: EXPIRED_TOKEN, isActive: true, revoked: false, expired: true },
];

function tokenAdmitsRoom(token) {
  if (token === null || token === undefined) return false;
  const normalized = String(token).trim();
  if (!normalized) return false;
  const share = SHARES.find((row) => row.token === normalized);
  if (!share) return false;
  return share.isActive && !share.revoked && !share.expired;
}

/**
 * A fake Supabase client implementing the deployed predicate.
 *
 * `caller` is either { uid: null } (anonymous link visitor) or
 * { uid, liveMember, blocked } (authenticated).
 */
function makeBackend(caller) {
  const calls = [];
  return {
    calls,
    client: {
      rpc(name, params) {
        calls.push({ name, params });
        if (name !== 'get_item_reaction_counts') {
          return Promise.resolve({ data: null, error: { message: `unexpected rpc ${name}` } });
        }

        // The single-argument overload no longer exists. A client that sends a
        // parameter the deployed function does not declare is a PostgREST
        // resolution failure, not a silent success — modelled so a future
        // rename of `p_share_token` cannot pass this suite.
        const declared = new Set(['p_item_ids', 'p_share_token']);
        for (const key of Object.keys(params ?? {})) {
          if (!declared.has(key)) {
            return Promise.resolve({
              data: null,
              error: { code: 'PGRST202', message: `no function matching ${key}` },
            });
          }
        }

        const admitted = caller.uid === null
          ? tokenAdmitsRoom(params.p_share_token)
          : Boolean(caller.liveMember) && !caller.blocked;

        if (!admitted) return Promise.resolve({ data: [], error: null });

        const rows = [];
        for (const itemId of params.p_item_ids ?? []) {
          const stored = STORED[itemId];
          if (!stored) continue;
          for (const reactionType of REACTION_TYPES) {
            rows.push({ item_id: itemId, reaction_type: reactionType, count: stored[reactionType] });
          }
        }
        return Promise.resolve({ data: rows, error: null });
      },
    },
  };
}

function loadStyleObjects(supabaseClient) {
  const relativePath = 'services/styleObjects.ts';
  const { outputText } = ts.transpileModule(read(relativePath), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: relativePath,
  });

  const module = { exports: {} };
  const requireFn = (id) => {
    if (id.endsWith('/supabaseClient')) return { supabase: supabaseClient };
    if (id.endsWith('/roomMessages')) return { containsBlockedMessageContent: () => false };
    if (id.endsWith('/dressingRoomCollaboration')) {
      return {
        createCollabRequestId: () => 'req-1',
        getCollabActorGeneration: () => 1,
        isCurrentCollabGeneration: () => true,
        setItemReactionDesiredState: async () => {},
        bumpCollabActorGeneration: () => {},
      };
    }
    if (id.endsWith('/dressingRoomItemContract')) {
      return {
        buildCanonicalSnapshotExtension: () => ({}),
        isLocalImageUri: () => false,
        isRemoteImageUrl: () => false,
        readSnapshotDedupeKey: () => null,
        resolveDressingRoomImageSource: () => ({ kind: 'none' }),
      };
    }
    if (id.endsWith('/roomShareState')) return { evaluateRoomShareRow: () => null };
    if (id.startsWith('expo-file-system')) return {};
    if (id === 'expo-image-manipulator') return { manipulateAsync: async () => ({}), SaveFormat: {} };
    if (id.includes('featureFlags')) {
      return {
        DRESSING_ROOM_CANONICAL_ITEM_V1: false,
        DRESSING_ROOM_COLLABORATION_V1: false,
        DRESSING_ROOM_COMMERCE_PRESERVATION_V1: false,
        DRESSING_ROOM_DEDUPE_V1: false,
        DRESSING_ROOM_REACTIONS_V1: false,
      };
    }
    return require(id);
  };

  // eslint-disable-next-line no-new-func
  Function('exports', 'require', 'module', '__filename', '__dirname', outputText)(
    module.exports,
    requireFn,
    module,
    path.join(ROOT, relativePath),
    path.dirname(path.join(ROOT, relativePath)),
  );
  return module.exports;
}

function countsFor(rows, itemId) {
  const out = {};
  for (const row of rows) {
    if (row.item_id !== itemId) continue;
    out[row.reaction_type] = row.count;
  }
  return out;
}

// ─── The six regression scenarios §11 requires ────────────────────────────────

test('anonymous visitor presenting a valid live share token reads real counts', async () => {
  const backend = makeBackend({ uid: null });
  const { getItemReactionCounts } = loadStyleObjects(backend.client);

  const rows = await getItemReactionCounts([ITEM_A, ITEM_B], { shareToken: LIVE_TOKEN });

  assert.deepEqual(countsFor(rows, ITEM_A), STORED[ITEM_A]);
  assert.deepEqual(countsFor(rows, ITEM_B), STORED[ITEM_B]);
  assert.equal(backend.calls[0].params.p_share_token, LIVE_TOKEN);
});

test('anonymous visitor presenting a token for a different room reads nothing', async () => {
  const backend = makeBackend({ uid: null });
  const { getItemReactionCounts } = loadStyleObjects(backend.client);

  const rows = await getItemReactionCounts([ITEM_A], { shareToken: OTHER_ROOM_TOKEN });

  assert.deepEqual(rows, []);
  assert.equal(backend.calls[0].params.p_share_token, OTHER_ROOM_TOKEN);
});

test('anonymous visitor presenting a revoked token reads nothing', async () => {
  const backend = makeBackend({ uid: null });
  const { getItemReactionCounts } = loadStyleObjects(backend.client);

  assert.deepEqual(await getItemReactionCounts([ITEM_A], { shareToken: REVOKED_TOKEN }), []);
});

test('anonymous visitor presenting an expired/inactive token reads nothing', async () => {
  const backend = makeBackend({ uid: null });
  const { getItemReactionCounts } = loadStyleObjects(backend.client);

  assert.deepEqual(await getItemReactionCounts([ITEM_A], { shareToken: EXPIRED_TOKEN }), []);
});

test('authenticated owner/member path still reads counts WITHOUT a share token', async () => {
  const backend = makeBackend({ uid: 'user-a', liveMember: true, blocked: false });
  const { getItemReactionCounts } = loadStyleObjects(backend.client);

  const rows = await getItemReactionCounts([ITEM_A]);

  assert.deepEqual(countsFor(rows, ITEM_A), STORED[ITEM_A]);
  // The parameter is OMITTED rather than sent as null, so the in-room
  // authenticated call shape is byte-identical to what it was before this
  // repair — the repair is scoped to the caller class the contract moved under.
  assert.ok(!('p_share_token' in backend.calls[0].params));
});

test('a removed or blocked authenticated member reads nothing even mid-session', async () => {
  const removed = makeBackend({ uid: 'user-b', liveMember: false, blocked: false });
  assert.deepEqual(await loadStyleObjects(removed.client).getItemReactionCounts([ITEM_A]), []);

  const blocked = makeBackend({ uid: 'user-c', liveMember: true, blocked: true });
  assert.deepEqual(await loadStyleObjects(blocked.client).getItemReactionCounts([ITEM_A]), []);
});

// ─── The regression itself ────────────────────────────────────────────────────

test('REGRESSION: an anonymous call with no token reads nothing — this is the B34-FE-DR-001 defect', async () => {
  const backend = makeBackend({ uid: null });
  const { getItemReactionCounts } = loadStyleObjects(backend.client);

  // Reproduces the pre-repair client exactly: item ids, no token.
  assert.deepEqual(await getItemReactionCounts([ITEM_A, ITEM_B]), []);

  // ...and the repaired call on the same backend succeeds, which is what makes
  // the empty result above a client defect rather than a backend one.
  const repaired = await getItemReactionCounts([ITEM_A, ITEM_B], { shareToken: LIVE_TOKEN });
  assert.deepEqual(countsFor(repaired, ITEM_A), STORED[ITEM_A]);
});

// ─── Token handling ───────────────────────────────────────────────────────────

test('the share token is trimmed but never case-folded', async () => {
  const backend = makeBackend({ uid: null });
  const { getItemReactionCounts } = loadStyleObjects(backend.client);

  await getItemReactionCounts([ITEM_A], { shareToken: `  ${LIVE_TOKEN}  ` });

  // `room_shares.share_token` is compared with `=`, so a lower-cased token
  // silently stops matching. services/sharedRoomMemberships.ts follows the
  // same rule and __tests__/sharedRoomMembershipRoute.test.js enforces it.
  assert.equal(backend.calls[0].params.p_share_token, LIVE_TOKEN);
});

test('an empty, whitespace-only or null token is omitted rather than sent', async () => {
  for (const shareToken of ['', '   ', null, undefined]) {
    const backend = makeBackend({ uid: null });
    const { getItemReactionCounts } = loadStyleObjects(backend.client);
    await getItemReactionCounts([ITEM_A], { shareToken });
    assert.ok(
      !('p_share_token' in backend.calls[0].params),
      `expected p_share_token to be omitted for ${JSON.stringify(shareToken)}`,
    );
  }
});

test('every batch of a chunked read carries the same share token', async () => {
  const backend = makeBackend({ uid: null });
  const { getItemReactionCounts } = loadStyleObjects(backend.client);

  // REACTION_BATCH_SIZE is 100; 150 distinct ids must produce 2 RPCs.
  const many = Array.from({ length: 150 }, (_, index) => `item-${index}`);
  await getItemReactionCounts(many, { shareToken: LIVE_TOKEN });

  assert.equal(backend.calls.length, 2);
  for (const call of backend.calls) {
    assert.equal(call.params.p_share_token, LIVE_TOKEN);
  }
});

// ─── Call-site binding ────────────────────────────────────────────────────────

test('the public room screen binds the route share token at BOTH reaction call sites', () => {
  const screen = read('app/(public)/rooms/[token].tsx');

  const callSites = screen.match(/getItemReactionCounts\(/g) ?? [];
  assert.equal(callSites.length, 2, 'expected exactly two reaction-count call sites');

  // Initial load uses the normalized route token; the refresh path uses the
  // ref so it cannot close over a stale token after a route change.
  assert.match(
    screen,
    /getItemReactionCounts\(itemIds, \{\s*shareToken: normalizedRouteToken,\s*\}\)/,
  );
  assert.match(
    screen,
    /getItemReactionCounts\(normalizedItemIds, \{\s*shareToken: routeTokenRef\.current,\s*\}\)/,
  );

  // The effect must re-run when the token changes, or a room-to-room
  // navigation reuses the previous room's token.
  assert.match(screen, /\[capabilities\.canReact, joinedRoomId, normalizedRouteToken, state\]/);
});

test('the authenticated in-room screen deliberately sends no share token', () => {
  const screen = read('app/dressing-rooms/[id].tsx');
  // Bare single-argument calls: this screen's caller is always an
  // authenticated owner/member, which the deployed predicate admits through
  // shared_room_memberships / can_access_room_messages() without a token.
  assert.match(screen, /getItemReactionCounts\(reactionItemIds\)/);
  assert.match(screen, /getItemReactionCounts\(normalizedItemIds\)/);
  // The screen manages room SHARES elsewhere, so the assertion is scoped to
  // the reaction call sites rather than the whole file.
  assert.doesNotMatch(screen, /getItemReactionCounts\([^)]*shareToken/);
});

test('the service forwards p_share_token and nothing else new', () => {
  const service = read('services/styleObjects.ts');
  assert.match(service, /p_share_token: shareToken/);
  assert.match(service, /options\?: \{ shareToken\?: string \| null \}/);
  // Guard against the token being lower-cased on its way to the RPC.
  assert.doesNotMatch(service, /shareToken[^\n]*toLowerCase/);
});
