// VTO privacy posture and integration wiring.
//
// Two kinds of assertion live here, and the difference matters:
//   - BEHAVIOURAL: the telemetry allowlist and the person-input path are
//     executed, because "it drops media" is a claim about what the code does.
//   - STRUCTURAL: config.toml, the deploy allowlist, the migration and the
//     actor-reset wiring are read as text, because they ARE text -- there is
//     no runtime in this suite that could execute a TOML file or a policy.
// A structural assertion is never used to stand in for a behavioural one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

/** Source with comments removed.
 *
 * Absence checks have to run against code, not prose: this project documents
 * what it deliberately does NOT do, so a naive text search finds the very
 * words the comment exists to disclaim and reports the discipline as a
 * violation of itself. */
function code(relative) {
  return read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Copies a value out of the vm realm so deepEqual compares structure rather
 *  than prototypes from two different contexts. */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadModule(relative, requireMap = {}) {
  const absPath = path.join(ROOT, relative);
  const output = ts.transpileModule(fs.readFileSync(absPath, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console,
    exports: mod.exports,
    module: mod,
    URL,
    Math,
    Number,
    require: (specifier) => {
      if (Object.prototype.hasOwnProperty.call(requireMap, specifier)) {
        return requireMap[specifier];
      }
      throw new Error(`Unexpected import in ${path.basename(absPath)}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: absPath }).runInContext(sandbox);
  return mod.exports;
}

// ── Telemetry: content-free by construction ──────────────────────────────────

function telemetryHarness() {
  const telemetry = loadModule('services/vto/vtoTelemetry.ts');
  const captured = [];
  telemetry.setVtoAnalyticsSink((event, payload) => captured.push({ event, payload }));
  return { telemetry, captured };
}

test('telemetry drops every media reference it is handed', () => {
  const { telemetry, captured } = telemetryHarness();
  telemetry.emitVtoEvent('vto_request_success', {
    origin: 'commerce_product',
    personUri: 'file:///cache/person-a.jpg',
    personDataUri: 'data:image/jpeg;base64,AAAA',
    signedUrl: 'https://storage.example.com/object?token=abc',
    resultDataUri: 'data:image/png;base64,BBBB',
    prompt: 'a photo of the user wearing a coat',
    rawProviderResponse: '{"image":"..."}',
  });
  assert.equal(captured.length, 1);
  assert.deepEqual(plain(captured[0].payload), { origin: 'commerce_product' });
});

test('telemetry drops a free-form value even under an allowlisted key', () => {
  const { telemetry, captured } = telemetryHarness();
  telemetry.emitVtoEvent('vto_request_failure', {
    failureCode: 'provider_timeout',
    // An allowlisted KEY carrying content is the subtler leak: the value has
    // to be checked too, not just the name.
    category: 'file:///cache/person-a.jpg',
    provider: 'data:image/png;base64,AAAA',
  });
  assert.deepEqual(plain(captured[0].payload), { failureCode: 'provider_timeout' });
});

test('telemetry drops unknown events entirely', () => {
  const { telemetry, captured } = telemetryHarness();
  telemetry.emitVtoEvent('vto_person_image_uploaded', { origin: 'commerce_product' });
  assert.equal(captured.length, 0);
});

test('telemetry never carries a raw user identifier', () => {
  const { telemetry, captured } = telemetryHarness();
  telemetry.emitVtoEvent('vto_request_start', {
    origin: 'commerce_product',
    userId: '11111111-2222-4333-8444-555555555555',
    email: 'someone@example.com',
  });
  assert.deepEqual(plain(captured[0].payload), { origin: 'commerce_product' });
});

test('dimension telemetry is bucketed, not exact', () => {
  const { telemetry } = telemetryHarness();
  // An exact pixel size is a weak fingerprint of one specific photo.
  assert.equal(telemetry.dimensionBucket(1024, 1280), 'le2048');
  assert.equal(telemetry.dimensionBucket(400, 300), 'le512');
  assert.equal(telemetry.dimensionBucket(null, null), 'unknown');
});

test('server telemetry has a closed field allowlist too', () => {
  const serverTelemetry = loadModule('supabase/functions/vto-generate/vtoTelemetry.ts', {
    '../_shared/deletion/common.ts': { logEvent: () => {} },
  });
  for (const forbidden of ['personDataUri', 'dataUri', 'userId', 'prompt', 'apiKey', 'body']) {
    assert.ok(
      !serverTelemetry.VTO_LOG_FIELDS.includes(forbidden),
      `${forbidden} must not be loggable`,
    );
  }
  assert.ok(serverTelemetry.VTO_LOG_FIELDS.includes('uid'), 'the short user id is the only id');
});

// ── Person image: the privacy boundary ───────────────────────────────────────

function personInputHarness(overrides = {}) {
  const cleaned = [];
  const clientTypes = loadModule('types/vto.ts');
  const mod = loadModule('services/vto/vtoPersonInput.ts', {
    'expo-image-picker': {},
    '../privacyImageUpload': {
      cleanupSanitizedImage: (uri) => {
        cleaned.push(uri);
        return Promise.resolve();
      },
      compressSanitizedImageForAnalysis: () =>
        Promise.resolve({ base64: 'data:image/jpeg;base64,AAAA', uri: 'file:///cache/c.jpg' }),
      prepareImageForPrivacyUpload: () =>
        Promise.resolve({
          sanitizedUri: 'file:///cache/sanitized.jpg',
          width: 1024,
          height: 1280,
          policy: { metadataStripped: true, sanitizerVersion: 'test-1.0.0' },
        }),
      PrivacyPrepareError: class PrivacyPrepareError extends Error {},
      ...overrides,
    },
    '../../types/vto': clientTypes,
  });
  return { mod, cleaned };
}

function picker(result) {
  return {
    requestMediaLibraryPermissionsAsync: () => Promise.resolve({ status: 'granted' }),
    launchImageLibraryAsync: () => Promise.resolve(result),
  };
}

test('a chosen photo is only accepted once the sanitizer reports it stripped metadata', async () => {
  const { mod } = personInputHarness();
  const outcome = await mod.pickVtoPersonInput({
    picker: picker({ canceled: false, assets: [{ uri: 'file:///photos/1.jpg' }] }),
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.person.metadataStripped, true);
  assert.equal(outcome.person.source, 'photo_library');
});

test('a sanitizer that admits it did not strip metadata blocks the upload', async () => {
  const { mod, cleaned } = personInputHarness();
  const outcome = await mod.pickVtoPersonInput({
    picker: picker({ canceled: false, assets: [{ uri: 'file:///photos/1.jpg' }] }),
    prepare: () =>
      Promise.resolve({
        sanitizedUri: 'file:///cache/unsanitized.jpg',
        width: 10,
        height: 10,
        policy: { metadataStripped: false, sanitizerVersion: 'x' },
      }),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'invalid_person_input');
  assert.ok(cleaned.includes('file:///cache/unsanitized.jpg'), 'the rejected derivative is deleted');
});

test('cancelling the picker is a no-op, not an error state', async () => {
  const { mod } = personInputHarness();
  const outcome = await mod.pickVtoPersonInput({
    picker: picker({ canceled: true, assets: null }),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'cancelled');
});

test('a denied photo permission never reaches the sanitizer', async () => {
  const { mod } = personInputHarness();
  let prepared = false;
  const outcome = await mod.pickVtoPersonInput({
    picker: {
      requestMediaLibraryPermissionsAsync: () => Promise.resolve({ status: 'denied' }),
      launchImageLibraryAsync: () => {
        throw new Error('picker must not open');
      },
    },
    prepare: () => {
      prepared = true;
      return Promise.resolve({});
    },
  });
  assert.equal(outcome.reason, 'permission_denied');
  assert.equal(prepared, false);
});

test('an oversized payload is refused before transport', async () => {
  const { mod } = personInputHarness();
  const outcome = await mod.buildVtoPersonPayload(
    { sanitizedUri: 'file:///cache/sanitized.jpg' },
    { compress: () => Promise.resolve({ base64: 'A'.repeat(3_000_000), uri: 'file:///cache/c.jpg' }) },
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'invalid_person_input');
});

test('the intake never reads an avatar, Closet, or previously-saved photo', () => {
  const source = code('services/vto/vtoPersonInput.ts');
  for (const forbidden of ['avatar', 'closet', 'savedScan', 'profilePhoto', 'previousResult']) {
    assert.ok(
      !new RegExp(forbidden, 'i').test(source),
      `person input must not reference ${forbidden}`,
    );
  }
});

test('VTO does not route person media through the passthrough sanitizer', () => {
  // services/privacyImageSanitizer.js returns its input unchanged. Using it
  // would look like sanitation while performing none.
  for (const file of [
    'services/vto/vtoPersonInput.ts',
    'services/vto/vtoRequestStore.ts',
    'components/vto/VirtualTryOnSheet.tsx',
  ]) {
    assert.ok(!code(file).includes('privacyImageSanitizer'), `${file} must not import it`);
  }
  assert.ok(read('services/vto/vtoPersonInput.ts').includes('prepareImageForPrivacyUpload'));
});

test('the UI does not claim a privacy property the pipeline does not have', () => {
  const sheet = read('components/vto/VirtualTryOnSheet.tsx');
  // Read WITH comments here: an overclaim in a comment is still an overclaim
  // somebody will copy into product copy later.
  for (const overclaim of ['zero-knowledge', 'anonymous', 'face is blurred', 'never leaves']) {
    assert.ok(!sheet.toLowerCase().includes(overclaim), `must not claim: ${overclaim}`);
  }
  assert.ok(sheet.includes('metadata'), 'the honest claim is stated');
});

// ── No credentials on the client ─────────────────────────────────────────────

test('no VTO client module carries a provider credential or endpoint', () => {
  const clientFiles = [
    'types/vto.ts',
    'services/vto/vtoClient.ts',
    'services/vto/vtoEligibility.ts',
    'services/vto/vtoFailures.ts',
    'services/vto/vtoFeatureControl.ts',
    'services/vto/vtoPersonInput.ts',
    'services/vto/vtoRequestStore.ts',
    'services/vto/vtoTelemetry.ts',
    'hooks/useVirtualTryOn.ts',
    'hooks/useVtoAvailability.ts',
    'components/vto/TryItOnEntry.tsx',
    'components/vto/VirtualTryOnSheet.tsx',
  ];
  for (const file of clientFiles) {
    const source = code(file);
    for (const pattern of [/RAPIDAPI/i, /api[_-]?key/i, /x-rapidapi/i, /Bearer sk-/i, /\.p\.rapidapi\.com/i]) {
      assert.ok(!pattern.test(source), `${file} must not contain ${pattern}`);
    }
  }
});

// ── Structural wiring ────────────────────────────────────────────────────────

test('the actor boundary resets VTO state', () => {
  const context = read('contexts/AuthSessionContext.tsx');
  assert.ok(context.includes("import { resetVtoRequestState } from '../services/vto/vtoRequestStore'"));
  const resetFn = context.slice(
    context.indexOf('function resetActorScopedRuntimeState'),
    context.indexOf('export function AuthSessionProvider'),
  );
  assert.ok(resetFn.includes('resetVtoRequestState();'), 'must run inside the actor reset');
});

test('the Edge Function requires a verified JWT at the platform gate', () => {
  const config = read('supabase/config.toml');
  const section = config.slice(config.indexOf('[functions.vto-generate]'));
  assert.ok(section.startsWith('[functions.vto-generate]'), 'the function must be declared');
  // Split on /\r?\n/: core.autocrlf is true here, so the working tree is CRLF
  // even though the committed bytes are LF. A '\n'-only split leaves a
  // trailing '\r' and turns this into a Windows-only failure.
  assert.match(section.split(/\r?\n/)[1], /^verify_jwt = true$/);
});

test('vto-generate is governed by the edge manifest', () => {
  const manifest = JSON.parse(read('config/edge-function-manifest.json'));
  assert.ok(manifest.parity.expectedFunctions.includes('vto-generate'));
});

test('vto-generate is NOT cleared for automatic deployment', () => {
  // A first deployment is an explicit decision, not a side effect of source
  // landing on a branch.
  const {
    STAGING_DEPLOYMENT_ALLOWLIST,
  } = require('../security/scripts/staging-deployment-allowlist.js');
  assert.ok(!STAGING_DEPLOYMENT_ALLOWLIST.includes('vto-generate'));
});

test('the VTO migration adds no table, bucket, or per-user storage', () => {
  const migration = read('supabase/migrations/20260830160000_vto_feature_control.sql');
  for (const forbidden of ['create table', 'storage.buckets', 'storage.objects', 'vto_requests', 'vto_results']) {
    assert.ok(
      !migration.toLowerCase().includes(forbidden),
      `ephemeral-first: the migration must not contain "${forbidden}"`,
    );
  }
  assert.ok(migration.includes("'vto_generation'"), 'it only adds the control row');
  assert.ok(migration.includes('"enabled": false'), 'and it ships disabled');
});

test('the VTO control policy widens app_config reads by exactly one key', () => {
  const migration = read('supabase/migrations/20260830160000_vto_feature_control.sql');
  // A second, additive policy -- not a rewrite of the feature-freeze one,
  // which would be a way to silently change an unrelated grant.
  assert.ok(migration.includes('create policy "Allow public read for VTO feature control"'));
  assert.ok(migration.includes("using (key = 'vto_generation')"));
  // The existing feature-freeze grant must not be dropped, replaced, or
  // widened -- only named in the table comment.
  assert.ok(!/drop\s+policy[^;]*feature freeze/i.test(migration));
  assert.ok(!/using\s*\(\s*key\s*=\s*'mobile_feature_freeze'/i.test(migration));
});

test('the Commerce seam is additive: the existing card actions survive', () => {
  const shelf = read('components/ProductShelf.tsx');
  assert.ok(shelf.includes('<TryItOnEntry'), 'the seam exists');
  assert.ok(shelf.includes('add-to-dressing-room-button'), 'the existing action is untouched');
  assert.ok(shelf.includes('selectCommerceDestination'), 'destination selection is unchanged');
});

test('VTO never becomes retailer-ranking authority', () => {
  for (const file of [
    'components/vto/TryItOnEntry.tsx',
    'components/vto/VirtualTryOnSheet.tsx',
    'services/vto/vtoRequestStore.ts',
    'supabase/functions/vto-generate/vtoHandler.ts',
  ]) {
    const source = code(file);
    for (const forbidden of ['sort(', 'rank', 'bestMatch', 'matchScore', 'reorder']) {
      assert.ok(!source.includes(forbidden), `${file} must not influence ranking (${forbidden})`);
    }
  }
});

test('no VTO surface infers anything about the body', () => {
  const vtoFiles = [
    'types/vto.ts',
    'services/vto/vtoEligibility.ts',
    'services/vto/vtoPersonInput.ts',
    'services/vto/vtoRequestStore.ts',
    'components/vto/VirtualTryOnSheet.tsx',
    'supabase/functions/vto-generate/vtoHandler.ts',
    'supabase/functions/vto-generate/vtoContract.ts',
  ];
  const forbidden = [
    'bmi',
    'bodyFat',
    'body_fat',
    'bodyComposition',
    'measurement',
    'sizeRecommendation',
    'recommendedSize',
    'attractiveness',
    'idealProportions',
    'healthStatus',
  ];
  for (const file of vtoFiles) {
    const source = code(file).toLowerCase();
    for (const term of forbidden) {
      assert.ok(!source.includes(term.toLowerCase()), `${file} must not mention ${term}`);
    }
  }
});

test('a try-on writes no Closet, purchase, or style-preference record', () => {
  const persistenceImports = [
    'services/library',
    'savedScansCloud',
    'savedScanMedia',
    'styleMemoryEvents',
    'closetMedia',
    'styleObjects',
  ];
  for (const file of [
    'services/vto/vtoRequestStore.ts',
    'services/vto/vtoClient.ts',
    'components/vto/VirtualTryOnSheet.tsx',
    'components/vto/TryItOnEntry.tsx',
  ]) {
    const source = read(file);
    for (const dependency of persistenceImports) {
      assert.ok(!source.includes(dependency), `${file} must not import ${dependency}`);
    }
  }
});

test('the entry point renders through the shared K+ gate, not a VTO paywall', () => {
  const entry = code('components/vto/TryItOnEntry.tsx');
  assert.ok(entry.includes('KPlusGate'), 'the one shared K+ surface');
  for (const forbidden of ['vto_paid', 'premiumVto', 'isVtoSubscriber', 'vtoProduct']) {
    assert.ok(!entry.includes(forbidden), `must not invent ${forbidden}`);
  }
});

test('no VTO module invents a second entitlement key', () => {
  const files = [
    'services/vto/vtoEligibility.ts',
    'hooks/useVtoAvailability.ts',
    'supabase/functions/vto-generate/vtoEntitlement.ts',
  ];
  for (const file of files) {
    const source = code(file);
    for (const forbidden of ['vto_paid', 'premium_vto', 'isVtoSubscriber', 'vto_entitlement']) {
      assert.ok(!source.includes(forbidden), `${file} must not define ${forbidden}`);
    }
  }
  assert.ok(
    read('supabase/functions/vto-generate/vtoEntitlement.ts').includes("'k_plus'"),
    'the existing K+ key is the authority',
  );
});
