const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const module = { exports: {} };
  const sandbox = {
    __DEV__: false,
    console,
    exports: module.exports,
    module,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      if (id === './roomDeepLinks') return require('../services/roomDeepLinks');
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return module.exports;
}

function loadCaptureModule(saveImpl) {
  const saveCalls = [];
  const capture = loadTsModule('services/captureSharedRoomMembership.ts', {
    './sharedRoomMemberships': {
      saveSharedRoomForCurrentUser: async (token) => {
        saveCalls.push(token);
        return saveImpl(token);
      },
    },
  });
  return { capture, saveCalls };
}

function makeTracker(previewShareToken = 'active-token-a') {
  const attempted = new Set();
  return {
    previewShareToken,
    hasAttempted: (key) => attempted.has(key),
    markAttempted: (key) => attempted.add(key),
  };
}

test('valid available preview with authenticated native user saves membership', async () => {
  const { capture, saveCalls } = loadCaptureModule(async () => ({ status: 'saved' }));
  const tracker = makeTracker();
  const result = await capture.captureSharedRoomMembershipAfterPreview({
    shareToken: 'active-token-a',
    previewStatus: 'available',
    sessionState: { phase: 'authenticated', actorId: 'user-1' },
    platform: 'ios',
    ...tracker,
  });
  assert.deepEqual(result, { status: 'saved' });
  assert.deepEqual(saveCalls, ['active-token-a']);
});

test('valid empty room saves membership', async () => {
  const { capture, saveCalls } = loadCaptureModule(async () => ({ status: 'already_saved' }));
  const tracker = makeTracker('empty-token');
  const result = await capture.captureSharedRoomMembershipAfterPreview({
    shareToken: 'empty-token',
    previewStatus: 'empty',
    sessionState: { phase: 'authenticated', actorId: 'user-1' },
    platform: 'android',
    ...tracker,
  });
  assert.equal(result.status, 'already_saved');
  assert.equal(saveCalls.length, 1);
});

test('malformed token does not save', async () => {
  const { capture, saveCalls } = loadCaptureModule(async () => ({ status: 'saved' }));
  const result = await capture.captureSharedRoomMembershipAfterPreview({
    shareToken: 'bad token!',
    previewStatus: 'available',
    sessionState: { phase: 'authenticated', actorId: 'user-1' },
    platform: 'ios',
    ...makeTracker(),
  });
  assert.equal(result, null);
  assert.equal(saveCalls.length, 0);
});

test('unavailable preview does not save', async () => {
  const { capture, saveCalls } = loadCaptureModule(async () => ({ status: 'saved' }));
  const result = await capture.captureSharedRoomMembershipAfterPreview({
    shareToken: 'active-token-a',
    previewStatus: 'unavailable',
    sessionState: { phase: 'authenticated', actorId: 'user-1' },
    platform: 'ios',
    ...makeTracker(),
  });
  assert.equal(result, null);
  assert.equal(saveCalls.length, 0);
});

test('network-failed preview does not save', async () => {
  const { capture, saveCalls } = loadCaptureModule(async () => ({ status: 'saved' }));
  const result = await capture.captureSharedRoomMembershipAfterPreview({
    shareToken: 'active-token-a',
    previewStatus: 'network_error',
    sessionState: { phase: 'authenticated', actorId: 'user-1' },
    platform: 'ios',
    ...makeTracker(),
  });
  assert.equal(result, null);
  assert.equal(saveCalls.length, 0);
});

test('rate-limited preview does not save', async () => {
  const { capture, saveCalls } = loadCaptureModule(async () => ({ status: 'saved' }));
  const result = await capture.captureSharedRoomMembershipAfterPreview({
    shareToken: 'active-token-a',
    previewStatus: 'rate_limited',
    sessionState: { phase: 'authenticated', actorId: 'user-1' },
    platform: 'ios',
    ...makeTracker(),
  });
  assert.equal(result, null);
  assert.equal(saveCalls.length, 0);
});

