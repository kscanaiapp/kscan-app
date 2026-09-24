'use strict';

/**
 * The "Add Scan to Dressing Room" sheet, executed: every path a user can take
 * through components/AddScanToDressingRoomModal.tsx.
 *
 * The component is the real module, run under __tests__/helpers/componentRenderer.js.
 * Its collaborators are stand-ins at the module boundary EXCEPT the actor authority
 * (services/actorContext.js and services/actorScope.ts), which is real so that an
 * account switch in the middle of an await is a genuine epoch change rather than a
 * flag the test flips.
 *
 * Scenario ledger (see the implementation notes for file:line):
 *   WORKS  existing room, new room, cancel, deleted/stale room, invalid scan,
 *          repeated tap, navigation to the room list
 *   FIXED  a room list or save result that resolves after an actor switch is no
 *          longer applied; a create-then-add failure no longer strands the created
 *          room (a retry adds to it instead of creating a second one)
 *   NOT COVERED, on purpose: duplicate prevention. It lives in
 *          services/styleObjects.ts behind DRESSING_ROOM_DEDUPE_V1, which the
 *          owner-ratified flag matrix keeps OFF, so the sheet does not attempt it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createReactNativeStub,
  createRenderer,
  deepStub,
  deferred,
  findAll,
  runModule,
  settle,
  textContent,
} = require('./helpers/componentRenderer');

const responsiveLayout = require('../services/responsiveLayout');

const SPACING = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };

/** Same rule as services/dressingRoomItemContract.hasUsableDressingRoomImageSource (which has its own suite). */
function hasUsableDressingRoomImageSource({ localUri, storageBucket, storagePath, imageUrl }) {
  if (storageBucket && storagePath) return true;
  if (imageUrl && /^https?:\/\//i.test(imageUrl)) return true;
  return Boolean(localUri && /^(file|content|asset|ph):\/\//i.test(localUri));
}

function loadActorAuthority() {
  const actorContext = runModule('services/actorContext.js', {}, { jsx: false });
  const actorScope = runModule('services/actorScope.ts', { './actorContext': actorContext }, { jsx: false });
  actorContext.advanceActorEpoch('actor-a');
  return { actorContext, actorScope };
}

function createServices() {
  const services = {
    rooms: [{ id: 'room-trip', title: 'Trip', itemCount: 2 }],
    listCalls: 0,
    created: [],
    added: [],
    listImpl: async () => services.rooms,
    createImpl: async ({ title }) => ({ id: 'room-new', title }),
    addImpl: async () => ({ id: 'item-1' }),
  };
  services.module = {
    listDressingRooms: () => {
      services.listCalls += 1;
      return services.listImpl();
    },
    createDressingRoom: (input) => {
      services.created.push(input);
      return services.createImpl(input);
    },
    addScanImageToDressingRoom: (input) => {
      services.added.push(input);
      return services.addImpl(input);
    },
  };
  return services;
}

function mount({ services = createServices(), props = {} } = {}) {
  const renderer = createRenderer();
  const authority = loadActorAuthority();
  const pushes = [];
  const closes = [];

  const { AddScanToDressingRoomModal } = runModule('components/AddScanToDressingRoomModal.tsx', {
    ...renderer.runtimeModules,
    'react-native': createReactNativeStub({ platformOS: 'ios' }),
    'expo-router': { router: { push: (href) => pushes.push(href) } },
    '../constants/theme': {
      LUXURY: deepStub(),
      RADIUS: deepStub(),
      SHADOWS: deepStub(),
      SPACING,
    },
    '../services/responsiveLayout': responsiveLayout,
    '../contexts/AuthSessionContext': { useAuthSession: () => ({ user: { id: 'actor-a' } }) },
    '../services/styleObjects': services.module,
    '../services/dressingRoomItemContract': { hasUsableDressingRoomImageSource },
    '../services/actorScope': authority.actorScope,
  });

  const build = (overrides = {}) =>
    renderer.jsx(AddScanToDressingRoomModal, {
      visible: true,
      localImageUri: 'file:///scan.jpg',
      scan: {
        sourceType: 'live_scan',
        sourceId: null,
        result: 'A camel wool coat.',
        metadata: { category: 'Coat' },
      },
      onClose: () => closes.push('close'),
      ...props,
      ...overrides,
    });
  let element = build();

  let tree = renderer.render(element);
  const labelled = (label) => findAll(tree, (node) => node.props?.accessibilityLabel === label);

  return {
    services,
    authority,
    pushes,
    closes,
    async settled() {
      await settle();
      tree = renderer.render(element);
    },
    rerender() {
      tree = renderer.render(element);
    },
    /** The same mounted sheet with a different `visible`: closing and reopening it re-runs its open effect. */
    setVisible(visible) {
      element = build({ visible });
      tree = renderer.render(element);
    },
    has: (label) => labelled(label).length > 0,
    control(label) {
      const [node] = labelled(label);
      assert.ok(node, `no control labelled "${label}" in: ${textContent(tree)}`);
      return node;
    },
    /** A disabled control does nothing, exactly as in React Native. */
    press(label) {
      const node = this.control(label);
      if (node.props.disabled) return false;
      node.props.onPress();
      return true;
    },
    type(label, text) {
      this.control(label).props.onChangeText(text);
      this.rerender();
    },
    text: () => textContent(tree),
  };
}

const ROOM_BUTTON = 'Save scan to Trip';
const TITLE_FIELD = 'New dressing room title';
const CREATE_BUTTON = 'Create new room and save scan';

// ── WORKS ────────────────────────────────────────────────────────────────────

test('WORKS: an existing room takes the scan and the sheet reports success', async () => {
  const m = mount();
  await m.settled();
  assert.ok(m.has(ROOM_BUTTON), 'the owner-scoped list offers the room');

  m.press(ROOM_BUTTON);
  await m.settled();

  assert.equal(m.services.added.length, 1);
  assert.equal(m.services.added[0].dressingRoomId, 'room-trip');
  assert.equal(m.services.added[0].userId, 'actor-a');
  assert.equal(m.services.added[0].scan.localImageUri, 'file:///scan.jpg');
  assert.equal(m.services.added[0].scan.metadata.category, 'Coat');
  assert.match(m.text(), /Added to Dressing Room/);
  assert.match(m.text(), /Added to Trip\./);
  assert.ok(m.has('View Dressing Room') && m.has('Continue scanning'));
});

test('WORKS: a new room is created, then the scan is added to it', async () => {
  const services = createServices();
  services.rooms = [];
  const m = mount({ services });
  await m.settled();
  assert.match(m.text(), /Create your first Dressing Room\./);
  assert.equal(m.press(CREATE_BUTTON), false, 'Create is disabled until a title is typed');

  m.type(TITLE_FIELD, 'Weekend');
  m.press(CREATE_BUTTON);
  await m.settled();

  assert.deepEqual(services.created.map((input) => input.title), ['Weekend']);
  assert.equal(services.created[0].userId, 'actor-a');
  assert.equal(services.added.length, 1);
  assert.equal(services.added[0].dressingRoomId, 'room-new');
  assert.match(m.text(), /Added to Weekend\./);
});

test('WORKS: cancel closes the sheet and writes nothing', async () => {
  const m = mount();
  await m.settled();
  m.press('Close add to room');
  assert.deepEqual(m.closes, ['close']);
  assert.equal(m.services.added.length, 0);
  assert.equal(m.services.created.length, 0);
});

test('WORKS: a room deleted since the list loaded fails as a message, keeps the sheet open, and can be retried', async () => {
  const services = createServices();
  services.addImpl = async () => {
    throw new Error('Unable to add scan to Dressing Room.');
  };
  const m = mount({ services });
  await m.settled();

  m.press(ROOM_BUTTON);
  await m.settled();

  assert.match(m.text(), /Unable to add scan to Dressing Room\./);
  assert.doesNotMatch(m.text(), /Added to/);
  assert.deepEqual(m.closes, [], 'a failed save does not dismiss the sheet');
  assert.ok(m.has(ROOM_BUTTON), 'the row stays so the user can retry or pick another room');

  services.addImpl = async () => ({ id: 'item-2' });
  m.press(ROOM_BUTTON);
  await m.settled();
  assert.equal(services.added.length, 2);
  assert.match(m.text(), /Added to Trip\./);
});

test('WORKS: a scan with no usable image offers no room to save to', async () => {
  const m = mount({ props: { localImageUri: null } });
  await m.settled();
  assert.match(m.text(), /doesn't have a usable image yet/);
  assert.equal(m.has(ROOM_BUTTON), false);
  assert.equal(m.has(CREATE_BUTTON), false);
  assert.equal(m.services.added.length, 0);
});

test('WORKS: a repeated tap while a save is in flight saves once', async () => {
  const services = createServices();
  const gate = deferred();
  services.addImpl = () => gate.promise;
  const m = mount({ services });
  await m.settled();

  const first = m.press(ROOM_BUTTON);
  const second = m.press(ROOM_BUTTON);
  assert.equal(first, true);
  assert.equal(second, true, 'the control is still enabled in the stale node, so the ref guard is what stops it');
  gate.resolve({ id: 'item-1' });
  await m.settled();

  assert.equal(services.added.length, 1);
});

test('WORKS: View Dressing Room closes the sheet and opens the room list; Continue Scanning only closes', async () => {
  const m = mount();
  await m.settled();
  m.press(ROOM_BUTTON);
  await m.settled();

  m.press('Continue scanning');
  assert.deepEqual(m.closes, ['close']);
  assert.deepEqual(m.pushes, []);

  m.press('View Dressing Room');
  assert.deepEqual(m.closes, ['close', 'close']);
  assert.deepEqual(m.pushes, ['/dressing-rooms']);
});

// ── FIXED ────────────────────────────────────────────────────────────────────

test('FIXED: a room list requested as one actor is never shown after another actor holds the session', async () => {
  const services = createServices();
  const gate = deferred();
  services.listImpl = () => gate.promise;
  const m = mount({ services });

  // A -> B while A's list is still in flight.
  m.authority.actorContext.advanceActorEpoch('actor-b');
  gate.resolve([{ id: 'room-of-a', title: 'Private board of A', itemCount: 3 }]);
  await m.settled();

  assert.equal(m.has('Save scan to Private board of A'), false, "A's rooms must not be offered to B");
  assert.doesNotMatch(m.text(), /Private board of A/);
  assert.ok(m.has('Close add to room'), 'the sheet stays closable');
});

test('FIXED: a late room list from the previous actor cannot overwrite the current actor list', async () => {
  // The realistic race: A's request is slow, B signs in, the sheet is reopened and B's own
  // list arrives, and THEN A's answer lands. Without the actor guard it replaces B's rooms.
  const services = createServices();
  const stale = deferred();
  const requests = [stale.promise, Promise.resolve([{ id: 'room-of-b', title: 'Board of B', itemCount: 1 }])];
  services.listImpl = () => requests.shift();
  const m = mount({ services });

  m.authority.actorContext.advanceActorEpoch('actor-b');
  m.setVisible(false);
  m.setVisible(true);
  await m.settled();
  assert.ok(m.has('Save scan to Board of B'), "B's own list is shown");

  stale.resolve([{ id: 'room-of-a', title: 'Private board of A', itemCount: 3 }]);
  await m.settled();

  assert.ok(m.has('Save scan to Board of B'), "B's list must survive A's late answer");
  assert.equal(m.has('Save scan to Private board of A'), false);
  assert.doesNotMatch(m.text(), /Private board of A/);
});

test('FIXED: a save that resolves after an actor switch is not reported as done', async () => {
  const services = createServices();
  const gate = deferred();
  services.addImpl = () => gate.promise;
  const m = mount({ services });
  await m.settled();

  m.press(ROOM_BUTTON);
  m.authority.actorContext.advanceActorEpoch('actor-b');
  gate.resolve({ id: 'item-1' });
  await m.settled();

  assert.doesNotMatch(m.text(), /Added to/, "A's write must not surface as a success under B's session");
});

test('FIXED: a save that fails after an actor switch does not surface the departed actor error', async () => {
  const services = createServices();
  const gate = deferred();
  services.addImpl = () => gate.promise;
  const m = mount({ services });
  await m.settled();

  m.press(ROOM_BUTTON);
  m.authority.actorContext.advanceActorEpoch('actor-b');
  gate.reject(new Error('Unable to add scan to Dressing Room.'));
  await m.settled();

  assert.doesNotMatch(m.text(), /Unable to add scan/);
});

test('FIXED: a failed add after a successful create keeps the room, so a retry adds to it instead of creating a second one', async () => {
  const services = createServices();
  services.rooms = [];
  let attempts = 0;
  services.addImpl = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('Could not upload scan image.');
    return { id: 'item-1' };
  };
  const m = mount({ services });
  await m.settled();

  m.type(TITLE_FIELD, 'Weekend');
  m.press(CREATE_BUTTON);
  await m.settled();
  assert.match(m.text(), /Could not upload scan image\./);
  assert.equal(services.created.length, 1);

  m.press(CREATE_BUTTON);
  await m.settled();

  assert.equal(services.created.length, 1, 'the retry must not create a second room');
  assert.deepEqual(services.added.map((input) => input.dressingRoomId), ['room-new', 'room-new']);
  assert.match(m.text(), /Added to Weekend\./);
});

test('GUARD: reusing the created room applies only to the same title; a different title is a different room', async () => {
  const services = createServices();
  services.rooms = [];
  let attempts = 0;
  services.addImpl = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('Could not upload scan image.');
    return { id: 'item-1' };
  };
  services.createImpl = async ({ title }) => ({ id: `room-${title}`, title });
  const m = mount({ services });
  await m.settled();

  m.type(TITLE_FIELD, 'Weekend');
  m.press(CREATE_BUTTON);
  await m.settled();
  m.type(TITLE_FIELD, 'Holiday');
  m.press(CREATE_BUTTON);
  await m.settled();

  assert.deepEqual(services.created.map((input) => input.title), ['Weekend', 'Holiday']);
  assert.equal(services.added.at(-1).dressingRoomId, 'room-Holiday');
});
