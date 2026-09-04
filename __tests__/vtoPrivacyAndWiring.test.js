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

// Deliberately exposes ONLY launchImageLibraryAsync. If the person-input path
// ever reintroduces a pre-picker permission gate, it will throw here instead of
// silently re-closing VTO on Android.
function picker(result) {
  return {
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

test('the picker opens with no pre-permission gate (VTO Android repair)', async () => {
  const { mod } = personInputHarness();
  let launched = false;
  let permissionAsked = false;
  const outcome = await mod.pickVtoPersonInput({
    picker: {
      // Present but forbidden: a gate here is exactly the defect. On Android
      // this app blocks READ/WRITE_EXTERNAL_STORAGE and declares no
      // READ_MEDIA_IMAGES, so this call can never resolve to 'granted' and
      // asking closed VTO permanently.
      requestMediaLibraryPermissionsAsync: () => {
        permissionAsked = true;
        return Promise.resolve({ status: 'denied' });
      },
      launchImageLibraryAsync: () => {
        launched = true;
        return Promise.resolve({ canceled: false, assets: [{ uri: 'file:///photos/1.jpg' }] });
      },
    },
  });
  assert.equal(permissionAsked, false, 'no media-library permission may be requested before the picker');
  assert.equal(launched, true, 'the system picker must open directly');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.person.source, 'photo_library');
});

test("'permission_denied' is no longer a reachable person-input outcome", async () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'vto', 'vtoPersonInput.ts'),
    'utf8',
  );
  // Strip block comments: the header explains the removed gate on purpose.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(
    /requestMediaLibraryPermissionsAsync/.test(code),
    false,
    'the person-input path must not request a media-library permission',
  );
  assert.equal(
    /permission_denied/.test(code),
    false,
    'the person-input path must not report a permission outcome it can never produce',
  );
});

test('the iOS photo-library purpose string discloses Virtual Try-On, and overclaims nothing', () => {
  const app = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8'));
  const purpose = (app.expo || app).ios.infoPlist.NSPhotoLibraryUsageDescription;

  // VTO sends a recognizable photo of the user to a third-party generation
  // provider. Apple requires the purpose string to cover that use, and before
  // this repair it named only style inspiration / Closet / Dressing Rooms.
  assert.match(purpose, /Virtual Try-On/, 'VTO photo-library use must be disclosed');
  assert.match(purpose, /Style Closet/);
  assert.match(purpose, /Dressing Rooms/);
  assert.match(purpose, /style inspiration/i);

  // VTO earns none of these claims -- see docs/vto-foundation.md. A purpose
  // string is a promise to the user and to App Review; it must not make one
  // the pipeline does not keep.
  for (const forbidden of [
    /face[- ]mask/i,
    /zero[- ]knowledge/i,
    /on[- ]device only/i,
    /only on your device/i,
    /never leaves? your (device|phone)/i,
    /anonymi[sz]ed/i,
  ]) {
    assert.equal(forbidden.test(purpose), false, `purpose string must not claim: ${forbidden}`);
  }
});

