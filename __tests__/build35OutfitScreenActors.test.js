const test = require('node:test');
const assert = require('node:assert/strict');
const { createRenderer, runModule, deepStub, findAll, deferred, settle } = require('./helpers/componentRenderer');
const actor = require('../services/actorContext');
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function harness(route, httpLimit) {
  actor.__resetActorContextForTests(); actor.advanceActorEpoch(A);
  const r = createRenderer(); let userId = A;
  const saved = deferred(); const navigation = []; const events = [];
  const items = [0, 1].map(i => ({ sourceType: 'closet_item', sourceId: `${A.slice(0,-1)}${i}`, title: `Piece ${i}`, remoteBacked: true, category: 'top', aiEligible: true }));
  const scope = runModule('services/actorScope.ts', { './actorContext': actor });
  const outfits = httpLimit ? runModule('services/styleOutfits.ts', {
    './supabaseClient': { supabase: { functions: { invoke: async () => ({ data: null, error: { context: new Response(JSON.stringify(httpLimit), { status: 429 }) } }) } } },
    './authenticatedFunctionSession': { resolveAuthenticatedFunctionSession: async () => ({ ok: true, accessToken: 'fixture-token' }) },
    './actorScope': scope,
    '../constants/featureFlags': { AI_STYLIST_UI_ENABLED: true, AI_STYLIST_BACKEND_ENABLED: true },
    '../types/fashionReasoning': runModule('types/fashionReasoning.ts', {}),
    '../types/ownedClosetItem': runModule('types/ownedClosetItem.ts', {}),
  }) : { isGenerationInFlight: () => false, generateOutfits: () => saved.promise };
  const module = runModule(route, {
    ...r.runtimeModules,
    'react-native': { View: 'View', Text: 'Text', Image: 'Image', ScrollView: 'ScrollView', TouchableOpacity: 'TouchableOpacity', Modal: 'Modal', ActivityIndicator: 'ActivityIndicator', StyleSheet: { create: s => s } },
    'expo-router': { router: { push: p => navigation.push(p), replace: p => navigation.push(p) }, useLocalSearchParams: () => ({}) },
    'expo-status-bar': { StatusBar: 'StatusBar' },
    '../../contexts/AuthSessionContext': { useAuthSession: () => ({ isAuthenticated: true, user: { id: userId } }) },
    '../../services/actorScope': scope,
    '../../services/navigationExit': { goBackOrHome() {} },
    '../../components/FeatureFreezeFallback': { FeatureFreezeFallback: 'Fallback' },
    '../../components/StyleObjectCards': { TextField: 'TextField' },
    '../../components/looks/AskMyRoomModal': { AskMyRoomModal: 'RoomModal' },
    '../../components/luxury': Object.fromEntries(['LuxuryScreen','KScanHeader','SectionHeader','EmptyStateCard','InlineNotice','PrimaryButton','SecondaryButton'].map(x => [x,x])),
    '../../constants/theme': { LUXURY: deepStub(), SPACING: deepStub() },
    '../../services/responsiveLayout': { MODAL_MAX_WIDTH: 600 },
    '../../constants/featureFlags': { AI_STYLIST_UI_ENABLED: true },
    '../../hooks/useFeatureFreeze': { useFeatureFreeze: () => ({ isFeatureEnabled: () => true, isLoading: false }) },
    '../../hooks/useOwnedClosetItems': { useOwnedClosetItems: () => ({ items: userId === A ? items : [], loading: false, localScans: [] }) },
    '../../hooks/usePrivateDressingRoom': { usePrivateDressingRoomStatus: () => ({}) },
    '../../constants/elise': { ELISE_IDENTITY: { name: 'Elise' }, ELISE_LOADING_COPY: {} },
    '../../services/style-chat/styleChatAttachmentStore': { setAttachmentHandoff() {} },
    '../../types/styleChatAttachments': {},
    '../../services/styleOutfits': outfits,
    '../../services/styleObjects': { LOOK_MIN_ITEMS: 2, LOOK_MAX_ITEMS: 6, createLookFromOwnedItems: () => saved.promise, updateLookOwnedItems: () => saved.promise, getLookDetail: async () => ({}) },
    '../../services/ownedClosetItems': { ensureRemoteBackedOwnedItem: async x => x, OwnedItemSyncError: Error },
    '../../services/styleMemoryEvents': { recordAiStylistEvent: x => events.push(x), REJECTION_REASONS: [], REJECTION_REASON_LABELS: {} },
    '../../types/fashionReasoning': runModule('types/fashionReasoning.ts', {}),
    '../../types/ownedClosetItem': runModule('types/ownedClosetItem.ts', {}),
  });
  const render = () => r.render(r.jsx(module.default, {}));
  return { render, saved, navigation, events, outfits, switchTo(id) { actor.advanceActorEpoch(id); userId = id; } };
}
function one(tree, predicate) {
  const nodes = findAll(tree, predicate); assert.equal(nodes.length, 1); return nodes[0];
}

for (const [route, label] of [['app/looks/create.tsx', 'Look name'], ['app/stylist/index.tsx', 'Note (optional)']]) {
  test(`${route}: account switch resets private draft, including A→B→A`, () => {
    const h = harness(route);
    one(h.render(), n => n.type === 'TextField' && n.props.label === label).props.onChangeText('A private draft');
    assert.equal(one(h.render(), n => n.type === 'TextField' && n.props.label === label).props.value, 'A private draft');
    h.switchTo(B);
    assert.equal(one(h.render(), n => n.type === 'TextField' && n.props.label === label).props.value, '');
    h.switchTo(A);
    assert.equal(one(h.render(), n => n.type === 'TextField' && n.props.label === label).props.value, '');
  });
}

test('manual Look save completed after actor change cannot navigate the arriving actor', async () => {
  const h = harness('app/looks/create.tsx');
  one(h.render(), n => n.type === 'TextField' && n.props.label === 'Look name').props.onChangeText('A Look');
  for (const node of findAll(h.render(), n => n.props.testID === 'look-builder-item')) node.props.onPress();
  const save = one(h.render(), n => n.type === 'PrimaryButton' && n.props.testID === 'save-look-button');
  assert.equal(save.props.disabled, false);
  const pending = save.props.onPress();
  h.switchTo(B);
  h.saved.resolve({ id: 'A-look', source: 'manual' }); await pending;
  assert.deepEqual(h.navigation, []);
  assert.deepEqual(h.events, []);
});

for (const [payload, messageKey] of [
  [{ status: 'quota_exceeded', usage: { generationsUsed: 10, generationsLimit: 10 } }, 'AI_QUOTA_MESSAGE'],
  [{ status: 'burst_limit', retryAfterSeconds: 5 }, 'AI_BURST_MESSAGE'],
]) {
  test(`HTTP 429 ${payload.status} renders the intended Stylist limit message`, async () => {
    const h = harness('app/stylist/index.tsx', payload);
    one(h.render(), n => n.props.testID === 'generate-outfits-button').props.onPress();
    await settle(3);
    const notice = one(h.render(), n => n.type === 'InlineNotice' && n.props.title === 'Elise');
    assert.equal(notice.props.body, h.outfits[messageKey]);
    assert.notEqual(notice.props.body, h.outfits.AI_UNAVAILABLE_MESSAGE);
    assert.equal(h.outfits.isInUnavailableCooldown(), false);
  });
}
