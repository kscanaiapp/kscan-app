// BUG-14 — a saved Look must still be there after a force-stop, and must be
// reachable from the surface the product points the user at.
//
// The reported failure was: save a Look in the private Dressing Room, see the
// Saved Look confirmation, force-stop, relaunch, open Closet -> MY LOOKS, and
// find an empty state. Two things had to be established separately:
//
//   1. does the record actually survive a restart? (it does — proven here by
//      booting a SECOND module registry over the SAME bytes, so nothing in
//      memory can carry the answer across a relaunch);
//   2. can the user get back to it? (it could not be reached: MY LOOKS lists
//      cloud `looks` rows, a different entity from the device-local Dressing
//      Room Saved Look, so the surface reported "none" for something that
//      existed).
//
// Both halves are asserted below, because fixing either alone leaves the user
// with the same experience.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const MANIFEST = 'file:///private-documents/kscan_private_dressing_room_saved_looks/kscan_private_dressing_room_saved_looks.json';

/**
 * Boot a complete, isolated instance of the Saved Look store over `disk`.
 *
 * Every call gets a fresh module cache, a fresh actor context and a fresh
 * mutation queue. Two boots over one disk is a force-stop and relaunch.
 */
function boot(disk) {
  const fileSystem = {
    documentDirectory: 'file:///private-documents/',
    EncodingType: { UTF8: 'utf8' },
    async makeDirectoryAsync() {},
    async getInfoAsync(uri) {
      return { exists: disk.has(uri) };
    },
    async readAsStringAsync(uri) {
      if (!disk.has(uri)) throw new Error(`ENOENT ${uri}`);
      return disk.get(uri);
    },
    async writeAsStringAsync(uri, contents) {
      disk.set(uri, contents);
    },
    async deleteAsync(uri) {
      disk.delete(uri);
    },
    async moveAsync({ from, to }) {
      if (!disk.has(from)) throw new Error(`ENOENT ${from}`);
      disk.set(to, disk.get(from));
      disk.delete(from);
    },
  };

  const cache = new Map();
  function loadModule(relPath) {
    if (cache.has(relPath)) return cache.get(relPath);
    const filename = path.join(ROOT, relPath);
    const output = ts.transpileModule(read(relPath), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
    }).outputText;
    const mod = { exports: {} };
    const dirname = path.dirname(filename);
    const localRequire = (specifier) => {
      if (specifier === 'expo-file-system/legacy') return fileSystem;
      if (!specifier.startsWith('.')) throw new Error(`Unexpected import ${specifier}`);
      let resolved = path.resolve(dirname, specifier);
      for (const ext of ['', '.ts', '.js']) {
        if (fs.existsSync(resolved + ext) && fs.statSync(resolved + ext).isFile()) {
          resolved += ext;
          break;
        }
      }
      return loadModule(path.relative(ROOT, resolved).replace(/\\/g, '/'));
    };
    vm.runInThisContext(`(function(exports,module,require){${output}\n})`, { filename })(
      mod.exports,
      mod,
      localRequire,
    );
    cache.set(relPath, mod.exports);
    return mod.exports;
  }

  const actor = loadModule('services/actorContext.js');
  const store = loadModule('services/privateSavedLookStore.ts');

  /** Relaunching starts signed out; signing in is what restores the session. */
  const signIn = (actorId) => {
    actor.advanceActorEpoch(actorId);
    return actor.createActorRequest();
  };

  return { store, actor, signIn };
}

const closetItem = (id = 'closet-top') => ({
  id,
  title: 'Navy silk blouse',
  notes: null,
  origin: null,
  imageUri: 'file:///private/closet/top.jpg',
  thumbnailUri: 'file:///private/closet/top-thumb.jpg',
  createdAt: null,
  updatedAt: null,
  displaySummary: 'Tops - Blouse - Navy',
  taxonomyUnknown: false,
  category: 'Tops',
  clothingType: 'Blouse',
  subtype: 'Silk blouse',
  brand: 'Atelier',
  primaryColor: 'Navy',
  secondaryColors: ['Silver'],
  material: ['Silk'],
  size: null,
});

const effectiveLook = (lookId = 'look-1') => ({
  lookId,
  sessionId: 'session-1',
  items: [{ slot: 'top', closetItemId: 'closet-top', overridden: false, baseClosetItemId: null }],
  completeness: 'partial',
  missingSlots: ['bottom'],
  labelCodes: [],
  rank: 0,
  edited: false,
});

function lookInput(overrides = {}) {
  return {
    sourceSessionId: 'session-1',
    sourceCompositionId: 'composition-1',
    sourceInputFingerprint: 'fingerprint-1',
    look: effectiveLook(),
    closetItems: [closetItem()],
    occasion: 'Work',
    anchorClosetItemId: 'closet-top',
    name: 'Monday meeting',
    ...overrides,
  };
}

