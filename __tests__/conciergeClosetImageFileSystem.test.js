/**
 * Build 34 -> 1.1.0 / Repair 2 -- Wardrobe Concierge Closet image filesystem
 * compatibility (DEFECT SHARED_CONCIERGE_FILESYSTEM_001).
 *
 * THE DEFECT
 * ----------
 * `StyleChatBubble` handed `import * as FileSystem from 'expo-file-system'` to
 * the Concierge image resolver. The resolver's contract is the LEGACY shape,
 * `getInfoAsync(uri) -> { exists, size }`, and on Expo SDK 54 the bare
 * `expo-file-system` entry does not provide it: its `getInfoAsync` is a
 * deprecation shim that throws unconditionally. The resolver's `fileExists`
 * treats any throw as "the file is not there", so EVERY Closet photo resolved
 * as absent and every Concierge card silently degraded to text -- on both
 * platforms, with no error anywhere. The other 24 modules that touch the
 * Closet filesystem import `expo-file-system/legacy`.
 *
 * WHY THE EXISTING CONCIERGE TESTS DID NOT CATCH IT
 * -------------------------------------------------
 * They are source-text assertions. Nothing ever ran the resolver against the
 * object the bubble supplied, so the suite could not tell the working module
 * from the throwing one. This file EXECUTES, end to end:
 *
 *   the real installed expo-file-system (both entry points, faked native layer)
 *     -> the real StyleChatBubble
 *     -> the real ConciergeEvidenceBlock
 *     -> the real conciergeClosetImageSource + resolver
 *     -> the real closetRestoreMedia (cache paths, private-store hydration)
 *
 * Only the device (native module), the Supabase client, and the two Closet
 * stores that are not the subject (closetLibrary.loadCloset,
 * closetSyncStore.listClosetSyncEntries) are faked. Every scenario runs on both
 * platforms; the code under test has no platform branch, and this proves it
 * gets the same answer from both device shapes.
 *
 * OUT OF SCOPE, DELIBERATELY: a stale iOS data-container URI after the app
 * container UUID changes (Repair 3). Every URI here belongs to the CURRENT
 * container.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ROOT,
  createReactNativeStub,
  createRenderer,
  deepStub,
  findAll,
  runModule,
  settle,
} = require('./helpers/componentRenderer');
const { loadExpoFileSystemSdk, withCapturedWarnings } = require('./helpers/expoFileSystemSdk');

const PLATFORMS = ['ios', 'android'];
const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_OWNER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SERVER_A = '11111111-1111-4111-8111-111111111111';
const SERVER_B = '22222222-2222-4222-8222-222222222222';
const SERVER_C = '33333333-3333-4333-8333-333333333333';

// ── world: one fake device + the two faked Closet stores ─────────────────────

function createSupabaseStub() {
  const requested = [];
  const signable = new Map(); // storagePath -> signed URL
  return {
    requested,
    signable,
    supabase: {
      storage: {
        from(bucket) {
          return {
            async createSignedUrl(storagePath, ttl) {
              requested.push({ bucket, storagePath, ttl });
              const url = signable.get(storagePath);
              return url
                ? { data: { signedUrl: url }, error: null }
                : { data: null, error: { message: 'not found' } };
            },
          };
        },
      },
    },
  };
}

function createWorld(platformOS) {
  const sdk = loadExpoFileSystemSdk({ platformOS });
  const supa = createSupabaseStub();
  const owners = new Map();
  const stateFor = (ownerId) => {
    if (!owners.has(ownerId)) owners.set(ownerId, { items: [], sync: {}, syncUnreadable: false });
    return owners.get(ownerId);
  };
  const doc = sdk.device.documentDirectory;

  const world = {
    platformOS,
    sdk,
    supa,
    doc,
    stateFor,
    closetLibrary: {
      loadCloset: async (ownerId) => stateFor(ownerId).items.map((item) => ({ ...item })),
    },
    closetSyncStore: {
      listClosetSyncEntries: async (ownerId) => {
        const state = stateFor(ownerId);
        if (state.syncUnreadable) throw new Error('sidecar unreadable');
        return { ...state.sync };
      },
    },
    /**
     * A Closet item this device holds. `fileSize: null` leaves the image file
     * off the disk (the record still points at it); `0` is a failed write.
     * Returns the local imageUri.
     */
    addItem({ ownerId = OWNER, clientId, serverId, fileSize = 48_213 }) {
      const imageUri = `${doc}kscan_closet/images/${clientId}.jpg`;
      const state = stateFor(ownerId);
      state.items.push({ id: clientId, imageUri });
      state.sync[clientId] = { serverId };
      if (fileSize !== null) sdk.device.put(imageUri, fileSize);
      return imageUri;
    },
  };
  return world;
}

