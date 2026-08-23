'use strict';

// Coverage for how a wearable result's commerce provenance reaches a human, and
// for the route gate on the internal-only Meta surfaces.
//
// WHY THIS FILE EXISTS. wearable-scan stamps every product with the array it
// came from — 'retail' (a live, buyable listing) or 'suggested' (a catalog
// visual-similarity match). That distinction was the entire point of the
// backend grouping work, and NO client surface consumed it: `commerceGroup`
// appeared nowhere in the mobile app. The glasses glance, the companion result
// card and the deep-link handoff screen all rendered a suggestion exactly like
// a listing — title, brand, retailer, price — so the grouping fix stopped one
// step short of the wearer. The collapse simply moved from the server to the
// client.
//
// The handoff screen additionally read `primary.resaleSource`, a field
// wearable-scan has never produced and deliberately never will (scan-identify
// carries no resale provenance), so that line was always dead.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'services', 'metaWearableDevice.ts');
const COMPANION_SCREEN = path.join(__dirname, '..', 'app', 'wearables', 'meta.tsx');
const RESULT_SCREEN = path.join(__dirname, '..', 'app', 'wearables', 'result', '[resultId].tsx');

function loadModule() {
  const output = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    module: mod,
    exports: mod.exports,
    console,
    Promise,
    Set,
    Number,
    Math,
    Array,
    require: (id) => {
      throw new Error(`Unexpected runtime require in metaWearableDevice.ts: ${id}`);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(output, sandbox, { filename: 'metaWearableDevice.ts' });
  return mod.exports;
}

const M = loadModule();

test('a live listing and a similarity suggestion read differently', () => {
  const retail = M.describeCommerceGroup('retail');
  const suggested = M.describeCommerceGroup('suggested');
  assert.ok(retail.length > 0);
  assert.ok(suggested.length > 0);
  assert.notEqual(retail, suggested);
});

test('an unknown or missing group says nothing rather than guessing', () => {
  for (const value of [undefined, null, '', 'resale', 'RETAIL', 42, {}]) {
    assert.equal(M.describeCommerceGroup(value), '', `guessed for ${JSON.stringify(value)}`);
  }
});

test('THE DEFECT: the glasses glance no longer presents a suggestion as a listing', () => {
  const suggestion = M.toDisplayPayload({
    summary: 'A charcoal wool overcoat',
    confidence: 87,
    actions: ['save', 'open_on_phone'],
    primaryMatch: {
      title: 'Double-Breasted Overcoat',
      brand: 'Acme Co',
      commerceGroup: 'suggested',
      price: { label: '$249.00' },
    },
  });
  assert.ok(suggestion.subtitle.includes(M.describeCommerceGroup('suggested')));
  assert.ok(!suggestion.subtitle.includes(M.describeCommerceGroup('retail')));

  const listing = M.toDisplayPayload({
    summary: 'A charcoal wool overcoat',
    confidence: 87,
    actions: ['save'],
    primaryMatch: {
      title: 'Double-Breasted Overcoat',
      brand: 'Acme Co',
      commerceGroup: 'retail',
      price: { label: '$249.00' },
    },
  });
  assert.ok(listing.subtitle.includes(M.describeCommerceGroup('retail')));
});

test('an ungrouped item still renders — silently, with no invented provenance', () => {
  const payload = M.toDisplayPayload({
    primaryMatch: { title: 'Unlabelled Item', brand: 'Some Brand' },
    actions: [],
  });
  assert.equal(payload.title, 'Unlabelled Item');
  assert.equal(payload.subtitle, 'Some Brand');
});

test('the glance subtitle stays inside the display budget with the group added', () => {
  const payload = M.toDisplayPayload({
    confidence: 99,
    actions: [],
    primaryMatch: {
      title: 'T'.repeat(200),
      brand: 'B'.repeat(200),
      commerceGroup: 'suggested',
    },
  });
  assert.ok(payload.title.length <= 48);
  assert.ok(payload.subtitle.length <= 48);
});

// ---------------------------------------------------------------------------
// Screen wiring. Source-level; these screens cannot be rendered off-device.
// ---------------------------------------------------------------------------

const companionScreen = fs.readFileSync(COMPANION_SCREEN, 'utf8');
const resultScreen = fs.readFileSync(RESULT_SCREEN, 'utf8');

test('both user-visible result surfaces show the commerce group', () => {
  assert.match(companionScreen, /describeCommerceGroup\(primary\.commerceGroup\)/);
  assert.match(resultScreen, /describeCommerceGroup\(primary\.commerceGroup\)/);
});

test('the dead resaleSource read is gone from the handoff screen', () => {
  const code = resultScreen
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');
  assert.ok(!/primary\.resaleSource/.test(code), 'resaleSource is read again — it never exists');
});

test('the alternatives count distinguishes listings from look-alikes', () => {
  assert.match(companionScreen, /function summariseAlternatives/);
  assert.match(companionScreen, /in stock/);
  assert.match(companionScreen, /similar/);
});

test('both internal-only routes are gated by the Meta candidate flag', () => {
  for (const screen of [companionScreen, resultScreen]) {
    assert.match(screen, /META_WEARABLE_CANDIDATE_ENABLED/);
    assert.match(screen, /if \(!META_WEARABLE_CANDIDATE_ENABLED\) return <Redirect href="\/" \/>;/);
  }
});

test('the route gate is a hook-free wrapper, so hook order cannot depend on a flag', () => {
  for (const [name, screen] of [['companion', companionScreen], ['result', resultScreen]]) {
    const gate = screen.slice(screen.indexOf('export default function'));
    const body = gate.slice(0, gate.indexOf('\n}\n') + 1);
    assert.ok(
      !/\buse[A-Z]\w*\(/.test(body),
      `${name} route gate calls a hook before the flag check`,
    );
  }
});
