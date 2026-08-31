// K+ Smart Watchlist V1 — notification tap routing.
//
// Proving tests for hostile-audit repair DEF-WL-03: pushDelivery.ts sends
// `data: { watchId, eventType, deepLink }` and documents that tapping the
// alert opens /watchlist/[watchId], but nothing in the app read that payload
// — there was no notification-response listener and no notification handler
// anywhere in source, so a tapped alert landed on the app's default route.
//
// The routing module is loaded and EXECUTED here (VM-transpile with an
// injected requireMap, the same technique as kplusEntitlementStore.test.js),
// not asserted against as source text: the point of these cases is what the
// function actually returns for a hostile payload.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'services', 'watchlist', 'watchNotificationRouting.ts');

function loadRouting() {
  const source = fs.readFileSync(MODULE_PATH, 'utf8');
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
    require: (specifier) => {
      throw new Error(`Unexpected import in watchNotificationRouting.ts: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: MODULE_PATH }).runInContext(sandbox);
  return mod.exports;
}

const VALID_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

test('a Watchlist payload resolves to that Watch detail route', () => {
  const { watchRouteFromNotificationData } = loadRouting();
  assert.equal(
    watchRouteFromNotificationData({ watchId: VALID_ID, eventType: 'target_price_reached' }),
    `/watchlist/${VALID_ID}`,
  );
});

test('SECURITY: the URL-shaped payload field is never used as the destination', () => {
  const { watchRouteFromNotificationData } = loadRouting();
  // A push payload is untrusted input. Even a payload carrying a plausible
  // deepLink must contribute nothing to the route.
  assert.equal(
    watchRouteFromNotificationData({ deepLink: 'https://attacker.example/steal' }),
    null,
  );
  assert.equal(
    watchRouteFromNotificationData({ watchId: VALID_ID, deepLink: 'https://attacker.example/steal' }),
    `/watchlist/${VALID_ID}`,
  );
});

test('SECURITY: a non-UUID watch id never becomes a route', () => {
  const { watchRouteFromNotificationData } = loadRouting();
  for (const hostile of [
    '../../settings',
    'https://attacker.example',
    `${VALID_ID}/../../privacy`,
    `${VALID_ID}%2F..%2Fprivacy`,
    'kscan://watchlist/x',
    '',
    '   ',
    `${VALID_ID}extra`,
    123,
    null,
    { toString: () => VALID_ID },
  ]) {
    assert.equal(
      watchRouteFromNotificationData({ watchId: hostile }),
      null,
      `hostile watchId must not route: ${JSON.stringify(hostile)}`,
    );
  }
});

test('a non-Watchlist or malformed payload routes nowhere', () => {
  const { watchRouteFromNotificationData } = loadRouting();
  for (const payload of [null, undefined, 'string', 42, [], {}, { eventType: 'target_price_reached' }]) {
    assert.equal(watchRouteFromNotificationData(payload), null);
  }
});

test("a well-formed id belonging to another actor still only yields that actor's own route shape", () => {
  const { watchRouteFromNotificationData } = loadRouting();
  // Ownership is resolved by the destination screen's RLS-scoped read, never
  // here. What this asserts is that the payload cannot widen the route into
  // anything but the ordinary watch detail path.
  const other = '99999999-8888-7777-6666-555555555555';
  assert.equal(watchRouteFromNotificationData({ watchId: other }), `/watchlist/${other}`);
});

test('WIRING: the routing installer is mounted at the app root', () => {
  // The pure function above is useless if nothing installs the listener —
  // exactly the failure this repair closes.
  const layout = fs.readFileSync(path.join(ROOT, 'app', '_layout.tsx'), 'utf8');
  assert.match(layout, /installWatchNotificationRouting/);
  assert.match(
    layout,
    /from '\.\.\/services\/watchlist\/watchNotificationRouting'/,
    'the root layout must import the routing installer',
  );
});

test('WIRING: the push payload still carries the id this router consumes', () => {
  const delivery = fs.readFileSync(
    path.join(ROOT, 'supabase', 'functions', 'commerce-watch-refresh', 'pushDelivery.ts'),
    'utf8',
  );
  assert.match(delivery, /data:\s*\{\s*watchId:/, 'the sender must keep emitting watchId');
});
