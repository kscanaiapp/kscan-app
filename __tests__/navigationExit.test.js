const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const CANONICAL_HOME_ROUTE = '/';
const CANONICAL_ONBOARDING_ROUTE = '/onboarding';
const CANONICAL_AUTH_ROUTE = '/auth';

/** Mirrors services/navigationExit.ts for behavior assertions without a TS toolchain. */
function goBackOrReplace(router, fallbackRoute) {
  if (router.canGoBack()) {
    router.back();
    return;
  }
  router.replace(fallbackRoute);
}

function goBackOrHome(router) {
  goBackOrReplace(router, CANONICAL_HOME_ROUTE);
}

function goBackOrOnboarding(router) {
  goBackOrReplace(router, CANONICAL_ONBOARDING_ROUTE);
}

function goBackOrAuth(router) {
  goBackOrReplace(router, CANONICAL_AUTH_ROUTE);
}

test('navigationExit helper source exports canonical Home and replace fallbacks', () => {
  const source = read('services/navigationExit.ts');
  assert.match(source, /export const CANONICAL_HOME_ROUTE = '\/'/);
  assert.match(source, /export const CANONICAL_ONBOARDING_ROUTE = '\/onboarding'/);
  assert.match(source, /export const CANONICAL_AUTH_ROUTE = '\/auth'/);
  assert.match(source, /if \(router\.canGoBack\(\)\)/);
  assert.match(source, /router\.back\(\)/);
  assert.match(source, /router\.replace\(fallbackRoute\)/);
  assert.match(source, /export function goBackOrHome/);
  assert.doesNotMatch(source, /router\.push\(/);
});

test('canonical Home route is authenticated stack root "/"', () => {
  assert.equal(CANONICAL_HOME_ROUTE, '/');
  assert.match(read('app/index.tsx'), /HomeLuxuryTechV1/);
});

test('goBackOrHome uses back when history exists and replace Home when empty', () => {
  const withHistory = {
    canGoBack: () => true,
    backCalls: 0,
    replaceCalls: [],
    back() {
      this.backCalls += 1;
    },
    replace(href) {
      this.replaceCalls.push(href);
    },
  };
  goBackOrHome(withHistory);
  assert.equal(withHistory.backCalls, 1);
  assert.deepEqual(withHistory.replaceCalls, []);

  const empty = {
    canGoBack: () => false,
    backCalls: 0,
    replaceCalls: [],
    back() {
      this.backCalls += 1;
    },
    replace(href) {
      this.replaceCalls.push(href);
    },
  };
  goBackOrHome(empty);
  assert.equal(empty.backCalls, 0);
  assert.deepEqual(empty.replaceCalls, [CANONICAL_HOME_ROUTE]);
});

test('auth funnel helpers fall back to onboarding and auth without looping via Home', () => {
  const empty = {
    canGoBack: () => false,
    replaceCalls: [],
    back() {},
    replace(href) {
      this.replaceCalls.push(href);
    },
  };
  goBackOrOnboarding(empty);
  goBackOrAuth(empty);
  assert.deepEqual(empty.replaceCalls, [CANONICAL_ONBOARDING_ROUTE, CANONICAL_AUTH_ROUTE]);
});

test('AnalysisCard exposes a visible Close control above scroll content', () => {
  const source = read('components/AnalysisCard.tsx');
  assert.match(source, /testID="analysis-card-close"/);
  assert.match(source, /accessibilityLabel="Close this screen"/);
  assert.match(source, /accessibilityRole="button"/);
  assert.match(source, />Close</);
  assert.match(source, /onRequestClose=\{runExit\}/);
  assert.match(source, /isLibraryScan \? 'Done' : 'Scan Again'/);
  assert.match(source, /testID=\{isLibraryScan \? 'analysis-card-done' : 'analysis-card-scan-again'\}/);
  const closeIdx = source.indexOf('testID="analysis-card-close"');
  const scrollIdx = source.indexOf('<ScrollView');
  assert.ok(closeIdx > -1 && scrollIdx > closeIdx, 'Close control must render above ScrollView');
});

test('authenticated stack screens wire Back through goBackOrHome', () => {
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
  for (const rel of screens) {
    const source = read(rel);
    assert.match(source, /goBackOrHome/, `${rel} must import/use goBackOrHome`);
    assert.doesNotMatch(
      source,
      /onBack=\{\(\) => router\.back\(\)\}/,
      `${rel} must not use bare router.back() for header Back`,
    );
  }
});

test('auth cancel/back controls use empty-history safe helpers', () => {
  const auth = read('app/auth/index.tsx');
  assert.match(auth, /goBackOrOnboarding\(router\)/);
  assert.doesNotMatch(auth, /onPress=\{\(\) => router\.back\(\)\}/);

  const reset = read('app/auth/reset.tsx');
  assert.match(reset, /goBackOrAuth\(router\)/);

  const update = read('app/auth/update-password.tsx');
  assert.match(update, /goBackOrAuth\(router\)/);
  assert.match(update, /accessibilityLabel="Cancel and go back"/);
});

test('KScanHeader Back uses Go back accessibility label and safe-area padding', () => {
  const header = read('components/luxury/KScanHeader.tsx');
  assert.match(header, /accessibilityLabel=\{backLabel === 'Back' \? 'Go back' : backLabel\}/);
  assert.match(header, /useSafeAreaInsets/);
  assert.match(header, /paddingTop: insets\.top/);
});

test('route inventory keeps Home as root with no exit control required', () => {
  const home = read('app/index.tsx');
  assert.match(home, /export default function Home/);
  assert.doesNotMatch(home, /onBack|goBackOrHome|router\.back/);
});

test('full-screen authenticated route inventory recognizes valid exit patterns', () => {
  /** @type {Array<{ route: string; file: string; kind: 'home'|'homeDismiss'|'backOrHome'|'authFallback'|'devOnly' }>} */
  const inventory = [
    { route: '/', file: 'app/index.tsx', kind: 'home' },
    { route: '/scan', file: 'app/scan/index.tsx', kind: 'homeDismiss' },
    { route: '/library', file: 'app/library.tsx', kind: 'backOrHome' },
    { route: '/privacy', file: 'app/privacy.tsx', kind: 'backOrHome' },
    { route: '/dressing-rooms', file: 'app/dressing-rooms/index.tsx', kind: 'backOrHome' },
    { route: '/dressing-rooms/[id]', file: 'app/dressing-rooms/[id].tsx', kind: 'backOrHome' },
    { route: '/looks', file: 'app/looks/index.tsx', kind: 'backOrHome' },
    { route: '/looks/[id]', file: 'app/looks/[id].tsx', kind: 'backOrHome' },
    { route: '/looks/create', file: 'app/looks/create.tsx', kind: 'backOrHome' },
    { route: '/stylist', file: 'app/stylist/index.tsx', kind: 'backOrHome' },
    { route: '/text-scan', file: 'app/text-scan/index.tsx', kind: 'backOrHome' },
    { route: '/style-chat', file: 'app/style-chat/index.tsx', kind: 'homeDismiss' },
    { route: '/style-chat/[sessionId]', file: 'app/style-chat/[sessionId].tsx', kind: 'homeDismiss' },
    { route: '/rooms/[token]', file: 'app/(public)/rooms/[token].tsx', kind: 'backOrHome' },
    { route: '/auth', file: 'app/auth/index.tsx', kind: 'authFallback' },
    { route: '/auth/reset', file: 'app/auth/reset.tsx', kind: 'authFallback' },
    { route: '/auth/update-password', file: 'app/auth/update-password.tsx', kind: 'authFallback' },
    { route: '/style-chat/debug-memory', file: 'app/style-chat/debug-memory.tsx', kind: 'devOnly' },
  ];

  for (const entry of inventory) {
    const source = read(entry.file);
    if (entry.kind === 'home') {
      assert.doesNotMatch(source, /goBackOrHome|onBack=/);
      continue;
    }
    if (entry.kind === 'backOrHome') {
      assert.match(source, /goBackOrHome/, `${entry.route} missing goBackOrHome`);
      continue;
    }
    if (entry.kind === 'homeDismiss') {
      if (entry.route === '/scan') {
        const scanApp = read('app.js');
        assert.match(scanApp, /handleHome/);
        assert.match(scanApp, /router\.replace\('\/'\)/);
        assert.match(scanApp, /accessibilityLabel="Go Home"/);
      } else {
        assert.match(source, /StyleChatHeader/, `${entry.route} missing StyleChatHeader`);
        const header = read('components/style-chat/StyleChatHeader.tsx');
        assert.match(header, /dismissTo\('\/'\)/);
        assert.match(header, /accessibilityLabel="Return to Home"/);
      }
      continue;
    }
    if (entry.kind === 'authFallback') {
      assert.match(source, /goBackOrOnboarding|goBackOrAuth/, `${entry.route} missing auth fallback`);
      continue;
    }
    if (entry.kind === 'devOnly') {
      assert.match(source, /__DEV__|router\.back/);
    }
  }

  assert.match(read('app/library.tsx'), /AnalysisCard/);
  assert.match(read('components/AnalysisCard.tsx'), /testID="analysis-card-close"/);
});
