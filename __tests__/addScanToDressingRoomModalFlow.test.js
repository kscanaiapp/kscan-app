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

/** `mutate` rewrites the component source first (a negative control); it must change it. */
function mount({ services = createServices(), props = {}, mutate } = {}) {
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
  }, { mutate });

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
    /** The Android hardware Back button (and any other request-close path): the Modal's own handler. */
    hardwareBack() {
      const [modal] = findAll(tree, (node) => node.type === 'Modal');
      assert.ok(modal, 'the sheet renders a Modal');
      modal.props.onRequestClose();
    },
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

// ── COMPLETION HARDENING ─────────────────────────────────────────────────────
//
// Two residuals of the completion path, both about a sheet that is still on screen
// while something else is in flight:
//
//   A. "View Dressing Room" closes the sheet and pushes a route. The sheet stays
//      mounted and tappable for the whole close transition, and React has not
//      repainted between two rapid taps, so only a synchronous guard can stop a
//      second navigation.
//   B. The visible Close button is disabled while a save is in flight, but the
//      Modal's own request-close path (Android hardware Back) was `onRequestClose=
//      {onClose}`, unguarded, so Back dismissed the sheet mid-save and the customer
//      never saw the outcome of a write that still completed.

const { readSource } = require('./helpers/componentRenderer');

function mutatedSource(from, to) {
  return (source) => {
    const next = source.replace(from, to);
    assert.notEqual(next, source, `mutation ${String(from)} matched nothing: the negative control is vacuous`);
    return next;
  };
}

async function reachSuccess(m) {
  await m.settled();
  m.press(ROOM_BUTTON);
  await m.settled();
  assert.ok(m.has('View Dressing Room'), 'precondition: the sheet reached its success state');
}

test('HARDENING A: the first View Dressing Room tap closes the sheet and navigates once', async () => {
  const m = mount();
  await reachSuccess(m);

  m.press('View Dressing Room');

  assert.deepEqual(m.closes, ['close']);
  assert.deepEqual(m.pushes, ['/dressing-rooms'], 'the destination is unchanged');
});

test('HARDENING A: a rapid second tap while the transition is in flight is ignored', async () => {
  const m = mount();
  await reachSuccess(m);

  const first = m.press('View Dressing Room');
  const second = m.press('View Dressing Room'); // same painted node: React has not re-rendered in between
  m.rerender();
  const third = m.press('View Dressing Room'); // even after a repaint, while the sheet is still mounted

  assert.deepEqual([first, second, third], [true, true, true], 'the control itself stays enabled, so a ref is what stops it');
  assert.deepEqual(m.closes, ['close'], 'closed once');
  assert.deepEqual(m.pushes, ['/dressing-rooms'], 'navigated once');
});

test('HARDENING A: the guard is per opening -- reopening the sheet for another scan navigates again', async () => {
  const m = mount();
  await reachSuccess(m);
  m.press('View Dressing Room');
  assert.deepEqual(m.pushes, ['/dressing-rooms']);

  m.setVisible(false);
  m.setVisible(true);
  await reachSuccess(m);
  m.press('View Dressing Room');
  m.press('View Dressing Room');

  assert.deepEqual(m.pushes, ['/dressing-rooms', '/dressing-rooms'], 'once per opening, not once per app session');
});

test('HARDENING A: Continue Scanning is not gated by the navigation guard', async () => {
  const m = mount();
  await reachSuccess(m);
  m.press('View Dressing Room');
  m.press('Continue scanning');
  assert.deepEqual(m.closes, ['close', 'close']);
  assert.deepEqual(m.pushes, ['/dressing-rooms']);
});

test('HARDENING B: hardware Back during a save does not dismiss the sheet, and the write still completes', async () => {
  const services = createServices();
  const gate = deferred();
  services.addImpl = () => gate.promise;
  const m = mount({ services });
  await m.settled();

  m.press(ROOM_BUTTON);
  assert.equal(services.added.length, 1, 'the save is in flight');
  m.hardwareBack();
  assert.deepEqual(m.closes, [], 'Back is ignored while saving');

  gate.resolve({ id: 'item-1' });
  await m.settled();
  assert.equal(services.added.length, 1, 'the in-flight write was neither cancelled nor repeated');
  assert.match(m.text(), /Added to Trip\./, 'the customer still sees the outcome');
  assert.deepEqual(m.closes, []);
});

test('HARDENING B: hardware Back during a create-then-add save is ignored as well', async () => {
  const services = createServices();
  services.rooms = [];
  const gate = deferred();
  services.createImpl = () => gate.promise;
  const m = mount({ services });
  await m.settled();

  m.type(TITLE_FIELD, 'Weekend');
  m.press(CREATE_BUTTON);
  m.hardwareBack();
  assert.deepEqual(m.closes, []);

  gate.resolve({ id: 'room-new', title: 'Weekend' });
  await m.settled();
  assert.equal(services.added.length, 1);
  assert.match(m.text(), /Added to Weekend\./);
});

