const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(
    output,
    {
      __DEV__: false,
      console,
      URL,
      URLSearchParams,
      Intl,
      exports: module.exports,
      module,
      require: (id) => {
        if (id in requireMap) return requireMap[id];
        if (id.startsWith('node:')) return require(id);
        throw new Error(`Unexpected require: ${id}`);
      },
    },
    { filename },
  );
  return module.exports;
}

const commerce = loadTsModule('services/dressingRoomCommerce.ts', {
  '../types/canonicalDressingRoomItem': {},
});
const card = loadTsModule('services/dressingRoomCommerceCard.ts', {
  './dressingRoomCommerce': commerce,
  '../types/canonicalDressingRoomItem': {},
  '../types/styleObjects': {},
});
const optimism = loadTsModule('services/dressingRoomReactionOptimism.ts');

function item(overrides = {}) {
  return {
    id: 'item-1',
    dressingRoomId: 'room-1',
    snapshotVersion: 1,
    snapshotPayload: {},
    sortOrder: 0,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Rich commerce card — the shared product must keep its own identity.
// ═══════════════════════════════════════════════════════════════════════════

test('commerce card reads price, brand and link from the item own row', () => {
  const resolved = card.resolveRoomCommerceCard(
    item({
      brand: 'Totême',
      priceAmount: '248',
      currency: 'USD',
      productUrl: 'https://www.net-a-porter.com/en-gb/shop/product/12345',
    }),
  );

  assert.equal(resolved.hasCommerce, true);
  assert.equal(resolved.priceLabel, '$248.00');
  assert.equal(resolved.brand, 'Totême');
  assert.equal(resolved.productUrl, 'https://www.net-a-porter.com/en-gb/shop/product/12345');
  // The host is shown beside the link so a friendly label can never stand over
  // an unrelated destination.
  assert.equal(resolved.productUrlHost, 'net-a-porter.com');
});

test('commerce card keeps the currency it was given', () => {
  assert.equal(
    card.resolveRoomCommerceCard(item({ priceAmount: '120', currency: 'GBP' })).priceLabel,
    '£120.00',
  );
  assert.equal(
    card.resolveRoomCommerceCard(item({ priceAmount: '120', currency: 'EUR' })).priceLabel,
    '€120.00',
  );
});

test('commerce card falls back to this item own snapshot purchase option', () => {
  const resolved = card.resolveRoomCommerceCard(
    item({
      snapshotPayload: {
        purchaseOptions: [
          {
            title: 'Wool Coat',
            retailer: 'Nordstrom',
            price: '395',
            currency: 'USD',
            productUrl: 'https://shop.nordstrom.com/s/wool-coat/999',
          },
        ],
      },
    }),
  );

  assert.equal(resolved.priceLabel, '$395.00');
  assert.equal(resolved.retailer, 'Nordstrom');
  assert.equal(resolved.productUrl, 'https://shop.nordstrom.com/s/wool-coat/999');
});

test('commerce card prefers the row own persisted price over a snapshot option', () => {
  // Product identity: the row records what was actually shared. A later
  // purchase option must not silently re-price the shared item.
  const resolved = card.resolveRoomCommerceCard(
    item({
      priceAmount: '248',
      currency: 'USD',
      snapshotPayload: {
        purchaseOptions: [{ retailer: 'Somewhere Else', price: '99', currency: 'USD', productUrl: 'https://example.com/x' }],
      },
    }),
  );
  assert.equal(resolved.priceLabel, '$248.00');
});

test('commerce card never surfaces an unsafe or credentialed link', () => {
  for (const unsafe of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'http://insecure.example.com/p',
    'https://user:pass@example.com/p',
    'https://example.com/p?access_token=abc123',
  ]) {
    const resolved = card.resolveRoomCommerceCard(item({ productUrl: unsafe }));
    assert.equal(resolved.productUrl, null, `${unsafe} must not become a tappable link`);
    assert.equal(resolved.productUrlHost, null);
  }
});

test('commerce card does not claim a retailer that is only the brand again', () => {
  const resolved = card.resolveRoomCommerceCard(
    item({
      brand: 'Ganni',
      snapshotPayload: { purchaseOptions: [{ retailer: 'Ganni', price: '210', currency: 'USD', title: 'Blazer' }] },
    }),
  );
  assert.equal(resolved.brand, 'Ganni');
  assert.equal(resolved.retailer, null, 'a retailer identical to the brand asserts no storefront');
});

test('commerce card is inert for an item with no commerce facts', () => {
  const resolved = card.resolveRoomCommerceCard(item({ title: 'A scan' }));
  assert.equal(resolved.hasCommerce, false);
  assert.equal(resolved.priceLabel, null);
  assert.equal(resolved.productUrl, null);
  assert.equal(card.resolveRoomCommerceCard(null).hasCommerce, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// Optimistic reactions — instant, and truthfully reversible.
// ═══════════════════════════════════════════════════════════════════════════

test('optimistic reaction adds the tapped type when none was set', () => {
  const result = optimism.applyOptimisticReaction({
    current: null,
    tapped: 'love',
    counts: { love: 2, like: 1, looking: 0, thumbs_down: 0 },
  });
  assert.equal(result.active, true);
  assert.equal(result.nextSelection, 'love');
  assert.equal(result.nextCounts.love, 3);
  assert.equal(result.nextCounts.like, 1);
});

test('optimistic reaction clears when the same type is tapped again', () => {
  const result = optimism.applyOptimisticReaction({
    current: 'love',
    tapped: 'love',
    counts: { love: 3, like: 1, looking: 0, thumbs_down: 0 },
  });
  assert.equal(result.active, false);
  assert.equal(result.nextSelection, null);
  assert.equal(result.nextCounts.love, 2);
});

test('optimistic reaction moves the count when a different type is tapped', () => {
  // One actor holds at most one reaction per item, matching the
  // (item_id, user_id) unique index. The local arithmetic mirrors that rule.
  const result = optimism.applyOptimisticReaction({
    current: 'like',
    tapped: 'love',
    counts: { love: 1, like: 4, looking: 0, thumbs_down: 0 },
  });
  assert.equal(result.active, true);
  assert.equal(result.nextSelection, 'love');
  assert.equal(result.nextCounts.love, 2);
  assert.equal(result.nextCounts.like, 3);
});

test('optimistic reaction never renders a negative count', () => {
  const result = optimism.applyOptimisticReaction({
    current: 'love',
    tapped: 'love',
    counts: { love: 0, like: 0, looking: 0, thumbs_down: 0 },
  });
  assert.equal(result.nextCounts.love, 0);
});

test('optimistic reaction does not mutate the counts it was given', () => {
  const counts = { love: 1, like: 0, looking: 0, thumbs_down: 0 };
  const result = optimism.applyOptimisticReaction({ current: null, tapped: 'love', counts });
  // The caller keeps `counts` as its rollback snapshot; mutating it in place
  // would destroy the value the rollback depends on.
  assert.equal(counts.love, 1);
  assert.equal(result.nextCounts.love, 2);
});

// ═══════════════════════════════════════════════════════════════════════════
// Wiring: optimistic UI must roll back truthfully, and never cross rooms.
// ═══════════════════════════════════════════════════════════════════════════

test('an optimistic message is bound to the room and actor generation it started in', () => {
  const panel = read('components/rooms/RoomMessagesPanel.tsx');
  assert.match(panel, /const stillThisSend = \(\) =>/);
  assert.match(
    panel,
    /isCurrentCollabGeneration\(sendGeneration\) &&\s*activeRoomIdRef\.current === sendRoomId/,
    'a room switch or an account switch must discard the optimistic row, not move it',
  );
});

test('a rejected send removes the optimistic row and hands the draft back', () => {
  const panel = read('components/rooms/RoomMessagesPanel.tsx');
  assert.match(panel, /const rollbackOptimistic = \(\) => \{/);
  // Recoverable failure: row withdrawn, text returned so a retry reuses the
  // same idempotency key.
  assert.match(panel, /rollbackOptimistic\(\);\s*setDraft\(previousDraft\);\s*setSendError\(message\);/);
  // Lost membership: the transcript is cleared wholesale, and the draft is NOT
  // restored, because there is nowhere left to send it.
  assert.match(panel, /message === ROOM_MESSAGES_ACCESS_ERROR\) \{[\s\S]{0,320}?applyAccessRevoked\(\);/);
});

test('a pending message is never presented as delivered or actionable', () => {
  const panel = read('components/rooms/RoomMessagesPanel.tsx');
  // No server time yet, so no timestamp is shown.
  assert.match(panel, /pending \? \(\s*<Text style=\{styles\.messagePending\}>Sending…<\/Text>/);
  // No server row yet, so Reply / Report / Block have nothing to act on.
  assert.match(panel, /replyEnabled && !isReply && !pending && onReply/);
  assert.match(panel, /\{!message\.isMine && !pending \? \(/);
});

test('a rejected reaction restores the exact prior selection and counts', () => {
  for (const screen of ['app/dressing-rooms/[id].tsx', 'app/(public)/rooms/[token].tsx']) {
    const source = read(screen);
    assert.match(source, /const previousSelection = currentReaction;/, screen);
    assert.match(source, /const previousCounts = reactionCounts\[itemId\] \?\? createEmptyReactionCounts\(\);/, screen);
    assert.match(
      source,
      /setSelectedReactions\(\(current\) => \(\{ \.\.\.current, \[itemId\]: previousSelection \}\)\);\s*setReactionCounts\(\(current\) => \(\{ \.\.\.current, \[itemId\]: previousCounts \}\)\);/,
      `${screen} must restore both halves of the snapshot`,
    );
    // And it must not roll back into a room or an account that has moved on.
    assert.match(source, /const stillThisRoomAndActor = \(\) =>/, screen);
  }
});

test('the access-revoked screen shows nothing from the room behind it', () => {
  const screen = read('app/dressing-rooms/[id].tsx');
  assert.match(screen, /testID="dressing-room-access-revoked"/);
  // Every painter of room content is flushed before the state renders.
  for (const flush of [
    'setRoom\\(null\\)',
    'setItems\\(\\[\\]\\)',
    'setInspirations\\(\\[\\]\\)',
    'setReactionCounts\\(\\{\\}\\)',
    'setSelectedReactions\\(\\{\\}\\)',
    'setSelectedItem\\(null\\)',
  ]) {
    assert.match(screen, new RegExp(flush), `access loss must flush: ${flush}`);
  }
  // The stale room title must not survive into the header either.
  assert.match(screen, /title=\{accessLost \? 'Dressing Room' : room\?\.title \|\| 'Untitled Room'\}/);
  // No Retry on an authorization loss - it could only fail again.
  assert.match(screen, /title="Return to Rooms"/);
});

test('access loss is distinguished from a transient failure by the server, not by copy', () => {
  const screen = read('app/dressing-rooms/[id].tsx');
  assert.match(screen, /const access = await resolveCollaborationAccess\(roomId\);/);
  assert.match(
    screen,
    /access\.reason === 'unauthorized' \|\| access\.reason === 'not_found'/,
    'only the server decides that access was lost',
  );
  // A failure to classify leaves the ordinary retryable error in place.
  assert.match(screen, /\} catch \{\s*lostAccess = false;\s*\}/);
});
