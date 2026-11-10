'use strict';

// Real mounted onboarding + legal/completion services. Only native hosts, auth,
// storage and the database transport are synthetic; this is not live RLS/OAuth.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createRenderer, runModule, deepStub, findAll, byTestId, byType,
  textContent, settle, deferred,
} = require('./helpers/componentRenderer');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function harness(platform, options = {}) {
  const r = createRenderer();
  let actor = A;
  let rejectWrite = Boolean(options.rejectWrite);
  const rows = [];
  const writes = [];
  const local = new Map([[`onboardingComplete:${A}`, 'true']]);
  const completed = [];
  const versions = runModule('constants/legal.ts', {}, { jsx: false });
  for (const [type, version] of [
    ['terms', versions.TERMS_VERSION], ['privacy', versions.PRIVACY_VERSION],
    ['minimum_age', versions.AGE_VERSION], ['ai_processing', 'v1'],
  ]) rows.push({ user_id: A, acceptance_type: type, policy_version: version });
  const client = {
    auth: { getSession: async () => {
      if (options.sessionGate) await options.sessionGate.promise;
      return { data: { session: actor ? { user: { id: actor } } : null }, error: null };
    } },
    from(table) {
      assert.equal(table, 'legal_acceptances');
      return {
        select: () => ({ eq: async (column, value) => {
          assert.equal(column, 'user_id');
          return { data: rows.filter((row) => row.user_id === value), error: null };
        } }),
        async upsert(payload, config) {
          assert.equal(config.ignoreDuplicates, true);
          assert.equal(config.onConflict, 'user_id,acceptance_type,policy_version');
          writes.push(payload);
          if (options.writeGate) await options.writeGate.promise;
          if (rejectWrite) return { error: new Error('synthetic database outage') };
          for (const row of payload) {
            if (!rows.some((old) => old.user_id === row.user_id && old.acceptance_type === row.acceptance_type && old.policy_version === row.policy_version)) rows.push(row);
          }
          return { error: null };
        },
      };
    },
  };
  const legal = runModule('services/legalAcceptance.ts', {
    'react-native': { Platform: { OS: 'ios' } },
    './supabaseClient': { supabase: client }, '../constants/legal': versions,
    '../src/utils/errorLogger': { logError() {} },
  });
  const completion = runModule('services/onboardingCompletion.ts', {
    '@react-native-async-storage/async-storage': {
      getItem: async (key) => local.get(key) ?? null,
      setItem: async (key, value) => { local.set(key, value); },
      removeItem: async (key) => { local.delete(key); },
    },
    './legalAcceptance': legal, '../constants/legal': versions,
  });
  completion.subscribeOnboardingCompletion((id) => completed.push(id));
  const { default: Screen } = runModule('app/onboarding/index.tsx', {
    ...r.runtimeModules,
    'react-native': {
      View: 'View', Text: 'Text', Pressable: 'Pressable', TextInput: 'TextInput',
      ActivityIndicator: 'ActivityIndicator', Platform: { OS: platform },
      StyleSheet: { create: (styles) => styles },
      BackHandler: { addEventListener: () => ({ remove() {} }) },
      Linking: { openURL: async () => {} },
    },
    'expo-status-bar': { StatusBar: 'StatusBar' },
    'expo-router': { useLocalSearchParams: () => ({ resume: 'terms' }), useRouter: () => ({ push() {} }) },
    '../../contexts/AuthSessionContext': { useAuthSession: () => ({ loading: false, isAuthenticated: !!actor, user: actor ? { id: actor } : null }) },
    '../../services/onboardingCompletion': completion,
    '../../components/luxury': { LuxuryScreen: 'LuxuryScreen', KScanHeader: 'KScanHeader', PrimaryButton: 'PrimaryButton', TertiaryButton: 'TertiaryButton' },
    '../../components/onboarding': { OnboardingShell: 'OnboardingShell' },
    '../../components/account-home': { WelcomeStepV1: 'WelcomeStepV1', AccountSetupStepV1: 'AccountSetupStepV1', PermissionsStepV1: 'PermissionsStepV1' },
    '../../components/kplus/KPlusMembershipStep': { KPlusMembershipStep: 'KPlusMembershipStep' },
    '../../constants/theme': { LUXURY: deepStub(), RADIUS: deepStub(), SHADOWS: deepStub(), SPACING: deepStub(), TYPOGRAPHY: deepStub() },
    '../../constants/legal': versions,
    '../../services/authValidation': { validateAuthInput() {}, mapAuthError() {} },
    '../../services/legalAcceptance': legal,
    '../../hooks/usePermissionPreferences': { usePermissionPreferences: () => ({ preferences: {}, setPreference() {}, requestNotificationPermission: async () => {}, disableNotificationDelivery: async () => {} }) },
    'expo-web-browser': {}, '../../services/supabaseClient': { supabase: client },
    '../../services/authConfig': { AUTH_CALLBACK_URL: 'kscan://auth/callback' },
    '../../services/authCallbackOrigin': {}, '../../services/authDeepLink': {},
    '../../services/oauthCallbackSession': {}, '../../services/authLifecycleTrace': { traceAuthLifecycle() {} },
  });
  const render = () => r.render(r.jsx(Screen, {}));
  const accept = () => byTestId(render(), 'onboarding-accept-continue-button')[0];
  const checkAll = () => {
    for (const node of findAll(render(), (n) => n.props.accessibilityRole === 'checkbox')) node.props.onPress();
  };
  return {
    render, accept, checkAll, completion, rows, writes, local, completed, versions,
    setActor(id) { actor = id; }, allowWrite() { rejectWrite = false; },
  };
}

