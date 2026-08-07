const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Transpile-and-run a leaf TypeScript module that imports only type-level deps. */
function loadTsModule(rel) {
  const filename = path.join(ROOT, rel);
  const output = ts.transpileModule(read(rel), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  vm.runInThisContext(`(function(exports,module,require){${output}\n})`, { filename })(
    mod.exports,
    mod,
    () => ({}),
  );
  return mod.exports;
}

function flags(env) {
  const source = read('constants/featureFlags.ts');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = { exports: mod.exports, module: mod, process: { env }, __DEV__: false };
  vm.createContext(sandbox);
  new vm.Script(output).runInContext(sandbox);
  return mod.exports;
}

const ALL_ON = {
  EXPO_PUBLIC_PRIVATE_DRESSING_ROOM_V1: 'true',
  EXPO_PUBLIC_PRIVATE_DRESSING_ROOM_INTERACTIONS_V1: 'true',
  EXPO_PUBLIC_PRIVATE_DRESSING_ROOM_ELISE_V1: 'true',
  EXPO_PUBLIC_PRIVATE_DRESSING_ROOM_SAVED_LOOKS_V1: 'true',
};

test('Saved Looks leaf defaults OFF and activates only beneath every parent gate', () => {
  assert.equal(flags({}).PRIVATE_DRESSING_ROOM_SAVED_LOOKS_ACTIVE, false);
  assert.equal(flags(ALL_ON).PRIVATE_DRESSING_ROOM_SAVED_LOOKS_ACTIVE, true);
  for (const key of Object.keys(ALL_ON)) {
    assert.equal(
      flags({ ...ALL_ON, [key]: 'false' }).PRIVATE_DRESSING_ROOM_SAVED_LOOKS_ACTIVE,
      false,
      `${key} did not gate Saved Looks`,
    );
  }
});

// SUPERSEDED BY THE OWNER-AUTHORIZED BUILD 3 ACTIVATION, deliberately.
// The Phase 5 leaf is now set in every profile; what survives is that Saved
// Looks remain a LEAF under the Elise and workspace gates, so no route or
// storage can activate when any parent is off.
test('every profile enables the Saved Looks leaf, which stays nested under its parents', () => {
  const eas = JSON.parse(read('eas.json'));
  for (const [profile, config] of Object.entries(eas.build)) {
    assert.equal(
      config.env?.EXPO_PUBLIC_PRIVATE_DRESSING_ROOM_SAVED_LOOKS_V1,
      'true',
      `${profile} does not enable the Phase 5 leaf`,
    );
  }
  const flags = read('constants/featureFlags.ts');
  assert.ok(
    flags.includes('PRIVATE_DRESSING_ROOM_SAVED_LOOKS_ACTIVE =\n  PRIVATE_DRESSING_ROOM_ELISE_ACTIVE && PRIVATE_DRESSING_ROOM_SAVED_LOOKS_V1'),
    'Saved Looks are no longer nested under the Elise gate',
  );
});

test('ON entry points save the effective Look, open detail, and expose the distinct list route', () => {
  const room = read('app/stylist/dressing-room/index.tsx');
  const hook = read('hooks/usePrivateDressingRoom.ts');
  const stylist = read('app/stylist/index.tsx');
  assert.match(room, /savedLooksEnabled[\s\S]*?title=\{saveLookBusy \? 'Saving Look'/);
  assert.match(room, /await saveActiveLook\(\)[\s\S]*?\/stylist\/saved-looks\/\[id\]/);
  assert.match(hook, /saveLookBusyRef\.current[\s\S]*?savePrivateSavedLook/);
  assert.match(hook, /look,\s*closetItems: view\.closetItems/);
  assert.match(stylist, /PRIVATE_DRESSING_ROOM_SAVED_LOOKS_ACTIVE[\s\S]*?title="Saved Looks"[\s\S]*?\/stylist\/saved-looks/);
});

test('OFF routes render a bounded disabled state before starting local reads', () => {
  for (const rel of [
    'app/stylist/saved-looks/index.tsx',
    'app/stylist/saved-looks/[id].tsx',
    'app/stylist/saved-looks/handoff.tsx',
  ]) {
    const source = read(rel);
    assert.match(source, /if \(!PRIVATE_DRESSING_ROOM_SAVED_LOOKS_ACTIVE/);
    const loader = source.indexOf('const load = useCallback');
    const firstRead = Math.min(...[
      source.indexOf('loadPrivateSavedLook', loader),
      source.indexOf('loadSavedLookReturnContext', loader),
    ].filter((value) => value >= 0));
    const guard = source.indexOf('!PRIVATE_DRESSING_ROOM_SAVED_LOOKS_ACTIVE', loader);
    assert.ok(loader >= 0 && guard > loader && (firstRead < 0 || guard < firstRead), `${rel} reads before its OFF guard`);
  }
});

test('list and detail expose required loading, empty, recovery, missing and signed-out states', () => {
  const list = read('app/stylist/saved-looks/index.tsx');
  const detail = read('app/stylist/saved-looks/[id].tsx');
  for (const text of ['Loading Saved Looks', 'No Saved Looks yet', 'Saved Looks recovered', 'Sign in to continue']) {
    assert.ok(list.includes(text), `list missing ${text}`);
  }
  for (const text of ['Loading Saved Look', 'Saved Look not found', 'Sign in to continue']) {
    assert.ok(detail.includes(text), `detail missing ${text}`);
  }
  // BUG-15: the Closet-unavailable notice still exists, but its wording now
  // lives in the shopper-copy module instead of being written into the screen.
  assert.match(detail, /SAVED_LOOK_DETAIL_COPY\.closetUnavailableTitle/);
  assert.match(detail, /SAVED_LOOK_DETAIL_COPY\.closetUnavailableBody/);
  assert.match(list, /Alert\.alert\('Delete Saved Look\?'/);
  assert.match(detail, /Alert\.alert\('Delete Saved Look\?'/);
});

test('typed Closet failures remain distinct from an empty Closet', () => {
  for (const rel of ['app/stylist/saved-looks/index.tsx', 'app/stylist/saved-looks/[id].tsx']) {
    const source = read(rel);
    assert.match(source, /loadClosetTyped/);
    assert.doesNotMatch(source, /loadCloset\(/);
    assert.match(source, /closetUnavailable: !closet\.ok/);
  }
  const detail = read('app/stylist/saved-looks/[id].tsx');
  assert.match(detail, /current\.look && !current\.closetUnavailable[\s\S]*?resolvePrivateSavedLookOwnership/);
});

test('detail supports deleted references, incompatible edits, placeholders and explicit commerce choices', () => {
  const detail = read('app/stylist/saved-looks/[id].tsx');
  assert.ok(detail.includes('No current image'));
  assert.ok(detail.includes("'Shop anyway'"));
  assert.ok(detail.includes("'Find an alternative'"));
  assert.match(detail, /SAVED_LOOK_DETAIL_COPY\.ownedAlternativeTitle/);

  // BUG-15: the deleted-reference and incompatible-edit states are still
  // distinguished for the shopper, but the screen no longer carries the
  // wording. Asserting through the copy module keeps the states covered while
  // letting the words be shopper-facing.
  const copy = loadTsModule('services/privateSavedLookCopy.ts');
  assert.match(detail, /savedLookSlotCopy\(slotOwnership\?\.state\)/);
  const deleted = copy.savedLookSlotCopy('deleted_reference');
  const changed = copy.savedLookSlotCopy('incompatible_edit');
  assert.notEqual(deleted.label, changed.label, 'the two states must not read the same');
  for (const entry of [deleted, changed]) {
    assert.ok(entry.label.length > 0 && entry.detail.length > 0);
    assert.notEqual(entry.label, copy.SAVED_LOOK_SLOT_UNAVAILABLE.label);
  }
});

test('same-route return context restores the same slot and refreshes ownership before clearing', () => {
  const detail = read('app/stylist/saved-looks/[id].tsx');
  const handoff = read('app/stylist/saved-looks/handoff.tsx');
  assert.match(detail, /loadPrivateSavedLook[\s\S]*?loadClosetTyped[\s\S]*?loadSavedLookReturnContext/);
  // DEFECT-P6-005: the highlight is derived through resolveReturnContextSlot,
  // which binds it to THIS Look and to a slot that Look still has. The inline
  // `savedLookId === saved.look.id` comparison this used to assert lived here
  // and checked only the id; the helper enforces both and is unit-tested in
  // __tests__/privateSavedLookReturnContext.test.js.
  assert.match(detail, /resolveReturnContextSlot\(returnContext, saved\.look\)/);
  assert.doesNotMatch(
    detail,
    /highlightedSlot\s*=\s*returnContext\?\.savedLookId/,
    'the id-only highlight derivation must not come back',
  );
  assert.match(detail, /resolvePrivateSavedLookOwnership/);
  assert.match(detail, /clearSavedLookReturnContext/);
  assert.match(handoff, /pathname: '\/stylist\/saved-looks\/\[id\]'[\s\S]*?context\.savedLookId/);
  assert.match(handoff, /if \(!context\) \{[\s\S]*?router\.replace\('\/stylist\/saved-looks'\)/);
});

test('existing cloud Saved Outfit route remains separate and unmodified by Phase 5 imports', () => {
  const legacy = read('app/looks/[id].tsx');
  assert.doesNotMatch(legacy, /privateSavedLook|saved-looks/);
  assert.ok(fs.existsSync(path.join(ROOT, 'app/stylist/saved-looks/[id].tsx')));
});

test('busy guard rejects concurrent save submission and always clears after failure', () => {
  const hook = read('hooks/usePrivateDressingRoom.ts');
  const start = hook.indexOf('const saveActiveLook');
  const end = hook.indexOf('/** Route unmount', start);
  const block = hook.slice(start, end);
  assert.match(block, /saveLookBusyRef\.current\) return null/);
  assert.match(block, /saveLookBusyRef\.current = true/);
  assert.match(block, /catch \{\s*return null/);
  assert.match(block, /finally[\s\S]*?saveLookBusyRef\.current = false[\s\S]*?setSaveLookBusy\(false\)/);
});

test('Saved Looks remains local-only with no Supabase schema or cloud Look persistence', () => {
  const phase5Files = [
    'services/privateSavedLookStore.ts', 'services/privateSavedLookSchema.ts',
    'services/privateSavedLookOwnership.ts', 'services/privateSavedLookHandoff.ts',
    'services/privateSavedLookReturnContext.ts',
  ].map(read).join('\n');
  assert.doesNotMatch(
    phase5Files,
    /from ['"].*supabaseClient['"]|supabase\.|\.from\(['"]looks['"]\)|look_items|kscan\.freeTier\.styleBoards\.v1/i,
  );
  const migrations = fs.readdirSync(path.join(ROOT, 'supabase/migrations'));
  assert.equal(migrations.some((name) => /saved.?look/i.test(name)), false);
});
