// Elise visual-context intake — focused safety and isolation tests.
//
// Covers: store isolation, privacy preparation, scan-result mapping, Edge Function
// active-context parsing/prompt assembly, and the scanner return-to-Elise seam.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    __DEV__: false,
    console,
    Date,
    JSON,
    Math,
    exports: mod.exports,
    module: mod,
    require: (spec) => {
      if (spec in requireMap) return requireMap[spec];
      throw new Error(`Unexpected import in ${relativePath}: ${spec}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return mod.exports;
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// ── Store isolation ──────────────────────────────────────────────────────────

test('visual context store is keyed by actor + session', () => {
  const store = loadTsModule('services/style-chat/eliseVisualContextStore.ts', {});
  const ctx = {
    id: 'a',
    actorKey: 'user:1',
    sessionId: 'session-a',
    source: 'scan',
    status: 'ready',
    title: 'Purple top',
    createdAt: Date.now(),
    revision: 1,
  };
  store.setVisualContext('user:1', 'session-a', ctx);
  assert.equal(store.getVisualContext('user:1', 'session-a')?.title, 'Purple top');
  assert.equal(store.getVisualContext('user:2', 'session-a'), null);
  assert.equal(store.getVisualContext('user:1', 'session-b'), null);
});

test('stale revision updates are rejected', () => {
  const store = loadTsModule('services/style-chat/eliseVisualContextStore.ts', {});
  const r1 = store.setVisualContext('user:1', 'session-a', {
    id: 'a',
    actorKey: 'user:1',
    sessionId: 'session-a',
    source: 'scan',
    status: 'preparing',
    title: 'Preparing…',
    createdAt: Date.now(),
    revision: 0,
  });
  store.setVisualContext('user:1', 'session-a', null);
  const applied = store.updateVisualContextIfCurrent('user:1', 'session-a', r1, (ctx) => ({
    ...ctx,
    status: 'ready',
  }));
  assert.equal(applied, false);
  assert.equal(store.getVisualContext('user:1', 'session-a'), null);
});

test('reset clears all visual context state', () => {
  const store = loadTsModule('services/style-chat/eliseVisualContextStore.ts', {});
  store.setVisualContext('user:1', 'session-a', {
    id: 'a',
    actorKey: 'user:1',
    sessionId: 'session-a',
    source: 'scan',
    status: 'ready',
    title: 'T',
    createdAt: Date.now(),
    revision: 1,
  });
  store.resetVisualContextStore();
  assert.equal(store.getVisualContext('user:1', 'session-a'), null);
});

// ── Privacy preparation ──────────────────────────────────────────────────────

test('prepareImageForPrivacyUpload strips metadata and reports honest policy', async () => {
  const manipResult = { uri: 'file:///cache/sanitized.jpg', width: 1024, height: 768 };
  const manipulator = {
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: async () => manipResult,
  };
  const fileSystem = {
    deleteAsync: async () => {},
  };
  const privacy = loadTsModule('services/privacyImageUpload.ts', {
    'expo-image-manipulator': manipulator,
    'expo-file-system/legacy': fileSystem,
  });

  const result = await privacy.prepareImageForPrivacyUpload('file:///library/original.jpg');
  assert.equal(result.sanitizedUri, manipResult.uri);
  assert.equal(result.policy.metadataStripped, true);
  assert.equal(result.policy.faceDetectionAvailable, false);
  assert.equal(result.policy.faceMaskApplied, false);
});

test('prepareImageForPrivacyUpload rejects cloud placeholders', async () => {
  const privacy = loadTsModule('services/privacyImageUpload.ts', {
    'expo-image-manipulator': { SaveFormat: { JPEG: 'jpeg' }, manipulateAsync: async () => ({}) },
    'expo-file-system/legacy': { deleteAsync: async () => {} },
  });
  await assert.rejects(
    () => privacy.prepareImageForPrivacyUpload('https://example.com/photo.jpg'),
    /must be on this device/,
  );
});

test('sanitization failure blocks remote analysis', async () => {
  const privacy = loadTsModule('services/privacyImageUpload.ts', {
    'expo-image-manipulator': {
      SaveFormat: { JPEG: 'jpeg' },
      manipulateAsync: async () => { throw new Error('codec failure'); },
    },
    'expo-file-system/legacy': { deleteAsync: async () => {} },
  });
  await assert.rejects(
    () => privacy.prepareImageForPrivacyUpload('file:///library/original.jpg'),
    /Image preparation failed/,
  );
});

// ── Mapping scan-identify to visual context ──────────────────────────────────

test('buildEliseVisualContextFromScanIdentify uses only response evidence', () => {
  const { buildEliseVisualContextFromScanIdentify } = loadTsModule(
    'services/style-chat/buildEliseVisualContext.ts',
    {},
  );
  const response = {
    status: 'completed',
    recommendedProducts: [],
    userMessage: 'Identified a fashion item from your scan.',
    attributes: {
      category: 'Tops',
      colorPalette: ['purple', 'black'],
      styleTags: ['lace', 'corset'],
      confidenceScore: 0.91,
    },
    identification: {
      visual_observation: 'Deep plum corset-style top with lace panels.',
      item_type: 'Corset top',
      primary_color: 'deep plum',
      material_estimate: 'lace',
      silhouette: 'fitted corset',
      style_tags: ['lace', 'corset', 'ribbon detailing'],
      confidence_score: 0.91,
    },
    displayResult: {
      headline: 'Purple lace corset top',
      details: 'Deep plum corset-style top with lace panels and ribbon detailing.',
    },
  };
  const ctx = buildEliseVisualContextFromScanIdentify(response, {
    actorKey: 'user:1',
    sessionId: 'session-a',
    source: 'upload',
    createdAt: Date.now(),
  });
  assert.equal(ctx.title, 'Purple lace corset top');
  assert.equal(ctx.summary, 'Deep plum corset-style top with lace panels and ribbon detailing.');
  assert.equal(ctx.category, 'Corset top');
  assert.equal(ctx.colors.length, 1);
  assert.equal(ctx.colors[0], 'deep plum');
  assert.equal(ctx.materials.length, 1);
  assert.equal(ctx.materials[0], 'lace');
  assert.equal(ctx.silhouette, 'fitted corset');
  assert.ok(ctx.styleAttributes.some((a) => a === 'corset'));
  assert.equal(ctx.confidence, 0.91);
  assert.equal(ctx.brand, undefined);
});

// ── Edge Function active-context contract ────────────────────────────────────

test('parseActiveContext accepts structured visual context', () => {
  const { parseActiveContext } = loadTsModule('supabase/functions/stylechat-generate/activeContext.ts', {});
  const parsed = parseActiveContext({
    source: 'upload',
    visualContext: {
      source: 'upload',
      title: 'Purple lace corset top',
      summary: 'Deep plum corset-style top with lace panels.',
      category: 'Tops',
      colors: ['deep plum'],
      materials: ['lace'],
      silhouette: 'fitted corset',
      styleAttributes: ['lace', 'corset'],
      brand: null,
      confidence: 0.91,
    },
  });
  assert.equal(parsed?.source, 'upload');
  assert.equal(parsed?.visualContext?.title, 'Purple lace corset top');
  assert.equal(parsed.visualContext.colors.length, 1);
  assert.equal(parsed.visualContext.colors[0], 'deep plum');
});

test('buildActiveContextBlock includes visual context without local URIs', () => {
  const { buildActiveContextBlock, parseActiveContext } = loadTsModule(
    'supabase/functions/stylechat-generate/activeContext.ts',
    {},
  );
  const block = buildActiveContextBlock(parseActiveContext({
    source: 'upload',
    visualContext: {
      source: 'upload',
      title: 'Purple lace corset top',
      category: 'Tops',
      colors: ['deep plum'],
      styleAttributes: ['lace', 'corset'],
      confidence: 0.91,
    },
  }));
  assert.match(block, /Purple lace corset top/);
  assert.match(block, /lace/);
  assert.match(block, /corset/);
  assert.doesNotMatch(block, /file:\/\//);
  assert.doesNotMatch(block, /base64/);
});

// ── Scanner return-to-Elise seam ─────────────────────────────────────────────

test('canonical scanner route is /scan and supports returnToSessionId', () => {
  const scanRoute = read('app/scan/index.tsx');
  assert.match(scanRoute, /KScanApp/);
  const appSource = read('app.js');
  assert.match(appSource, /returnToSessionId/);
  assert.match(appSource, /\/style-chat\/\$\{returnToSessionId\}/);
});

test('StyleChat session screen integrates the visual context bar', () => {
  const screen = read('app/style-chat/[sessionId].tsx');
  assert.match(screen, /EliseVisualContextBar/);
  assert.match(screen, /useEliseVisualContext/);
  assert.match(screen, /startScan\(composerText\)/);
  assert.match(screen, /startUpload/);
});

test('draft store supports actor-scoped keys', () => {
  const store = loadTsModule('services/style-chat/styleChatAttachmentStore.ts', {
    '../../types/styleChatAttachments': {},
  });
  store.setDraftComposerText('session-x', 'hello actor a', 'user:a');
  store.setDraftComposerText('session-x', 'hello actor b', 'user:b');
  assert.equal(store.getDraftComposerText('session-x', 'user:a'), 'hello actor a');
  assert.equal(store.getDraftComposerText('session-x', 'user:b'), 'hello actor b');
  store.clearDraftAttachments('session-x', { actorKey: 'user:a' });
  assert.equal(store.getDraftComposerText('session-x', 'user:a'), '');
  assert.equal(store.getDraftComposerText('session-x', 'user:b'), 'hello actor b');
});
