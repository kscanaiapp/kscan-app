const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ROOT,
  loadEngine,
  loadAdapter,
  executableSource,
} = require('./fixtures/avatarEngineHarness');

const ENGINE_DIR = path.join(ROOT, 'services', 'avatars', 'engine');

function engineSourceFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) files.push(full);
    }
  };
  walk(ENGINE_DIR);
  return files;
}

/**
 * Engine sources as EXECUTABLE code — comments and type-only imports removed.
 *
 * Scanning raw text would fail on the doc comments that document these very
 * guarantees ("the engine never touches Supabase" contains "Supabase"). The
 * ban is on coupling in code, so the scanners read compiled output.
 */
function readEngineSources() {
  return engineSourceFiles().map((file) => ({
    file: path.relative(ROOT, file),
    text: executableSource(path.relative(ROOT, file).split(path.sep).join('/')),
  }));
}

test('engine core loads with every non-relative import forbidden', () => {
  // The harness throws on any bare specifier, so simply loading the engine
  // proves it has no runtime dependency on React, React Native, Expo,
  // Supabase, ElevenLabs, a store, a navigator or an analytics transport.
  const engine = loadEngine();
  assert.equal(typeof engine.AvatarRuntime, 'function');
  assert.equal(typeof engine.validateAvatarPackage, 'function');
  assert.equal(engine.AVATAR_ENGINE_CONTRACT_VERSION, 2);
});

