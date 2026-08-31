/**
 * Build 34 / K+ Wardrobe Concierge V1 — Android platform integration.
 *
 * DELIBERATELY THE SAME CONTRACT AS THE iOS SUITE (section 51). Android must
 * not become a simplified Concierge, so every matrix row the iOS branch asserts
 * is asserted here against the same shared logic, plus the concerns that are
 * genuinely Android's.
 *
 * SCOPE, STATED HONESTLY. This verifies WIRING and decision logic. It does not
 * mount a React Native tree, and no emulator or physical device runtime was
 * available in this environment — so "renders correctly on an Android device"
 * is not proven by anything here, and no EAS build was run.
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
  assert.equal(hook.includes('explanationBlocks.push'), true);
  assert.equal(hook.includes('uiBlocks: explanationBlocks'), true);
});

test('a turn with no wardrobe evidence writes no block at all', () => {
  assert.equal(read('hooks/useStyleChat.ts').includes("conciergeResult.presentation !== 'none'"), true);
});

test('the bubble renders the block through the shared component', () => {
  const bubble = read('components/style-chat/StyleChatBubble.tsx');
  assert.equal(bubble.includes("block?.type === 'concierge_evidence'"), true);
  assert.equal(bubble.includes('<ConciergeEvidenceBlock'), true);
  assert.equal(bubble.includes('ownerId={conciergeOwnerId}'), true);
});

test('the flag gates BOTH the write and the render', () => {
  assert.equal(read('hooks/useStyleChat.ts').includes('if (ELISE_CONCIERGE_V1)'), true);
  assert.equal(
    read('components/style-chat/StyleChatBubble.tsx').includes('if (!ELISE_CONCIERGE_V1) return null;'),
    true,
  );
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

// ── parity matrix rows, identical to iOS ─────────────────────────────────────

test('matrix: K+ inactive or expired renders no Concierge surface', () => {
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
});

test('matrix: owned item cards carry the real server facts', () => {
  const card = buildConciergeResult(v2()).focusCard;
  assert.equal(card.brand, 'Aldo');
  assert.equal(card.subtype, 'penny loafer');
  assert.equal(card.primaryColor, 'brown');
  assert.equal(card.clientId, LOAFERS);
});

test('matrix: look groups and relationship labels behave as on iOS', () => {
  const result = buildConciergeResult(
    v2({
      wardrobeContextMode: 'mixed',
      recommendations: [
        {
          candidateId: 'closet:a',
          actorRelationship: 'owned',
          displayFacts: { title: 'Navy trousers', category: 'trousers', subtype: null, brand: null, primaryColor: 'navy', clientId: 'a' },
        },
        {
          candidateId: 'saved:b',
          actorRelationship: 'saved',
          displayFacts: { title: 'Grey coat', category: 'coat', subtype: null, brand: null, primaryColor: 'grey', clientId: 'b' },
        },
      ],
      looks: [{ lookId: 'look_1', label: 'casual', candidateIds: ['closet:a', 'saved:b'], missingPieceCodes: [] }],
    }),
  );
  assert.equal(result.presentation, 'mixed');
  assert.equal(result.looks.length, 1);
  assert.equal(result.looks[0].cards.length, 2);
  // Mixed evidence must keep each relationship distinct — a saved item must not
  // be filed under the same ownership claim as an owned one.
  assert.deepEqual(result.looks[0].cards.map((c) => c.relationship), ['owned', 'saved']);
});

test('matrix: account switch cannot leak the previous account', () => {
  assert.equal(conciergeOwnerIdFromUserKey('user:aaa'), 'aaa');
  assert.equal(conciergeOwnerIdFromUserKey(null), null);

  const block = read('components/concierge/ConciergeEvidenceBlock.tsx');
  assert.equal(block.includes('setImages({})'), true);
  assert.equal(block.includes('cancelled = true'), true);
  assert.equal(/\[ownerId, clientIdKey/.test(block), true);
});

test('matrix: loading shows a placeholder, never a broken image', async () => {
  const state = await resolveConciergeImage({ resolveLocalUri: async () => null }, LOAFERS);
  assert.deepEqual(state, { status: 'unavailable' });

  const card = read('components/concierge/ConciergeClosetCard.tsx');
  assert.equal(card.includes('thumbFallback'), true);
  assert.equal(card.includes('onError={() => setImageFailed(true)}'), true);
});

test('matrix: item-detail navigation is intentionally absent in V1', () => {
  // Section 46, and the SAME decision as iOS: no authorized route opens one
  // Closet item, so cards stay inert on both platforms. Documented as a shared
  // limitation rather than an Android gap.
  const library = read('app/library.tsx');
  assert.equal(/useLocalSearchParams<\{\s*section\?: string;?\s*\}>/.test(library), true);

  const bubble = read('components/style-chat/StyleChatBubble.tsx');
  const mount = bubble.slice(bubble.indexOf('<ConciergeEvidenceBlock'));
  const mountTag = mount.slice(0, mount.indexOf('/>') + 2);
  assert.equal(mountTag.includes('onCardPress'), false);
});

// ── Android-specific concerns ────────────────────────────────────────────────

test('Android: a content:// pick never becomes a Closet imageUri', () => {
  // On Android the gallery/camera hands back a content:// URI. A content URI
  // stored as a Closet imageUri would resolve for one session and then fail
  // permanently once its grant lapsed, producing cards whose images vanish.
  // Intake normalises every source through ImageManipulator into the app's own
  // documentDirectory first, so what is persisted is always a file:// path.
  const library = read('services/closetLibrary.js');
  assert.equal(library.includes('ImageManipulator.manipulateAsync'), true);
  assert.equal(library.includes("const IMAGES_DIR    = CLOSET_DIR + 'images/';"), true);
  assert.equal(library.includes("FileSystem.documentDirectory + 'kscan_closet/'"), true);
  // And an item with no durable image is refused rather than stored pointing at
  // a transient URI.
  assert.equal(library.includes('A Closet item with no durable image is not a usable'), true);
});

test('Android: the restore cache is app-private, not external storage', () => {
  const restore = read('services/closet/closetRestoreMedia.ts');
  assert.equal(
    restore.includes("FileSystem.documentDirectory + 'kscan_closet/remote-cache/'"),
    true,
  );
  // Section 40: existing private storage only. Anything under a shared/external
  // directory would make Closet photos world-readable on older Android.
  assert.equal(/cacheDirectory|ExternalDirectory|getExternal/.test(restore), false);
});

test('Android: a zero-byte cached file is treated as absent', () => {
  // An interrupted download on Android commonly leaves a 0-byte file behind.
  // Treating it as present would render a blank image instead of the text card.
  const source = read('services/concierge/conciergeClosetImageSource.ts');
  assert.equal(source.includes('info.size === undefined || info.size > 0'), true);
});

test('Android: the card cannot overflow a narrow phone bubble', () => {
  const card = read('components/concierge/ConciergeClosetCard.tsx');
  assert.equal(card.includes('minWidth: 0'), true);
  assert.equal(card.includes('flexShrink: 1'), true);
  assert.equal(card.includes('numberOfLines'), true);
});

test('Android: the Concierge path has no platform branch to diverge on', () => {
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

test('Android: this branch adds no Android-only Concierge behaviour', () => {
  // Section 51 in the other direction: Android must not quietly gain a
  // behaviour iOS lacks either. The only file this branch adds is this test.
  assert.equal(fs.existsSync(path.join(ROOT, 'components/concierge/ConciergeEvidence.tsx')), true);
  assert.equal(fs.existsSync(path.join(ROOT, 'components/concierge/ConciergeEvidence.android.tsx')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'components/concierge/ConciergeClosetCard.android.tsx')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'services/concierge/conciergeModel.android.ts')), false);
});
