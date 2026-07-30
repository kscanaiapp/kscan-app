const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function loadNavigationExit() {
  const relativePath = 'services/navigationExit.ts';
  const output = ts.transpileModule(read(relativePath), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: relativePath,
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    exports: mod.exports,
    module: mod,
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: relativePath }).runInContext(sandbox);
  return mod.exports;
}

function createRouter(hasHistory) {
  return {
    backCalls: 0,
    replaceCalls: [],
    canGoBack: () => hasHistory,
    back() {
      this.backCalls += 1;
    },
    replace(href) {
      this.replaceCalls.push(href);
    },
  };
}

function walkTsx(relativeDir) {
  const absoluteDir = path.join(ROOT, relativeDir);
  const files = [];
  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTsx(relativePath));
    } else if (entry.isFile() && entry.name.endsWith('.tsx')) {
      files.push(relativePath.replaceAll('\\', '/'));
    }
  }
  return files;
}

test('history available navigates back through the production helper', () => {
  const { goBackOrHome } = loadNavigationExit();
  const router = createRouter(true);

  goBackOrHome(router);

  assert.equal(router.backCalls, 1);
  assert.deepEqual(router.replaceCalls, []);
});

test('history unavailable replaces with canonical Home through the production helper', () => {
  const { CANONICAL_HOME_ROUTE, goBackOrHome } = loadNavigationExit();
  const router = createRouter(false);

  goBackOrHome(router);

  assert.equal(CANONICAL_HOME_ROUTE, '/');
  assert.equal(router.backCalls, 0);
  assert.deepEqual(router.replaceCalls, ['/']);
});

test('auth-specific production helpers preserve onboarding and sign-in fallbacks', () => {
  const {
    goBackOrAuth,
    goBackOrOnboarding,
  } = loadNavigationExit();
  const router = createRouter(false);

  goBackOrOnboarding(router);
  goBackOrAuth(router);

  assert.deepEqual(router.replaceCalls, ['/onboarding', '/auth']);
});

test('old-scan direct entry always has a visible and hardware-backed exit', () => {
  const library = read('app/library.tsx');
  const analysis = read('components/AnalysisCard.tsx');

  assert.match(library, /scanSourceType="style_library_scan"/);
  assert.match(library, /onDismiss=\{handleCloseScan\}/);
  assert.match(analysis, /testID="analysis-card-close"/);
  assert.match(analysis, /accessibilityLabel="Close this screen"/);
  assert.match(analysis, /onRequestClose=\{runExit\}/);
  assert.match(analysis, /isLibraryScan \? 'Done' : 'Scan Again'/);
  assert.match(
    analysis,
    /testID=\{isLibraryScan \? 'analysis-card-done' : 'analysis-card-scan-again'\}/,
  );
});

test('AnalysisCard Close is sticky above scroll content and uses the same safe dismissal', () => {
  const source = read('components/AnalysisCard.tsx');
  const closeIndex = source.indexOf('testID="analysis-card-close"');
  const scrollIndex = source.indexOf('<ScrollView');

  assert.ok(closeIndex >= 0, 'AnalysisCard must expose sticky Close');
  assert.ok(scrollIndex > closeIndex, 'sticky Close must render above scroll content');
  assert.match(source, /testID="analysis-card-close"[\s\S]*?onPress=\{runExit\}/);
  assert.match(source, /closeButton:[\s\S]*?minWidth: 44[\s\S]*?minHeight: 44/);
});

test('Library detail uses Done while live scanner results retain Scan Again', () => {
  const source = read('components/AnalysisCard.tsx');

  assert.match(source, /const isLibraryScan = scanSourceType === 'style_library_scan'/);
  assert.match(source, /\{isLibraryScan \? 'Done' : 'Scan Again'\}/);
  assert.match(source, /accessibilityLabel=\{isLibraryScan \? 'Close this screen' : 'Scan another item'\}/);
  assert.match(read('app.js'), /scanSourceType="live_scan"/);
  assert.match(read('components/scan-results/ScanResultV2.tsx'), /label: 'Scan Again'/);
});

