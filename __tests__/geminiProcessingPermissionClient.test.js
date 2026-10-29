const test = require('node:test');
const assert = require('node:assert/strict');
const { runModule, deferred, settle, createRenderer, deepStub, byType, textContent, readSource } = require('./helpers/componentRenderer');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
function serviceFixture(response) {
  let actor = A; let epoch = 1; const calls = [];
  const mod = runModule('services/geminiProcessingPermission.ts', {
    './actorContext': {
      createActorRequest: () => ({ actorId: actor, epoch, requestId: 'fixture' }),
      isActorRequestCurrent: (scope) => scope.actorId === actor && scope.epoch === epoch,
    },
    '../constants/legal': { AI_PROCESSING_VERSION: 'v2_google_gemini' },
    './supabaseClient': { supabase: { rpc(name, args) {
      calls.push({ name, args });
      return { abortSignal: (signal) => response
        ? response({ name, args, signal })
        : Promise.resolve({ data: { user_id: actor, policy_version: 'v2_google_gemini', granted: args.p_granted ?? true,
          revision: args.p_expected_revision === undefined ? 7 : args.p_expected_revision + 1 }, error: null }) };
    } } },
  }, { jsx: false });
  return { ...mod, calls, switchActor(next) { actor = next; epoch++; } };
}
test('current permission RPCs carry the verified-actor fence and expected revision, never client ownership authority', async () => {
  const s = serviceFixture();
  assert.deepEqual(await s.readGeminiProcessingPermission(A), { granted: true, revision: 7 });
  assert.deepEqual(await s.setGeminiProcessingPermission(A, false, 7), { granted: false, revision: 8 });
  assert.deepEqual(s.calls[1], { name: 'set_ai_processing_permission', args: { p_expected_user_id: A, p_granted: false, p_expected_revision: 7 } });
  await assert.rejects(s.setGeminiProcessingPermission(A, 'true', 7));
  await assert.rejects(s.setGeminiProcessingPermission(A, true, -1));
  s.switchActor(B);
  await assert.rejects(s.setGeminiProcessingPermission(A, true, 7));
  assert.equal(s.calls.length, 2);
});
for (const data of [null, [], {}, { user_id: B, policy_version: 'v2_google_gemini', granted: false, revision: 1 },
  { user_id: A, policy_version: 'v1', granted: false, revision: 1 },
  { user_id: A, policy_version: 'v2_google_gemini', granted: 'false', revision: 1 },
  { user_id: A, policy_version: 'v2_google_gemini', granted: false, revision: -1 }]) {
  test(`permission response is not authoritative when invalid: ${JSON.stringify(data)}`, async () => {
    const s = serviceFixture(async () => ({ data, error: null }));
    await assert.rejects(s.readGeminiProcessingPermission(A));
  });
}
test('RPC errors, contradictory write acknowledgment and actor switch cannot report permission success', async () => {
  for (const result of [{ data: null, error: { code: '401' } },
    { data: { user_id: A, policy_version: 'v2_google_gemini', granted: true, revision: 4 }, error: null },
    { data: { user_id: A, policy_version: 'v2_google_gemini', granted: false, revision: 3 }, error: null }]) {
    await assert.rejects(serviceFixture(async () => result).setGeminiProcessingPermission(A, false, 3));
  }
  const pending = deferred();
  const s = serviceFixture(() => pending.promise);
  const request = s.readGeminiProcessingPermission(A);
  s.switchActor(B);
  pending.resolve({ data: { user_id: A, policy_version: 'v2_google_gemini', granted: true, revision: 1 }, error: null });
  await assert.rejects(request, /Account changed/);
});
test('a permission timeout aborts the RPC and rejects instead of fabricating a saved change', async () => {
  const originalTimeout = global.setTimeout; const originalClear = global.clearTimeout;
  let fire;
  global.setTimeout = (callback) => { fire = callback; return 1; };
  global.clearTimeout = () => {};
  try {
    const s = serviceFixture(({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const pending = s.setGeminiProcessingPermission(A, false, 1);
    fire(); await assert.rejects(pending, /aborted/);
  } finally { global.setTimeout = originalTimeout; global.clearTimeout = originalClear; }
});
function uiFixture(platform, options = {}) {
  const r = createRenderer(); const calls = [];
  const { GeminiProcessingSettingsSection } = runModule('components/settings/GeminiProcessingSettingsSection.tsx', {
    ...r.runtimeModules,
    'react-native': { View: 'View', Text: 'Text', Platform: { OS: platform }, StyleSheet: { create: (s) => s } },
    '../PrivacyToggle': { PrivacyToggle: 'PrivacyToggle' },
    '../luxury': { SectionHeader: 'SectionHeader', SecondaryButton: 'SecondaryButton' },
    '../../constants/theme': { LUXURY: deepStub(), RADIUS: deepStub(), SPACING: deepStub() },
    '../../services/geminiProcessingPermission': {
      readGeminiProcessingPermission: options.read ?? (async () => ({ granted: true, revision: 2 })),
      setGeminiProcessingPermission: async (actor, next, revision) => {
        calls.push({ actor, next, revision });
        return options.save ? options.save(actor, next, revision) : { granted: next, revision: revision + 1 };
      },
    },
  });
  return { calls, render: (actorId = A) => r.render(r.jsx(GeminiProcessingSettingsSection, { actorId })) };
}
for (const platform of ['ios', 'android']) {
  test(`${platform}: load gates the control, rapid duplicate taps serialize, and saved withdrawal is authoritative`, async () => {
    const pending = deferred(); const f = uiFixture(platform, { save: () => pending.promise });
    assert.equal(byType(f.render(), 'PrivacyToggle')[0].props.disabled, true);
    await settle();
    let toggle = byType(f.render(), 'PrivacyToggle')[0];
    assert.equal(toggle.props.value, true);
    toggle.props.onChange(false); toggle.props.onChange(false);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].revision, 2);
    assert.equal(byType(f.render(), 'PrivacyToggle')[0].props.busy, true);
    pending.resolve({ granted: false, revision: 3 }); await settle();
    toggle = byType(f.render(), 'PrivacyToggle')[0];
    assert.equal(toggle.props.value, false); assert.equal(toggle.props.busy, false);
  });
  test(`${platform}: failed/ambiguous save shows unknown status and requires reread, no false rollback`, async () => {
    const f = uiFixture(platform, { save: async () => { throw Error('offline'); } });
    f.render(); await settle(); byType(f.render(), 'PrivacyToggle')[0].props.onChange(false); await settle();
    const tree = f.render();
    assert.equal(byType(tree, 'PrivacyToggle')[0].props.disabled, true);
    assert.match(textContent(tree), /could not verify/);
    byType(tree, 'SecondaryButton')[0].props.onPress(); await settle();
    assert.equal(byType(f.render(), 'PrivacyToggle')[0].props.value, true);
  });
  test(`${platform}: superseded actor read/save cannot overwrite the next account`, async () => {
    const pending = deferred(); const f = uiFixture(platform, { save: () => pending.promise });
    f.render(A); await settle(); byType(f.render(A), 'PrivacyToggle')[0].props.onChange(false);
    f.render(B); await settle();
    pending.resolve({ granted: false, revision: 3 }); await settle();
    assert.equal(byType(f.render(B), 'PrivacyToggle')[0].props.value, true);
    assert.equal(f.calls[0].actor, A);
  });
}
test('the existing Privacy route mounts the control and source retains the accessible shared toggle pattern', () => {
  assert.match(readSource('app/privacy.tsx'), /<GeminiProcessingSettingsSection actorId=\{user\?\.id \?\? null\}/);
  assert.match(readSource('components/PrivacyToggle.tsx'), /accessibilityRole="switch"/);
  assert.match(readSource('components/settings/GeminiProcessingSettingsSection.tsx'), /accessibilityRole="alert"/);
});

const permissionFailures = [
  ['HTTP 500', async () => ({ data: null, error: { status: 500, message: 'upstream internal details' } })],
  ['HTTP 429', async () => ({ data: null, error: { status: 429, message: 'upstream rate limit details' } })],
  ['timeout', async () => { throw new DOMException('upstream timeout details', 'TimeoutError'); }],
  ['malformed JSON', async () => { throw new SyntaxError('upstream invalid JSON details'); }],
  ['empty body', async () => ({ data: null, error: null })],
  ['valid JSON with wrong schema', async () => ({ data: { status: 'saved' }, error: null })],
];
for (const platform of ['ios', 'android']) {
  for (const [failure, respond] of permissionFailures) {
    test(`${platform}: mounted permission control and real service fail closed on ${failure}`, async () => {
      const service = serviceFixture(respond);
      const f = uiFixture(platform, {
        save: (actor, next, revision) => service.setGeminiProcessingPermission(actor, next, revision),
      });
      f.render(A); await settle();
      byType(f.render(A), 'PrivacyToggle')[0].props.onChange(false);
      await settle();
      const tree = f.render(A);
      assert.equal(service.calls.length, 1, 'one intent must not amplify into retries');
      assert.equal(byType(tree, 'PrivacyToggle')[0].props.disabled, true);
      assert.equal(byType(tree, 'PrivacyToggle')[0].props.busy, false);
      assert.match(textContent(tree), /could not verify/);
      assert.doesNotMatch(textContent(tree), /upstream|permission (?:was )?saved|withdrawal (?:was )?saved|successfully/i,
        'no raw details or affirmative success claim; the uncertainty message may refer to a saved permission');
      assert.equal(byType(tree, 'SecondaryButton').length, 1, 'authority reread remains available');
    });
  }
}
