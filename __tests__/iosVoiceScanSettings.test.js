'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  byTestId,
  createReactNativeStub,
  createRenderer,
  deepStub,
  runModule,
  settle,
  textContent,
} = require('./helpers/componentRenderer');

/**
 * iOS Voice Scan settings path (components/text-scan/VoiceListeningSheet.tsx).
 *
 * iOS shows the microphone and speech-recognition prompts once. After a denial
 * the native request resolves with canAskAgain false and no UI, so the sheet
 * lands on 'permission_denied_permanently', whose copy says "Enable it in your
 * device Settings" -- with no way there from the sheet. On iOS the sheet now
 * offers "Open Settings"; Android renders exactly what it rendered before.
 *
 * The real component is executed (not text-matched): Platform.OS is the only
 * input that differs between the iOS and Android renders below.
 */

const SHEET = 'components/text-scan/VoiceListeningSheet.tsx';

function Button(props) {
  return null;
}

function loadSheet({ platformOS, openSettings, mutate }) {
  const renderer = createRenderer();
  const rn = createReactNativeStub({ platformOS });
  const animation = () => ({ start() {}, stop() {} });
  rn.Animated.loop = animation;
  rn.Animated.sequence = animation;
  rn.Linking = { openSettings };
  const { VoiceListeningSheet } = runModule(
    SHEET,
    {
      ...renderer.runtimeModules,
      'react-native': rn,
      'expo-haptics': { impactAsync: () => Promise.resolve(), ImpactFeedbackStyle: { Light: 'light' } },
      '../luxury': { PrimaryButton: Button, SecondaryButton: Button },
      '../icons/kscan': { VoiceScanIcon: Button },
      '../../constants/theme': { LUXURY: deepStub(), MOTION: deepStub(), RADIUS: deepStub(), SHADOWS: deepStub(), SPACING: deepStub() },
    },
    mutate ? { mutate } : {},
  );
  return { renderer, VoiceListeningSheet };
}

function renderSheet({ platformOS, reason, openSettings = () => Promise.resolve(), onDismiss = () => {}, mutate }) {
  const { renderer, VoiceListeningSheet } = loadSheet({ platformOS, openSettings, mutate });
  const tree = renderer.render(
    renderer.jsx(VoiceListeningSheet, {
      visible: true,
      state: 'unavailable',
      unavailableReason: reason,
      partialTranscript: '',
      onStop() {},
      onCancel() {},
      onDismiss,
    }),
  );
  return tree;
}

const settingsButton = (tree) => byTestId(tree, 'voice-scan-open-settings');

test('iOS: a permanent microphone/speech denial offers Open Settings beside Use Text Instead', async () => {
  const opened = [];
  let dismissed = 0;
  const tree = renderSheet({
    platformOS: 'ios',
    reason: 'permission_denied_permanently',
    openSettings: () => {
      opened.push('settings');
      return Promise.resolve();
    },
    onDismiss: () => {
      dismissed += 1;
    },
  });

  assert.match(textContent(tree), /Enable it in your device Settings/);
  assert.equal(byTestId(tree, 'voice-scan-use-text').length, 1, 'the text fallback is still offered');
  const [button] = settingsButton(tree);
  assert.ok(button, 'Open Settings is offered on iOS');
  assert.equal(button.props.title, 'Open Settings');
  assert.match(button.props.accessibilityLabel, /Settings/);

  button.props.onPress();
  await settle();
  assert.deepEqual(opened, ['settings']);
  assert.equal(dismissed, 1, 'the sheet steps aside so the text field is ready on return');
});

test('iOS: if Settings cannot be opened, the sheet stays up with its reason', async () => {
  let dismissed = 0;
  const tree = renderSheet({
    platformOS: 'ios',
    reason: 'permission_denied_permanently',
    openSettings: () => Promise.reject(new Error('cannot open')),
    onDismiss: () => {
      dismissed += 1;
    },
  });
  settingsButton(tree)[0].props.onPress();
  await settle();
  assert.equal(dismissed, 0);
});

test('iOS: a denial that can still prompt, and every other reason, offer no Settings button', () => {
  for (const reason of [
    'permission_denied',
    'on_device_recognition_unavailable',
    'recognizer_error',
    'not_kplus',
    'flag_disabled',
  ]) {
    const tree = renderSheet({ platformOS: 'ios', reason });
    assert.equal(settingsButton(tree).length, 0, `${reason} must not offer Settings`);
    assert.equal(byTestId(tree, 'voice-scan-use-text').length, 1, `${reason} keeps the text fallback`);
  }
});

test('Android: the permanent-denial sheet is unchanged (no Settings button, same actions)', () => {
  let opened = 0;
  const tree = renderSheet({
    platformOS: 'android',
    reason: 'permission_denied_permanently',
    openSettings: () => {
      opened += 1;
      return Promise.resolve();
    },
  });
  assert.equal(settingsButton(tree).length, 0);
  assert.deepEqual(
    byTestId(tree, 'voice-scan-use-text').map((node) => node.props.title),
    ['Use Text Instead'],
  );
  assert.equal(opened, 0);
});

test('negative control: dropping the iOS branch removes the Settings path', () => {
  const tree = renderSheet({
    platformOS: 'ios',
    reason: 'permission_denied_permanently',
    mutate: (source) =>
      source.replace(
        "Platform.OS === 'ios' && reason === 'permission_denied_permanently'",
        'false',
      ),
  });
  assert.equal(settingsButton(tree).length, 0);
});

test('negative control: an ungated button would leak the Settings path to Android', () => {
  const tree = renderSheet({
    platformOS: 'android',
    reason: 'permission_denied_permanently',
    mutate: (source) =>
      source.replace(
        "Platform.OS === 'ios' && reason === 'permission_denied_permanently'",
        "reason === 'permission_denied_permanently'",
      ),
  });
  assert.equal(settingsButton(tree).length, 1, 'the Android assertion above would catch this');
});