for (const platform of ['ios', 'android']) {
  test(`${platform}: existing v1 user acknowledges v2, then permissions/membership hand off a persisted completion`, async () => {
    const h = harness(platform); h.render(); await settle();
    assert.equal(h.accept().props.disabled, true);
    assert.equal(await h.completion.isOnboardingComplete(A), false);
    h.checkAll(); assert.equal(h.accept().props.disabled, false);
    await h.accept().props.onPress(); await settle();
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].length, 4);
    assert.ok(h.rows.some((row) => row.user_id === A && row.acceptance_type === 'ai_processing' && row.policy_version === h.versions.AI_PROCESSING_VERSION));
    assert.equal(await h.completion.isOnboardingComplete(A), false, 'receipt write alone does not pretend the remaining screens completed');
    byType(h.render(), 'PermissionsStepV1')[0].props.onNotNow();
    await byType(h.render(), 'KPlusMembershipStep')[0].props.onSkip(); await settle();
    assert.equal(byTestId(h.render(), 'onboarding-home-handoff').length, 1);
    assert.equal(await h.completion.isOnboardingComplete(A), true);
    assert.deepEqual(h.completed, [A], 'the actual completion service notifies the root gate');
    assert.equal(h.local.has(`onboardingComplete:${B}`), false);
  });

  test(`${platform}: failed consent persistence stays actionable, then a successful retry advances`, async () => {
    const h = harness(platform, { rejectWrite: true }); h.render(); await settle();
    h.checkAll(); await h.accept().props.onPress(); await settle();
    assert.match(textContent(h.render()), /Unable to save your preferences/);
    assert.equal(h.accept().props.disabled, false);
    assert.equal(byType(h.render(), 'PermissionsStepV1').length, 0);
    assert.equal(await h.completion.isOnboardingComplete(A), false);
    assert.deepEqual(h.completed, []);
    h.allowWrite(); await h.accept().props.onPress(); await settle();
    assert.equal(byType(h.render(), 'PermissionsStepV1').length, 1);
    assert.equal(h.writes.length, 2);
  });
}

for (const platform of ['ios', 'android']) {
test(`${platform}: a pending acknowledgment from A cannot advance B or inherit A checkbox choices`, async () => {
  const gate = deferred(); const h = harness(platform, { writeGate: gate });
  h.render(); await settle(); h.checkAll();
  const pending = h.accept().props.onPress(); await settle();
  assert.equal(h.writes.length, 1);
  assert.ok(h.writes[0].every((row) => row.user_id === A));
  h.setActor(B); h.render(); await settle();
  gate.resolve(); await pending; await settle();
  assert.equal(byType(h.render(), 'PermissionsStepV1').length, 0, 'A completion must not advance B');
  assert.equal(h.accept().props.disabled, true, 'B must choose their own acknowledgments');
  assert.equal(findAll(h.render(), (n) => n.props.accessibilityRole === 'checkbox' && n.props.accessibilityState.checked).length, 0);
  assert.equal(await h.completion.isOnboardingComplete(B), false);
  assert.deepEqual(h.completed, []);
});

test(`${platform}: actor change during session resolution cannot write B receipts for A's tap`, async () => {
  const gate = deferred(); const h = harness(platform, { sessionGate: gate });
  h.render(); await settle(); h.checkAll();
  const pending = h.accept().props.onPress(); await settle();
  h.setActor(B); h.render(); await settle();
  gate.resolve(); await pending; await settle();
  assert.equal(h.writes.length, 0, 'a resolved foreign actor is not consent authority for the old tap');
  assert.equal(byType(h.render(), 'PermissionsStepV1').length, 0);
  assert.equal(h.accept().props.disabled, true);
});
}

test('rapid duplicate Accept callbacks produce one receipt operation', async () => {
  const gate = deferred(); const h = harness('ios', { writeGate: gate });
  h.render(); await settle(); h.checkAll();
  const callback = h.accept().props.onPress;
  const first = callback(); const second = callback(); await settle();
  gate.resolve(); await Promise.all([first, second]); await settle();
  assert.equal(h.writes.length, 1);
  assert.equal(byType(h.render(), 'PermissionsStepV1').length, 1, 'one continuation only, not a skipped step');
});