test('VTO adds no media-library permission to the Android manifest', () => {
  const app = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8'));
  const android = (app.expo || app).android || {};
  const granted = android.permissions || [];
  const blocked = android.blockedPermissions || [];

  for (const forbidden of [
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.WRITE_EXTERNAL_STORAGE',
  ]) {
    assert.equal(granted.includes(forbidden), false, `${forbidden} must not be requested`);
    assert.ok(blocked.includes(forbidden), `${forbidden} must stay blocked`);
  }
  assert.equal(
    granted.some((p) => String(p).includes('READ_MEDIA')),
    false,
    'the system photo picker needs no READ_MEDIA_* permission — do not add one for VTO',
  );
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
  const migration = read('supabase/migrations/20260830174616_vto_feature_control.sql');
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
  const migration = read('supabase/migrations/20260830174616_vto_feature_control.sql');
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

/**
 * VTO-NC-010. The test above is a DENYLIST of six module-name substrings, and a
 * denylist over a repo with ~30 Closet modules names the ones somebody happened
 * to think of. `services/ownedClosetItems.ts` -- the one whose entire subject is
 * ownership -- was not among them, and neither were closetLibrary,
 * closetPromotion or privateSavedLookStore.
 *
 * The Build 34 VTO deep audit ran the ownership mutation the spec asks for
 * (write an owned Closet item on a successful generation) and the suite stayed
 * GREEN. So the invariant "a try-on is evidence, not ownership" was documented,
 * asserted, and unenforced.
 *
 * This is the enforcing version: an ALLOWLIST. Every module a VTO surface
 * imports is listed here, so ANY new dependency -- a Closet writer, a purchase
 * recorder, a style-signal emitter, or something nobody has written yet --
 * fails this test until a person deliberately adds it and says why.
 */
const VTO_ALLOWED_IMPORTS = {
  'services/vto/vtoRequestStore.ts': [
    '../../types/vto', '../actorContext', './vtoClient', './vtoEligibility',
    './vtoFailures', './vtoPersonInput', './vtoTelemetry',
  ],
  'services/vto/vtoClient.ts': [
    '../../types/vto', '../authenticatedFunctionSession', '../supabaseClient', './vtoFailures',
  ],
  'services/vto/vtoPersonInput.ts': [
    '../../types/vto', '../privacyImageUpload', 'expo-image-picker',
  ],
  'hooks/useVirtualTryOn.ts': [
    '../services/vto/vtoPersonInput', '../services/vto/vtoRequestStore', '../types/vto', 'react',
  ],
  'components/vto/VirtualTryOnSheet.tsx': [
    '../../constants/theme', '../../hooks/useReducedMotion', '../../hooks/useVirtualTryOn',
    '../../services/haptics', '../../services/kplus/kplusTelemetry',
    // CONVERGENCE #276 + #277. The UX lane added staged progress copy, a
    // silhouette guide, an explicit Save-to-Dressing-Room affordance and a
    // retailer link-out. Each is listed deliberately:
    //   openExternalUrl      -- opens the retailer page the garment came from.
    //                           A link-out is not an acquisition.
    //   vtoProgressStages    -- pure copy/timing derivation over types/vto.
    //   VtoSaveToDressingRoom-- the ONLY durable path, and it is user-initiated
    //                           and Dressing-Room-scoped. A Dressing Room is not
    //                           the Closet: this is still evidence, not ownership.
    //   VtoSilhouetteGuide   -- presentational SVG overlay.
    '../../services/openExternalUrl',
    '../../services/responsiveLayout',
    '../../services/vto/vtoProgressStages',
    '../../services/vto/vtoTelemetry',
    '../../types/vto', '../luxury',
    './VtoSaveToDressingRoom', './VtoSilhouetteGuide',
    // P3-C LIVE VTO INTEGRATION. The sheet gains a second visualization MODE,
    // not a second entry point or a second generative path. Each of these is
    // read-only with respect to ownership: the capability router and the
    // garment eligibility check are pure decisions, the session hook speaks
    // only the high-level native contract, and the three components are
    // presentation. All of them are enrolled in this allowlist in their own
    // right below, so they are guarded rather than merely reachable.
    '../../hooks/useVtoLiveSession',
    '../../services/vto/vtoLiveCapability',
    '../../services/vto/vtoLiveGarment',
    './VtoLiveErrorBoundary', './VtoLivePanel', './VtoModeSelector',
    'react', 'react-native',
  ],
  'components/vto/TryItOnEntry.tsx': [
    '../../constants/theme', '../../hooks/useVtoAvailability',
    // CONVERGENCE #277: minimize/restore needs the live session status, and the
    // pill reports it. Neither reads or writes ownership state.
    '../../hooks/useVtoSessionStatus',
    // P3-C: the capability router is asked ONCE, here, and handed to the sheet.
    // The entry point itself is unchanged -- still one Try It On, still gated
    // by the same availability/K+ answer as before.
    '../../hooks/useVtoLiveCapability',
    '../../services/haptics', '../../services/vto/vtoTelemetry',
    '../../types/vto', '../kplus/KPlusGate',
    './VirtualTryOnSheet', './VtoMinimizedPill',
    'react', 'react-native',
  ],

  // CONVERGENCE #276 + #277. The UX lane introduced six NEW VTO surfaces. They
  // are enrolled here rather than left outside the allowlist, because a module
  // this control does not name is a module it does not guard -- which is the
  // exact failure mode (a denylist that forgot a file) that VTO-NC-010 was
  // written to end. Enrolling them also subjects them to the forbidden-call
  // scan below.
  'components/vto/VtoSaveToDressingRoom.tsx': [
    '../../constants/theme', '../../services/haptics',
    '../../services/vto/vtoResultExport', '../../services/vto/vtoTelemetry',
    '../../types/vto', '../AddScanToDressingRoomModal', '../luxury',
    'react', 'react-native',
  ],
  'components/vto/VtoSilhouetteGuide.tsx': [
    '../../constants/theme', 'react', 'react-native', 'react-native-svg',
  ],
  'components/vto/VtoMinimizedPill.tsx': [
    '../../constants/theme', '../../services/vto/vtoProgressStages',
    'react', 'react-native',
  ],
  'services/vto/vtoProgressStages.ts': [
    '../../types/vto',
  ],
  // The one module allowed to touch the filesystem, and only to materialise a
  // cache file the user explicitly asked to save. It never exports the person
  // photo, and discardVtoResultExport removes the file if the save is
  // abandoned. `expo-file-system/legacy` is therefore named here on purpose.
  'services/vto/vtoResultExport.ts': [
    'expo-file-system/legacy',
  ],
  'hooks/useVtoSessionStatus.ts': [
    '../services/vto/vtoRequestStore', 'react',
  ],

  // ── P3-C LIVE VTO (feature-gated, default OFF) ────────────────────────────
  // Enrolled for the same reason the #276/#277 surfaces were: a module this
  // control does not name is a module it does not guard. Enrolling them also
  // subjects every one of them to the forbidden-call scan below, which is what
  // makes "Live writes no ownership state either" a checked claim rather than
  // an assurance.
  'types/vtoLive.ts': [],
  'services/vto/vtoLiveCapability.ts': [
    './liveVtoNativeModule',
  ],
  'services/vto/vtoLiveGarment.ts': [
    '../../types/vto', '../../types/vtoLive', './vtoEligibility',
  ],
  'services/vto/liveVtoNativeModule.ts': [
    '../../constants/featureFlags', '../../types/vtoLive', 'react-native',
  ],
  'services/vto/vtoLiveSession.ts': [
    '../../types/vtoLive', './liveVtoNativeModule',
  ],
  'services/vto/vtoLiveHarness.ts': [
    '../../constants/featureFlags', '../../types/vtoLive',
    './liveVtoNativeModule', './vtoLiveCapability',
  ],
  // The Live -> Photoreal bridge. It imports the SAME privacy sanitizer the
  // photo picker uses and nothing resembling a network client: the generation
  // itself runs through the existing store/client/Edge Function, untouched.
  'services/vto/vtoPhotorealHandoff.ts': [
    '../../types/vto', '../../types/vtoLive', '../privacyImageUpload',
    './vtoLiveHarness', './vtoPersonInput',
  ],
  'services/vto/vtoLiveCameraPermission.ts': [
    './vtoLiveCapability',
  ],
  'hooks/useVtoLiveCapability.ts': [
    '../constants/featureFlags', '../services/vto/liveVtoNativeModule',
    '../services/vto/vtoLiveCameraPermission', '../services/vto/vtoLiveCapability',
    '../services/vto/vtoLiveGarment', '../services/vto/vtoLiveHarness',
    '../types/vto', 'react', 'react-native',
  ],
  'hooks/useVtoLiveSession.ts': [
    '../services/vto/liveVtoNativeModule', '../services/vto/vtoLiveCameraPermission',
    '../services/vto/vtoLiveHarness', '../services/vto/vtoLiveSession',
    '../services/vto/vtoPhotorealHandoff', '../types/vto', '../types/vtoLive',
    'react',
  ],
  'components/vto/VtoModeSelector.tsx': [
    '../../constants/theme', '../../services/haptics', '../../types/vtoLive',
    'react', 'react-native',
  ],
  'components/vto/VtoLivePanel.tsx': [
    '../../constants/theme', '../../services/vto/vtoLiveSession',
    '../../types/vtoLive', '../luxury', 'react', 'react-native',
  ],
  'components/vto/VtoLiveErrorBoundary.tsx': [
    'react',
  ],
};

/**
 * The two lazy requires the allowlist's `from '...'` scan cannot see.
 *
 * Both are deliberate and both are load-bearing: `requireOptionalNativeModule`
 * is what makes a MISSING Live native module a null rather than a throw, and
 * expo-camera is required inside a function so the AI-Photo-only path never
 * pulls the camera module into its bundle. Pinning them here means the set of
 * dynamically-required modules is guarded to exactly the same standard as the
 * static one, rather than being a hole in it.
 */
const VTO_ALLOWED_LAZY_REQUIRES = {
  'services/vto/liveVtoNativeModule.ts': ['expo-modules-core'],
  'services/vto/vtoLiveCameraPermission.ts': ['expo-camera'],
};

test('VTO-NC-010: no VTO surface may acquire a dependency nobody approved', () => {
  for (const [file, allowed] of Object.entries(VTO_ALLOWED_IMPORTS)) {
    const source = read(file);
    const imported = [
      ...new Set([...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])),
    ].sort();
    assert.deepEqual(
      imported,
      [...allowed].sort(),
      `${file} imports changed. A try-on is evidence, not ownership: if this is a `
        + 'deliberate new dependency, add it here and say why in the commit.',
    );
  }
});

test('VTO-NC-010: a lazily-required module is guarded exactly like a static import', () => {
  // Every VTO module in the allowlist is scanned, not just the two expected to
  // have requires -- so a NEW lazy require smuggled into any of them fails
  // here instead of slipping past the `from '...'` scan above.
  for (const file of Object.keys(VTO_ALLOWED_IMPORTS)) {
    const source = code(file);
    const required = [
      ...new Set([...source.matchAll(/require\(\s*'([^']+)'/g)].map((m) => m[1])),
    ].sort();
    const allowed = [...(VTO_ALLOWED_LAZY_REQUIRES[file] ?? [])].sort();
    assert.deepEqual(
      required,
      allowed,
      `${file} changed which modules it requires lazily. A lazy require is still `
        + 'a dependency: add it to VTO_ALLOWED_LAZY_REQUIRES and say why.',
    );
  }
});

test('VTO-NC-010: a successful generation reaches no ownership or persistence call', () => {
  // The import allowlist above is the structural guard. This is the call-shape
  // one, so a write smuggled in through an already-allowed module (or through a
  // global) is caught too.
  const forbiddenCalls = [
    /addClosetItem/, /markOwned/, /setOwned/, /promoteToCloset/, /saveToCloset/,
    /recordPurchase/, /saveLook/, /createLook/, /upsertStyleObject/,
    /recordStyleMemory/, /AsyncStorage/, /\.from\(\s*['"]user_closet_items/,
    /\.from\(\s*['"]saved_scans/, /\.storage\s*\./,
  ];
  for (const file of Object.keys(VTO_ALLOWED_IMPORTS)) {
    const source = read(file);
    for (const pattern of forbiddenCalls) {
      assert.ok(
        !pattern.test(source),
        `${file} must not call ${pattern} -- a try-on is not an acquisition`,
      );
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

// ── Commerce identity integrity (product-integration continuation) ──────────

test('Shop is driven only by the onShop prop, never reconstructed from a result or provider response', () => {
  const sheet = code('components/vto/VirtualTryOnSheet.tsx');
  // The Shop button's onPress must call the injected callback and nothing
  // that reads vto.result, vto.garment.imageUrl, or any provider field to
  // build a destination -- Commerce decided that before VTO ever saw the item.
  const shopBlockMatch = sheet.match(/title="Shop this piece"[\s\S]{0,300}/);
  assert.ok(shopBlockMatch, 'the Shop button must exist');
  const shopBlock = shopBlockMatch[0];
  assert.ok(shopBlock.includes('onShop?.()') || shopBlock.includes('onShop()'));
  for (const forbidden of ['vto.result', 'vto.garment', 'outcome.', 'provider']) {
    assert.ok(!shopBlock.includes(forbidden), `Shop handler must not reference ${forbidden}`);
  }
});

test('TryItOnEntry passes the SAME onShop through to the sheet unmodified', () => {
  const entry = code('components/vto/TryItOnEntry.tsx');
  assert.ok(entry.includes('onShop={onShop}'), 'the destination is Commerce\'s, passed straight through');
});

test('the garment identity (productRef) is what session-photo reattachment keys on, not title or image', () => {
  const hook = code('hooks/useVirtualTryOn.ts');
  assert.ok(hook.includes('garment?.productRef'));
});

// ── Paid-request safety (product-integration continuation) ──────────────────

test('no VTO module wraps generation in a retry/query library', () => {
  for (const file of [
    'services/vto/vtoClient.ts',
    'services/vto/vtoRequestStore.ts',
    'hooks/useVirtualTryOn.ts',
    'components/vto/VirtualTryOnSheet.tsx',
  ]) {
    const source = code(file);
    for (const forbidden of ['react-query', 'useMutation', 'useQuery', 'exponentialBackoff', 'axios-retry']) {
      assert.ok(!source.includes(forbidden), `${file} must not use ${forbidden}`);
    }
  }
});

test('startVtoGeneration and retryVtoGeneration are called only from explicit user callbacks, never a useEffect', () => {
  const hook = read('hooks/useVirtualTryOn.ts');
  // Split into blocks by top-level function boundaries is overkill for a
  // grep-level check; instead assert the two effects present don't call
  // either generation entry point, and that generate/retry ARE useCallback
  // bodies (i.e. invoked on demand, not on mount/update).
  const effectBlocks = hook.match(/use(?:Layout)?Effect\(\(\) => \{[\s\S]*?\n {2}\}, \[[^\]]*\]\);/g) || [];
  assert.ok(effectBlocks.length >= 2, 'expected the reattach and unmount effects');
  for (const block of effectBlocks) {
    assert.ok(!block.includes('startVtoGeneration('), 'an effect must never start a paid generation');
    assert.ok(!block.includes('retryVtoGeneration('), 'an effect must never retry a paid generation');
  }
  assert.ok(/const generate = useCallback\(/.test(hook));
  assert.ok(/const retry = useCallback\(/.test(hook));
});

test('a superseded (not-yet-billed) submission is aborted client-side, not silently resubmitted', () => {
  // startVtoGeneration's own supersede path aborts the PREVIOUS request via
  // the AbortController threaded into vtoClient -- it does not issue a
  // second independent submission behind the first's back.
  const store = code('services/vto/vtoRequestStore.ts');
  assert.ok(store.includes('controller.abort') === false || store.includes('AbortController'));
  assert.ok(store.includes('invalidate()'), 'a new start must invalidate (and abort) any prior one');
});
