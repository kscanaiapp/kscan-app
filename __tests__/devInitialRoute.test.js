// DEVELOPMENT-ONLY QA starting route (Build 3 Phase 4).
//
// Exists because inside an Expo dev client a `kscan://` VIEW intent never
// reaches expo-router — the dev client owns the scheme — so `adb shell am start
// -d kscan://stylist/dressing-room` lands on Home with the auth gate reporting
// `guardAction: 'allow'`. That is not a guard problem and no URL form fixes it,
// which left automated runtime QA tapping through the UI on cached coordinates.
//
// The risk this introduces is a build that starts somewhere other than Home, so
// that is what these assert against: it must be impossible in release, and it
// must never be able to outrank the auth gate.
//
// `.test.js` so scripts/run-all-tests.js discovers it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const FLAGS = 'constants/featureFlags.ts';
const LAYOUT = 'app/_layout.tsx';

/** Evaluates the flag module under a chosen __DEV__ and process.env. */
function flagUnder({ dev, env = {} }) {
  const output = ts.transpileModule(fs.readFileSync(path.join(ROOT, FLAGS), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    exports: mod.exports,
    module: mod,
    require: () => {
      throw new Error('featureFlags must not import');
    },
    process: { env },
    __DEV__: dev,
  };
  vm.createContext(sandbox);
  new vm.Script(output).runInContext(sandbox);
  return mod.exports;
}

const ROUTE = { EXPO_PUBLIC_DEV_INITIAL_ROUTE: '/stylist/dressing-room' };

test('a release build can never resolve a dev initial route', () => {
  for (const env of [
    ROUTE,
    { EXPO_PUBLIC_DEV_INITIAL_ROUTE: '/' },
    { EXPO_PUBLIC_DEV_INITIAL_ROUTE: '/onboarding' },
  ]) {
    assert.equal(
      flagUnder({ dev: false, env }).DEV_INITIAL_ROUTE,
      null,
      `${JSON.stringify(env)} must be inert in release`,
    );
  }
});

test('in development it resolves only an explicit absolute route', () => {
  assert.equal(flagUnder({ dev: true, env: ROUTE }).DEV_INITIAL_ROUTE, '/stylist/dressing-room');
  // Anything that is not an absolute path is ignored rather than guessed at.
  for (const value of [undefined, '', '   ', 'stylist/dressing-room', 'true', '1']) {
    const env = value === undefined ? {} : { EXPO_PUBLIC_DEV_INITIAL_ROUTE: value };
    assert.equal(
      flagUnder({ dev: true, env }).DEV_INITIAL_ROUTE,
      null,
      `${JSON.stringify(value)} must not resolve`,
    );
  }
});

test('__DEV__ is checked before the variable is read, with an inline literal', () => {
  const source = fs.readFileSync(path.join(ROOT, FLAGS), 'utf8');
  const start = source.indexOf('export const DEV_INITIAL_ROUTE');
  assert.ok(start > 0, 'DEV_INITIAL_ROUTE must exist');
  const decl = source.slice(start, start + 400);
  assert.ok(
    decl.indexOf("__DEV__ === true") < decl.indexOf('EXPO_PUBLIC_DEV_INITIAL_ROUTE'),
    '__DEV__ must be evaluated before the variable is read',
  );
  // An inline literal, not a function call: only a literal can be folded.
  assert.match(decl, /typeof __DEV__ !== 'undefined' && __DEV__ === true/);
});

test('the QA route variable is absent from every build profile', () => {
  const eas = fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8');
  assert.equal(eas.includes('DEV_INITIAL_ROUTE'), false, 'no EAS profile may name it');
  const parsed = JSON.parse(eas);
  for (const [profile, config] of Object.entries(parsed.build ?? {})) {
    assert.equal(
      'EXPO_PUBLIC_DEV_INITIAL_ROUTE' in (config.env ?? {}),
      false,
      `${profile} must not carry it`,
    );
  }
  for (const file of ['.env.example', '.env.e2e.example']) {
    const full = path.join(ROOT, file);
    if (fs.existsSync(full)) {
      assert.equal(fs.readFileSync(full, 'utf8').includes('DEV_INITIAL_ROUTE'), false, file);
    }
  }
});

test('the route jump can never outrank the auth gate', () => {
  const layout = fs.readFileSync(path.join(ROOT, LAYOUT), 'utf8');
  const start = layout.indexOf('if (!DEV_INITIAL_ROUTE || devJumpRef.current) return;');
  assert.ok(start > 0, 'the dev jump effect must exist');
  const effect = layout.slice(start, start + 600);

  // It waits for navigation readiness, defers to the auth-callback route, and
  // only fires once the guard has SETTLED to allow — so it cannot race the guard
  // or push an unauthenticated actor into a protected route.
  assert.match(effect, /if \(!navReady \|\| waitingForAuthCallbackRoute\) return;/);
  assert.match(effect, /if \(guardState\.action !== 'allow'\) return;/);
  // Strictly one-shot, so it cannot fight later user navigation.
  assert.match(effect, /devJumpRef\.current = true;/);
  // It PUSHES rather than replaces, leaving Home on the stack and Back working.
  assert.match(effect, /router\.push\(DEV_INITIAL_ROUTE/);

  // The guard's own redirect effect is untouched: it still replaces on redirect.
  assert.match(layout, /if \(waitingForAuthCallbackRoute \|\| guardState\.action !== 'redirect'/);
  assert.match(layout, /router\.replace\(redirectTo\);/);
});

test('the dev jump adds no user-visible control and no production route', () => {
  const layout = fs.readFileSync(path.join(ROOT, LAYOUT), 'utf8');
  // No new screen, button or link — it reuses the existing router only. Bounded
  // to the effect itself; slicing to end-of-file would catch the layout's own
  // error UI and prove nothing.
  const start = layout.indexOf('if (!DEV_INITIAL_ROUTE || devJumpRef.current) return;');
  const devBlock = layout.slice(start, layout.indexOf('}, [guardState.action, navReady', start));
  assert.ok(devBlock.length > 0 && devBlock.length < 800, 'effect bounds not found');
  for (const forbidden of ['<Pressable', '<Text', '<View', 'onPress', 'Linking.']) {
    assert.equal(devBlock.includes(forbidden), false, `dev jump must not use ${forbidden}`);
  }
  // Comments stripped: the flag appears in CODE only as the import plus the
  // three uses inside that single effect (guard, trace, push). Any further code
  // reference would mean the dev route had leaked into another decision.
  const code = layout.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal((code.match(/DEV_INITIAL_ROUTE/g) ?? []).length, 4);
});