// ── 1. Does the record survive a restart? ────────────────────────────────────

test('a saved Look is still there after a force-stop and relaunch', async () => {
  const disk = new Map();

  const first = boot(disk);
  const saved = await first.store.savePrivateSavedLook(first.signIn('actor-a'), lookInput());
  assert.equal(saved.ok, true);
  assert.equal(saved.wrote, true, 'the save must actually have written');
  const savedId = saved.look.id;

  // Force-stop: everything in memory is gone. Only the disk remains.
  const second = boot(disk);
  const reloaded = await second.store.loadPrivateSavedLooks(second.signIn('actor-a'));

  assert.equal(reloaded.ok, true);
  assert.equal(reloaded.looks.length, 1);
  assert.equal(reloaded.looks[0].id, savedId);
});

test('the reopened Look keeps its occasion, name, slots, owner and save date', async () => {
  const disk = new Map();
  const first = boot(disk);
  const saved = await first.store.savePrivateSavedLook(first.signIn('actor-a'), lookInput());
  const before = saved.look;

  const second = boot(disk);
  const detail = await second.store.loadPrivateSavedLook(second.signIn('actor-a'), before.id);

  assert.equal(detail.ok, true);
  assert.equal(detail.look.occasion, 'Work');
  assert.equal(detail.look.name, 'Monday meeting');
  assert.equal(detail.look.actorId, 'actor-a');
  assert.equal(detail.look.createdAt, before.createdAt);
  assert.deepEqual(
    detail.look.slots.map((slot) => slot.slotKey),
    before.slots.map((slot) => slot.slotKey),
  );
  assert.equal(detail.look.slots[0].wasOwnedAtSave, true);
});

test('the Look survives a second restart, and is not duplicated by either', async () => {
  const disk = new Map();
  const first = boot(disk);
  await first.store.savePrivateSavedLook(first.signIn('actor-a'), lookInput());

  const second = boot(disk);
  await second.store.loadPrivateSavedLooks(second.signIn('actor-a'));

  const third = boot(disk);
  const reloaded = await third.store.loadPrivateSavedLooks(third.signIn('actor-a'));

  assert.equal(reloaded.ok, true);
  assert.equal(reloaded.looks.length, 1, 'a reload must never duplicate a Look');
});

test('signing out and back in returns the same Look', async () => {
  const disk = new Map();
  const env = boot(disk);
  const saved = await env.store.savePrivateSavedLook(env.signIn('actor-a'), lookInput());

  env.actor.advanceActorEpoch(null); // sign out
  const signedOut = await env.store.loadPrivateSavedLooks(env.actor.createActorRequest());
  assert.equal(signedOut.ok, false, 'a signed-out read must not expose a private partition');

  const back = await env.store.loadPrivateSavedLooks(env.signIn('actor-a'));
  assert.equal(back.ok, true);
  assert.equal(back.looks.length, 1);
  assert.equal(back.looks[0].id, saved.look.id);
});

test('another account sees none of it, across a restart', async () => {
  const disk = new Map();
  const first = boot(disk);
  await first.store.savePrivateSavedLook(first.signIn('actor-a'), lookInput());

  const second = boot(disk);
  const other = await second.store.loadPrivateSavedLooks(second.signIn('actor-b'));

  assert.equal(other.ok, true);
  assert.deepEqual(other.looks, [], "another actor must not see this actor's Looks");
});

test('a save that fails reports failure and leaves nothing behind to find later', async () => {
  const disk = new Map();
  const env = boot(disk);
  const request = env.signIn('actor-a');

  // No source fingerprint: the record cannot be built, so nothing is written.
  const failed = await env.store.savePrivateSavedLook(request, lookInput({ sourceInputFingerprint: '' }));
  assert.equal(failed.ok, false, 'a rejected Look must never report success');
  assert.equal(failed.look, null);

  const after = boot(disk);
  const reloaded = await after.store.loadPrivateSavedLooks(after.signIn('actor-a'));
  assert.equal(reloaded.ok, true);
  assert.deepEqual(reloaded.looks, []);
});

test('an unreadable store is reported, never presented as an empty list', async () => {
  const disk = new Map();
  const first = boot(disk);
  await first.store.savePrivateSavedLook(first.signIn('actor-a'), lookInput());

  disk.set(MANIFEST, '{ not json');

  const second = boot(disk);
  const reloaded = await second.store.loadPrivateSavedLooks(second.signIn('actor-a'));

  // This distinction is the whole reason this defect looked like data loss:
  // "we could not read it" must not render as "you have none".
  assert.equal(reloaded.ok, false);
  assert.equal(reloaded.recoverable, true);
  assert.deepEqual(reloaded.looks, []);
});