/** The real modules under the resolver, wired over the world's fake device. */
function loadGraph(world) {
  const { sdk, supa } = world;
  const plain = { jsx: false };
  const contract = runModule('services/closet/closetSyncContract.ts', {}, plain);
  const closetMedia = runModule('services/closetMedia.ts', {}, plain);
  const restoreMedia = runModule(
    'services/closet/closetRestoreMedia.ts',
    {
      'expo-file-system/legacy': sdk.legacy,
      '../supabaseClient': { supabase: supa.supabase },
      './closetSyncContract': contract,
    },
    plain,
  );
  const imageResolver = runModule('services/concierge/conciergeImageResolver.ts', {}, plain);
  const conciergeModel = runModule('services/concierge/conciergeModel.ts', {}, plain);
  const imageSource = runModule(
    'services/concierge/conciergeClosetImageSource.ts',
    {
      '../closetLibrary': world.closetLibrary,
      '../closet/closetSyncStore': world.closetSyncStore,
      '../closet/closetRestoreMedia': restoreMedia,
      '../closetMedia': closetMedia,
    },
    plain,
  );
  return { closetMedia, restoreMedia, imageResolver, conciergeModel, imageSource };
}

function sourceFor(graph, { fileSystem, ownerId = OWNER, allowPrivateStoreFallback } = {}) {
  return graph.imageSource.createConciergeClosetImageSource({
    ownerId,
    fileSystem,
    allowPrivateStoreFallback,
  });
}

// ── P1: the module the bubble used cannot satisfy the resolver contract ──────

for (const platformOS of PLATFORMS) {
  test(`[${platformOS}] P1: SDK contract -- the bare entry's getInfoAsync throws, /legacy answers`, async () => {
    const sdk = loadExpoFileSystemSdk({ platformOS });
    const uri = sdk.device.put(`${sdk.device.documentDirectory}kscan_closet/images/x.jpg`);

    const { result: bare, warnings } = await withCapturedWarnings(() =>
      sdk.main.getInfoAsync(uri).then(
        (value) => ({ resolved: value }),
        (error) => ({ rejected: error }),
      ),
    );
    assert.ok(
      bare.rejected instanceof Error,
      `expo-file-system@${sdk.sdkVersion} bare getInfoAsync must reject; it resolved`,
    );
    assert.match(bare.rejected.message, /deprecated/);
    assert.match(bare.rejected.message, /expo-file-system\/legacy/);
    assert.equal(warnings.length, 1, 'the shim warns before it throws');
    assert.equal(
      sdk.device.callsTo('getInfoAsync').length,
      0,
      'the shim throws before the native module is ever consulted',
    );

    const info = await sdk.legacy.getInfoAsync(uri);
    assert.equal(info.exists, true);
    assert.ok(info.size > 0);
  });

  test(`[${platformOS}] P2/T1: fed the bare module, a VALID local Closet photo resolves as absent`, async () => {
    const world = createWorld(platformOS);
    const localUri = world.addItem({ clientId: 'c-1', serverId: SERVER_A });
    const graph = loadGraph(world);

    // The exact object the unrepaired bubble supplied.
    const { result: viaBare } = await withCapturedWarnings(async () => {
      const source = sourceFor(graph, { fileSystem: world.sdk.main });
      return {
        uri: await source.resolveLocalUri(SERVER_A),
        state: await graph.imageResolver.resolveConciergeImage(source, SERVER_A),
      };
    });
    assert.equal(viaBare.uri, null, 'the valid photo is lost: the throw is read as "no file"');
    assert.deepEqual(viaBare.state, { status: 'unavailable' });

    // Same item, same file, same resolver -- only the provider differs.
    const source = sourceFor(graph, { fileSystem: world.sdk.legacy });
    assert.equal(await source.resolveLocalUri(SERVER_A), localUri);
  });
}

// ── The resolver contract, on the repaired provider (/legacy) ────────────────