test('malformed and timed-out previews do not save', async () => {
  for (const previewStatus of ['malformed', 'timeout']) {
    const { capture, saveCalls } = loadCaptureModule(async () => ({ status: 'saved' }));
    const result = await capture.captureSharedRoomMembershipAfterPreview({
      shareToken: 'active-token-a',
      previewStatus,
      sessionState: { phase: 'authenticated', actorId: 'user-1' },
      platform: 'ios',
      ...makeTracker(),
    });
    assert.equal(result, null);
    assert.equal(saveCalls.length, 0);
  }
});

test('a preview validated for an old token cannot save the current route token', async () => {
  const { capture, saveCalls } = loadCaptureModule(async () => ({ status: 'saved' }));
  const result = await capture.captureSharedRoomMembershipAfterPreview({
    shareToken: 'new-token',
    previewShareToken: 'old-token',
    previewStatus: 'available',
    sessionState: { phase: 'authenticated', actorId: 'user-1' },
    platform: 'ios',
    hasAttempted: () => false,
    markAttempted: () => {},
  });
  assert.equal(result, null);
  assert.equal(saveCalls.length, 0);
});

test('auth-loading state waits without saving', async () => {
  const { capture, saveCalls } = loadCaptureModule(async () => ({ status: 'saved' }));
  assert.equal(
    capture.isEligibleForSharedRoomMembershipCapture({
      shareToken: 'active-token-a',
      previewShareToken: 'active-token-a',
      previewStatus: 'available',
      sessionState: { phase: 'loading' },
      platform: 'ios',
    }),
    false,
  );
  const result = await capture.captureSharedRoomMembershipAfterPreview({
    shareToken: 'active-token-a',
    previewStatus: 'available',
    sessionState: { phase: 'loading' },
    platform: 'ios',
    ...makeTracker(),
  });
  assert.equal(result, null);
  assert.equal(saveCalls.length, 0);
});

test('authenticated session arriving later saves once', async () => {
  const { capture, saveCalls } = loadCaptureModule(async () => ({ status: 'saved' }));
  const tracker = makeTracker();
  const first = await capture.captureSharedRoomMembershipAfterPreview({
    shareToken: 'active-token-a',
    previewStatus: 'available',
    sessionState: { phase: 'loading' },
    platform: 'ios',
    ...tracker,
  });
  assert.equal(first, null);
  const second = await capture.captureSharedRoomMembershipAfterPreview({
    shareToken: 'active-token-a',
    previewStatus: 'available',
    sessionState: { phase: 'authenticated', actorId: 'user-1' },
    platform: 'ios',
    ...tracker,
  });
  assert.equal(second.status, 'saved');
  assert.equal(saveCalls.length, 1);
});

test('unauthenticated user continues without saving', async () => {
  const { capture, saveCalls } = loadCaptureModule(async () => ({ status: 'saved' }));
  const result = await capture.captureSharedRoomMembershipAfterPreview({
    shareToken: 'active-token-a',
    previewStatus: 'available',
    sessionState: { phase: 'unauthenticated' },
    platform: 'ios',
    ...makeTracker(),
  });
  assert.equal(result, null);
  assert.equal(saveCalls.length, 0);
});

test('browser route never saves', async () => {
  const { capture, saveCalls } = loadCaptureModule(async () => ({ status: 'saved' }));
  const result = await capture.captureSharedRoomMembershipAfterPreview({
    shareToken: 'active-token-a',
    previewStatus: 'available',
    sessionState: { phase: 'authenticated', actorId: 'user-1' },
    platform: 'web',
    ...makeTracker(),
  });
  assert.equal(result, null);
  assert.equal(saveCalls.length, 0);
});

test('unknown non-native platforms and empty actors never save', async () => {
  const cases = [
    { platform: 'server', actorId: 'user-1' },
    { platform: 'ios', actorId: '' },
  ];
  for (const { platform, actorId } of cases) {
    const { capture, saveCalls } = loadCaptureModule(async () => ({ status: 'saved' }));
    const result = await capture.captureSharedRoomMembershipAfterPreview({
      shareToken: 'active-token-a',
      previewStatus: 'available',
      sessionState: { phase: 'authenticated', actorId },
      platform,
      ...makeTracker(),
    });
    assert.equal(result, null);
    assert.equal(saveCalls.length, 0);
  }
});