test('HARDENING B: hardware Back when idle closes the sheet normally', async () => {
  const m = mount();
  await m.settled();
  m.hardwareBack();
  assert.deepEqual(m.closes, ['close']);
});

test('HARDENING B: once a save has failed (no longer saving), hardware Back closes normally', async () => {
  const services = createServices();
  services.addImpl = async () => {
    throw new Error('Unable to add scan to Dressing Room.');
  };
  const m = mount({ services });
  await m.settled();
  m.press(ROOM_BUTTON);
  await m.settled();

  m.hardwareBack();
  assert.deepEqual(m.closes, ['close']);
});

test('HARDENING B: after a successful save, hardware Back closes normally', async () => {
  const m = mount();
  await reachSuccess(m);
  m.hardwareBack();
  assert.deepEqual(m.closes, ['close']);
});

test('HARDENING: the guards are synchronous refs, not React state', () => {
  const source = readSource('components/AddScanToDressingRoomModal.tsx');
  assert.match(source, /const navigatingRef = useRef\(false\);/);
  assert.match(source, /if \(navigatingRef\.current\) return;/);
  assert.match(source, /onRequestClose=\{handleRequestClose\}/);
  assert.match(source, /const handleRequestClose = \(\) => \{\s*if \(savingRef\.current\) return;\s*onClose\(\);\s*\};/);
});

// ── Negative controls: each guard, removed on its own, must be caught ───────

test('NEGATIVE CONTROL: without the navigation guard a rapid second tap navigates twice', async () => {
  const m = mount({ mutate: mutatedSource(/if \(navigatingRef\.current\) return;/, '') });
  await reachSuccess(m);
  m.press('View Dressing Room');
  m.press('View Dressing Room');
  assert.deepEqual(m.pushes, ['/dressing-rooms', '/dressing-rooms'], 'the regression these tests guard against');
});

test('NEGATIVE CONTROL: a guard that never resets blocks the next opening', async () => {
  const m = mount({ mutate: mutatedSource(/navigatingRef\.current = false;/, '') });
  await reachSuccess(m);
  m.press('View Dressing Room');
  m.setVisible(false);
  m.setVisible(true);
  await reachSuccess(m);
  m.press('View Dressing Room');
  assert.deepEqual(m.pushes, ['/dressing-rooms'], 'the second opening could not navigate: the reset matters');
});

test('NEGATIVE CONTROL: the unguarded Modal handler lets hardware Back dismiss a save in flight', async () => {
  const services = createServices();
  const gate = deferred();
  services.addImpl = () => gate.promise;
  const m = mount({
    services,
    mutate: mutatedSource(/onRequestClose=\{handleRequestClose\}/, 'onRequestClose={onClose}'),
  });
  await m.settled();
  m.press(ROOM_BUTTON);
  m.hardwareBack();
  assert.deepEqual(m.closes, ['close'], 'the regression these tests guard against');
  gate.resolve({ id: 'item-1' });
  await m.settled();
});

test('NEGATIVE CONTROL: a handler whose saving check is removed lets Back dismiss a save in flight', async () => {
  const services = createServices();
  const gate = deferred();
  services.addImpl = () => gate.promise;
  const m = mount({
    services,
    mutate: mutatedSource(/if \(savingRef\.current\) return;\s*onClose\(\);/, 'onClose();'),
  });
  await m.settled();
  m.press(ROOM_BUTTON);
  m.hardwareBack();
  assert.deepEqual(m.closes, ['close']);
  gate.resolve({ id: 'item-1' });
  await m.settled();
});

// ── The guard covers the close transition itself ────────────────────────────
//
// React Native keeps a Modal's children rendered after `visible` turns false until the
// native dismissal completes (Libraries/Modal/Modal.js `_shouldShowModal`), so the sheet
// is genuinely tappable while it fades out. That window is the one the guard exists for:
// resetting it on CLOSE instead of on OPEN would re-arm it inside the window.

test('HARDENING A: a tap on the still-mounted sheet after it was told to close is ignored', async () => {
  const m = mount();
  await reachSuccess(m);

  m.press('View Dressing Room');
  m.setVisible(false); // the parent closed it; the fade-out is still on screen
  assert.ok(m.has('View Dressing Room'), 'the sheet content is still rendered during the fade-out');
  m.press('View Dressing Room');
  m.press('View Dressing Room');

  assert.deepEqual(m.pushes, ['/dressing-rooms'], 'one navigation, however long the fade-out lasts');
  assert.deepEqual(m.closes, ['close']);
});

test('NEGATIVE CONTROL: resetting the guard when the sheet closes lets a tap during the fade-out navigate again', async () => {
  const m = mount({
    mutate: mutatedSource(
      /(navigatingRef\.current = false;\s*void reload\(\);\s*\})(\s*\}, \[visible, reload\]\);)/,
      '$1 else {\n      navigatingRef.current = false;\n    }$2',
    ),
  });
  await reachSuccess(m);

  m.press('View Dressing Room');
  m.setVisible(false);
  m.press('View Dressing Room');

  assert.deepEqual(m.pushes, ['/dressing-rooms', '/dressing-rooms'], 'the regression this test guards against');
});