for (const platformOS of PLATFORMS) {
  const label = `[${platformOS}]`;

  test(`${label} T2: a valid local Closet photo resolves to its own URI`, async () => {
    const world = createWorld(platformOS);
    const localUri = world.addItem({ clientId: 'c-1', serverId: SERVER_A });
    const graph = loadGraph(world);
    const source = sourceFor(graph, { fileSystem: world.sdk.legacy });

    assert.equal(await source.resolveLocalUri(SERVER_A), localUri);
    assert.deepEqual(await graph.imageResolver.resolveConciergeImage(source, SERVER_A), {
      status: 'ready',
      uri: localUri,
    });
  });

  test(`${label} T3/P3: a photo that is genuinely absent still degrades to a text card`, async () => {
    const world = createWorld(platformOS);
    world.addItem({ clientId: 'c-1', serverId: SERVER_A, fileSize: null });
    const graph = loadGraph(world);
    const source = sourceFor(graph, { fileSystem: world.sdk.legacy });

    // Not the stale local URI, not a made-up one: nothing.
    assert.equal(await source.resolveLocalUri(SERVER_A), null);
    assert.deepEqual(await graph.imageResolver.resolveConciergeImage(source, SERVER_A), {
      status: 'unavailable',
    });
    // The provider really was consulted; absence was DETECTED, not defaulted.
    assert.ok(world.sdk.device.callsTo('getInfoAsync').length >= 1);
  });

  test(`${label} T3: a missing local original continues to a legitimate restore cache`, async () => {
    const world = createWorld(platformOS);
    world.addItem({ clientId: 'c-1', serverId: SERVER_A, fileSize: null });
    const graph = loadGraph(world);
    const cache = graph.restoreMedia.buildClosetRestoreMediaCachePaths(OWNER, SERVER_A);
    world.sdk.device.put(cache.primary);
    const source = sourceFor(graph, { fileSystem: world.sdk.legacy });

    assert.equal(await source.resolveLocalUri(SERVER_A), cache.primary);
  });

  test(`${label} T4: a zero-byte file is a failed write, not an image`, async () => {
    const world = createWorld(platformOS);
    world.addItem({ clientId: 'c-1', serverId: SERVER_A, fileSize: 0 });
    const graph = loadGraph(world);
    const source = sourceFor(graph, { fileSystem: world.sdk.legacy });
    assert.equal(await source.resolveLocalUri(SERVER_A), null, 'zero-byte local original');

    // A zero-byte restore-cache primary is rejected too, and the valid
    // thumbnail behind it is what resolves.
    const cache = graph.restoreMedia.buildClosetRestoreMediaCachePaths(OWNER, SERVER_A);
    world.sdk.device.put(cache.primary, 0);
    assert.equal(await source.resolveLocalUri(SERVER_A), null, 'zero-byte primary, no thumbnail');
    world.sdk.device.put(cache.thumbnail);
    assert.equal(await source.resolveLocalUri(SERVER_A), cache.thumbnail);
  });

  test(`${label} T5: a device that never held the item resolves the restore-cache primary`, async () => {
    const world = createWorld(platformOS);
    const graph = loadGraph(world);
    const cache = graph.restoreMedia.buildClosetRestoreMediaCachePaths(OWNER, SERVER_A);
    world.sdk.device.put(cache.primary);
    world.sdk.device.put(cache.thumbnail);
    const source = sourceFor(graph, { fileSystem: world.sdk.legacy });

    assert.equal(await source.resolveLocalUri(SERVER_A), cache.primary);
  });

  test(`${label} T6: precedence is local original > restore primary > restore thumbnail`, async () => {
    const world = createWorld(platformOS);
    const localUri = world.addItem({ clientId: 'c-1', serverId: SERVER_A });
    const graph = loadGraph(world);
    const cache = graph.restoreMedia.buildClosetRestoreMediaCachePaths(OWNER, SERVER_A);
    world.sdk.device.put(cache.primary);
    world.sdk.device.put(cache.thumbnail);
    const source = sourceFor(graph, { fileSystem: world.sdk.legacy });

    assert.equal(await source.resolveLocalUri(SERVER_A), localUri, 'the original wins');
    world.sdk.device.files.delete(localUri);
    assert.equal(await source.resolveLocalUri(SERVER_A), cache.primary, 'then the primary');
    world.sdk.device.files.delete(cache.primary);
    assert.equal(await source.resolveLocalUri(SERVER_A), cache.thumbnail, 'then the thumbnail');
    world.sdk.device.files.delete(cache.thumbnail);
    assert.equal(await source.resolveLocalUri(SERVER_A), null, 'then nothing');
  });

  test(`${label} T7: wrong-item and wrong-owner isolation`, async () => {
    const world = createWorld(platformOS);
    const uriA = world.addItem({ clientId: 'c-a', serverId: SERVER_A });
    const uriB = world.addItem({ clientId: 'c-b', serverId: SERVER_B });
    const graph = loadGraph(world);
    const source = sourceFor(graph, { fileSystem: world.sdk.legacy });

    assert.equal(await source.resolveLocalUri(SERVER_A), uriA);
    assert.equal(await source.resolveLocalUri(SERVER_B), uriB);
    assert.equal(await source.resolveLocalUri(SERVER_C), null, 'an unknown item gets no image');

    // B's photo is gone while A's is intact: B must NOT inherit A's.
    world.sdk.device.files.delete(uriB);
    assert.equal(await source.resolveLocalUri(SERVER_B), null);
    assert.equal(await source.resolveLocalUri(SERVER_A), uriA);

    // Another account's source never sees this account's mapping...
    const foreign = sourceFor(graph, { fileSystem: world.sdk.legacy, ownerId: OTHER_OWNER });
    assert.equal(await foreign.resolveLocalUri(SERVER_A), null);
    // ...nor this account's restore cache: cache paths are owner-scoped.
    const cacheA = graph.restoreMedia.buildClosetRestoreMediaCachePaths(OWNER, SERVER_C);
    world.sdk.device.put(cacheA.primary);
    assert.equal(await foreign.resolveLocalUri(SERVER_C), null);
    assert.equal(await source.resolveLocalUri(SERVER_C), cacheA.primary);
  });

  test(`${label} T7: an unreadable sync sidecar degrades to text, never to a wrong image`, async () => {
    const world = createWorld(platformOS);
    world.addItem({ clientId: 'c-a', serverId: SERVER_A });
    world.stateFor(OWNER).syncUnreadable = true;
    const graph = loadGraph(world);
    const source = sourceFor(graph, { fileSystem: world.sdk.legacy });

    assert.equal(await source.resolveLocalUri(SERVER_A), null);
  });

  test(`${label} T8: private fallback OFF performs no storage read and no download`, async () => {
    for (const allowPrivateStoreFallback of [undefined, false]) {
      const world = createWorld(platformOS);
      const graph = loadGraph(world);
      const source = sourceFor(graph, { fileSystem: world.sdk.legacy, allowPrivateStoreFallback });

      assert.equal(source.hydrateFromPrivateStore, undefined, 'the step is not even present');
      assert.deepEqual(await graph.imageResolver.resolveConciergeImage(source, SERVER_A), {
        status: 'unavailable',
      });
      assert.deepEqual(world.supa.requested, [], 'no signed-URL request');
      assert.deepEqual(world.sdk.device.callsTo('downloadAsync'), [], 'no download');
    }
  });

  test(`${label} T9: private fallback ON hydrates exactly the two deterministic objects`, async () => {
    const world = createWorld(platformOS);
    const graph = loadGraph(world);
    const paths = graph.closetMedia.buildClosetMediaPaths(OWNER, SERVER_A);
    world.supa.signable.set(paths.primary, 'https://signed.example/primary');
    world.supa.signable.set(paths.thumbnail, 'https://signed.example/thumb');
    world.sdk.device.downloads.set('https://signed.example/primary', { status: 200, size: 9_000 });
    world.sdk.device.downloads.set('https://signed.example/thumb', { status: 200, size: 900 });
    const source = sourceFor(graph, {
      fileSystem: world.sdk.legacy,
      allowPrivateStoreFallback: true,
    });

    const cache = graph.restoreMedia.buildClosetRestoreMediaCachePaths(OWNER, SERVER_A);
    assert.deepEqual(await graph.imageResolver.resolveConciergeImage(source, SERVER_A), {
      status: 'ready',
      uri: cache.primary,
    });
    assert.deepEqual(
      world.supa.requested.map((request) => request.storagePath),
      [paths.primary, paths.thumbnail],
      'bounded: the two deterministic objects, never a prefix or another item',
    );
    assert.ok(world.supa.requested.every((request) => request.storagePath.startsWith(`${OWNER}/`)));

    // The hydrated file now satisfies the LOCAL step, so a second resolution
    // needs no network at all.
    const before = world.supa.requested.length;
    assert.equal(await source.resolveLocalUri(SERVER_A), cache.primary);
    assert.equal(world.supa.requested.length, before);
  });

  test(`${label} T9: private fallback ON is not used when a local photo already exists`, async () => {
    const world = createWorld(platformOS);
    const localUri = world.addItem({ clientId: 'c-a', serverId: SERVER_A });
    const graph = loadGraph(world);
    const source = sourceFor(graph, {
      fileSystem: world.sdk.legacy,
      allowPrivateStoreFallback: true,
    });

    assert.deepEqual(await graph.imageResolver.resolveConciergeImage(source, SERVER_A), {
      status: 'ready',
      uri: localUri,
    });
    assert.deepEqual(world.supa.requested, []);
  });

  test(`${label} T9: private fallback ON with nothing to fetch still ends at a text card`, async () => {
    const world = createWorld(platformOS);
    const graph = loadGraph(world);
    const source = sourceFor(graph, {
      fileSystem: world.sdk.legacy,
      allowPrivateStoreFallback: true,
    });

    assert.deepEqual(await graph.imageResolver.resolveConciergeImage(source, SERVER_A), {
      status: 'unavailable',
    });
  });
}

