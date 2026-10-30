const test = require('node:test');
const assert = require('node:assert/strict');
const { runModule } = require('./helpers/componentRenderer');

function fixture() {
  const previous = [process.env.EXPO_PUBLIC_POSTHOG_API_KEY, process.env.EXPO_PUBLIC_POSTHOG_HOST];
  process.env.EXPO_PUBLIC_POSTHOG_API_KEY = 'synthetic-fixture';
  process.env.EXPO_PUBLIC_POSTHOG_HOST = 'https://example.invalid';
  let sdk;
  class SDK {
    constructor(_key, options) { this.options = options; this.actor = 'restored-prior-actor'; this.sent = []; this.resetCount = 0; sdk = this; }
    ready() { return this.readyImpl ? this.readyImpl() : Promise.resolve(); }
    reset() { this.resetCount++; if (this.failReset) throw Error('reset failed'); this.actor = 'anonymous-fixture'; }
    identify(id) {
      if (this.failIdentify) throw Error('identify failed');
      this.actor = id; this.capture('$identify');
    }
    getDistinctId() { if (this.failRead) throw Error('read failed'); return this.actor; }
    capture(event, properties = {}) {
      const result = this.options.before_send({ event, properties: { ...properties, distinct_id: this.actor } });
      if (result) this.sent.push(result);
    }
  }
  try {
    const identity = runModule('services/analytics/posthogIdentitySync.ts', {}, { jsx: false });
    const setters = {};
    const modules = {
      'posthog-react-native': { __esModule: true, default: SDK, PostHogProvider() {} },
      './posthogIdentitySync': identity,
    };
    for (const [file, setter] of [
      ['../closetTelemetry', 'setClosetTelemetrySink'], ['../kplus/kplusTelemetry', 'setKPlusAnalyticsSink'],
      ['../todayWithElise/analytics', 'setTodayWithEliseAnalyticsSink'], ['../voice/voiceTelemetry', 'setVoiceAnalyticsSink'],
      ['../vto/vtoTelemetry', 'setVtoAnalyticsSink'], ['../purchaseImport/purchaseImportTelemetry', 'setPurchaseImportTelemetrySink'],
      ['../blackOwnedDiscoveryTelemetry', 'setBlackOwnedDiscoveryAnalyticsSink'],
    ]) modules[file] = { [setter]: (sink) => { setters[setter] = sink; } };
    const core = runModule('services/analytics/posthogClient.core.ts', modules, { jsx: false });
    core.bridgeAllTelemetrySinks();
    return { core, sdk, setters };
  } finally {
    for (const [i, key] of ['EXPO_PUBLIC_POSTHOG_API_KEY', 'EXPO_PUBLIC_POSTHOG_HOST'].entries()) {
      if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i];
    }
  }
}
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('unverified startup blocks restored-identity feature and SDK lifecycle events', () => {
  const { core, sdk } = fixture();
  core.forwardTelemetryToPostHog('closet_candidate_created', {});
  sdk.capture('Application Opened');
  assert.equal(sdk.sent.length, 0);
});
for (const failure of ['failReset', 'failIdentify', 'failRead']) {
  test(`${failure}: account transition fails closed for unrelated feature sinks and SDK lifecycle, then recovers`, async () => {
    const { core, sdk, setters } = fixture();
    core.syncPostHogIdentity(A); await settle(); sdk.sent = [];
    sdk[failure] = true;
    assert.doesNotThrow(() => core.syncPostHogIdentity(B));
    await settle();
    setters.setClosetTelemetrySink('closet_candidate_created', {});
    setters.setKPlusAnalyticsSink('kplus_feature_exposed', {});
    sdk.capture('Application Backgrounded');
    assert.equal(sdk.sent.filter((e) => e.event !== '$identify').length, 0);
    assert.ok(sdk.sent.every((e) => e.properties.distinct_id === B));
    sdk[failure] = false; core.syncPostHogIdentity(B);
    await settle();
    setters.setClosetTelemetrySink('closet_candidate_created', {});
    setters.setKPlusAnalyticsSink('kplus_feature_exposed', {});
    assert.equal(sdk.sent.filter((e) => e.event !== '$identify').length, 2);
    assert.ok(sdk.sent.every((e) => e.properties.distinct_id === B));
  });
}
test('failed identify invalidates the previous success cache before returning to the former actor', async () => {
  const { core, sdk } = fixture();
  core.syncPostHogIdentity(A); await settle(); sdk.failIdentify = true; core.syncPostHogIdentity(B); await settle();
  sdk.failIdentify = false; core.syncPostHogIdentity(A); await settle(); sdk.sent = [];
  core.forwardTelemetryToPostHog('closet_candidate_created', {});
  assert.equal(sdk.sent.length, 1); assert.equal(sdk.sent[0].properties.distinct_id, A);
});
test('identified SDK events must match the verified actor; valid identify and anonymous reset remain supported', async () => {
  const { core, sdk } = fixture(); core.identifyPostHogUser(A); await settle();
  assert.equal(sdk.sent[0].event, '$identify');
  assert.equal(sdk.options.before_send({ event: 'fixture', properties: { distinct_id: B } }), null);
  core.resetPostHogUser(); await settle(); sdk.sent = []; sdk.capture('Application Opened');
  assert.equal(sdk.sent.length, 1); assert.equal(sdk.sent[0].properties.distinct_id, 'anonymous-fixture');
});
test('late SDK readiness for A cannot overwrite B, and initialization errors remain closed', async () => {
  const { core, sdk } = fixture();
  let releaseA, releaseB;
  const a = new Promise((resolve) => { releaseA = resolve; });
  const b = new Promise((resolve) => { releaseB = resolve; });
  let calls = 0; sdk.readyImpl = () => calls++ === 0 ? a : b;
  core.syncPostHogIdentity(A); await settle(); core.syncPostHogIdentity(B); await settle();
  releaseB(); await settle(); releaseA(); await settle();
  assert.equal(sdk.actor, B); assert.equal(sdk.resetCount, 1);
  sdk.sent = []; sdk.readyImpl = async () => { throw Error('initialization failed'); };
  core.syncPostHogIdentity(null); await settle(); sdk.capture('Application Backgrounded');
  assert.equal(sdk.sent.length, 0);
});
test('a successful-looking logout that retains the prior identified ID cannot capture', async () => {
  const { core, sdk } = fixture(); core.syncPostHogIdentity(A); await settle(); sdk.sent = [];
  sdk.reset = () => {}; core.resetPostHogUser(); await settle();
  core.forwardTelemetryToPostHog('kplus_feature_exposed', {}); sdk.capture('Application Backgrounded');
  assert.equal(sdk.sent.length, 0);
  core.resetPostHogUser(); await settle(); sdk.capture('Application Backgrounded');
  assert.equal(sdk.sent.length, 0, 'retry must not trust the unchanged old ID');
  sdk.reset = () => { sdk.actor = 'new-anonymous-fixture'; };
  core.resetPostHogUser(); await settle(); sdk.capture('Application Backgrounded');
  assert.equal(sdk.sent.length, 1, 'a verified reset can recover after the no-op');
});
test('startup anonymous sync must actually clear an unknown persisted SDK identity', async () => {
  const { core, sdk } = fixture(); sdk.reset = () => {};
  core.syncPostHogIdentity(null); await settle(); sdk.capture('Application Opened');
  assert.equal(sdk.sent.length, 0);
});