test('NEGATIVE CONTROL: an in-memory-only store fails the restart assertion', async () => {
  // A store that never reaches the disk — the shape of defect the reporter
  // suspected. The same assertion used above must fail against it.
  const memoryOnly = (() => {
    let looks = [];
    return {
      async savePrivateSavedLook(_request, input) {
        const look = { id: 'saved-look-mem', ...input };
        looks.push(look);
        return { ok: true, look, looks, wrote: true };
      },
      async loadPrivateSavedLooks() {
        return { ok: true, looks, recovered: 'primary' };
      },
      /** Relaunch drops everything that was only ever in memory. */
      restart() {
        looks = [];
      },
    };
  })();

  await memoryOnly.savePrivateSavedLook(null, lookInput());
  assert.equal((await memoryOnly.loadPrivateSavedLooks()).looks.length, 1);

  memoryOnly.restart();
  const afterRestart = await memoryOnly.loadPrivateSavedLooks();
  assert.throws(
    () => assert.equal(afterRestart.looks.length, 1),
    'the restart assertion must fail when persistence is only in memory',
  );
});

// ── 2. Can the user get back to it? ──────────────────────────────────────────

test('MY LOOKS tells the user their Dressing Room Saved Looks exist', () => {
  const screen = read('app/looks/index.tsx');

  assert.match(screen, /usePrivateSavedLooksSummary/);
  assert.match(screen, /router\.push\('\/stylist\/saved-looks'\)/);
  assert.match(screen, /testID="looks-dressing-room-entry"/);

  // The notice must render in BOTH states. Before this repair the empty state
  // was all the user saw, and it said they had nothing.
  const emptyStateAt = screen.indexOf('looks.length === 0');
  const noticeAt = screen.indexOf('{dressingRoomLooksNotice}');
  assert.ok(noticeAt >= 0 && noticeAt < emptyStateAt, 'the notice must render above the empty state');
});

test('an unreadable Dressing Room store is not reported to the user as zero', () => {
  const screen = read('app/looks/index.tsx');
  const hook = read('hooks/usePrivateSavedLooksSummary.ts');

  assert.match(hook, /unreadable: !result\.ok/);
  assert.match(hook, /count: result\.ok \? result\.looks\.length : null/);
  assert.match(screen, /dressingRoomLooks\.unreadable/);
});

test('the two Look entities stay separate — this is an entry point, not a merge', () => {
  const screen = read('app/looks/index.tsx');
  // The cloud list still comes from useLooks alone; private records are counted
  // and linked, never folded into the grid.
  assert.match(screen, /const \{ looks, loading, error, reload \} = useLooks\(\);/);
  assert.equal(screen.includes('loadPrivateSavedLooks'), false, 'the screen must not read the private store directly');
  assert.match(screen, /looks\.map\(\(look\) => \(/);
});

test('NEGATIVE CONTROL: without the entry point MY LOOKS still reports nothing', () => {
  // The screen as it was: no awareness of the private store at all.
  const preRepairScreen = `
    const { looks, loading, error, reload } = useLooks();
    {looks.length === 0 ? (
      <EmptyStateCard title="Build outfits from the pieces you already own." />
    ) : null}
  `;
  assert.throws(
    () => assert.match(preRepairScreen, /usePrivateSavedLooksSummary/),
    'the reachability check must fail when the screen cannot see the private store',
  );
  assert.throws(
    () => assert.match(preRepairScreen, /testID="looks-dressing-room-entry"/),
    'the entry-point check must fail when there is no entry point',
  );
});

// ── 3. The canonical Look size rule ──────────────────────────────────────────

test('the cloud Look minimum is 2 and is enforced at every layer', () => {
  const service = read('services/styleObjects.ts');
  assert.match(service, /export const LOOK_MIN_ITEMS = 2;/);
  assert.match(service, /export const LOOK_MAX_ITEMS = 6;/);
  assert.match(service, /items\.length < LOOK_MIN_ITEMS/);

  // The create screen cannot submit below it...
  const create = read('app/looks/create.tsx');
  assert.match(create, /selectedItems\.length >= LOOK_MIN_ITEMS/);
  assert.match(create, /if \(selectedItems\.length < LOOK_MIN_ITEMS/);

  // ...and the database refuses even if a client ever did.
  const migration = read('supabase/migrations/20260711000001_ai_stylist_looks_extension.sql');
  assert.match(migration, /item_count < 2 or item_count > 6/);
  assert.match(migration, /A Look needs between 2 and 6 items/);
});

test('a Dressing Room Saved Look is a different entity with its own rule', () => {
  // It snapshots the slots of an effective Look, including slots that are
  // MISSING, so a one-slot record is meaningful rather than an under-sized
  // Look. The 2-6 rule belongs to the cloud entity and is not imported here.
  const schema = read('services/privateSavedLookSchema.ts');
  assert.match(schema, /if \(slots\.length === 0\) return null;/);
  assert.equal(schema.includes('LOOK_MIN_ITEMS'), false);
  assert.match(schema, /if \(!effective && !missing\.has\(slotKey\)\) continue;/);
});
