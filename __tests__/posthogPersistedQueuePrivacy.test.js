const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { runModule } = require('./helpers/componentRenderer');

const root = path.resolve(__dirname, '..');
const sdkRequire = createRequire(path.join(root, 'node_modules/posthog-react-native/dist/posthog-rn.js'));
const sdkPrototype = sdkRequire('@posthog/core').PostHogCore.prototype;
const actor = '11111111-1111-4111-8111-111111111111';
const rawUrl = 'kscan://auth/callback#access_token=SYNTHETIC_LEGACY_TOKEN';

async function fixture() {
  const names = ['EXPO_PUBLIC_POSTHOG_API_KEY', 'EXPO_PUBLIC_POSTHOG_HOST'];
  const previous = names.map((name) => process.env[name]);
  process.env[names[0]] = 'synthetic-key';
  process.env[names[1]] = 'https://analytics-fixture.invalid';
  let sdk;
  class SDK {
    constructor(_key, options) { this.options = options; this.actor = 'restored'; this.storage = new Map(); this.writes = 0; sdk = this; }
    ready() { return Promise.resolve(); }
    reset() { this.actor = 'anonymous'; }
    identify(id) { this.actor = id; }
    getDistinctId() { return this.actor; }
    getPersistedProperty(key) { return this.storage.get(key); }
    setPersistedProperty(key, value) { this.writes++; if (this.failWrites) throw Error('synthetic storage failure'); this.storage.set(key, value); }
    capture() {}
  }
  try {
    const modules = {
      'posthog-react-native': { __esModule: true, default: SDK, PostHogProvider() {} },
      './posthogIdentitySync': runModule('services/analytics/posthogIdentitySync.ts', {}, { jsx: false }),
    };
    for (const [file, setter] of [
      ['../closetTelemetry', 'setClosetTelemetrySink'], ['../kplus/kplusTelemetry', 'setKPlusAnalyticsSink'],
      ['../todayWithElise/analytics', 'setTodayWithEliseAnalyticsSink'], ['../voice/voiceTelemetry', 'setVoiceAnalyticsSink'],
      ['../vto/vtoTelemetry', 'setVtoAnalyticsSink'], ['../purchaseImport/purchaseImportTelemetry', 'setPurchaseImportTelemetrySink'],
      ['../blackOwnedDiscoveryTelemetry', 'setBlackOwnedDiscoveryAnalyticsSink'],
    ]) modules[file] = { [setter]: () => {} };
    const app = runModule('services/analytics/posthogClient.core.ts', modules, { jsx: false });
    app.syncPostHogIdentity(actor);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(sdk.options.before_send({ event: 'Application Opened', properties: { distinct_id: actor, url: rawUrl } }).properties.url, undefined);
    for (const name of ['normalizeMessage', 'normalizeTimestamp', 'normalizeTimestampForWire', 'persistedQueueKeyForRoute', 'getActiveQueueRoutes', 'getBatchEndpointPath', 'sendBatch']) {
      if (typeof sdkPrototype[name] === 'function') sdk[name] = sdkPrototype[name];
    }
    const route = sdk.getActiveQueueRoutes()[0];
    const key = sdk.persistedQueueKeyForRoute(route);
    assert.equal(key, 'queue', 'Inspect intentional SDK upgrades if the persisted queue key changes');
    const attempts = [];
    Object.assign(sdk, {
      apiKey: 'synthetic-key', host: 'https://analytics-fixture.invalid', disableCompression: true,
      maxBatchSize: 100, _dequeuedMessagesCount: 0, _events: { emit() {} }, _logger: { warn() {} },
      flushStorage: async () => {}, getCustomHeaders: () => ({}),
      fetchWithRetry: async (url, options) => {
        assert.equal(new URL(url).origin, 'https://analytics-fixture.invalid');
        attempts.push(JSON.parse(options.body));
      },
    });
    return { app, sdk, key, attempts, flush: () => sdkPrototype._flushRoute.call(sdk, route, []) };
  } finally {
    names.forEach((name, i) => previous[i] === undefined ? delete process.env[name] : process.env[name] = previous[i]);
  }
}

function queued(uuid) {
  return { message: { type: 'capture', event: 'Application Opened', ...(uuid ? { uuid } : {}),
    timestamp: '2026-10-29T12:00:00Z', properties: { distinct_id: actor, url: rawUrl, bounded_count: 3 } } };
}

for (const uuid of ['22222222-2222-4222-8222-222222222222', undefined]) {
  test(`actual SDK flush sanitizes restored URL and dequeues once (${uuid ? 'UUID' : 'legacy no UUID'})`, async () => {
    const f = await fixture();
    const original = queued(uuid);
    f.sdk.storage.set(f.key, [original]);
    await f.flush();
    assert.equal(f.attempts.length, 1);
    const event = f.attempts[0].batch[0];
    assert.equal(Object.hasOwn(event.properties, 'url'), false);
    assert.equal(JSON.stringify(f.attempts).includes('SYNTHETIC_LEGACY_TOKEN'), false);
    assert.equal(event.properties.distinct_id, actor);
    assert.equal(event.properties.bounded_count, 3);
    if (uuid) assert.equal(event.uuid, uuid);
    assert.equal(original.message.properties.url, rawUrl, 'Sanitize a copy before installing the cleaned queue');
    assert.equal(f.sdk.storage.get(f.key).length, 0);
    await f.flush();
    assert.equal(f.attempts.length, 1, 'An acknowledged event must not replay');
  });
}

test('failed cleanup persistence prevents transport, then recovers without duplicating the event', async () => {
  const f = await fixture();
  f.sdk.storage.set(f.key, [queued('33333333-3333-4333-8333-333333333333')]);
  f.sdk.failWrites = true;
  await assert.doesNotReject(f.flush());
  assert.equal(f.attempts.length, 0);
  assert.equal(f.sdk.storage.get(f.key)[0].message.properties.url, rawUrl);
  f.sdk.failWrites = false;
  await f.flush();
  assert.equal(f.attempts.length, 1);
  assert.equal(JSON.stringify(f.attempts).includes('SYNTHETIC_LEGACY_TOKEN'), false);
  assert.equal(f.sdk.storage.get(f.key).length, 0);
});

test('unrelated SDK keys and already safe queues retain identity and do not schedule writes', async () => {
  const f = await fixture();
  const properties = { url: 'local-config-value', marker: 3 };
  const safeQueue = [{ message: { event: 'closet_candidate_created', properties: { distinct_id: actor } } }];
  f.sdk.storage.set('props', properties);
  f.sdk.storage.set(f.key, safeQueue);
  assert.equal(f.sdk.getPersistedProperty('props'), properties);
  assert.equal(f.sdk.getPersistedProperty(f.key), safeQueue);
  assert.equal(f.sdk.writes, 0);
  assert.equal(f.sdk.getDistinctId(), actor);
});

test('empty or malformed persisted state is not fabricated into new events', async () => {
  const f = await fixture();
  for (const value of [undefined, null, {}, [], [null, { message: null }, { message: { properties: [] } }]]) {
    f.sdk.storage.set(f.key, value);
    assert.doesNotThrow(() => f.sdk.getPersistedProperty(f.key));
    assert.equal(f.sdk.getPersistedProperty(f.key), value);
  }
  assert.equal(f.sdk.writes, 0);
});