// ── T10: the PRODUCTION wiring -- the real bubble, the real block ────────────

const STUB_IDENTITY = { identity: { displayName: 'Elise' } };

function loadBubble(world, graph, { mutate } = {}) {
  const renderer = createRenderer();
  const jsx = renderer.runtimeModules['react/jsx-runtime'].jsx;

  // The pure card renderer is not under test; it is replaced by a probe that
  // records exactly the `images` map the block decided on.
  function ConciergeEvidence() {
    return null;
  }

  const block = runModule('components/concierge/ConciergeEvidenceBlock.tsx', {
    ...renderer.runtimeModules,
    '../../services/concierge/conciergeImageResolver': graph.imageResolver,
    '../../services/concierge/conciergeClosetImageSource': graph.imageSource,
    './ConciergeEvidence': { ConciergeEvidence },
  });

  const { StyleChatBubble } = runModule(
    'components/style-chat/StyleChatBubble.tsx',
    {
      ...renderer.runtimeModules,
      // Both specifiers resolve to the REAL SDK entry points, so whichever one
      // the bubble imports gets exactly what a device would give it.
      ...world.sdk.specifiers,
      'react-native': createReactNativeStub({ platformOS: world.platformOS }),
      'react-native-safe-area-context': {
        useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 0 }),
      },
      '../../constants/theme': { LUXURY: deepStub(), RADIUS: deepStub(), SPACING: deepStub() },
      '../../constants/featureFlags': { ELISE_CONCIERGE_V1: true },
      './StyleChatUiBlock': { StyleChatUiBlockView: () => null },
      './StyleChatActionCards': { StyleChatActionCards: () => null },
      './StyleChatFeedbackControls': { StyleChatFeedbackControls: () => null },
      './StyleChatVoiceRetry': { StyleChatVoiceRetry: () => null },
      '../../hooks/useStylistIdentity': { useStylistIdentity: () => STUB_IDENTITY },
      '../../services/signature-style/localSignatureStyleFeedbackStore': {
        SIGNATURE_STYLE_ENABLED: false,
      },
      '../../contexts/AiOutputReportingContext': {
        useAiOutputReporting: () => ({ openAiOutputReport() {} }),
      },
      '../../services/style-chat/styleChatMessageState': {
        isPendingUserMessage: () => false,
        isStablePersistedId: () => false,
      },
      '../../services/style-chat/styleChatOutcome': { isSyntheticStyleChatFailure: () => false },
      '../../services/signature-style/signatureStyleEligibility': {
        isEligibleForStyleFeedback: () => false,
      },
      '../concierge/ConciergeEvidenceBlock': block,
      '../../services/concierge/conciergeModel': graph.conciergeModel,
    },
    { mutate },
  );

  async function mount({ userKey, serverIds }) {
    const message = {
      id: 'optimistic-1',
      sender: 'assistant',
      content: 'Here is what you own.',
      uiBlocks: [
        {
          type: 'concierge_evidence',
          result: {
            presentation: 'cards',
            focusCard: null,
            cards: serverIds.map((clientId) => ({ clientId })),
            looks: [],
          },
        },
      ],
    };
    const element = jsx(StyleChatBubble, { message, userKey });
    renderer.render(element);
    await settle(12);
    const tree = renderer.render(element);
    const probe = findAll(tree, (node) => node.type === ConciergeEvidence);
    assert.equal(probe.length, 1, 'the Concierge evidence block must render exactly once');
    return probe[0].props.images;
  }

  return { mount };
}