test('owner and temporary membership results do not throw', async () => {
  for (const status of ['owner', 'temporary_failure']) {
    const { capture } = loadCaptureModule(async () => ({ status }));
    const result = await capture.captureSharedRoomMembershipAfterPreview({
      shareToken: 'active-token-a',
      previewStatus: 'available',
      sessionState: { phase: 'authenticated', actorId: 'user-1' },
      platform: 'ios',
      ...makeTracker(),
    });
    assert.equal(result.status, status);
  }
});

test('rerender does not repeat the RPC for the same attempt key', async () => {
  const { capture, saveCalls } = loadCaptureModule(async () => ({ status: 'saved' }));
  const tracker = makeTracker();
  const input = {
    shareToken: 'active-token-a',
    previewStatus: 'available',
    sessionState: { phase: 'authenticated', actorId: 'user-1' },
    platform: 'ios',
    ...tracker,
  };
  await capture.captureSharedRoomMembershipAfterPreview(input);
  await capture.captureSharedRoomMembershipAfterPreview(input);
  assert.equal(saveCalls.length, 1);
});

test('temporary failure is attempted once per route lifecycle and can retry after reset', async () => {
  const { capture, saveCalls } = loadCaptureModule(async () => ({ status: 'temporary_failure' }));
  const tracker = capture.createMembershipCaptureAttemptTracker();
  const input = {
    shareToken: 'active-token-a',
    previewShareToken: 'active-token-a',
    previewStatus: 'available',
    sessionState: { phase: 'authenticated', actorId: 'user-1' },
    platform: 'ios',
    hasAttempted: tracker.hasAttempted,
    markAttempted: tracker.markAttempted,
  };

  assert.equal((await capture.captureSharedRoomMembershipAfterPreview(input)).status, 'temporary_failure');
  assert.equal(await capture.captureSharedRoomMembershipAfterPreview(input), null);
  tracker.reset();
  assert.equal((await capture.captureSharedRoomMembershipAfterPreview(input)).status, 'temporary_failure');
  assert.equal(saveCalls.length, 2);
});

test('attempt tracker retains only the current actor/token key', () => {
  const { capture } = loadCaptureModule(async () => ({ status: 'saved' }));
  const tracker = capture.createMembershipCaptureAttemptTracker();
  tracker.markAttempted('actor-a:token-a');
  assert.equal(tracker.hasAttempted('actor-a:token-a'), true);
  tracker.markAttempted('actor-b:token-b');
  assert.equal(tracker.hasAttempted('actor-a:token-a'), false);
  assert.equal(tracker.hasAttempted('actor-b:token-b'), true);
});

test('user change uses a separate attempt key', () => {
  const { capture } = loadCaptureModule(async () => ({ status: 'saved' }));
  const keyA = capture.buildMembershipCaptureAttemptKey('user-a', 'active-token-a');
  const keyB = capture.buildMembershipCaptureAttemptKey('user-b', 'active-token-a');
  assert.notEqual(keyA, keyB);
});

test('token change may save the new token', async () => {
  const { capture, saveCalls } = loadCaptureModule(async () => ({ status: 'saved' }));
  const trackerA = makeTracker();
  await capture.captureSharedRoomMembershipAfterPreview({
    shareToken: 'active-token-a',
    previewStatus: 'available',
    sessionState: { phase: 'authenticated', actorId: 'user-1' },
    platform: 'ios',
    ...trackerA,
  });
  const trackerB = makeTracker('active-token-b');
  await capture.captureSharedRoomMembershipAfterPreview({
    shareToken: 'active-token-b',
    previewStatus: 'available',
    sessionState: { phase: 'authenticated', actorId: 'user-1' },
    platform: 'ios',
    ...trackerB,
  });
  assert.deepEqual(saveCalls, ['active-token-a', 'active-token-b']);
});
