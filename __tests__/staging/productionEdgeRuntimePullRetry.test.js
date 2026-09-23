const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const LIB = path.join(ROOT, 'scripts', 'lib', 'supabase-deploy-retry.mjs');

function pathToFileUrl(file) {
  const normalized = path.resolve(file).replace(/\\/g, '/');
  return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`;
}

const loadLib = () => import(pathToFileUrl(LIB));

function ghcrThrottle() {
  const error = new Error('Command failed: supabase functions deploy example');
  error.stderr = [
    "Unable to find image 'ghcr.io/supabase/edge-runtime:v1.74.2' locally",
    'docker: error pulling image configuration: download failed after attempts=1:',
    'toomanyrequests: retry-after: 333.011us',
    'failed to bundle function: exit 125',
  ].join('\n');
  return error;
}

test('retries only the pre-upload GHCR Edge Runtime pull throttle', async () => {
  const { runWithTransientEdgeRuntimePullRetry } = await loadLib();
  let calls = 0;
  const delays = [];

  const result = await runWithTransientEdgeRuntimePullRetry(
    () => {
      calls += 1;
      if (calls < 3) throw ghcrThrottle();
      return 'deployed';
    },
    {
      attempts: 4,
      baseDelayMs: 10,
      sleep: async (ms) => delays.push(ms),
    },
  );

  assert.equal(result, 'deployed');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [10, 20]);
});

test('does not retry an unrelated deploy failure', async () => {
  const { runWithTransientEdgeRuntimePullRetry } = await loadLib();
  let calls = 0;
  const denied = new Error('HTTP 403: deployment denied');

  await assert.rejects(
    runWithTransientEdgeRuntimePullRetry(
      () => {
        calls += 1;
        throw denied;
      },
      { sleep: async () => assert.fail('unrelated failures must not sleep or retry') },
    ),
    denied,
  );

  assert.equal(calls, 1);
});

test('stops after the configured number of transient attempts', async () => {
  const { runWithTransientEdgeRuntimePullRetry } = await loadLib();
  let calls = 0;

  await assert.rejects(
    runWithTransientEdgeRuntimePullRetry(
      () => {
        calls += 1;
        throw ghcrThrottle();
      },
      { attempts: 3, baseDelayMs: 1, sleep: async () => {} },
    ),
    /supabase functions deploy/,
  );

  assert.equal(calls, 3);
});

test('the classifier requires the image, throttle, and pre-upload bundle failure signals', async () => {
  const { isTransientEdgeRuntimePullFailure } = await loadLib();

  assert.equal(isTransientEdgeRuntimePullFailure(ghcrThrottle()), true);
  assert.equal(
    isTransientEdgeRuntimePullFailure(new Error('toomanyrequests while calling an unrelated API')),
    false,
  );
  assert.equal(
    isTransientEdgeRuntimePullFailure(
      new Error('ghcr.io/supabase/edge-runtime failed after bundle upload'),
    ),
    false,
  );
});
