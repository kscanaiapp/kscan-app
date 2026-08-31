// VTO contract + eligibility parity between the client and the Edge Function.
//
// The two halves cannot share a module: the client is React Native/Metro and
// the server is Deno with `.ts` import specifiers, and the edge-function
// bundle closure only follows relative specifiers inside supabase/functions.
// So they are peers -- and a peer that silently drifts is worse than a
// duplicate, because the failure mode is a user tapping an affordance the
// server then refuses.
//
// These tests are that guard. Both implementations are transpiled and run
// against ONE shared fixture table; a disagreement is a failing test rather
// than a puzzling refusal in the field.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadModule(absPath, requireMap = {}) {
  const source = fs.readFileSync(absPath, 'utf8');
  const output = ts.transpileModule(source, {
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

const clientTypes = loadModule(path.join(ROOT, 'types', 'vto.ts'));
const clientEligibility = loadModule(path.join(ROOT, 'services', 'vto', 'vtoEligibility.ts'), {
  '../../types/vto': clientTypes,
});
const clientFailures = loadModule(path.join(ROOT, 'services', 'vto', 'vtoFailures.ts'), {
  '../../types/vto': clientTypes,
});

const serverContract = loadModule(
  path.join(ROOT, 'supabase', 'functions', 'vto-generate', 'vtoContract.ts'),
);
const scanHelpers = loadModule(
  path.join(ROOT, 'supabase', 'functions', '_shared', 'scanHelpers.ts'),
);
const serverEligibility = loadModule(
  path.join(ROOT, 'supabase', 'functions', 'vto-generate', 'vtoEligibility.ts'),
  { '../_shared/scanHelpers.ts': scanHelpers, './vtoContract.ts': serverContract },
);
const serverFeatureControl = loadModule(
  path.join(ROOT, 'supabase', 'functions', 'vto-generate', 'vtoFeatureControl.ts'),
  { '../_shared/deletion/common.ts': { rest: () => Promise.resolve(new Response('[]')) } },
);

// ── Vocabularies ─────────────────────────────────────────────────────────────

test('failure codes are identical on both sides of the wire', () => {
  assert.deepEqual(
    [...clientTypes.VTO_FAILURE_CODES].sort(),
    [...serverContract.VTO_FAILURE_CODES].sort(),
  );
});

test('ineligibility reasons are identical on both sides of the wire', () => {
  assert.deepEqual(
    [...clientTypes.VTO_INELIGIBLE_REASONS].sort(),
    [...serverContract.VTO_INELIGIBLE_REASONS].sort(),
  );
});

test('request origins are identical on both sides of the wire', () => {
  assert.deepEqual([...clientTypes.VTO_ORIGINS].sort(), [...serverContract.VTO_ORIGINS].sort());
});

test('the person payload ceiling is the same number on both sides', () => {
  const client = loadModule(path.join(ROOT, 'services', 'vto', 'vtoPersonInput.ts'), {
    'expo-image-picker': {},
    '../privacyImageUpload': {
      cleanupSanitizedImage: () => Promise.resolve(),
      compressSanitizedImageForAnalysis: () => Promise.resolve({ base64: '', uri: '' }),
      prepareImageForPrivacyUpload: () => Promise.resolve({}),
      PrivacyPrepareError: class extends Error {},
    },
    '../../types/vto': clientTypes,
  });
  assert.equal(
    client.VTO_PERSON_PAYLOAD_MAX_CHARS,
    serverContract.VTO_PERSON_PAYLOAD_MAX_CHARS,
    'a client that sends more than the server accepts fails every large photo',
  );
});

test('the default supported-category set is the same on both sides', () => {
  assert.deepEqual(
    [...clientEligibility.DEFAULT_VTO_SUPPORTED_CATEGORIES],
    [...serverFeatureControl.DEFAULT_VTO_SUPPORTED_CATEGORIES],
  );
});

test('every failure code has user-facing copy', () => {
  for (const code of clientTypes.VTO_FAILURE_CODES) {
    const failure = clientFailures.toVtoFailure(code);
    assert.equal(failure.code, code);
    assert.ok(failure.message.length > 0, `${code} needs copy`);
    assert.equal(typeof failure.retryable, 'boolean');
  }
});

test('a provider string never becomes user-facing copy', () => {
  const failure = clientFailures.toVtoFailure('UPSTREAM: account sk-live-1234 quota exceeded');
  assert.equal(failure.code, 'unknown');
  assert.ok(!failure.message.includes('sk-live'));
});

test('ineligibility reasons the failure taxonomy lacks are mapped, not degraded', () => {
  for (const reason of clientTypes.VTO_INELIGIBLE_REASONS) {
    const failure = clientFailures.vtoFailureForIneligibility(reason);
    assert.notEqual(failure.code, 'unknown', `${reason} must map to a real failure`);
  }
});

test('a non-retryable failure never offers a retry that cannot help', () => {
  for (const code of ['entitlement_required', 'feature_disabled', 'unsupported_category']) {
    assert.equal(clientFailures.toVtoFailure(code).retryable, false, code);
  }
});

// ── Category canonicalization ────────────────────────────────────────────────

// One table, both implementations. Covers every branch VTO cares about plus
// the near-misses that make a naive matcher wrong (bootcut jeans are not
// boots; a suit jacket is a blazer, not generic outerwear).
const CATEGORY_FIXTURES = [
  'wool coat',
  'Puffer Jacket',
  'trench coat',
  'bomber jacket',
  'raincoat',
  'suit jacket',
  'tailored blazer',
  'sport coat',
  'midi dress',
  'evening gown',
  'sundress',
  'silk blouse',
  'oversized shirt',
  'crewneck sweater',
  'hoodie',
  'cardigan',
  'polo',
  't-shirt',
  'tank top',
  'bootcut jeans',
  'wide-leg trousers',
  'chinos',
  'leggings',
  'sneakers',
  'chelsea boots',
  'leather loafers',
  'handbag',
  'crossbody bag',
  'sunglasses',
  'gold necklace',
  'leather belt',
  'NON_FASHION',
  'non-fashion',
  '',
  '   ',
  'something we have never seen',
];

test('client and server canonicalize every fixture identically', () => {
  for (const fixture of CATEGORY_FIXTURES) {
    assert.equal(
      clientEligibility.toCanonicalVtoCategory(fixture),
      serverEligibility.toCanonicalVtoCategory(fixture),
      `canonicalization diverged for ${JSON.stringify(fixture)}`,
    );
  }
});

test('client and server resolve the same slot for every fixture', () => {
  for (const fixture of CATEGORY_FIXTURES) {
    const canonical = serverEligibility.toCanonicalVtoCategory(fixture);
    assert.equal(
      clientEligibility.resolveVtoGarmentSlot(canonical) ?? null,
      serverEligibility.resolveVtoGarmentSlot(canonical) ?? null,
      `slot diverged for ${JSON.stringify(fixture)}`,
    );
  }
});

test('client and server agree on eligibility for every fixture', () => {
  const supported = [...clientEligibility.DEFAULT_VTO_SUPPORTED_CATEGORIES];
  for (const fixture of CATEGORY_FIXTURES) {
    const client = clientEligibility.evaluateVtoEligibility({
      category: fixture,
      imageUrl: 'https://cdn.example.com/x.jpg',
      productRef: 'p1',
      featureEnabled: true,
      hasEntitlement: true,
      supportedCategories: supported,
    });
    const server = serverEligibility.evaluateServerVtoEligibility({
      category: fixture,
      garmentImageUrl: 'https://cdn.example.com/x.jpg',
      productRef: 'p1',
      supportedCategories: supported,
    });
    assert.equal(client.eligible, server.eligible, `eligibility diverged for ${fixture}`);
    if (client.eligible && server.eligible) {
      assert.equal(client.slot, server.slot, `slot diverged for ${fixture}`);
    }
  }
});

test('client and server accept the same garment image references', () => {
  const urls = [
    'https://cdn.example.com/x.jpg',
    'http://cdn.example.com/x.jpg',
    'file:///etc/passwd',
    'content://media/1',
    'data:image/png;base64,AAAA',
    'javascript:alert(1)',
    'not a url',
    '',
    null,
    undefined,
  ];
  for (const url of urls) {
    assert.equal(
      clientEligibility.isSupportedGarmentImageUrl(url),
      serverEligibility.isSupportedGarmentImageUrl(url),
      `image-url acceptance diverged for ${String(url)}`,
    );
  }
});

test('the launch default is narrower than the slot map allows', () => {
  // Recognising a garment and shipping it are different decisions: bottoms
  // are understood but stay off until benchmark evidence says otherwise.
  const supported = [...clientEligibility.DEFAULT_VTO_SUPPORTED_CATEGORIES];
  assert.ok(!supported.includes('pants'));
  assert.ok(!supported.includes('skirt'));
  assert.equal(clientEligibility.resolveVtoGarmentSlot('pants'), 'bottom');
});
