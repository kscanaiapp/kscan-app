/**
 * MIRROR SELFIE — bounded staging probe (Build 29 §17).
 *
 * Mirror Selfie is Build 29 scope and stays ON. This file is the bounded
 * validation the repair scope requires, using the REAL `closet_mirror` mobile
 * contract rather than hand-constructed substitute semantics: the payload comes
 * from the production request builder and is judged by the deployed function's
 * own validator, both executed here.
 *
 * WHAT IS PROVEN
 *   1. exact staging generation — scan-identify v32, read live 2026-08-15
 *   2. the real `closet_mirror` payload, from `buildClosetV2Request`
 *   3. that payload is ACCEPTED by the deployed request validator
 *   4. ordinary Scanner requests remain compatible and are not reclassified
 *
 * WHAT IS NOT PROVEN, AND WHY — READ THIS BEFORE TREATING MIRROR AS CERTIFIED.
 * The live model round-trip (an actual fashion-identification RESPONSE from
 * staging) is NOT executed. `scripts/smoke-scan-identify.js` is the governed
 * probe for that and requires `STAGING_USER_JWT`, a real staging user token. It
 * is not available here, and the script explicitly refuses service-role keys
 * and fabricated JWTs — manufacturing one to make this file look complete would
 * defeat the control it exists behind. So the request contract is certified and
 * the response is not.
 *
 * CONSEQUENCE: no Mirror Selfie production promotion is claimed. Both
 * environments already accept `closet_mirror` (staging v32 and production v147
 * each carry it in the entry-path vocabulary), so no promotion appears to be
 * required — but "appears" is not certification, and the ledger records the
 * live probe as outstanding rather than passed.
 *
 * Mirror Selfie is NOT disabled. The correct response to an unrun probe is to
 * run it when the credential exists, not to remove a feature that has already
 * had implementation and testing investment.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

const moduleCache = new Map();
function loadTs(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  if (moduleCache.has(normalized)) return moduleCache.get(normalized);

  const source = fs.readFileSync(path.join(ROOT, normalized), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const module = { exports: {} };
  const dir = path.dirname(normalized);
  const sandbox = {
    console,
    Date,
    TextEncoder,
    __DEV__: false,
    process: { env: {} },
    globalThis: { crypto: undefined },
    exports: module.exports,
    module,
    require: (specifier) => {
      // Genuine native externals only. These are unreachable from the pure
      // request-building functions under test; anything else still throws, so a
      // dependency cannot be stubbed away silently.
      if (specifier === 'expo-crypto') {
        return { randomUUID: () => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', getRandomBytes: () => new Uint8Array(16) };
      }
      if (specifier === 'expo-file-system' || specifier === 'expo-file-system/legacy') return {};
      if (specifier === 'react-native') return { Platform: { OS: 'android' } };
      if (!specifier.startsWith('.')) {
        throw new Error(`Unexpected external import in ${normalized}: ${specifier}`);
      }
      const base = path.join(dir, specifier).split(path.sep).join('/');
      for (const candidate of [base, `${base}.ts`, `${base}.js`]) {
        if (fs.existsSync(path.join(ROOT, candidate))) return loadTs(candidate);
      }
      throw new Error(`Unresolved import ${specifier} from ${normalized}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: normalized }).runInContext(sandbox);
  moduleCache.set(normalized, module.exports);
  return module.exports;
}

/** The REAL server-side request validator the deployed function runs. */
const server = () => loadTs('supabase/functions/_shared/fashionIdentificationV2.ts');

/** A prepared evidence object of the shape the mirror pipeline produces. */
function mirrorEvidence() {
  return {
    evidenceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    imageBase64: 'iVBORw0KGgoAAAANSUhEUg==',
    mimeType: 'image/jpeg',
    width: 1024,
    height: 1536,
    source: 'mirror_extract',
  };
}

/** The REAL client request builder — this is the mobile contract, not a copy. */
function buildRealRequest(entryPathKey, platform = 'android') {
  const closet = loadTs('services/closetIdentificationV2.ts');
  return closet.buildClosetV2Request({
    evidence: mirrorEvidence(),
    entryPath: entryPathKey,
    platform,
    requestId: 'ffffffff-1111-4222-8333-444444444444',
    appVersion: '1.0.1',
  });
}

/* ------------------------------------------------------------------ */
/* 1–2. The real mirror contract                                       */
/* ------------------------------------------------------------------ */