test(`T10: the bubble supplies the same filesystem authority as the rest of the Closet`, () => {
  const bubbleSource = fs.readFileSync(
    path.join(ROOT, 'components', 'style-chat', 'StyleChatBubble.tsx'),
    'utf8',
  );
  const closetSource = fs.readFileSync(
    path.join(ROOT, 'services', 'closet', 'closetRestoreMedia.ts'),
    'utf8',
  );
  const specifier = (source) =>
    /import \* as FileSystem from '([^']+)'/.exec(source)?.[1] ?? null;
  assert.equal(specifier(closetSource), 'expo-file-system/legacy');
  assert.equal(specifier(bubbleSource), specifier(closetSource));
});

for (const platformOS of PLATFORMS) {
  const label = `[${platformOS}]`;

  test(`${label} T10: the real bubble resolves a valid local Closet photo`, async () => {
    const world = createWorld(platformOS);
    const localUri = world.addItem({ clientId: 'c-1', serverId: SERVER_A });
    const bubble = loadBubble(world, loadGraph(world));

    const images = await bubble.mount({ userKey: `user:${OWNER}`, serverIds: [SERVER_A] });
    assert.deepEqual(images[SERVER_A], { status: 'ready', uri: localUri });
  });

  test(`${label} T10: the real bubble keeps two items' photos apart`, async () => {
    const world = createWorld(platformOS);
    const uriA = world.addItem({ clientId: 'c-a', serverId: SERVER_A });
    const uriB = world.addItem({ clientId: 'c-b', serverId: SERVER_B });
    const bubble = loadBubble(world, loadGraph(world));

    const images = await bubble.mount({
      userKey: `user:${OWNER}`,
      serverIds: [SERVER_A, SERVER_B],
    });
    assert.deepEqual(images[SERVER_A], { status: 'ready', uri: uriA });
    assert.deepEqual(images[SERVER_B], { status: 'ready', uri: uriB });
  });

  test(`${label} T10/P3: the real bubble still falls back to a text card when the photo is gone`, async () => {
    const world = createWorld(platformOS);
    world.addItem({ clientId: 'c-1', serverId: SERVER_A, fileSize: null });
    world.addItem({ clientId: 'c-2', serverId: SERVER_B, fileSize: 0 });
    const bubble = loadBubble(world, loadGraph(world));

    const images = await bubble.mount({
      userKey: `user:${OWNER}`,
      serverIds: [SERVER_A, SERVER_B],
    });
    assert.deepEqual(images[SERVER_A], { status: 'unavailable' });
    assert.deepEqual(images[SERVER_B], { status: 'unavailable' });
  });

  test(`${label} T10: an anonymous or malformed actor triggers no Closet or filesystem read`, async () => {
    for (const userKey of [undefined, null, '', 'anon:1234', 'user:', 'user:   ']) {
      const world = createWorld(platformOS);
      world.addItem({ clientId: 'c-1', serverId: SERVER_A });
      const bubble = loadBubble(world, loadGraph(world));

      const images = await bubble.mount({ userKey, serverIds: [SERVER_A] });
      assert.deepEqual(images, {}, `userKey=${String(userKey)}`);
      assert.deepEqual(world.sdk.device.callsTo('getInfoAsync'), [], `userKey=${String(userKey)}`);
    }
  });

  // ── negative control: the wrong provider must be caught by THIS harness ────
  test(`${label} negative control: swapping the bubble back to the bare module loses the photo`, async () => {
    const world = createWorld(platformOS);
    world.addItem({ clientId: 'c-1', serverId: SERVER_A });
    // `mutate` refuses to run vacuously: if the import line is not present in
    // the exact repaired form, this throws rather than passing quietly.
    const bubble = loadBubble(world, loadGraph(world), {
      mutate: (source) =>
        source.replace(
          "import * as FileSystem from 'expo-file-system/legacy';",
          "import * as FileSystem from 'expo-file-system';",
        ),
    });

    const { result: images } = await withCapturedWarnings(() =>
      bubble.mount({ userKey: `user:${OWNER}`, serverIds: [SERVER_A] }),
    );
    assert.notEqual(images[SERVER_A]?.status, 'ready');
    assert.deepEqual(images[SERVER_A], { status: 'unavailable' });
    assert.deepEqual(
      world.sdk.device.callsTo('getInfoAsync'),
      [],
      'the bare shim threw before the device was consulted',
    );
  });
}
