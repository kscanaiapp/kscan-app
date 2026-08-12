'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');

test('dynamic Expo config attributes mobile release, source, build, platform environment, and replay-off', () => {
  const previous = {
    KSCAN_RELEASE_ID: process.env.KSCAN_RELEASE_ID,
    KSCAN_SOURCE_SHA: process.env.KSCAN_SOURCE_SHA,
    KSCAN_OBSERVABILITY_ENVIRONMENT: process.env.KSCAN_OBSERVABILITY_ENVIRONMENT,
  };
  try {
    process.env.KSCAN_RELEASE_ID = 'staging-build29-test';
    process.env.KSCAN_SOURCE_SHA = 'a'.repeat(40);
    process.env.KSCAN_OBSERVABILITY_ENVIRONMENT = 'staging';
    delete require.cache[require.resolve('../app.config.js')];
    const resolveConfig = require('../app.config.js');
    const config = resolveConfig({ config: {
      version: '1.0.1',
      ios: { buildNumber: '23' },
      android: { versionCode: 23 },
      extra: { eas: { projectId: 'test' } },
    } });
    assert.deepEqual(config.extra.observability, {
      contractVersion: 'build29-observability-v1',
      environment: 'staging',
      releaseId: 'staging-build29-test',
      sourceSha: 'a'.repeat(40),
      sourceAttributionState: 'VERIFIABLE',
      replayEnabled: false,
    });
    assert.equal(config.version, '1.0.1');
    assert.equal(config.ios.buildNumber, '23');
    assert.equal(config.android.versionCode, 23);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('production replay remains off even with malformed enable-like environment input', () => {
  const previous = {
    KSCAN_RELEASE_ID: process.env.KSCAN_RELEASE_ID,
    KSCAN_SOURCE_SHA: process.env.KSCAN_SOURCE_SHA,
    KSCAN_OBSERVABILITY_ENVIRONMENT: process.env.KSCAN_OBSERVABILITY_ENVIRONMENT,
    KSCAN_REPLAY_ENABLED: process.env.KSCAN_REPLAY_ENABLED,
  };
  try {
    process.env.KSCAN_RELEASE_ID = 'production-build29-test';
    process.env.KSCAN_SOURCE_SHA = 'd'.repeat(40);
    process.env.KSCAN_OBSERVABILITY_ENVIRONMENT = 'production';
    process.env.KSCAN_REPLAY_ENABLED = 'true';
    delete require.cache[require.resolve('../app.config.js')];
    const resolveConfig = require('../app.config.js');
    const config = resolveConfig({ config: { extra: {} } });
    assert.equal(config.extra.observability.environment, 'production');
    assert.equal(config.extra.observability.replayEnabled, false);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('build environment validation rejects missing attribution and cross-environment routing', async () => {
  const module = await import(pathToFileURL(path.join(ROOT, 'scripts/verify-observability-build-env.mjs')));
  assert.equal(module.validateObservabilityBuildEnvironment({
    KSCAN_OBSERVABILITY_ENVIRONMENT: 'staging',
    KSCAN_RELEASE_ID: 'release-test',
    EAS_BUILD_GIT_COMMIT_HASH: 'b'.repeat(40),
    EAS_BUILD_PROFILE: 'staging',
    EAS_BUILD_ID: 'build-test-1',
  }).ok, true);
  assert.equal(module.validateObservabilityBuildEnvironment({
    KSCAN_OBSERVABILITY_ENVIRONMENT: 'production',
    KSCAN_RELEASE_ID: 'release-test',
    EAS_BUILD_GIT_COMMIT_HASH: 'b'.repeat(40),
    EAS_BUILD_PROFILE: 'staging',
    EAS_BUILD_ID: 'build-test-1',
  }).ok, false);
  assert.equal(module.validateObservabilityBuildEnvironment({
    KSCAN_OBSERVABILITY_ENVIRONMENT: 'staging',
    EAS_BUILD_PROFILE: 'staging',
  }).ok, false);
});

test('source map manifest is release-bound, checksummed, and upload-blocked without a provider', async () => {
  const module = await import(pathToFileURL(path.join(ROOT, 'scripts/export-observability-sourcemaps.mjs')));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-sourcemaps-'));
  try {
    fs.writeFileSync(path.join(temp, 'index.js'), 'console.log("ok")');
    fs.writeFileSync(path.join(temp, 'index.js.map'), JSON.stringify({ version: 3, sources: ['app.ts'] }));
    const manifest = module.buildSourceMapManifest(temp, {
      releaseId: 'release-test',
      sourceSha: 'c'.repeat(40),
      environment: 'staging',
      distribution: 'staging',
      buildIdentifier: 'build-test-1',
    });
    assert.equal(manifest.releaseId, 'release-test');
    assert.equal(manifest.sourceSha, 'c'.repeat(40));
    assert.equal(manifest.environment, 'staging');
    assert.equal(manifest.distribution, 'staging');
    assert.equal(manifest.buildIdentifier, 'build-test-1');
    assert.equal(manifest.uploadState, 'BLOCKED_NEW_PROVIDER_CONFIGURATION');
    assert.equal(manifest.files.length, 2);
    assert.ok(manifest.files.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('critical mobile paths propagate canonical correlation headers', () => {
  for (const file of [
    'services/scanIdentification.ts',
    'services/textScanEdge.ts',
    'services/style-chat/providers/edgeStyleChatProvider.ts',
    'services/styleOutfits.ts',
    'services/privateDressingRoomEliseClient.ts',
  ]) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(source, /createCorrelationContext\(/, `${file} creates correlation context`);
    assert.match(source, /headers:\s*correlationHeaders\(correlation\)/, `${file} propagates headers`);
  }
});

test('account switch and sign-out reset correlation state', () => {
  const source = fs.readFileSync(path.join(ROOT, 'contexts/AuthSessionContext.tsx'), 'utf8');
  assert.match(source, /function resetActorScopedRuntimeState[\s\S]*resetCorrelationContext\(\)/);
  assert.match(source, /const signOut[\s\S]*resetActorScopedRuntimeState\(null\)/);
});

test('representative Edge Functions wrap every response with correlation', () => {
  for (const file of [
    'supabase/functions/scan-identify/index.ts',
    'supabase/functions/stylechat-generate/index.ts',
    'supabase/functions/style-outfit-generate/index.ts',
  ]) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(source, /observeEdgeRequest\(req,/);
    assert.match(source, /x-kscan-request-id, traceparent/);
  }
});

test('governed health contract remains provider-free and release-aligned', () => {
  const health = fs.readFileSync(path.join(ROOT, 'supabase/functions/staging-health/index.ts'), 'utf8');
  assert.match(health, /\/health\/live/);
  assert.match(health, /\/health\/ready/);
  assert.match(health, /\/version/);
  assert.match(health, /KSCAN_RELEASE_ID/);
  assert.match(health, /KSCAN_SOURCE_SHA/);
  assert.doesNotMatch(health, /GEMINI_API_KEY|OPENROUTER_API_KEY/);
});