test('a Mirror crop resolves to its own entry path, never laundered as gallery', () => {
  const closet = loadTs('services/closetIdentificationV2.ts');

  assert.equal(closet.closetEntryPathKeyForSource('mirror_extract'), 'mirror');
  assert.equal(closet.closetEntryPathFor('mirror'), 'closet_mirror');

  // Mislabeling a Mirror crop as a gallery pick would misrepresent its
  // provenance to the backend; unknown sources still fail closed rather than
  // defaulting.
  assert.equal(closet.closetEntryPathKeyForSource('camera'), 'camera');
  assert.equal(closet.closetEntryPathKeyForSource('gallery'), 'gallery');
  assert.equal(closet.closetEntryPathKeyForSource('something_new'), null);
});

test('the production builder emits a closet_mirror request', () => {
  const result = buildRealRequest('mirror');
  assert.equal(result.kind, 'ok', `builder rejected the mirror request: ${result.reason}`);

  const { request } = result;
  assert.equal(request.source.entryPath, 'closet_mirror');
  assert.equal(request.source.platform, 'android');
  assert.equal(request.evidence.length, 1, 'exactly one evidence object per request');
  assert.equal(request.evidence[0].transport.type, 'jpeg_base64');
});

/* ------------------------------------------------------------------ */
/* 3. The deployed validator accepts it                                */
/* ------------------------------------------------------------------ */

test('the deployed request validator accepts the real closet_mirror payload', () => {
  const { validateFashionIdentificationRequestV2 } = server();
  const built = buildRealRequest('mirror');
  assert.equal(built.kind, 'ok');

  const verdict = validateFashionIdentificationRequestV2(built.request);
  assert.equal(
    verdict.ok,
    true,
    `staging would reject the real mirror request: ${JSON.stringify(verdict)}`,
  );
});

test('closet_mirror is in the deployed entry-path vocabulary', () => {
  const { FASHION_IDENTIFICATION_ENTRY_PATHS } = server();
  const paths = Array.from(FASHION_IDENTIFICATION_ENTRY_PATHS);
  for (const entryPath of ['closet_mirror', 'closet_camera', 'closet_gallery']) {
    assert.ok(paths.includes(entryPath), `the backend must accept ${entryPath}`);
  }
});

/* ------------------------------------------------------------------ */
/* 4. Ordinary Scanner compatibility is untouched                      */
/* ------------------------------------------------------------------ */

test('ordinary Closet camera and gallery requests still validate', () => {
  const { validateFashionIdentificationRequestV2 } = server();
  for (const entryPath of ['camera', 'gallery']) {
    const built = buildRealRequest(entryPath);
    assert.equal(built.kind, 'ok', `${entryPath} must still build`);
    assert.equal(
      validateFashionIdentificationRequestV2(built.request).ok,
      true,
      `${entryPath} must still validate — Mirror must not disturb ordinary intake`,
    );
  }
});

test('Scanner entry paths remain distinct from Closet ones', () => {
  const { FASHION_IDENTIFICATION_ENTRY_PATHS } = server();
  const paths = Array.from(FASHION_IDENTIFICATION_ENTRY_PATHS);

  // A Closet request describing itself as Scanner would be indistinguishable
  // downstream from a scan that is allowed to shop and to create a Recent Scan.
  assert.ok(paths.includes('scanner_camera'), 'Scanner keeps its own vocabulary');
  const closet = loadTs('services/closetIdentificationV2.ts');
  for (const value of Object.values(closet.CLOSET_ENTRY_PATHS)) {
    assert.doesNotMatch(value, /^scanner_/, 'no Closet path may masquerade as Scanner');
  }
});

/* ------------------------------------------------------------------ */
/* The limit of this probe, asserted so it cannot be forgotten         */
/* ------------------------------------------------------------------ */

test('the live response probe is recorded as outstanding, not as passed', () => {
  const ledger = fs.readFileSync(
    path.join(ROOT, 'docs', 'release', 'BUILD29_BACKEND_PROMOTION_LEDGER.md'),
    'utf8',
  );

  // The request contract is certified above; the RESPONSE is not, because the
  // governed probe needs a staging user JWT that is not available here. The
  // ledger must say so rather than implying Mirror is fully certified.
  assert.match(ledger, /Mirror Selfie/);
  assert.match(
    ledger,
    /STAGING_USER_JWT/,
    'the ledger must name the credential the live probe is blocked on',
  );
  assert.match(
    ledger,
    /not yet run|outstanding/i,
    'the outstanding live probe must be stated, not implied',
  );

  // And the feature must not have been quietly switched off to avoid the gap.
  const eas = JSON.parse(fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8'));
  for (const [profile, config] of Object.entries(eas.build)) {
    assert.equal(
      config.env.EXPO_PUBLIC_MIRROR_SELFIE_V1,
      'true',
      `${profile} must keep Mirror Selfie enabled`,
    );
  }
});