test('authenticated direct-entry surfaces use the shared Home fallback', () => {
  const screens = [
    'app/library.tsx',
    'app/privacy.tsx',
    'app/dressing-rooms/index.tsx',
    'app/dressing-rooms/[id].tsx',
    'app/looks/index.tsx',
    'app/looks/[id].tsx',
    'app/looks/create.tsx',
    'app/stylist/index.tsx',
    'app/text-scan/index.tsx',
    'app/(public)/rooms/[token].tsx',
  ];

  for (const relativePath of screens) {
    const source = read(relativePath);
    assert.match(source, /goBackOrHome/, relativePath + ' must use goBackOrHome');
    assert.doesNotMatch(
      source,
      /onBack=\{\(\) => router\.back\(\)\}/,
      relativePath + ' must not use an unconditional header back',
    );
  }
});

test('auth and account-restoration exits use direct-entry-safe auth fallbacks', () => {
  const auth = read('app/auth/index.tsx');
  const reset = read('app/auth/reset.tsx');
  const update = read('app/auth/update-password.tsx');
  const restore = read('app/account/restore.tsx');

  assert.match(auth, /goBackOrOnboarding\(router\)/);
  assert.match(reset, /goBackOrAuth\(router\)/);
  assert.match(update, /goBackOrAuth\(router\)/);
  assert.match(update, /accessibilityLabel="Cancel and go back"/);
  assert.match(restore, /goBackOrAuth\(router\)/);
  assert.match(restore, /testID="restore-exit"/);
});

