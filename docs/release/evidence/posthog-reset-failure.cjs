const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const root = process.argv[2];
const { runModule } = require(path.join(root, '__tests__/helpers/componentRenderer'));
const savedKey = process.env.EXPO_PUBLIC_POSTHOG_API_KEY;
const savedHost = process.env.EXPO_PUBLIC_POSTHOG_HOST;
let sdk;
class FakePostHog {
  constructor(_key, options) { this.options = options; this.actor = null; this.failReset = false; this.sent = []; sdk = this; }
  identify(id) { this.actor = id; }
  ready() { return Promise.resolve(); }
  getDistinctId() { return this.actor ?? 'anonymous-fixture'; }
  reset() { if (this.failReset) throw Error('Synthetic SDK reset failure'); this.actor = null; }
  capture(event, properties) {
    const payload = { event, properties: { ...properties, distinct_id: this.actor } };
    const filtered = this.options.before_send ? this.options.before_send(payload) : payload;
    if (filtered) this.sent.push(filtered);
  }
}
async function main() { try {
  process.env.EXPO_PUBLIC_POSTHOG_API_KEY = 'synthetic-fixture';
  process.env.EXPO_PUBLIC_POSTHOG_HOST = 'https://example.invalid';
  const identity = runModule('services/analytics/posthogIdentitySync.ts', {}, { jsx: false });
  const core = runModule('services/analytics/posthogClient.core.ts', {
    'posthog-react-native': { __esModule: true, default: FakePostHog, PostHogProvider() {} },
    './posthogIdentitySync': identity,
    '../closetTelemetry': { setClosetTelemetrySink() {} },
    '../kplus/kplusTelemetry': { setKPlusAnalyticsSink() {} },
    '../todayWithElise/analytics': { setTodayWithEliseAnalyticsSink() {} },
    '../voice/voiceTelemetry': { setVoiceAnalyticsSink() {} },
    '../vto/vtoTelemetry': { setVtoAnalyticsSink() {} },
    '../purchaseImport/purchaseImportTelemetry': { setPurchaseImportTelemetrySink() {} },
    '../blackOwnedDiscoveryTelemetry': { setBlackOwnedDiscoveryAnalyticsSink() {} },
  }, { jsx: false });
  core.syncPostHogIdentity('actor-A');
  for (let i = 0; i < 8; i++) await Promise.resolve();
  core.forwardTelemetryToPostHog('kplus_feature_exposed', { source: 'account' });
  assert.equal(sdk.sent.length, 1, 'positive control: configured verified actor captures');
  sdk.sent = [];
  sdk.failReset = true;
  core.syncPostHogIdentity('actor-B');
  for (let i = 0; i < 8; i++) await Promise.resolve();
  core.forwardTelemetryToPostHog('kplus_feature_exposed', { source: 'account' });
  const observed = { boundary: 'actual wrapper + identity helper, injected SDK reset failure', sent: sdk.sent,
    expected: 'No B event emitted under prior A identity when reset fails', environment: 'offline; no vendor/network',
    sourceSha: require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    sourceFileSha256: Object.fromEntries(['services/analytics/posthogClient.core.ts', 'services/analytics/posthogIdentitySync.ts'].map(file => [file, require('crypto').createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])),
    verdict: sdk.sent.length === 0 ? 'PASS' : 'FAIL' };
  fs.writeFileSync(path.join(__dirname, process.argv[3] || 'posthog-reset-failure-result.json'), JSON.stringify(observed, null, 2) + '\n');
  console.log(JSON.stringify(observed));
  assert.equal(sdk.sent.length, 0, 'failed identity reset must stop capture under the previous actor');
} finally {
  if (savedKey === undefined) delete process.env.EXPO_PUBLIC_POSTHOG_API_KEY; else process.env.EXPO_PUBLIC_POSTHOG_API_KEY = savedKey;
  if (savedHost === undefined) delete process.env.EXPO_PUBLIC_POSTHOG_HOST; else process.env.EXPO_PUBLIC_POSTHOG_HOST = savedHost;
}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
