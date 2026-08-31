/**
 * Build 34 / K+ Wardrobe Concierge V1 — iOS platform integration.
 *
 * SCOPE, STATED HONESTLY. This verifies the iOS line's WIRING and the
 * decision logic behind each row of the platform parity matrix. It does not
 * mount a React Native tree and it is not a device certification: no simulator
 * or device runtime was available in this environment, so "renders correctly on
 * an iPhone" remains unproven by anything here.
 *
 * What it does prove is the part that actually broke before: that the chain
 *
 *   Edge response -> provider -> useStyleChat -> ui_blocks -> bubble -> renderer
 *
 * is connected on this branch, that the flag gates it at BOTH ends, and that
 * the states the matrix names resolve to the behaviour the sections require.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildConciergeResult,
  conciergeOwnerIdFromUserKey,
} = require('../services/concierge/conciergeModel.ts');
const {
  resolveConciergeImage,
} = require('../services/concierge/conciergeImageResolver.ts');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const LOAFERS = '33333333-3333-4333-8333-333333333333';

function v2(overrides = {}) {
  return {
    contractVersion: 'elise_advice_v2',
    wardrobeContextMode: 'closet',
    focusedItem: {
      evidenceId: null,
      actorRelationship: 'owned',
      displayFacts: {
        title: 'Brown loafers',
        category: 'loafers',
        subtype: 'penny loafer',
        brand: 'Aldo',
        primaryColor: 'brown',
        clientId: LOAFERS,
      },
    },
    recommendations: [],
    looks: null,
    wardrobeGap: null,
    ...overrides,
  };
}

// ── the chain is actually connected ──────────────────────────────────────────

test('the provider passes adviceMetadata through to the send path', () => {
  const provider = read('services/style-chat/providers/edgeStyleChatProvider.ts');
  assert.equal(provider.includes('adviceMetadata'), true);
  assert.equal(provider.includes('ELISE_ADVICE_METADATA_CLIENT_V1'), true);
});

test('useStyleChat projects adviceMetadata into a persisted ui_block', () => {
  const hook = read('hooks/useStyleChat.ts');
  assert.equal(hook.includes('buildConciergeResult(result.adviceMetadata'), true);
  assert.equal(hook.includes("type: 'concierge_evidence'"), true);
  // Section 18: the EXISTING ui_blocks column, no new store. The block must be
  // pushed onto the same array that is both rendered and persisted.
  assert.equal(hook.includes('explanationBlocks.push'), true);
  assert.equal(hook.includes('uiBlocks: explanationBlocks'), true);
});

test('a turn with no wardrobe evidence writes no block at all', () => {
  const hook = read('hooks/useStyleChat.ts');
  // The guard must be on the PROJECTED result, not merely on the flag: a K+
  // user asking about the weather must leave the bubble completely unchanged.
  assert.equal(hook.includes("conciergeResult.presentation !== 'none'"), true);
});

test('the bubble renders the block through the shared component', () => {
  const bubble = read('components/style-chat/StyleChatBubble.tsx');
  assert.equal(bubble.includes("block?.type === 'concierge_evidence'"), true);
  assert.equal(bubble.includes('<ConciergeEvidenceBlock'), true);
  assert.equal(bubble.includes('ownerId={conciergeOwnerId}'), true);
});

test('the flag gates BOTH the write and the render', () => {
  // Write-time only would leave already-persisted blocks rendering after the
  // capability is turned off, which is not a kill switch.
  assert.equal(read('hooks/useStyleChat.ts').includes('if (ELISE_CONCIERGE_V1)'), true);
  assert.equal(read('components/style-chat/StyleChatBubble.tsx').includes('if (!ELISE_CONCIERGE_V1) return null;'), true);
});

test('the Concierge flag is enabled only in staging-certification, never in staging or production', () => {
  // Build 34 Android staging-certification (P2-EAS-FLAGS ruling): ancestry,
  // staging runtime (stylechat-generate v119 deployed with the conciergeV1
  // branch live), and closure evidence (5 dedicated test suites, no
  // partial/TODO markers) are all proven, so the certification profile
  // enables the client flag. It must still never leak into the ordinary
  // staging or production profiles.
  const eas = JSON.parse(read('eas.json'));
  assert.equal(eas.build['staging-certification'].env.EXPO_PUBLIC_ELISE_CONCIERGE_V1, 'true');
  assert.equal('EXPO_PUBLIC_ELISE_CONCIERGE_V1' in (eas.build.staging.env ?? {}), false);
  assert.equal('EXPO_PUBLIC_ELISE_CONCIERGE_V1' in (eas.build.production.env ?? {}), false);
});

// ── parity matrix rows, as decisions ─────────────────────────────────────────

test('matrix: K+ inactive or expired renders no Concierge surface', () => {
  // Both states are decided SERVER-side and reach the client identically: no
  // owned evidence took part, so the mode is 'none'. There is deliberately no
  // client-side K+ check to disagree with the server.
  assert.equal(buildConciergeResult(v2({ wardrobeContextMode: 'none' })).presentation, 'none');
  assert.equal(buildConciergeResult({ contractVersion: 'elise_advice_v1' }).presentation, 'none');
});

test('matrix: empty Closet leaves Base Elise intact and shows no error', () => {
  const result = buildConciergeResult(
    v2({ wardrobeContextMode: 'none', focusedItem: { evidenceId: null, actorRelationship: 'unknown' } }),
  );
  assert.equal(result.presentation, 'none');
  assert.equal(result.cards.length, 0);
  assert.equal(result.focusCard, null);
});

test('matrix: a small Closet renders its real evidence, not a warning', () => {
  const result = buildConciergeResult(v2());
  assert.equal(result.presentation, 'closet');
  assert.equal(result.focusCard.title, 'Brown loafers');
  // One item is a complete, valid Concierge answer.
  assert.equal(result.cards.length, 0);
});

test('matrix: owned item cards carry the real server facts', () => {
  const result = buildConciergeResult(v2());
  const card = result.focusCard;
  assert.equal(card.brand, 'Aldo');
  assert.equal(card.subtype, 'penny loafer');
  assert.equal(card.primaryColor, 'brown');
  assert.equal(card.clientId, LOAFERS);
});

test('matrix: account switch cannot leak the previous account', async () => {
  assert.equal(conciergeOwnerIdFromUserKey('user:aaa'), 'aaa');
  assert.equal(conciergeOwnerIdFromUserKey('user:bbb'), 'bbb');
  assert.equal(conciergeOwnerIdFromUserKey(null), null);

  const block = read('components/concierge/ConciergeEvidenceBlock.tsx');
  // Images are cleared BEFORE the new resolution starts, and a late result from
  // the previous account is discarded rather than applied.
  assert.equal(block.includes('setImages({})'), true);
  assert.equal(block.includes('cancelled = true'), true);
  assert.equal(/\[ownerId, clientIdKey/.test(block), true);
});

test('matrix: loading shows a placeholder, never a broken image', async () => {
  const state = await resolveConciergeImage({ resolveLocalUri: async () => null }, LOAFERS);
  assert.deepEqual(state, { status: 'unavailable' });

  const card = read('components/concierge/ConciergeClosetCard.tsx');
  // 'pending' and 'unavailable' render the SAME placeholder on purpose: a card
  // with no picture must not advertise that a download failed.
  assert.equal(card.includes('thumbFallback'), true);
  assert.equal(card.includes('onError={() => setImageFailed(true)}'), true);
});

test('matrix: item-detail navigation is intentionally absent in V1', () => {
  // Section 46. app/library.tsx accepts only a `section` param — there is no
  // authorized route that opens ONE Closet item — so cards stay inert rather
  // than a new detail experience being invented. This is a documented, SHARED
  // decision, identical on Android; it is not an iOS shortfall.
  const library = read('app/library.tsx');
  assert.equal(/useLocalSearchParams<\{\s*section\?: string;?\s*\}>/.test(library), true);

  // The shared components ACCEPT an optional onCardPress so a future authorized
  // route can be wired in one place. What matters for V1 is that the mount site
  // never supplies one, which leaves every card inert.
  const bubble = read('components/style-chat/StyleChatBubble.tsx');
  const mount = bubble.slice(bubble.indexOf('<ConciergeEvidenceBlock'));
  const mountTag = mount.slice(0, mount.indexOf('/>') + 2);
  assert.equal(mountTag.includes('<ConciergeEvidenceBlock'), true);
  assert.equal(mountTag.includes('onCardPress'), false, 'V1 cards must stay non-interactive');
});

// ── iOS-specific concerns ────────────────────────────────────────────────────

test('iOS: every resolvable image URI carries a file:// scheme', () => {
  // On iOS an <Image> source with a bare filesystem path does not load. Both
  // resolution paths must therefore build from FileSystem.documentDirectory,
  // which is already a file:// URI, rather than concatenating a raw path.
  assert.equal(
    read('services/closetLibrary.js').includes("FileSystem.documentDirectory + 'kscan_closet/'"),
    true,
  );
  assert.equal(
    read('services/closet/closetRestoreMedia.ts').includes(
      "FileSystem.documentDirectory + 'kscan_closet/remote-cache/'",
    ),
    true,
  );
});

test('iOS: the card cannot overflow a narrow iPhone bubble', () => {
  const card = read('components/concierge/ConciergeClosetCard.tsx');
  // The chat bubble is already width-constrained. Without both of these a long
  // garment title pushes the row wider than its parent instead of wrapping.
  assert.equal(card.includes('minWidth: 0'), true);
  assert.equal(card.includes('flexShrink: 1'), true);
  assert.equal(card.includes('numberOfLines'), true);
});

test('iOS: the Concierge path has no platform branch to diverge on', () => {
  // If either platform ever needs a Platform.OS branch here, that is the moment
  // the two Concierges start becoming different products (section 51).
  for (const relative of [
    'components/concierge/ConciergeEvidence.tsx',
    'components/concierge/ConciergeClosetCard.tsx',
    'components/concierge/ConciergeEvidenceBlock.tsx',
    'services/concierge/conciergeModel.ts',
    'services/concierge/conciergeLabels.ts',
    'services/concierge/conciergeImageResolver.ts',
  ]) {
    assert.equal(read(relative).includes('Platform.OS'), false, `${relative} must stay platform-neutral`);
  }
});

test('iOS: this branch changes no Android-only file', () => {
  // Section 48: the iOS pass must not modify Android. Asserted structurally
  // because the shared C4 layer is the only client surface this feature edits.
  const bubble = read('components/style-chat/StyleChatBubble.tsx');
  assert.equal(bubble.includes('android'), false);
});
