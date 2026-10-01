'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function loadTsModule(relative, requireShim = () => ({}), sandboxExtras = {}) {
  const filename = path.join(ROOT, relative);
  const output = ts.transpileModule(read(relative), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console,
    Date,
    JSON,
    Number,
    String,
    Boolean,
    Promise,
    exports: mod.exports,
    module: mod,
    require: requireShim,
    ...sandboxExtras,
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return { exports: mod.exports, sandbox };
}

test('Packing UUID: Hermes/global crypto absent uses Expo Crypto and returns a server UUID', () => {
  let expoCalls = 0;
  const expoUuid = '8c157faa-4e4c-4f72-9dd2-80c7f66a6fb1';
  const loaded = loadTsModule('hooks/usePackingPlan.ts', (specifier) => {
    if (specifier === 'expo-crypto') {
      return { randomUUID: () => { expoCalls += 1; return expoUuid; } };
    }
    return {};
  });

  assert.equal(loaded.sandbox.crypto, undefined, 'the test realm must model Hermes without crypto');
  const result = loaded.exports.newSessionId();
  assert.equal(result, expoUuid);
  assert.equal(expoCalls, 1, 'Expo Crypto must be the exercised fallback');
  assert.match(result, UUID_V4_RE);
});

test('Packing UUID: Web Crypto remains preferred and the implementation is platform-neutral', () => {
  const loaded = loadTsModule('hooks/usePackingPlan.ts', (specifier) =>
    specifier === 'expo-crypto'
      ? { randomUUID: () => { throw new Error('Expo fallback should not run'); } }
      : {},
  );
  const webUuid = '5d535d17-755d-49b5-805d-4f34e59b82f9';
  const result = loaded.exports.newSessionId({ randomUUID: () => webUuid });
  assert.equal(result, webUuid);
  assert.match(result, UUID_V4_RE);

  const source = read('hooks/usePackingPlan.ts');
  const helper = source.slice(source.indexOf('export function newSessionId'), source.indexOf('export function usePackingPlan'));
  assert.match(source, /import \* as ExpoCrypto from 'expo-crypto'/);
  assert.doesNotMatch(helper, /Date\.now|Math\.random/);
  assert.doesNotMatch(helper, /Platform\.OS|from 'react-native'/);
});

const dates = loadTsModule('components/packing/packingDates.ts').exports;

test('Packing dates: MM/DD/YYYY parses deterministically to canonical server dates', () => {
  assert.equal(dates.parsePackingDisplayDate('10/03/2026'), '2026-10-03');
  assert.equal(dates.parsePackingDisplayDate('10/06/2026'), '2026-10-06');
  assert.equal(dates.parsePackingDisplayDate('02/29/2028'), '2028-02-29');
  assert.equal(dates.parsePackingDisplayDate('02/29/2027'), null);
  assert.equal(dates.parsePackingDisplayDate('02/31/2026'), null);
  assert.equal(dates.parsePackingDisplayDate('13/01/2026'), null);
  assert.equal(dates.parsePackingDisplayDate('10-03-2026'), null);
});

test('Packing dates: restored ISO is displayed and reversed ranges are rejected', () => {
  assert.equal(dates.formatPackingCanonicalDate('2026-10-03'), '10/03/2026');
  assert.deepEqual(
    { ...dates.normalizePackingDateRange('10/06/2026', '10/03/2026', 30) },
    { ok: false, message: 'Your return date is before your departure date.' },
  );
});

test('Packing form: both platforms share MM/DD/YYYY input while submit stays canonical', () => {
  const form = read('components/packing/PackingTripForm.tsx');
  assert.equal((form.match(/placeholder="MM\/DD\/YYYY"/g) ?? []).length, 2);
  assert.match(form, /formatPackingCanonicalDate\(initial\?\.startDate \?\? ''\)/);
  assert.match(form, /formatPackingCanonicalDate\(initial\?\.endDate \?\? ''\)/);
  assert.match(form, /startDate: dates\.startDate/);
  assert.match(form, /endDate: dates\.endDate/);
  assert.match(form, /month slash day slash year/g);
  assert.doesNotMatch(form, /keyboardType="(?:number-pad|numeric|decimal-pad)"/);
  assert.doesNotMatch(form, /Platform\.OS/);
});

for (const [name, relative, heading] of [
  ['intake', 'components/closet/ClosetIntakeModal.tsx', 'Add to Closet'],
  ['manual details', 'components/closet/ClosetCandidateManualClassifyModal.tsx', 'Add details'],
]) {
  test(`Closet ${name} modal: Android gets a top safe area and iOS pageSheet gets no doubled inset`, () => {
    const source = read(relative);
    assert.match(source, /import \{ SafeAreaView \} from 'react-native-safe-area-context'/);
    assert.match(source, /<SafeAreaView[\s\S]*?edges=\{Platform\.OS === 'android' \? \['top'\] : \[\]\}/);
    assert.match(source, /presentationStyle=\{Platform\.OS === 'ios' \? 'pageSheet' : undefined\}/);
    assert.match(source, /<Modal/);
    assert.match(source, /onRequestClose=\{onClose\}/);
    assert.match(source, /<ScrollView/);
    assert.ok(source.includes(`>${heading}</Text>`));
    assert.match(source, /<PrimaryButton/);
  });
}