test('Shared Room retains its existing back-or-Home semantics through the shared helper', () => {
  const source = read('app/(public)/rooms/[token].tsx');

  assert.match(source, /const handleBack = useCallback\(\(\) => \{\s*goBackOrHome\(router\)/);
  assert.match(source, /onBack=\{handleBack\}/);
  assert.match(source, /title="Shared Room"/);
});

test('Android Hardware Back is wired for scanner results, Closet, Elise, settings, and StyleChat', () => {
  const scanner = read('app.js');
  const analysis = read('components/AnalysisCard.tsx');
  const scanResult = read('components/scan-results/ScanResultV2.tsx');
  const closetIntake = read('components/closet/ClosetIntakeModal.tsx');
  const elisePhoto = read('components/style-chat/StyleChatPhotoIntake.tsx');
  const eliseAttachments = read('components/style-chat/StyleChatAttachmentBar.tsx');
  const privacy = read('app/privacy.tsx');
  const styleChatHeader = read('components/style-chat/StyleChatHeader.tsx');

  assert.match(scanner, /BackHandler\.addEventListener\('hardwareBackPress', onBack\)/);
  assert.match(scanner, /status === 'result'\) return false/);
  assert.match(analysis, /<Modal transparent animationType="none" onRequestClose=\{runExit\}>/);
  assert.ok(
    (scanResult.match(/onRequestClose=\{runExit\}/g) || []).length >= 3,
    'every ScanResultV2 modal mode must handle Android Back',
  );
  assert.match(closetIntake, /onRequestClose=\{onClose\}/);
  assert.match(elisePhoto, /onRequestClose=\{busy \? \(\) => \{\} : handleCancel\}/);
  assert.match(eliseAttachments, /onRequestClose=/);
  assert.match(privacy, /onRequestClose=\{\(\) => setDeletionConfirmVisible\(false\)\}/);
  assert.match(styleChatHeader, /BackHandler\.addEventListener\('hardwareBackPress'/);
  assert.match(styleChatHeader, /router\.dismissTo\('\/'\)/);
});

test('ScanResultV2 keeps its guarded history-or-local-dismiss exit', () => {
  const source = read('components/scan-results/ScanResultV2.tsx');
  const handler = source.match(/const handleBack = \(\) => \{([\s\S]*?)\n  \};/);

  assert.ok(handler, 'ScanResultV2 handleBack must remain present');
  assert.match(handler[1], /if \(router\.canGoBack\(\)\)/);
  assert.match(handler[1], /router\.back\(\)/);
  assert.match(handler[1], /onDismiss\(\)/);
});

test('complete user-visible route inventory has an explicit exit classification', () => {
  const inventory = [
    { file: 'app/index.tsx', kind: 'home-root' },
    { file: 'app/scan/index.tsx', kind: 'home-dismiss' },
    { file: 'app/library.tsx', kind: 'back-or-home' },
    { file: 'app/privacy.tsx', kind: 'back-or-home' },
    { file: 'app/dressing-rooms/index.tsx', kind: 'back-or-home' },
    { file: 'app/dressing-rooms/[id].tsx', kind: 'back-or-home' },
    { file: 'app/looks/index.tsx', kind: 'back-or-home' },
    { file: 'app/looks/[id].tsx', kind: 'back-or-home' },
    { file: 'app/looks/create.tsx', kind: 'back-or-home' },
    { file: 'app/stylist/index.tsx', kind: 'back-or-home' },
    // Private Dressing Room workspace (Build 3 Phase 1). Back-or-home so a
    // deep link into the workspace cannot trap the user with an empty stack,
    // which is also the Android hardware-back path.
    { file: 'app/stylist/dressing-room/index.tsx', kind: 'back-or-home' },
    { file: 'app/stylist/saved-looks/index.tsx', kind: 'stylist-fallback' },
    { file: 'app/stylist/saved-looks/[id].tsx', kind: 'stylist-fallback' },
    { file: 'app/stylist/saved-looks/handoff.tsx', kind: 'stylist-fallback' },
    { file: 'app/text-scan/index.tsx', kind: 'back-or-home' },
    { file: 'app/(public)/rooms/[token].tsx', kind: 'back-or-home' },
    { file: 'app/style-chat/index.tsx', kind: 'home-dismiss' },
    { file: 'app/style-chat/[sessionId].tsx', kind: 'home-dismiss' },
    { file: 'app/auth/index.tsx', kind: 'auth-fallback' },
    { file: 'app/auth/reset.tsx', kind: 'auth-fallback' },
    { file: 'app/auth/update-password.tsx', kind: 'auth-fallback' },
    { file: 'app/account/restore.tsx', kind: 'auth-fallback' },
    { file: 'app/auth/callback.tsx', kind: 'redirect-only' },
    { file: 'app/onboarding/index.tsx', kind: 'onboarding-root' },
    { file: 'app/dev/icon-review.tsx', kind: 'development-only' },
    { file: 'app/style-chat/debug-memory.tsx', kind: 'development-only' },
  ];
  const discovered = walkTsx('app')
    .filter((file) => !file.endsWith('/_layout.tsx') && file !== 'app/_layout.tsx')
    .sort();
  const classified = inventory.map((entry) => entry.file).sort();

  assert.deepEqual(discovered, classified, 'every TSX route must be classified');

  for (const entry of inventory) {
    const source = read(entry.file);
    if (entry.kind === 'back-or-home') {
      assert.match(source, /goBackOrHome/);
    } else if (entry.kind === 'stylist-fallback') {
      assert.match(source, /router\.replace\('\/stylist(?:\/saved-looks)?'\)/);
      assert.doesNotMatch(source, /router\.back\(\)/);
    } else if (entry.kind === 'auth-fallback') {
      assert.match(source, /goBackOrOnboarding|goBackOrAuth/);
    } else if (entry.kind === 'home-dismiss') {
      if (entry.file === 'app/scan/index.tsx') {
        assert.match(source, /KScanApp/);
        assert.match(read('app.js'), /router\.replace\('\/'\)/);
      } else {
        assert.match(source, /StyleChatHeader/);
      }
    } else if (entry.kind === 'redirect-only') {
      assert.match(source, /router\.replace/);
    } else if (entry.kind === 'onboarding-root') {
      assert.match(source, /router\.push\('\/auth'\)/);
      assert.match(source, /BackHandler\.addEventListener\('hardwareBackPress'/);
    } else if (entry.file === 'app/dev/icon-review.tsx') {
      assert.match(source, /QA_TOOLS_ENABLED/);
    } else if (entry.kind === 'development-only') {
      assert.match(source, /__DEV__/);
    }
  }
});

test('remaining bare router.back calls are guarded or development-only', () => {
  const sources = [...walkTsx('app'), ...walkTsx('components')];
  const withBareBack = sources
    .filter((relativePath) => /router\.back\(\)/.test(read(relativePath)))
    .sort();

  assert.deepEqual(withBareBack, [
    'app/style-chat/debug-memory.tsx',
    'components/scan-results/ScanResultV2.tsx',
  ]);
  assert.match(
    read('components/scan-results/ScanResultV2.tsx'),
    /if \(router\.canGoBack\(\)\)[\s\S]*?router\.back\(\)[\s\S]*?onDismiss\(\)/,
  );
  assert.match(read('app/style-chat/debug-memory.tsx'), /if \(!__DEV__\)/);
});

test('KScanHeader exposes a clear Back label and preserves a 44dp target', () => {
  const source = read('components/luxury/KScanHeader.tsx');

  assert.match(source, /accessibilityLabel=\{backLabel === 'Back' \? 'Go back' : backLabel\}/);
  assert.match(source, /useSafeAreaInsets/);
  assert.match(source, /minWidth:\s+44/);
  assert.match(source, /minHeight:\s+44/);
});