test('engine core contains no host or platform coupling', () => {
  const forbidden = [
    { label: 'react', pattern: /from\s+['"]react['"]/ },
    { label: 'react-native', pattern: /from\s+['"]react-native['"]/ },
    { label: 'expo', pattern: /from\s+['"]expo[-/]/ },
    { label: 'expo-audio', pattern: /expo-audio/ },
    { label: 'expo-av', pattern: /expo-av/ },
    { label: 'supabase', pattern: /supabase/i },
    { label: 'elevenlabs', pattern: /elevenlabs/i },
    { label: 'stylechat', pattern: /stylechat/i },
    { label: 'AppState', pattern: /\bAppState\b/ },
    { label: 'navigation', pattern: /expo-router|@react-navigation/ },
    { label: 'environment variable', pattern: /process\.env/ },
    { label: 'asset require', pattern: /require\s*\(/ },
    { label: 'store import', pattern: /from\s+['"][^'"]*stores\// },
    { label: 'component import', pattern: /from\s+['"][^'"]*components\// },
  ];
  const failures = [];
  for (const { file, text } of readEngineSources()) {
    for (const { label, pattern } of forbidden) {
      if (pattern.test(text)) failures.push(`${file}: ${label}`);
    }
  }
  assert.deepEqual(failures, [], `engine core must stay host-neutral:\n${failures.join('\n')}`);
});

test('engine core owns no clock, timer, subscription or animation loop', () => {
  const forbidden = [
    { label: 'requestAnimationFrame', pattern: /requestAnimationFrame/ },
    { label: 'cancelAnimationFrame', pattern: /cancelAnimationFrame/ },
    { label: 'setInterval', pattern: /setInterval\s*\(/ },
    { label: 'setTimeout', pattern: /setTimeout\s*\(/ },
    { label: 'setImmediate', pattern: /setImmediate\s*\(/ },
    { label: 'Date.now', pattern: /Date\.now\s*\(/ },
    { label: 'new Date', pattern: /new\s+Date\s*\(/ },
    { label: 'performance.now', pattern: /performance\.now\s*\(/ },
    { label: 'addEventListener', pattern: /addEventListener\s*\(/ },
    { label: 'Math.random', pattern: /Math\.random\s*\(/ },
    { label: 'window', pattern: /\bwindow\b/ },
    { label: 'document', pattern: /\bdocument\b/ },
    { label: 'new Audio', pattern: /new\s+Audio\s*\(/ },
    { label: 'fetch', pattern: /\bfetch\s*\(/ },
  ];
  const failures = [];
  for (const { file, text } of readEngineSources()) {
    for (const { label, pattern } of forbidden) {
      if (pattern.test(text)) failures.push(`${file}: ${label}`);
    }
  }
  assert.deepEqual(
    failures,
    [],
    `speech-driven state must derive from host playback position, never engine elapsed time:\n${failures.join('\n')}`,
  );
});

test('engine emits no JSX and returns state rather than views', () => {
  const failures = [];
  for (const { file, text } of readEngineSources()) {
    if (/\.tsx$/.test(file)) failures.push(`${file}: engine core must not contain a component file`);
    if (/React\.createElement|<\/[A-Za-z]/.test(text)) failures.push(`${file}: engine core must not render`);
  }
  assert.deepEqual(failures, []);
});

test('teardown leaves no engine timer or subscription behind', () => {
  const { AvatarRuntime, AvatarEngineMetricsCollector } = loadEngine();
  const metrics = new AvatarEngineMetricsCollector();
  const runtime = new AvatarRuntime({ metrics });
  runtime.loadAvatar({ avatarId: 'stylist_portrait_05', capabilities: { base: true } });
  runtime.dispose();

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.activeEngineTimersAfterTeardown, 0);
  assert.equal(snapshot.activeEngineSubscriptionsAfterTeardown, 0);
  assert.equal(runtime.getDebugState().disposed, true);
});

// -- Audio critical path ------------------------------------------------------

test('no awaited engine work sits on the native audio-start path', () => {
  // The architectural requirement is that audio never waits for the engine.
  // These three files are the whole path from "speech response ready" to
  // "native playback begins", so proving the engine is absent from them proves
  // the engine cannot delay speech.
  const audioPathFiles = [
    'services/avatarSpeech.ts',
    'services/avatars/stylistAudioPlayback.ts',
    'services/avatars/stylistSpeechClient.ts',
    'services/avatars/speechAppState.ts',
    'stores/avatarSpeechStore.ts',
  ];
  const engineReference = /avatars\/engine|avatarEngineAdapter|avatarEnginePackages|AvatarRuntime/;
  for (const relative of audioPathFiles) {
    const text = executableSource(relative);
    assert.equal(
      engineReference.test(text),
      false,
      `${relative} must not reference the avatar engine — audio would then wait on visual work`,
    );
  }
});

test('the adapter is synchronous and cannot be awaited into the audio path', () => {
  const adapterText = executableSource('services/avatars/avatarEngineAdapter.ts');
  assert.equal(/\basync\b/.test(adapterText), false, 'adapter must expose no async surface');
  assert.equal(/\bawait\b/.test(adapterText), false, 'adapter must never await');
  assert.equal(/Promise\s*[<.]/.test(adapterText), false, 'adapter must return no promise');

  for (const { file, text } of readEngineSources()) {
    assert.equal(/\basync\b/.test(text), false, `${file}: engine must expose no async surface`);
    assert.equal(/\bawait\b/.test(text), false, `${file}: engine must never await`);
  }
});

test('adapter never requests speech, plays audio or touches a backend', () => {
  const adapter = loadAdapter();
  assert.equal(typeof adapter.AvatarEngineHostAdapter, 'function');

  const text = executableSource('services/avatars/avatarEngineAdapter.ts');
  const forbidden = [
    /speakAvatarMessage/,
    /stopAvatarSpeechPlayback/,
    /playStylistAudio/,
    /createAudioPlayer/,
    /requestStylistSpeech/,
    /supabase/i,
    /elevenlabs/i,
    /AppState/,
    /expo-router/,
    /process\.env/,
  ];
  for (const pattern of forbidden) {
    assert.equal(pattern.test(text), false, `adapter must not reference ${pattern}`);
  }
});

test('instrumentation carries counts and durations only', () => {
  const { AvatarEngineMetricsCollector } = loadEngine();
  const metrics = new AvatarEngineMetricsCollector();
  metrics.countEvent('ALIGNMENT_INPUT_EVENTS', 12);
  metrics.recordDuration('FRAME_CALC_MS', 0.4);

  const snapshot = metrics.snapshot();
  const serialized = JSON.stringify(snapshot);

  // Every leaf in the snapshot must be a number; a string leaf would be the
  // first way text, a voice id or a token could escape through telemetry.
  const assertNumeric = (value, keyPath) => {
    if (value === null || typeof value !== 'object') {
      assert.equal(typeof value, 'number', `${keyPath} must be numeric, got ${typeof value}`);
      return;
    }
    for (const [key, child] of Object.entries(value)) assertNumeric(child, `${keyPath}.${key}`);
  };
  assertNumeric(snapshot, 'snapshot');

  // Structural proof: the only strings in the payload are its own metric keys.
  const stringLiterals = serialized.match(/"[^"]*"/g) ?? [];
  const allowedKeys = new Set([
    ...Object.keys(snapshot).map((key) => `"${key}"`),
    ...Object.keys(snapshot.counters).map((key) => `"${key}"`),
    ...['"count"', '"p50"', '"p95"', '"max"'],
  ]);
  for (const literal of stringLiterals) {
    assert.ok(allowedKeys.has(literal), `unexpected string in metrics payload: ${literal}`);
  }
  assert.equal(snapshot.counters.ALIGNMENT_INPUT_EVENTS, 12);
  assert.equal(snapshot.frameCalcMs.count, 1);
});
