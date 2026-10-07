'use strict';

// Build 35 — Elise contextual Virtual Try-On.
//
// When a customer gives Elise a photo of a garment K Scan can genuinely
// visualize, the APPLICATION appends one offer to her reply:
//
//     Would you like to try that on?
//     [ TRY IT ON ]
//
// These tests EXECUTE the shipped modules (transpiled in-process, over a
// stubbed module graph with a strict require) rather than reading their source.
// The claims are about what runs, what is stored, and what never leaves the
// device, and a substring search cannot establish any of them.
//
// Tests are labelled with the brief's own ids (P0-nn / P1-nn / P2-nn), and each
// NC-ELVTO-nn negative control re-runs the check it names against a deliberately
// broken copy of the source and requires an ASSERTION failure. The mutation is
// applied to the in-memory transpile only, so the working tree is never dirty.
//
// What is NOT proven here, and is not claimed: a real provider generation,
// output quality, or behaviour on a physical device.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');

const vm = require('node:vm');

const {
  ROOT,
  byTestId,
  createReactNativeStub,
  createRenderer,
  deepStub,
  findAll,
  settle,
  strictRequire,
  textContent,
  transpile,
} = require('./helpers/componentRenderer');
const { createHookRuntime } = require('./helpers/hookRuntime');

/**
 * The shared helper's runModule, with the transpile (and the compiled script)
 * memoized.
 *
 * Every scenario below builds its own world, and a world is ~10 real modules.
 * Re-transpiling the same unchanged TypeScript for each of ~150 scenarios cost
 * minutes of CPU and bought nothing: the module is still EXECUTED afresh every
 * time, over that scenario's own stubs, so no state is shared between tests.
 *
 * A MUTATED module is never cached. A negative control always transpiles its
 * own broken copy, and the helper's own "a mutation must change something" rule
 * still applies to it.
 */
const compiledModules = new Map();
function runModule(rel, modules, options = {}) {
  let factory;
  if (options.mutate) {
    factory = vm.runInThisContext(
      `(function (exports, module, require) {\n${transpile(rel, options)}\n})`,
      { filename: rel },
    );
  } else {
    const key = `${rel}|jsx:${options.jsx !== false}`;
    factory = compiledModules.get(key);
    if (!factory) {
      factory = vm.runInThisContext(
        `(function (exports, module, require) {\n${transpile(rel, options)}\n})`,
        { filename: rel },
      );
      compiledModules.set(key, factory);
    }
  }
  const mod = { exports: {} };
  factory(mod.exports, mod, strictRequire(modules, rel));
  return mod.exports;
}

const OFFER = 'services/style-chat/eliseVtoOffer.ts';
const BINDINGS = 'services/style-chat/eliseVtoOfferBindings.ts';
const SOURCE = 'services/style-chat/eliseVtoUploadSource.ts';
const FRAME = 'services/style-chat/eliseConversationFrame.ts';
const COMPONENT = 'components/style-chat/EliseVtoOffer.tsx';
const BUBBLE = 'components/style-chat/StyleChatBubble.tsx';
const SCREEN = 'app/style-chat/[sessionId].tsx';
const HOOK = 'hooks/useStyleChat.ts';
const HOST = 'components/vto/VtoLaunchHost.tsx';
const ENTRY = 'components/vto/TryItOnEntry.tsx';
const SHEET = 'components/vto/VirtualTryOnSheet.tsx';
const AVAILABILITY_HOOK = 'hooks/useVtoAvailability.ts';
const ELIGIBILITY = 'services/vto/vtoEligibility.ts';
const DISCOVERY = 'services/vto/vtoDiscovery.ts';
const TELEMETRY = 'services/vto/vtoTelemetry.ts';
const STORE = 'services/vto/vtoRequestStore.ts';
const CLIENT = 'services/vto/vtoClient.ts';
const FAILURES = 'services/vto/vtoFailures.ts';
const TYPES = 'types/vto.ts';
const CANDIDATE_TYPES = 'types/closetCandidate.ts';
const ENTITLEMENTS = 'types/entitlements.ts';
const ACTIONS = 'supabase/functions/stylechat-generate/actions.ts';
const STYLECHAT_INDEX = 'supabase/functions/stylechat-generate/index.ts';
const SERVER_CONTRACT = 'supabase/functions/vto-generate/vtoContract.ts';
const SERVER_GARMENT = 'supabase/functions/vto-generate/vtoUserSuppliedGarment.ts';

const ACTOR_A = '11111111-1111-4111-8111-111111111111';
const ACTOR_B = '22222222-2222-4222-8222-222222222222';
const SESSION_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DAY_MS = 24 * 60 * 60 * 1000;

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
const sha256 = (value) => nodeCrypto.createHash('sha256').update(value).digest('hex');

/** A mutation that must find its anchor: a vacuous control proves nothing. */
function mutateOpt(rel, from, to) {
  assert.ok(read(rel).includes(from), `mutation anchor not found in ${rel}: ${from.slice(0, 80)}`);
  return (source) => source.split(from).join(to);
}

/** The check must fail with an ASSERTION failure -- a crash is not a red. */
async function expectRed(fn, label) {
  let failure = null;
  try {
    await fn();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, `${label}: the mutant was NOT caught (the check is not protecting anything)`);
  assert.ok(
    failure instanceof assert.AssertionError,
    `${label}: the mutant crashed instead of failing an assertion: ${failure && failure.stack}`,
  );
}

// ── The world: every authority the offer consumes, as a controllable fake ───

function jpegBase64(seed, length = 2400) {
  const bytes = Buffer.alloc(length);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes[3] = 0xe0;
  for (let i = 4; i < length; i += 1) bytes[i] = (i * 31 + seed * 7) % 251;
  return bytes.toString('base64');
}

function createWorld(o = {}) {
  const mutationFor = (rel) => (o.mutate ? o.mutate[rel] : undefined);
  const env = {
    actorId: ACTOR_A,
    epoch: 1,
    vtoUi: true,
    config: {
      enabled: true,
      supportedCategories: ['top', 'outerwear', 'blazer', 'dress'],
      liveEnabled: false,
      liveSupportedCategories: [],
      awarenessEnabled: false,
    },
    /** KPlusResolvedState as the canonical reader reports it. */
    kplus: 'active',
    vtoStatus: 'idle',
    storage: o.storage ?? new Map(),
    files: new Map(),
    candidates: [],
    events: [],
    gateSource: null,
    random: 0,
    calls: {
      openUpgrade: 0,
      configReads: 0,
      candidateReads: 0,
      fileReads: 0,
      fileStats: 0,
      storageWrites: 0,
      haptics: 0,
      initiated: 0,
    },
  };

  const typesVto = runModule(TYPES, {}, { jsx: false });
  const candidateTypes = runModule(CANDIDATE_TYPES, {}, { jsx: false });
  const entitlements = runModule(ENTITLEMENTS, {}, { jsx: false });
  const eligibility = runModule(ELIGIBILITY, {}, { jsx: false, mutate: mutationFor(ELIGIBILITY) });
  const discovery = runModule(DISCOVERY, {}, { jsx: false });
  const telemetry = runModule(TELEMETRY, {}, { jsx: false, mutate: mutationFor(TELEMETRY) });
  telemetry.setVtoAnalyticsSink((event, payload) => env.events.push({ event, ...payload }));

  const asyncStorage = {
    getItem: async (key) => (env.storage.has(key) ? env.storage.get(key) : null),
    setItem: async (key, value) => {
      env.calls.storageWrites += 1;
      env.storage.set(key, value);
    },
    removeItem: async (key) => {
      env.calls.storageWrites += 1;
      env.storage.delete(key);
    },
  };
  const expoCrypto = {
    getRandomBytes: (count) => {
      env.random += 1;
      const bytes = new Uint8Array(count);
      for (let i = 0; i < count; i += 1) bytes[i] = (env.random * 17 + i * 13 + (env.random >> 8)) % 256;
      bytes[0] = env.random % 256;
      bytes[1] = (env.random >> 8) % 256;
      return bytes;
    },
    digestStringAsync: async (_algorithm, value) => sha256(value),
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  };
  const fileSystem = {
    EncodingType: { Base64: 'base64' },
    getInfoAsync: async (uri) => {
      env.calls.fileStats += 1;
      return { exists: env.files.has(uri) };
    },
    readAsStringAsync: async (uri) => {
      env.calls.fileReads += 1;
      if (!env.files.has(uri)) throw new Error('ENOENT');
      return env.files.get(uri);
    },
  };
  const actorScope = {
    captureActorScope: () => ({ actorId: env.actorId, epoch: env.epoch }),
    isActorScopeCurrent: (scope) => !!scope && scope.actorId === env.actorId && scope.epoch === env.epoch,
  };
  // The candidate authority: actor-scoped and expiry-enforcing, like the real one.
  const candidateLibrary = {
    getClosetCandidate: async (actorRequest, candidateId) => {
      env.calls.candidateReads += 1;
      const found = env.candidates.find(
        (candidate) =>
          candidate.candidateId === candidateId
          && candidate.ownerId === actorRequest.actorId
          && Date.parse(candidate.expiresAt) > Date.now(),
      );
      return found ? { ok: true, candidate: { ...found } } : { ok: false, errorCode: 'candidate_store_corrupt' };
    },
  };

  const offer = runModule(OFFER, {}, { jsx: false, mutate: mutationFor(OFFER) });
  const bindings = runModule(
    BINDINGS,
    {
      '@react-native-async-storage/async-storage': { __esModule: true, default: asyncStorage },
      'expo-crypto': expoCrypto,
      '../actorContext': { getActorContext: () => ({ actorId: env.actorId }) },
      './eliseVtoOffer': offer,
    },
    { jsx: false, mutate: mutationFor(BINDINGS) },
  );
  const source = runModule(
    SOURCE,
    {
      'expo-crypto': expoCrypto,
      'expo-file-system/legacy': fileSystem,
      '../../constants/featureFlags': { get VTO_UI_ENABLED() { return env.vtoUi; } },
      '../../types/closetCandidate': candidateTypes,
      '../../types/vto': typesVto,
      '../actorContext': { createActorRequest: () => ({ actorId: env.actorId, epoch: env.epoch }) },
      '../actorScope': actorScope,
      '../closetCandidateLibrary': candidateLibrary,
      '../vto/vtoEligibility': eligibility,
      '../vto/vtoFeatureControl': {
        getVtoRemoteConfig: async () => {
          env.calls.configReads += 1;
          return env.config;
        },
      },
      './eliseFashionContextV2': {
        // The contract's shape rule, reduced to what correlation reads. The
        // real validator's own behaviour is covered by its own suite.
        validateEliseFashionContextV2: (candidate) =>
          candidate && candidate.contractVersion === 'elise-fashion-context-v2' && Array.isArray(candidate.items)
            ? { kind: 'ok', context: candidate }
            : { kind: 'invalid', reason: 'shape' },
      },
      './eliseVtoOffer': offer,
      './eliseVtoOfferBindings': bindings,
    },
    { jsx: false, mutate: mutationFor(SOURCE) },
  );

  let candidateSeq = 0;
  const world = {
    env,
    typesVto,
    entitlements,
    eligibility,
    discovery,
    telemetry,
    offer,
    bindings,
    source,
    actorScope,
    mutationFor,
    eventsNamed: (name) => env.events.filter((entry) => entry.event === name),
    /** Stages a device-local candidate exactly as an Elise direct upload leaves one. */
    addCandidate(input = {}) {
      candidateSeq += 1;
      const candidateId = input.candidateId ?? `cand_${candidateSeq}`;
      const base64 = jpegBase64(input.seed ?? candidateSeq, input.byteLength ?? 2400);
      const uri = `file:///candidates/${candidateId}.jpg`;
      env.files.set(uri, base64);
      const candidate = {
        schemaVersion: 3,
        candidateId,
        batchId: `batch_${candidateId}`,
        batchPosition: 0,
        ownerId: input.ownerId ?? env.actorId,
        sourceType: 'gallery',
        originalImageUri: null,
        candidateImageUri: uri,
        candidateThumbnailUri: null,
        title: input.title ?? 'Photo',
        category: input.category ?? 'dress',
        classificationVersion: input.classificationVersion ?? 'elise-fashion-context-v2',
        contentHash: sha256(base64),
        contentHashVersion: 'sha256-normalized-v1',
        normalizedByteLength: Buffer.from(base64, 'base64').length,
        status: 'ready_for_review',
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + (input.expiresInMs ?? 7 * DAY_MS)).toISOString(),
      };
      env.candidates.push(candidate);
      return candidate;
    },
    /** The composer draft a ready direct image is sent as. */
    draft(candidate, input = {}) {
      const state = input.itemState ?? 'ready';
      const groundable = state === 'ready' || state === 'partial';
      return {
        draftId: input.draftId ?? `draft_${candidate.candidateId}`,
        state: 'ready',
        resolved: null,
        selection: { closetCandidateId: candidate.candidateId, retryCount: 0, updatedAt: 'now' },
        summary: { title: candidate.title },
        fashionContext: {
          contractVersion: 'elise-fashion-context-v2',
          source: 'direct_gallery',
          items: [{
            sourceIndex: 0,
            state,
            ...(groundable
              ? { identification: { category: input.category ?? candidate.category, subtype: input.subtype ?? null } }
              : {}),
          }],
        },
      };
    },
    /** The merged context exactly as the send path builds it: renumbered. */
    sentContext(drafts) {
      const items = [];
      for (const draft of drafts) {
        for (const item of draft.fashionContext?.items ?? []) items.push({ ...item, sourceIndex: items.length });
      }
      return { contractVersion: 'elise-fashion-context-v2', source: 'direct_gallery', items };
    },
    prepare(drafts, input = {}) {
      return source.prepareEliseVtoOffer({
        sessionId: input.sessionId ?? SESSION_1,
        drafts,
        sentContext: 'sentContext' in input ? input.sentContext : world.sentContext(drafts),
        focusedDraftId: input.focusedDraftId ?? null,
        focusExplicit: input.focusExplicit === true,
      });
    },
    storedBindings(actorId = env.actorId) {
      const raw = env.storage.get(bindings.eliseVtoOfferBindingsKey(actorId));
      return raw ? JSON.parse(raw).bindings : [];
    },
    /** Signs a different account in, as AuthSessionContext does. */
    signIn(actorId) {
      env.actorId = actorId;
      env.epoch += 1;
    },
  };
  return world;
}

// ── Rendering the real offer over the real launch host ───────────────────────

function kplusBucket(state) {
  if (state === 'active') return 'active';
  if (state === 'loading' || state === 'error') return 'resolving';
  return 'free';
}

function renderOffer(world, props) {
  const { env } = world;
  const renderer = createRenderer();
  const useAuthSession = () => ({
    user: env.actorId ? { id: env.actorId } : null,
    isAuthenticated: !!env.actorId,
  });
  const awarenessHooks = {
    useVtoActorKPlusState: () => kplusBucket(env.kplus),
    useVtoAwarenessBlocker: () => {},
  };
  const availability = runModule(
    AVAILABILITY_HOOK,
    {
      react: renderer.runtimeModules.react,
      '../constants/featureFlags': { get VTO_UI_ENABLED() { return env.vtoUi; } },
      '../contexts/AuthSessionContext': { useAuthSession },
      './useKPlusEntitlement': {
        // The canonical reader. RESOLVING is its own state and is never Free.
        useKPlusEntitlement: () => ({ isActive: env.kplus === 'active', state: env.kplus }),
      },
      '../services/vto/vtoFeatureControl': {
        DISABLED_VTO_REMOTE_CONFIG: { ...env.config, enabled: false },
        getVtoRemoteConfig: async () => env.config,
      },
      '../services/vto/vtoEligibility': world.eligibility,
      '../types/entitlements': world.entitlements,
    },
    { jsx: false },
  );
  const haptics = { selectionTick: () => { env.calls.haptics += 1; } };
  const host = runModule(
    HOST,
    {
      ...renderer.runtimeModules,
      '../../hooks/useVtoAwareness': awarenessHooks,
      '../../hooks/useVtoSessionStatus': { useVtoSessionStatus: () => ({ status: env.vtoStatus }) },
      '../../services/haptics': haptics,
      '../../services/vto/vtoAwareness': {
        markVtoInitiated: () => { env.calls.initiated += 1; },
        markVtoCompleted: () => {},
      },
      '../../services/vto/vtoTelemetry': world.telemetry,
      './VirtualTryOnSheet': { VirtualTryOnSheet: 'VirtualTryOnSheet' },
      './VtoMinimizedPill': { VtoMinimizedPill: 'VtoMinimizedPill' },
    },
    { mutate: world.mutationFor(HOST) },
  );
  const component = runModule(
    COMPONENT,
    {
      ...renderer.runtimeModules,
      'react-native': createReactNativeStub(),
      '../../constants/theme': { LUXURY: deepStub(), RADIUS: deepStub(), SPACING: deepStub() },
      '../../contexts/AuthSessionContext': { useAuthSession },
      '../../hooks/useVtoAvailability': availability,
      '../../hooks/useVtoAwareness': awarenessHooks,
      '../../services/haptics': haptics,
      '../../services/style-chat/eliseVtoOffer': world.offer,
      '../../services/style-chat/eliseVtoUploadSource': world.source,
      '../../services/vto/vtoDiscovery': world.discovery,
      '../../services/vto/vtoTelemetry': world.telemetry,
      '../../types/vto': world.typesVto,
      '../icons/kscan': { KScanIcon: 'KScanIcon' },
      '../kplus/KPlusGate': {
        KPlusGate: function KPlusGate({ children, source }) {
          env.gateSource = source;
          return children({ openUpgrade: () => { env.calls.openUpgrade += 1; } });
        },
      },
      '../vto/VtoLaunchHost': host,
    },
    { mutate: world.mutationFor(COMPONENT) },
  );

  let tree = null;
  const element = () => renderer.jsx(component.EliseVtoOffer, props, 'offer');
  const api = {
    async render() {
      for (let i = 0; i < 4; i += 1) {
        tree = renderer.render(element());
        await settle();
      }
      tree = renderer.render(element());
      return tree;
    },
    get tree() { return tree; },
    text: () => textContent(tree),
    host: (testID) => byTestId(tree, testID).filter((node) => typeof node.type === 'string'),
    ofType: (type) => findAll(tree, (node) => node.type === type),
    async press(testID) {
      const target = api.host(testID)[0];
      assert.ok(target, `no host element with testID ${testID}`);
      target.props.onPress();
      await settle();
      return api.render();
    },
  };
  return api;
}

/** An offer that exists: one eligible upload, prepared, bound, block returned. */
async function offeredWorld(o = {}) {
  const world = createWorld(o);
  const candidate = world.addCandidate({ category: o.category ?? 'dress', title: 'Silk slip dress' });
  const block = await world.prepare([world.draft(candidate)]);
  assert.ok(block, 'precondition: an eligible single upload is offered');
  return { world, candidate, block };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. The model cannot create, choose or grant a try-on
// ═════════════════════════════════════════════════════════════════════════════

/** P0-01 / P0-02 + NC-ELVTO-01. */
function checkModelCannotEmitTryOn(o = {}) {
  const actions = runModule(ACTIONS, {}, { jsx: false, mutate: o.mutate ? o.mutate[ACTIONS] : undefined });
  assert.equal(actions.ALLOWED_STYLECHAT_ACTIONS.includes('try_on_item'), false);
  assert.equal(actions.ALLOWED_STYLECHAT_ACTIONS.includes('elise_vto_offer'), false);

  const resolved = [{
    attachmentType: 'owned_item',
    items: [{ ref: { sourceType: 'saved_scan', sourceId: '3f2b8c1e-5d4a-4b6c-9e7f-0a1b2c3d4e5f' } }],
  }];
  const hostile = [
    { type: 'try_on_item' },
    { type: 'try_on_item', label: 'TRY IT ON' },
    { type: 'try_on_item', candidateId: 'cand_1', userId: ACTOR_B, contentHash: 'a'.repeat(64) },
    { type: 'try_on_item', anchor: { sourceType: 'saved_scan', sourceId: '3f2b8c1e-5d4a-4b6c-9e7f-0a1b2c3d4e5f' } },
    { type: 'elise_vto_offer', contractVersion: '1', localBindingId: 'a'.repeat(32) },
    { type: 'virtual_try_on', url: 'https://attacker.example/garment.jpg', source: 'user_supplied_garment' },
    { type: 'open_vto', provider: 'mock', entitlement: 'k_plus' },
  ];
  assert.deepEqual(actions.validateStyleChatActions(hostile, resolved), [], 'every try-on shaped action is dropped');

  // And it is dropped without taking a legitimate action down with it.
  const mixed = actions.validateStyleChatActions([hostile[0], { type: 'open_stylist' }, hostile[4]], resolved);
  assert.deepEqual(mixed.map((action) => action.type), ['open_stylist']);

  // Through the same extraction the handler uses on raw model output.
  const extracted = actions.extractActionsBlock(
    'That blazer is sharp. <actions>[{"type":"try_on_item","label":"TRY IT ON"}]</actions>',
  );
  assert.equal(extracted.text, 'That blazer is sharp.');
  assert.deepEqual(actions.validateStyleChatActions(extracted.rawActions, resolved), []);
}

test('P0-01 / P0-02: a model-emitted try_on_item, offer block, URL, source or user id is dropped', () => {
  checkModelCannotEmitTryOn();
});

test('NC-ELVTO-01: allowing try_on_item in the model action validator is caught', async () => {
  await expectRed(
    () => checkModelCannotEmitTryOn({
      mutate: { [ACTIONS]: mutateOpt(ACTIONS, "  'ask_my_room',\n] as const;", "  'ask_my_room',\n  'try_on_item',\n] as const;") },
    }),
    'try_on_item allowlisted',
  );
});

test('the system instruction tells Elise the offer is the application\'s, and forbids fit claims', () => {
  const prompt = read(STYLECHAT_INDEX);
  assert.match(prompt, /VIRTUAL TRY-ON — strictly follow all:/);
  assert.match(prompt, /Do not offer, suggest, or invite Virtual Try-On or "Try It On" yourself/);
  assert.match(prompt, /K Scan AI may add a Try It On option after your reply/);
  assert.match(prompt, /Never say or imply that a try-on happened/);
  assert.match(prompt, /Do not claim exact fit, sizing accuracy, or body measurements\./);
  assert.match(prompt, /A try-on is not one of your actions\./);
  // Nothing about a candidate, a binding or VTO authority is given to the model.
  assert.doesNotMatch(prompt, /localBindingId|candidateId|closetCandidateId|user_supplied_garment|contentHash/);
});

// ── The prose guard (P0-03, P2-04) ──────────────────────────────────────────

const INVITATION_CORPUS = [
  // the brief's own examples
  'Would you like to try that on?',
  'Want to try that on?',
  'Want to try it on?',
  'Want to see it on you?',
  'See how it looks on you?',
  'Try it on virtually.',
  // capitalization
  'would you like to try that on?',
  'WOULD YOU LIKE TO TRY THAT ON?',
  'Would You Like To Try That On?',
  // punctuation
  'Would you like to try that on',
  'Would you like to try that on?!',
  'Would you like to try that on...',
  'Want to try it on!',
  '**Would you like to try that on?**',
  // contractions and curly quotes
  'Let’s try it on.',
  "Let's try it on!",
  "Why don't you try it on?",
  'Why don’t we try it on?',
  "You could see what it'd look like on you.",
  // plural wording
  'Want to try them on?',
  'Want to try these on?',
  'Would you like to try those on?',
  'See how they look on you.',
  'Want to see them on you?',
  // other common phrasings
  'Wanna try it on?',
  'Do you want to try this on?',
  'Would you like to virtually try it on?',
  'You can try it on virtually!',
  'Shall we try on that dress?',
  'Would you like to try the dress on?',
  'Try that on?',
  'I can show you how it looks on you.',
  'Would you like to see how that would look on you?',
  'Use the Try It On feature to check.',
  'Tap below to try it on.',
  'A virtual try-on would settle it.',
];

const STYLING_ADVICE_CORPUS = [
  'Try it on with a belt before you decide.',
  'When you try it on in store, check the shoulders.',
  'This dress pairs well with block heels.',
  'I would try a cropped jacket on top of it.',
  'The colour will look great on you.',
  'Size up if you want a relaxed line.',
  'Tuck it in for a sharper waist.',
  'It works for the office and for dinner.',
  'Try a tonal belt on days you want polish.',
  'Keep the jewellery minimal so the neckline carries the look.',
];

test('P0-03 / P2-04: every known try-on invitation phrasing in model prose is neutralized', () => {
  const frame = runModule(FRAME, {}, { jsx: false });
  const missed = INVITATION_CORPUS.filter((sentence) => !frame.isEliseVtoInvitationSentence(sentence));
  assert.deepEqual(missed, [], 'these invitations survive the guard');
  for (const sentence of INVITATION_CORPUS) {
    const guarded = frame.guardEliseVtoInvitationProse(`That blazer is sharp. ${sentence}`);
    assert.equal(guarded.text, 'That blazer is sharp.', sentence);
    assert.equal(guarded.removed, 1, sentence);
  }
});

test('P2-04: the guard leaves ordinary styling advice and no-action replies untouched', () => {
  const frame = runModule(FRAME, {}, { jsx: false });
  const flagged = STYLING_ADVICE_CORPUS.filter((sentence) => frame.isEliseVtoInvitationSentence(sentence));
  assert.deepEqual(flagged, [], 'these are advice, not invitations');
  const reply = 'Pair it with slim trousers.\n\n1. Loafers\n2. A fine knit\n\nKeep the palette tonal.';
  assert.deepEqual(frame.guardEliseVtoInvitationProse(reply), { text: reply, removed: 0 });
  assert.deepEqual(frame.guardEliseVtoInvitationProse(''), { text: '', removed: 0 });
  assert.deepEqual(frame.guardEliseVtoInvitationProse(null), { text: '', removed: 0 });
});

test('P0-03: the guard only removes -- it keeps the reply\'s structure and never writes words of its own', () => {
  const frame = runModule(FRAME, {}, { jsx: false });
  const guarded = frame.guardEliseVtoInvitationProse(
    'That blazer is sharp. Pair it with slim trousers.\nWould you like to try that on?\n\n1. Loafers\n2. A fine knit',
  );
  assert.equal(guarded.text, 'That blazer is sharp. Pair it with slim trousers.\n\n1. Loafers\n2. A fine knit');
  assert.equal(guarded.removed, 1);
  // A reply that was ONLY an invitation becomes empty; the caller's existing
  // empty-reply handling takes over. Nothing is invented on Elise's behalf.
  assert.deepEqual(frame.guardEliseVtoInvitationProse('Would you like to try that on?'), { text: '', removed: 1 });
  // It is a guard, not a factory: its whole output is text and a count.
  assert.deepEqual(Object.keys(guarded).sort(), ['removed', 'text']);
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. The synced block carries an opaque id and nothing else
// ═════════════════════════════════════════════════════════════════════════════

/** P0-15 + NC-ELVTO-07. */
async function checkSyncedBlockIsOpaque(o = {}) {
  const { world, candidate, block } = await offeredWorld(o);
  assert.deepEqual(Object.keys(block).sort(), ['contractVersion', 'localBindingId', 'type']);
  assert.equal(block.type, 'elise_vto_offer');
  assert.equal(block.contractVersion, '1');
  assert.match(block.localBindingId, /^[A-Za-z0-9_-]{16,64}$/);

  // Exactly what would be written to the cloud message row.
  const synced = JSON.stringify(block);
  for (const [label, secret] of [
    ['candidate id', candidate.candidateId],
    ['content hash', candidate.contentHash],
    ['candidate image uri', candidate.candidateImageUri],
    ['batch id', candidate.batchId],
    ['category', candidate.category],
    ['classification version', candidate.classificationVersion],
    ['actor id', world.env.actorId],
  ]) {
    assert.equal(synced.includes(secret), false, `the synced block must not carry the ${label}`);
  }
  assert.doesNotMatch(synced, /file:|data:|https?:|base64|contentHash|candidate/i);
  // The id is not derived from the candidate: it is random.
  assert.equal(block.localBindingId.includes(candidate.contentHash.slice(0, 12)), false);
}

test('P0-15: the synced ui_block carries only an opaque binding id and the contract version', () => checkSyncedBlockIsOpaque());

test('NC-ELVTO-07: persisting the candidate id in the cloud ui_block is caught', async () => {
  await expectRed(
    () => checkSyncedBlockIsOpaque({
      mutate: {
        [SOURCE]: mutateOpt(
          SOURCE,
          'return buildEliseVtoOfferBlock(binding.localBindingId);',
          'return { ...buildEliseVtoOfferBlock(binding.localBindingId), candidateId: binding.candidateId };',
        ),
      },
    }),
    'candidate id in the synced block',
  );
  await expectRed(
    () => checkSyncedBlockIsOpaque({
      mutate: {
        [SOURCE]: mutateOpt(
          SOURCE,
          'return buildEliseVtoOfferBlock(binding.localBindingId);',
          'return { ...buildEliseVtoOfferBlock(binding.localBindingId), imageUri: candidate.candidateImageUri };',
        ),
      },
    }),
    'local uri in the synced block',
  );
});

test('P1-14: an unknown contract version or malformed block is ignored, never repaired or rerouted', () => {
  const { offer } = createWorld();
  const id = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  assert.deepEqual(offer.parseEliseVtoOfferBlock({ type: 'elise_vto_offer', contractVersion: '1', localBindingId: id }), {
    localBindingId: id,
  });
  for (const block of [
    null,
    undefined,
    'elise_vto_offer',
    [],
    { type: 'elise_vto_offer' },
    { type: 'elise_vto_offer', contractVersion: '2', localBindingId: id },
    { type: 'elise_vto_offer', contractVersion: 1, localBindingId: id },
    { type: 'elise_vto_offer', contractVersion: '1' },
    { type: 'elise_vto_offer', contractVersion: '1', localBindingId: '' },
    { type: 'elise_vto_offer', contractVersion: '1', localBindingId: 'short' },
    { type: 'elise_vto_offer', contractVersion: '1', localBindingId: '../../etc/passwd' },
    { type: 'elise_vto_offer', contractVersion: '1', localBindingId: 'file:///candidates/a.jpg' },
    { type: 'elise_vto_offer', contractVersion: '1', localBindingId: 12345678901234567890 },
    { type: 'stylechat_actions', contractVersion: '1', localBindingId: id },
  ]) {
    assert.equal(offer.parseEliseVtoOfferBlock(block), null, JSON.stringify(block));
  }
  // Extra stored fields are never read back out.
  assert.deepEqual(
    offer.parseEliseVtoOfferBlock({
      type: 'elise_vto_offer', contractVersion: '1', localBindingId: id, candidateId: 'cand_9', route: '/admin',
    }),
    { localBindingId: id },
  );
  assert.equal(offer.buildEliseVtoOfferBlock('nope'), null);

  // The bubble sends this block type to the parser and renders nothing for a
  // null: it can never reach the generic block view, which prints title/body.
  const bubble = stripComments(read(BUBBLE));
  assert.match(
    bubble,
    /if \(block\?\.type === ELISE_VTO_OFFER_BLOCK_TYPE\) \{\s*const offer = parseEliseVtoOfferBlock\(block\);\s*return offer \? \(\s*<EliseVtoOffer key=\{`vto-offer-\$\{i\}`\} localBindingId=\{offer\.localBindingId\} \/>\s*\) : null;\s*\}/,
  );
  assert.ok(
    bubble.indexOf('ELISE_VTO_OFFER_BLOCK_TYPE) {') < bubble.indexOf('<StyleChatUiBlockView key={i}'),
    'the offer branch is taken before the generic fallback',
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Which garment gets the offer
// ═════════════════════════════════════════════════════════════════════════════

test('P1-01: a single eligible Elise direct image receives exactly one offer, bound to that candidate', async () => {
  const { world, candidate, block } = await offeredWorld();
  const stored = world.storedBindings();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].localBindingId, block.localBindingId);
  assert.equal(stored[0].candidateId, candidate.candidateId);
  assert.equal(stored[0].contentHash, candidate.contentHash);
  assert.equal(stored[0].canonicalCategory, 'dress');
  assert.equal(stored[0].classificationVersion, 'elise-fashion-context-v2');
  assert.equal(stored[0].sessionId, SESSION_1);
  assert.equal(stored[0].expiresAt, candidate.expiresAt, 'the candidate\'s own lifetime, never extended');
});

/** P0-05 / P0-07 + NC-ELVTO-04: ambiguity fails closed, in every order. */
async function checkAmbiguityFailsClosed(o = {}) {
  for (const order of ['forward', 'reverse']) {
    const world = createWorld(o);
    const dress = world.addCandidate({ category: 'dress' });
    const blazer = world.addCandidate({ category: 'blazer' });
    const coat = world.addCandidate({ category: 'wool coat' });
    let drafts = [world.draft(dress), world.draft(blazer), world.draft(coat)];
    if (order === 'reverse') drafts = drafts.reverse();

    // No focus at all.
    assert.equal(await world.prepare(drafts), null, `${order}: no focus`);
    // The composer's AUTOMATIC first-attachment focus is not a choice.
    for (const draft of drafts) {
      assert.equal(
        await world.prepare(drafts, { focusedDraftId: draft.draftId, focusExplicit: false }),
        null,
        `${order}: default focus on ${draft.draftId}`,
      );
    }
    // An explicit focus on something that is not one of the eligible garments.
    assert.equal(await world.prepare(drafts, { focusedDraftId: 'draft_unknown', focusExplicit: true }), null);
    assert.deepEqual(world.storedBindings(), [], `${order}: nothing was bound`);
  }
}

test('P0-05 / P0-07: several eligible attachments with no explicit focus get no offer, in any order', () => checkAmbiguityFailsClosed());

test('NC-ELVTO-04: falling back to the first attachment is caught', async () => {
  await expectRed(
    () => checkAmbiguityFailsClosed({
      mutate: {
        [OFFER]: mutateOpt(OFFER, "  return { kind: 'none', reason: 'ambiguous' };", "  return { kind: 'offer', garment: offerable[0] };"),
      },
    }),
    'first-attachment fallback',
  );
  // And honouring the composer's default focus as if it were a choice.
  await expectRed(
    () => checkAmbiguityFailsClosed({
      mutate: { [OFFER]: mutateOpt(OFFER, 'if (input.focusExplicit === true && typeof', 'if (typeof') },
    }),
    'default focus treated as explicit',
  );
});

test('P0-06: with several eligible attachments, an explicit focus binds exactly that garment', async () => {
  for (const order of ['forward', 'reverse']) {
    for (const pick of [0, 1, 2]) {
      const world = createWorld();
      const candidates = [
        world.addCandidate({ category: 'dress' }),
        world.addCandidate({ category: 'blazer' }),
        world.addCandidate({ category: 'wool coat' }),
      ];
      let drafts = candidates.map((candidate) => world.draft(candidate));
      const chosen = drafts[pick];
      if (order === 'reverse') drafts = drafts.reverse();
      const block = await world.prepare(drafts, { focusedDraftId: chosen.draftId, focusExplicit: true });
      assert.ok(block, `${order}/${pick}: the focused garment is offered`);
      const stored = world.storedBindings();
      assert.equal(stored.length, 1, 'at most one offer per turn');
      assert.equal(stored[0].candidateId, candidates[pick].candidateId, `${order}/${pick}: only that garment binds`);
    }
  }
});

test('P0-06: an explicit focus on an INELIGIBLE attachment does not promote a different garment', async () => {
  const world = createWorld();
  const dress = world.addCandidate({ category: 'dress' });
  const blazer = world.addCandidate({ category: 'blazer' });
  const sneakers = world.addCandidate({ category: 'sneakers' });
  const drafts = [world.draft(dress), world.draft(blazer), world.draft(sneakers)];
  assert.equal(
    await world.prepare(drafts, { focusedDraftId: `draft_${sneakers.candidateId}`, focusExplicit: true }),
    null,
    'two eligible garments remain and neither was chosen',
  );
  // With ONE eligible garment the focus is irrelevant: it is the only candidate.
  const one = createWorld();
  const onlyDress = one.addCandidate({ category: 'dress' });
  const shoes = one.addCandidate({ category: 'loafers' });
  const block = await one.prepare(
    [one.draft(shoes), one.draft(onlyDress)],
    { focusedDraftId: `draft_${shoes.candidateId}`, focusExplicit: true },
  );
  assert.ok(block);
  assert.equal(one.storedBindings()[0].candidateId, onlyDress.candidateId);
});

/** NC-ELVTO-02: no offer before the draft is tied to its own sent context item. */
async function checkCorrelationIsRequired(o = {}) {
  // The draft says "dress"; the context Elise was actually sent says something
  // else at that position. There is no single garment to speak for.
  const mismatch = createWorld(o);
  const dress = mismatch.addCandidate({ category: 'dress' });
  const drafts = [mismatch.draft(dress)];
  const sent = mismatch.sentContext(drafts);
  sent.items[0] = { ...sent.items[0], identification: { category: 'blazer', subtype: null } };
  assert.equal(await mismatch.prepare(drafts, { sentContext: sent }), null, 'category disagrees with the sent item');

  // The sent context has no item at this draft's position at all.
  const missing = createWorld(o);
  const coat = missing.addCandidate({ category: 'wool coat' });
  const coatDrafts = [missing.draft(coat)];
  assert.equal(
    await missing.prepare(coatDrafts, {
      sentContext: { contractVersion: 'elise-fashion-context-v2', source: 'direct_gallery', items: [] },
    }),
    null,
    'nothing was sent for this draft',
  );

  // The sent item at that position is not groundable.
  const ungrounded = createWorld(o);
  const top = ungrounded.addCandidate({ category: 'silk blouse' });
  const topDrafts = [ungrounded.draft(top)];
  const topSent = ungrounded.sentContext(topDrafts);
  topSent.items[0] = { sourceIndex: 0, state: 'insufficient_evidence' };
  assert.equal(await ungrounded.prepare(topDrafts, { sentContext: topSent }), null, 'the sent item is not groundable');
}

test('P0-07: a draft that cannot be tied to its own sent context item gets no offer', () => checkCorrelationIsRequired());

test('NC-ELVTO-02: permitting an offer before deterministic garment correlation is caught', async () => {
  await expectRed(
    () => checkCorrelationIsRequired({
      mutate: {
        [OFFER]: (source) => source
          .split('    if (!category || !isGroundable(sentItem)) continue;\n').join('    if (!category) continue;\n')
          .split('    if (sentItem.sourceIndex !== firstIndex || categoryOf(sentItem) !== category) continue;\n').join(''),
      },
    }),
    'offer without correlation',
  );
});

test('correlation counts positions the way the wire contract did: another attachment\'s items shift the index', async () => {
  const world = createWorld();
  const dress = world.addCandidate({ category: 'dress' });
  // A saved Closet item attached FIRST. It has a resolved reference, so it is
  // not a direct upload -- but its context item still occupies position 0.
  const owned = {
    draftId: 'draft_owned',
    state: 'ready',
    resolved: { attachmentType: 'owned_item', sourceType: 'saved_scan', sourceId: 'x' },
    selection: { retryCount: 0, updatedAt: 'now' },
    fashionContext: {
      contractVersion: 'elise-fashion-context-v2',
      source: 'closet',
      items: [{ sourceIndex: 0, state: 'ready', identification: { category: 'blazer', subtype: null } }],
    },
  };
  const drafts = [owned, world.draft(dress)];
  const garments = world.offer.correlateEliseDirectImageGarments({
    drafts,
    sentItems: world.sentContext(drafts).items,
    itemsOf: (draft) => draft.fashionContext?.items ?? null,
    isOfferableCategory: () => true,
  });
  assert.deepEqual(garments.map((g) => [g.draftId, g.candidateId, g.sourceIndex, g.category]), [
    [`draft_${dress.candidateId}`, dress.candidateId, 1, 'dress'],
  ], 'the owned item is never a direct upload, and the upload is item 1');
  assert.ok(await world.prepare(drafts));
});

test('P1-02 / P1-03 / P1-04: non-fashion, shoes, bags, accessories and unidentified photos get no offer', async () => {
  for (const [label, category, itemState] of [
    ['sneakers', 'sneakers', 'ready'],
    ['boots', 'ankle boots', 'ready'],
    ['handbag', 'handbag', 'ready'],
    ['tote', 'leather tote', 'ready'],
    ['necklace', 'gold necklace', 'ready'],
    ['sunglasses', 'sunglasses', 'ready'],
    ['belt', 'belt', 'ready'],
    // Recognised garments the launch allowlist has not enabled.
    ['jeans', 'jeans', 'ready'],
    ['skirt', 'midi skirt', 'ready'],
    // Not identified as a garment at all.
    ['non-fashion', 'dress', 'non_fashion'],
    ['insufficient evidence', 'dress', 'insufficient_evidence'],
    ['technical failure', 'dress', 'technical_failure'],
  ]) {
    const world = createWorld();
    const candidate = world.addCandidate({ category });
    assert.equal(await world.prepare([world.draft(candidate, { itemState })]), null, label);
    assert.deepEqual(world.storedBindings(), [], `${label}: nothing bound`);
  }
  // No fashion context was sent at all (identification still pending, or a
  // text-only message): there is nothing to correlate, so nothing is offered.
  const pending = createWorld();
  const candidate = pending.addCandidate({ category: 'dress' });
  assert.equal(await pending.prepare([pending.draft(candidate)], { sentContext: null }), null);
  assert.equal(await pending.prepare([], {}), null);
});

test('P1-05: a PARTIAL identification with a canonical category is offerable -- no second threshold is invented', async () => {
  // The existing VTO rule is the category. A partial identity that still
  // carries a category the canonicalizer accepts is offered exactly as a ready
  // one is; a partial identity with no usable category is not.
  const partial = createWorld();
  const blazer = partial.addCandidate({ category: 'blazer' });
  assert.ok(await partial.prepare([partial.draft(blazer, { itemState: 'partial' })]));

  const bySubtype = createWorld();
  const coat = bySubtype.addCandidate({ category: 'trench coat' });
  const draft = bySubtype.draft(coat, { itemState: 'partial', category: '', subtype: 'trench coat' });
  assert.ok(await bySubtype.prepare([draft]), 'the same category-then-subtype precedence the attachment filed it under');

  const empty = createWorld();
  const unknown = empty.addCandidate({ category: 'garment' });
  assert.equal(await empty.prepare([empty.draft(unknown, { itemState: 'partial', category: '', subtype: '' })]), null);
});

test('offerability is about the GARMENT: it never asks about K+, and every other gap means no offer', async () => {
  // A Free customer is offered: the offer is their way into K+.
  for (const kplus of ['eligible', 'expired', 'loading', 'error', 'active']) {
    const world = createWorld();
    world.env.kplus = kplus;
    const candidate = world.addCandidate({ category: 'dress' });
    assert.ok(await world.prepare([world.draft(candidate)]), `K+ ${kplus}: the garment is still offerable`);
  }
  // The bridge has no K+ module in its graph at all: the strict require in
  // createWorld would have thrown on one.
  const bridgeCode = stripComments(read(SOURCE));
  assert.doesNotMatch(bridgeCode, /kplus|useKPlus|isActive|k_plus/i, 'the bridge reads no K+ state');
  // Its one mention of entitlement is the constant that asks the eligibility
  // authority "entitlement aside, would this be accepted?".
  assert.deepEqual(bridgeCode.match(/\w*[Ee]ntitlement\w*[^,\n]*/g), ['hasEntitlement: true']);

  const gaps = [
    ['VTO remote control off', (w) => { w.env.config = { ...w.env.config, enabled: false }; }],
    ['build does not carry VTO', (w) => { w.env.vtoUi = false; }],
    ['nobody signed in', (w) => { w.env.actorId = null; }],
    ['category removed from the remote allowlist', (w) => { w.env.config = { ...w.env.config, supportedCategories: ['top'] }; }],
    ['candidate deleted', (w) => { w.env.candidates.length = 0; }],
    ['candidate expired', (w) => { w.env.candidates[0].expiresAt = new Date(Date.now() - 1000).toISOString(); }],
    ['candidate has no content hash', (w) => { w.env.candidates[0].contentHash = null; }],
    ['candidate hashed with another scheme', (w) => { w.env.candidates[0].contentHashVersion = 'sha1-raw'; }],
    ['candidate never classified', (w) => { w.env.candidates[0].classificationVersion = null; }],
    ['candidate media missing', (w) => { w.env.files.clear(); }],
    ['candidate belongs to another account', (w) => { w.env.candidates[0].ownerId = ACTOR_B; }],
    ['candidate category no longer matches what Elise was told', (w) => { w.env.candidates[0].category = 'blazer'; }],
    ['image too large for the garment payload bound', (w) => { w.env.candidates[0].normalizedByteLength = 2_400_000; }],
  ];
  for (const [label, breakIt] of gaps) {
    const world = createWorld();
    const candidate = world.addCandidate({ category: 'dress' });
    const drafts = [world.draft(candidate)];
    breakIt(world);
    assert.equal(await world.prepare(drafts), null, label);
    assert.deepEqual(world.storedBindings(ACTOR_A), [], `${label}: nothing bound`);
  }
});

test('P1-13: the automatic offer appears at most once per garment fingerprint per conversation', async () => {
  const { world, candidate, block } = await offeredWorld();
  const drafts = [world.draft(candidate)];
  // Elise is asked about the same garment again, and again.
  assert.equal(await world.prepare(drafts), null);
  assert.equal(await world.prepare(drafts), null);
  assert.equal(world.storedBindings().length, 1, 'no second binding');
  assert.equal(world.storedBindings()[0].localBindingId, block.localBindingId, 'the original action is the action');

  // A different conversation is a different conversation.
  const other = await world.prepare(drafts, { sessionId: SESSION_2 });
  assert.ok(other);
  assert.notEqual(other.localBindingId, block.localBindingId);
  // A different garment in the same conversation is a different fingerprint.
  const blazer = world.addCandidate({ category: 'blazer' });
  assert.ok(await world.prepare([world.draft(blazer)]));
  assert.equal(world.storedBindings().length, 3);
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. The device-local binding: actor-scoped, durable, bounded
// ═════════════════════════════════════════════════════════════════════════════

/** P0-08 / P0-09 + NC-ELVTO-09. */
async function checkActorIsolation(o = {}) {
  const { world, block } = await offeredWorld(o);
  assert.ok(await world.bindings.resolveEliseVtoOfferBinding(block.localBindingId), 'A resolves A\'s own binding');

  // Account B signs in on the same device, looking at a message that carries
  // A's opaque id.
  world.signIn(ACTOR_B);
  assert.equal(await world.bindings.resolveEliseVtoOfferBinding(block.localBindingId), null, 'B cannot resolve A\'s binding');
  assert.equal(await world.source.peekEliseVtoOffer(block.localBindingId), null);
  const launch = await world.source.resolveEliseVtoOfferLaunch(block.localBindingId);
  assert.equal(launch.ok, false);
  assert.equal(launch.reason, 'binding_missing');
  assert.equal(world.env.calls.fileReads, 0, 'no previous-actor media was read');
  assert.equal((await world.source.loadEliseUploadGarmentPayload(block.localBindingId, 'a'.repeat(64))).ok, false);
  assert.equal(world.env.calls.fileReads, 0);

  // Signed out: nothing resolves.
  world.signIn(null);
  assert.equal(await world.bindings.resolveEliseVtoOfferBinding(block.localBindingId), null);
  // A returns: the binding is still A's.
  world.signIn(ACTOR_A);
  assert.ok(await world.bindings.resolveEliseVtoOfferBinding(block.localBindingId), 'A\'s binding survived B\'s visit');
}

test('P0-08 / P0-09: another account can never resolve a binding, and no previous-actor media is reachable', () => checkActorIsolation());

test('NC-ELVTO-09: allowing account A\'s binding after switching to account B is caught', async () => {
  await expectRed(
    () => checkActorIsolation({
      mutate: {
        [BINDINGS]: (source) => source
          .split('  return `${KEY_PREFIX}:${actorId}`;').join('  return KEY_PREFIX;')
          .split('file.version !== FILE_VERSION || file.actorId !== actorId || !Array.isArray(file.bindings)')
          .join('file.version !== FILE_VERSION || !Array.isArray(file.bindings)'),
      },
    }),
    'shared binding storage across accounts',
  );
});

test('P0-08: a forged or foreign stored record never yields a binding', async () => {
  const { world, block } = await offeredWorld();
  const aKey = world.bindings.eliseVtoOfferBindingsKey(ACTOR_A);
  const aFile = world.env.storage.get(aKey);
  // B's own key, holding a verbatim copy of A's file: the record is stamped
  // with A, so it is not B's.
  world.signIn(ACTOR_B);
  world.env.storage.set(world.bindings.eliseVtoOfferBindingsKey(ACTOR_B), aFile);
  assert.equal(await world.bindings.resolveEliseVtoOfferBinding(block.localBindingId), null);

  for (const raw of ['', 'not json', '[]', '{"version":2}', JSON.stringify({ version: 1, actorId: ACTOR_B, bindings: 'x' })]) {
    assert.deepEqual(world.bindings.parseEliseVtoOfferBindingFile(raw, ACTOR_B), []);
  }
  // A record with an unusable field is dropped whole, not repaired.
  const good = JSON.parse(aFile).bindings[0];
  for (const broken of [
    { ...good, localBindingId: 'x' },
    { ...good, candidateId: '' },
    { ...good, contentHash: 'h'.repeat(400) },
    { ...good, expiresAt: 'tomorrow' },
    { ...good, sessionId: 7 },
  ]) {
    assert.deepEqual(
      world.bindings.parseEliseVtoOfferBindingFile(JSON.stringify({ version: 1, actorId: ACTOR_A, bindings: [broken] }), ACTOR_A),
      [],
    );
  }
});

test('the binding survives an app restart on the same device, and holds nothing it should not', async () => {
  const { world, candidate, block } = await offeredWorld();
  // A new process: fresh module instances over the same device storage.
  const restarted = createWorld({ storage: world.env.storage });
  restarted.env.candidates.push(...world.env.candidates);
  for (const [uri, bytes] of world.env.files) restarted.env.files.set(uri, bytes);
  const launch = await restarted.source.resolveEliseVtoOfferLaunch(block.localBindingId);
  assert.equal(launch.ok, true, 'the same persisted action still launches after a restart');
  assert.equal(launch.garment.source.contentHash, candidate.contentHash);

  const stored = world.storedBindings()[0];
  assert.deepEqual(Object.keys(stored).sort(), [
    'candidateId', 'canonicalCategory', 'classificationVersion', 'contentHash', 'contentHashVersion',
    'createdAt', 'expiresAt', 'localBindingId', 'sessionId',
  ]);
  const raw = world.env.storage.get(world.bindings.eliseVtoOfferBindingsKey(ACTOR_A));
  assert.doesNotMatch(raw, /file:|data:|https?:|base64|person|provider|entitlement|k_plus|revenuecat/i);
});

test('the binding record is bounded and prunes what has expired', async () => {
  const world = createWorld();
  const candidate = world.addCandidate({ category: 'dress' });
  const fingerprint = world.source.fingerprintEliseUploadCandidate(candidate);
  for (let i = 0; i < world.bindings.MAX_ELISE_VTO_OFFER_BINDINGS + 12; i += 1) {
    const binding = await world.bindings.createEliseVtoOfferBinding({
      sessionId: `session_${i}`,
      fingerprint,
      expiresAt: candidate.expiresAt,
    });
    assert.ok(binding);
  }
  assert.equal(world.storedBindings().length, world.bindings.MAX_ELISE_VTO_OFFER_BINDINGS);
  assert.equal(new Set(world.storedBindings().map((b) => b.localBindingId)).size, world.bindings.MAX_ELISE_VTO_OFFER_BINDINGS);

  // A binding whose candidate has already expired is never created...
  assert.equal(
    await world.bindings.createEliseVtoOfferBinding({
      sessionId: 'late', fingerprint, expiresAt: new Date(Date.now() - 1000).toISOString(),
    }),
    null,
  );
  // ...and one that expires later stops resolving, then is pruned on the next write.
  const key = world.bindings.eliseVtoOfferBindingsKey(ACTOR_A);
  const file = JSON.parse(world.env.storage.get(key));
  const expiredId = file.bindings[0].localBindingId;
  file.bindings[0].expiresAt = new Date(Date.now() - 1000).toISOString();
  world.env.storage.set(key, JSON.stringify(file));
  assert.equal(await world.bindings.resolveEliseVtoOfferBinding(expiredId), null);
  await world.bindings.createEliseVtoOfferBinding({ sessionId: 'next', fingerprint, expiresAt: candidate.expiresAt });
  assert.equal(world.storedBindings().some((b) => b.localBindingId === expiredId), false);
});

test('deleting a conversation removes its bindings and nothing else', async () => {
  const { world, candidate, block } = await offeredWorld();
  const other = await world.prepare([world.draft(candidate)], { sessionId: SESSION_2 });
  await world.bindings.removeEliseVtoOfferBindingsForSession(SESSION_1);
  assert.deepEqual(world.storedBindings().map((b) => b.localBindingId), [other.localBindingId]);
  assert.equal(await world.bindings.resolveEliseVtoOfferBinding(block.localBindingId), null);
  // The Closet candidate belongs to the attachment lifecycle, not to this store.
  assert.equal(world.env.candidates.length, 1);
  assert.equal(world.env.files.size, 1);
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Every tap revalidates the exact garment
// ═════════════════════════════════════════════════════════════════════════════

const STALE_CASES = {
  'P0-10 candidate deleted': {
    reason: 'candidate_missing',
    apply: (world) => { world.env.candidates.length = 0; },
  },
  'P0-11 candidate expired': {
    reason: 'candidate_missing',
    apply: (world) => { world.env.candidates[0].expiresAt = new Date(Date.now() - 1000).toISOString(); },
  },
  'P0-12 candidate bytes / content hash changed': {
    reason: 'fingerprint_changed',
    apply: (world) => {
      const next = jpegBase64(991);
      world.env.files.set(world.env.candidates[0].candidateImageUri, next);
      world.env.candidates[0].contentHash = sha256(next);
    },
  },
  // Both blazer and outerwear are VTO-capable. It is still a different
  // interpretation, and the old action referred to the old one.
  'P0-13 category changed (blazer -> coat)': {
    reason: 'fingerprint_changed',
    category: 'blazer',
    apply: (world) => { world.env.candidates[0].category = 'wool coat'; },
  },
  'P0-14 classification version changed': {
    reason: 'fingerprint_changed',
    apply: (world) => { world.env.candidates[0].classificationVersion = 'elise-fashion-context-v3'; },
  },
};

async function checkStaleActionRefuses(label, o = {}) {
  const scenario = STALE_CASES[label];
  const { world, block } = await offeredWorld({ ...o, category: scenario.category });
  assert.equal((await world.source.resolveEliseVtoOfferLaunch(block.localBindingId)).ok, true, `${label}: precondition`);
  scenario.apply(world);
  const launch = await world.source.resolveEliseVtoOfferLaunch(block.localBindingId);
  assert.equal(launch.ok, false, `${label}: a stale action must not launch`);
  assert.equal(launch.reason, scenario.reason, label);
  assert.equal('garment' in launch, false, `${label}: no garment, and never a substitute`);
  assert.equal(world.env.calls.fileReads, 0, `${label}: nothing was read from the image`);
}

for (const label of Object.keys(STALE_CASES)) {
  test(`${label}: the persisted action is unavailable, and is never reinterpreted`, () => checkStaleActionRefuses(label));
}

test('P1-15: the upload\'s media removed after the message was created makes the action unavailable', async () => {
  const { world, block } = await offeredWorld();
  world.env.files.clear();
  const launch = await world.source.resolveEliseVtoOfferLaunch(block.localBindingId);
  assert.deepEqual(launch, { ok: false, reason: 'media_missing' });
});

test('NC-ELVTO-03: skipping tap-time fingerprint revalidation is caught for every stale case', async () => {
  const mutate = {
    [SOURCE]: (source) => source
      .split("  if (!candidate) return { ok: false, reason: 'candidate_missing' };\n")
      .join("  if (!candidate) return { ok: true, binding, candidate: { candidateImageUri: 'file:///stale.jpg', title: 'stale' } as ClosetCandidate };\n")
      .split(
        "  if (!current || eliseVtoFingerprintKey(current) !== eliseVtoFingerprintKey(binding)) {\n    return { ok: false, reason: 'fingerprint_changed' };\n  }\n",
      )
      .join(''),
  };
  for (const label of Object.keys(STALE_CASES)) {
    await expectRed(() => checkStaleActionRefuses(label, { mutate }), `${label} with revalidation skipped`);
  }
});

test('a resolved launch names the exact garment, and nothing that could leave the device by accident', async () => {
  const { world, candidate, block } = await offeredWorld();
  const launch = await world.source.resolveEliseVtoOfferLaunch(block.localBindingId);
  assert.equal(launch.ok, true);
  assert.deepEqual(launch.garment.source, {
    type: 'user_supplied_garment',
    contentHash: candidate.contentHash,
    contentHashVersion: 'sha256-normalized-v1',
  });
  assert.equal(launch.garment.category, 'dress');
  assert.equal(launch.garment.inlineMediaReady, true);
  assert.equal(launch.garment.brand, null);
  assert.equal(launch.garment.commerceSource, null);
  assert.equal(launch.garmentTitle, 'Silk slip dress');
  // productRef is what Save-to-Dressing-Room persists. It is built from the
  // OPAQUE id, so neither the candidate id nor the hash rides along.
  assert.equal(launch.garment.productRef, `user_supplied_garment:${block.localBindingId}`);
  assert.equal(launch.garment.productRef.includes(candidate.candidateId), false);
  assert.equal(launch.garment.productRef.includes(candidate.contentHash), false);
  assert.equal(world.env.calls.fileReads, 0, 'resolving a tap reads no image bytes');
});

test('the garment bytes are read only by the loader, and re-verified when they are', async () => {
  const { world, candidate, block } = await offeredWorld();
  const launch = await world.source.resolveEliseVtoOfferLaunch(block.localBindingId);
  assert.equal(world.env.calls.fileReads, 0);

  const payload = await launch.loadInlineGarment(launch.garment);
  assert.equal(payload.ok, true);
  assert.equal(world.env.calls.fileReads, 1);
  assert.equal(payload.dataUri, `data:image/jpeg;base64,${world.env.files.get(candidate.candidateImageUri)}`);
  assert.equal(sha256(payload.dataUri.slice('data:image/jpeg;base64,'.length)), candidate.contentHash);

  // The file is swapped AFTER the tap but before the generation: the record
  // still says the old hash, the bytes do not. The loader refuses.
  world.env.files.set(candidate.candidateImageUri, jpegBase64(4242));
  assert.deepEqual(await launch.loadInlineGarment(launch.garment), { ok: false });
  // The candidate is reclassified after the tap: refused before any read.
  world.env.files.set(candidate.candidateImageUri, payload.dataUri.slice('data:image/jpeg;base64,'.length));
  world.env.candidates[0].category = 'blazer';
  const readsBefore = world.env.calls.fileReads;
  assert.deepEqual(await launch.loadInlineGarment(launch.garment), { ok: false });
  assert.equal(world.env.calls.fileReads, readsBefore);
  // The account changes after the tap: refused.
  world.env.candidates[0].category = 'dress';
  world.signIn(ACTOR_B);
  assert.deepEqual(await launch.loadInlineGarment(launch.garment), { ok: false });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. The offer on screen: one object, the shared launcher, the shared K+ gate
// ═════════════════════════════════════════════════════════════════════════════

test('P0-04: an authorized offer renders the invitation and TRY IT ON together, as one block', async () => {
  const { world, block } = await offeredWorld();
  const ui = renderOffer(world, { localBindingId: block.localBindingId });
  await ui.render();
  assert.equal(ui.text(), 'Would you like to try that on? TRY IT ON');
  const blockNode = ui.host('elise-vto-offer');
  assert.equal(blockNode.length, 1, 'one block');
  assert.equal(textContent(blockNode[0]), 'Would you like to try that on? TRY IT ON', 'both live inside it');
  const cta = ui.host('elise-vto-offer-cta');
  assert.equal(cta.length, 1);
  assert.equal(cta[0].props.accessibilityRole, 'button');
  assert.equal(cta[0].props.accessibilityLabel, 'Try this on');
  assert.equal(ui.ofType('VirtualTryOnSheet').length, 0, 'nothing opens until asked');
  assert.deepEqual(world.eventsNamed('elise_vto_offer_rendered'), [
    { event: 'elise_vto_offer_rendered', origin: 'elise', actor_kplus_state: 'active' },
  ]);
  // The words come from one frozen object, and name no fit, size or body claim.
  assert.equal(world.offer.ELISE_VTO_OFFER_COPY.invitation, 'Would you like to try that on?');
  assert.equal(world.offer.ELISE_VTO_OFFER_COPY.cta, 'TRY IT ON');
  assert.doesNotMatch(
    Object.values(world.offer.ELISE_VTO_OFFER_COPY).join(' '),
    /\bfit(s|ted)?\b|\bsiz(e|ing)\b|measure|true to|guarantee|exact/i,
  );
});

test('P0-04: with no authorized offer, NEITHER the sentence nor the button appears', async () => {
  for (const [label, tweak] of [
    ['K+ resolving', (w) => { w.env.kplus = 'loading'; }],
    ['K+ unreadable', (w) => { w.env.kplus = 'error'; }],
    ['VTO remote control off', (w) => { w.env.config = { ...w.env.config, enabled: false }; }],
    ['build does not carry VTO', (w) => { w.env.vtoUi = false; }],
    ['category no longer supported', (w) => { w.env.config = { ...w.env.config, supportedCategories: ['top'] }; }],
  ]) {
    const { world, block } = await offeredWorld();
    tweak(world);
    const ui = renderOffer(world, { localBindingId: block.localBindingId });
    await ui.render();
    assert.equal(ui.text(), '', `${label}: no sentence and no button`);
    assert.equal(findAll(ui.tree, (node) => typeof node.type === 'string').length, 0, `${label}: no host element at all`);
    assert.equal(world.eventsNamed('elise_vto_offer_rendered').length, 0, `${label}: nothing was promoted`);
    assert.equal(world.env.calls.openUpgrade, 0);
  }
});

test('P1-08 / P1-09 / P0-25 / P0-28: an active member\'s tap opens the ONE shared sheet for that garment -- no Shop, no Watch, no photo, no cost', async () => {
  const { world, candidate, block } = await offeredWorld();
  const ui = renderOffer(world, { localBindingId: block.localBindingId });
  await ui.render();
  await ui.press('elise-vto-offer-cta');

  const sheets = ui.ofType('VirtualTryOnSheet');
  assert.equal(sheets.length, 1, 'the existing governed sheet, through the shared launch host');
  const props = sheets[0].props;
  assert.equal(props.origin, 'elise');
  assert.equal(props.visible, true);
  assert.equal(props.garment.source.type, 'user_supplied_garment');
  assert.equal(props.garment.source.contentHash, candidate.contentHash, 'the exact garment the offer was created for');
  assert.equal(props.garmentTitle, 'Silk slip dress');
  // An uploaded photo has no retailer destination and no watchable listing.
  assert.equal(props.onShop, undefined, 'Shop is hidden, not fabricated');
  assert.equal(props.onWatch, undefined, 'Watch is hidden, not fabricated');
  assert.equal(props.sizeGuideUrl, undefined);
  // Live VTO stays dark: no capability is handed over, which is AI Photo only.
  assert.equal(props.capability, undefined);
  assert.equal(typeof props.loadInlineGarment, 'function');
  assert.equal(typeof props.onClose, 'function');
  // No person image is supplied, inferred or adopted by the offer.
  assert.deepEqual(
    Object.keys(props).filter((key) => /person|photo|adopt/i.test(key)),
    [],
    'the person photo is chosen inside the sheet, explicitly, and nowhere else',
  );
  // Still showing the offer underneath; closing returns to the conversation.
  assert.equal(ui.host('elise-vto-offer-cta').length, 1);
  props.onClose();
  await ui.render();
  assert.equal(ui.ofType('VirtualTryOnSheet').length, 0);
  assert.equal(ui.text(), 'Would you like to try that on? TRY IT ON', 'the action remains after closing');

  assert.equal(world.env.calls.openUpgrade, 0);
  assert.equal(world.env.calls.fileReads, 0, 'rendering, tapping and opening read no image bytes');
  assert.equal(world.env.calls.initiated, 1);
  assert.deepEqual(world.env.events.map((entry) => entry.event), [
    'elise_vto_offer_rendered', 'elise_vto_offer_tapped', 'elise_vto_offer_launched',
  ]);
});

test('P0-22 / P0-29: a Free customer\'s tap opens the ONE shared K+ gate -- no sheet, no generation', async () => {
  for (const kplus of ['eligible', 'expired']) {
    const { world, block } = await offeredWorld();
    world.env.kplus = kplus;
    const ui = renderOffer(world, { localBindingId: block.localBindingId });
    await ui.render();
    assert.equal(ui.text(), 'Would you like to try that on? TRY IT ON', 'a Free customer sees the same offer');
    assert.equal(world.env.gateSource, 'vto', 'the shared gate, with the bounded vto source');

    await ui.press('elise-vto-offer-cta');
    assert.equal(world.env.calls.openUpgrade, 1);
    assert.equal(ui.ofType('VirtualTryOnSheet').length, 0, 'no try-on surface for a Free actor');
    assert.equal(world.env.calls.fileReads, 0);
    assert.equal(world.env.calls.initiated, 0, 'asking about K+ is not using try-on');
    assert.deepEqual(world.eventsNamed('elise_vto_offer_kplus_gate'), [
      { event: 'elise_vto_offer_kplus_gate', origin: 'elise', actor_kplus_state: 'free' },
    ]);
    assert.equal(world.eventsNamed('elise_vto_offer_launched').length, 0);
    assert.equal(ui.text(), 'Would you like to try that on? TRY IT ON', 'the action is not lost at the gate');
  }
});

test('P0-23: an unknown or unreadable K+ answer invents no access and opens nothing', async () => {
  for (const kplus of ['loading', 'error']) {
    const { world, block } = await offeredWorld();
    world.env.kplus = kplus;
    const ui = renderOffer(world, { localBindingId: block.localBindingId });
    await ui.render();
    assert.equal(ui.host('elise-vto-offer-cta').length, 0, `${kplus}: no control to tap`);
    assert.equal(world.env.gateSource, null, `${kplus}: a resolving customer is never sent to acquisition`);
    assert.equal(ui.ofType('VirtualTryOnSheet').length, 0);
    assert.equal(world.env.calls.openUpgrade, 0);
  }
});

test('P1-06 / §32: Free -> K+ acquisition -> the SAME offer launches VTO on the next tap', async () => {
  const { world, candidate, block } = await offeredWorld();
  world.env.kplus = 'eligible';
  const ui = renderOffer(world, { localBindingId: block.localBindingId });
  await ui.render();
  const bindingsBefore = JSON.stringify(world.storedBindings());
  const candidateReadsBefore = world.env.calls.candidateReads;

  // 4-5. Tap: the existing K+ acquisition flow opens.
  await ui.press('elise-vto-offer-cta');
  assert.equal(world.env.calls.openUpgrade, 1);
  assert.equal(ui.ofType('VirtualTryOnSheet').length, 0);

  // 6. The purchase completes: the CANONICAL reader's answer changes. Nothing
  //    in the offer granted it, and nothing here was restarted or re-uploaded.
  world.env.kplus = 'active';
  // 7-8. Back in the same conversation: the same action is still there.
  await ui.render();
  assert.equal(ui.text(), 'Would you like to try that on? TRY IT ON');
  assert.equal(JSON.stringify(world.storedBindings()), bindingsBefore, 'the same binding, no duplicate offer');

  // 9-12. Tap again: K+ is read fresh, the garment is revalidated, VTO opens.
  await ui.press('elise-vto-offer-cta');
  const sheets = ui.ofType('VirtualTryOnSheet');
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].props.garment.source.contentHash, candidate.contentHash);
  assert.equal(world.env.calls.openUpgrade, 1, 'not sent to acquisition a second time');
  assert.ok(world.env.calls.candidateReads > candidateReadsBefore, 'the local garment was revalidated on that tap');
  assert.equal(world.env.candidates.length, 1, 'no re-upload');
  assert.deepEqual(world.eventsNamed('elise_vto_offer_launched'), [
    { event: 'elise_vto_offer_launched', origin: 'elise', actor_kplus_state: 'active' },
  ]);
});

test('P0-24: nothing on the Elise offer path can grant, activate or cache K+', () => {
  for (const rel of [COMPONENT, SOURCE, BINDINGS, OFFER, HOST]) {
    const code = stripComments(read(rel));
    assert.doesNotMatch(
      code,
      /\bactivate\s*\(|grantKPlus|setKPlus|kplusEntitlementStore|kplusClient|kplusCommerceService|purchaseKPlus|restoreKPlusPurchases|RevenueCat|Purchases\b|KPlusEarlyAccess|early.access/i,
      `${rel} reaches for a K+ write or a legacy surface`,
    );
  }
  // The one K+ dependency is the shared gate, with the bounded source.
  const component = stripComments(read(COMPONENT));
  assert.match(component, /<KPlusGate source="vto">/);
  assert.equal([...component.matchAll(/KPlusGate/g)].length >= 2, true);
  // And the offer consults the canonical reader only through the shared hook.
  assert.match(component, /useVtoAvailability\(\{/);
  assert.doesNotMatch(component, /useKPlusEntitlement|isActive/);
});

test('P0-16: the same message on another device, with no local binding, shows a bounded unavailable state', async () => {
  const { block } = await offeredWorld();
  // Another device: the message synced, the binding and the candidate did not.
  const otherDevice = createWorld();
  const ui = renderOffer(otherDevice, { localBindingId: block.localBindingId });
  await ui.render();
  assert.equal(ui.text(), "Try It On isn't available for this upload anymore.");
  assert.equal(ui.host('elise-vto-offer-unavailable').length, 1);
  assert.equal(ui.host('elise-vto-offer-cta').length, 0, 'no button');
  assert.equal(ui.ofType('VirtualTryOnSheet').length, 0);
  assert.equal(otherDevice.env.calls.candidateReads, 0, 'it looked for no other garment');
  assert.equal(otherDevice.env.calls.fileReads, 0);
  assert.deepEqual(otherDevice.storedBindings(), [], 'it created nothing to compensate');
  assert.equal(otherDevice.eventsNamed('elise_vto_offer_rendered').length, 0);
});

test('P0-09 (on screen): after an account switch the previous account\'s offer is unavailable', async () => {
  const { world, block } = await offeredWorld();
  const ui = renderOffer(world, { localBindingId: block.localBindingId });
  await ui.render();
  assert.equal(ui.host('elise-vto-offer-cta').length, 1);
  world.signIn(ACTOR_B);
  await ui.render();
  assert.equal(ui.text(), "Try It On isn't available for this upload anymore.");
  assert.equal(ui.host('elise-vto-offer-cta').length, 0);
  assert.equal(world.env.calls.fileReads, 0);
});

test('P0-10..P0-14 / P1-15 (on screen): a stale tap ends in the bounded line, and opens nothing', async () => {
  const cases = { ...STALE_CASES, 'P1-15 media removed': { reason: 'media_missing', apply: (w) => { w.env.files.clear(); } } };
  for (const [label, scenario] of Object.entries(cases)) {
    for (const kplus of ['active', 'eligible']) {
      const { world, block } = await offeredWorld({ category: scenario.category });
      world.env.kplus = kplus;
      const ui = renderOffer(world, { localBindingId: block.localBindingId });
      await ui.render();
      assert.equal(ui.host('elise-vto-offer-cta').length, 1, `${label}/${kplus}: precondition`);
      scenario.apply(world);
      await ui.press('elise-vto-offer-cta');
      assert.equal(ui.text(), "Try It On isn't available for this upload anymore.", `${label}/${kplus}`);
      assert.equal(ui.host('elise-vto-offer-cta').length, 0, `${label}/${kplus}: the sentence and button go together`);
      assert.equal(ui.ofType('VirtualTryOnSheet').length, 0, `${label}/${kplus}: nothing launched`);
      // A dead offer never invites an upgrade either.
      assert.equal(world.env.calls.openUpgrade, 0, `${label}/${kplus}: no K+ prompt for a garment that cannot be tried on`);
      assert.deepEqual(world.eventsNamed('elise_vto_offer_unavailable'), [
        { event: 'elise_vto_offer_unavailable', origin: 'elise', reasonCode: scenario.reason },
      ]);
      assert.equal(world.eventsNamed('elise_vto_offer_launched').length, 0);
    }
  }
});

test('P0-21: VTO disabled after the action was persisted leaves nothing to tap, and a stale tap handler refuses', async () => {
  const { world, block } = await offeredWorld();
  const ui = renderOffer(world, { localBindingId: block.localBindingId });
  await ui.render();
  assert.equal(ui.host('elise-vto-offer-cta').length, 1);
  // The kill switch flips. The next read of the remote row removes the offer.
  world.env.config = { ...world.env.config, enabled: false };
  const reopened = renderOffer(world, { localBindingId: block.localBindingId });
  await reopened.render();
  assert.equal(reopened.text(), '');
  assert.equal(reopened.ofType('VirtualTryOnSheet').length, 0);
  // Preparing a NEW offer is refused too.
  const candidate = world.addCandidate({ category: 'blazer' });
  assert.equal(await world.prepare([world.draft(candidate)]), null);
});

test('P2-05: the offer funnel is bounded and content-free', async () => {
  const { world, candidate, block } = await offeredWorld();
  const ui = renderOffer(world, { localBindingId: block.localBindingId });
  await ui.render();
  await ui.press('elise-vto-offer-cta');
  world.env.files.clear();
  ui.ofType('VirtualTryOnSheet')[0].props.onClose();
  await ui.render();
  await ui.press('elise-vto-offer-cta');

  const names = world.env.events.map((entry) => entry.event);
  assert.deepEqual(names, [
    'elise_vto_offer_rendered', 'elise_vto_offer_tapped', 'elise_vto_offer_launched',
    'elise_vto_offer_tapped', 'elise_vto_offer_unavailable',
  ]);
  for (const entry of world.env.events) {
    const keys = Object.keys(entry).filter((key) => key !== 'event');
    assert.deepEqual(keys.filter((key) => !['origin', 'actor_kplus_state', 'reasonCode'].includes(key)), [], entry.event);
    const flat = JSON.stringify(entry);
    for (const secret of [block.localBindingId, candidate.candidateId, candidate.contentHash, candidate.candidateImageUri, 'dress', 'Silk']) {
      assert.equal(flat.includes(secret), false, `${entry.event} leaks ${secret}`);
    }
  }
  // The sink itself refuses content under the new property, like every other.
  world.env.events.length = 0;
  world.telemetry.emitVtoEvent('elise_vto_offer_unavailable', {
    origin: 'elise',
    reasonCode: candidate.candidateId,
    localBindingId: block.localBindingId,
    contentHash: candidate.contentHash,
    category: 'a silk slip dress the customer described',
  });
  assert.deepEqual(world.env.events, [{ event: 'elise_vto_offer_unavailable', origin: 'elise' }]);
  assert.deepEqual([...world.telemetry.VTO_BOUNDED_PROPERTY_VALUES.reasonCode].sort(), [
    'account_changed', 'binding_missing', 'candidate_missing', 'fingerprint_changed', 'media_missing', 'not_available',
  ]);
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. No paid work before the explicit, consented, governed generation
// ═════════════════════════════════════════════════════════════════════════════

const PERSON = Object.freeze({
  source: 'photo_library',
  sanitizedUri: 'file:///cache/vto/person-a.jpg',
  width: 1024,
  height: 1280,
  metadataStripped: true,
  sanitizerVersion: 'privacy-v1',
});

function loadStore(o = {}) {
  const calls = { generate: [], buildPayload: 0, loader: 0, released: 0 };
  const epoch = { value: 1 };
  const typesVto = runModule(TYPES, {}, { jsx: false });
  const store = runModule(
    STORE,
    {
      '../actorContext': {
        createActorRequest: () => ({ requestId: 'r1', epoch: epoch.value }),
        isActorRequestCurrent: (request) => request.epoch === epoch.value,
      },
      // The REAL transport boundary, replaced at the module seam so the store's
      // own consent backstop -- which keys on the real transport -- is live.
      './vtoClient': {
        requestVtoGeneration: async (args) => {
          calls.generate.push(args);
          return {
            ok: true, requestId: args.requestId, provider: 'mock', dataUri: 'data:image/png;base64,AAAA',
            mediaType: 'image/png', width: 512, height: 640, latencyMs: 5,
          };
        },
      },
      './vtoEligibility': runModule(ELIGIBILITY, {}, { jsx: false }),
      './vtoFailures': runModule(FAILURES, { '../../types/vto': typesVto }, { jsx: false }),
      './vtoPersonInput': {
        buildVtoPersonPayload: async () => {
          calls.buildPayload += 1;
          return { ok: true, dataUri: 'data:image/jpeg;base64,PERSONPAYLOAD', transientUri: 'file:///cache/vto/payload.jpg' };
        },
        releaseVtoPersonInput: async () => { calls.released += 1; },
      },
      './vtoTelemetry': { emitVtoEvent: () => {}, dimensionBucket: () => 'le1024' },
    },
    { jsx: false, mutate: o.mutate ? o.mutate[STORE] : undefined },
  );
  return { store, calls, epoch };
}

const SUPPLIED_GARMENT = Object.freeze({
  source: { type: 'user_supplied_garment', contentHash: 'c'.repeat(64), contentHashVersion: 'sha256-normalized-v1' },
  inlineMediaReady: true,
  productRef: 'user_supplied_garment:a1b2c3d4e5f60718293a4b5c6d7e8f90',
  imageUrl: 'file:///candidates/cand_1.jpg',
  category: 'dress',
  brand: null,
  commerceSource: null,
});
const GARMENT_DATA_URI = `data:image/jpeg;base64,${jpegBase64(5)}`;

function suppliedOptions(calls, extra = {}) {
  return {
    garment: SUPPLIED_GARMENT,
    origin: 'elise',
    loadInlineGarment: async () => {
      calls.loader += 1;
      return { ok: true, dataUri: GARMENT_DATA_URI };
    },
    ...extra,
  };
}

/** P0-26 + NC-ELVTO-05. */
async function checkConsentIsRequired(o = {}) {
  const { store, calls } = loadStore(o);
  store.setVtoPersonInput(PERSON, SUPPLIED_GARMENT, 'elise');
  const before = store.getVtoSnapshot();

  for (const consentGranted of [undefined, false, 'yes', 1, null]) {
    await store.startVtoGeneration(suppliedOptions(calls, { consentGranted }));
    await store.retryVtoGeneration(suppliedOptions(calls, { consentGranted }));
  }
  assert.equal(calls.generate.length, 0, 'no provider request without consent');
  assert.equal(calls.loader, 0, 'the garment image is not even read without consent');
  assert.equal(calls.buildPayload, 0, 'nor is the person image prepared');
  assert.equal(store.getVtoSnapshot(), before, 'a refused start changes nothing');

  await store.startVtoGeneration(suppliedOptions(calls, { consentGranted: true }));
  assert.equal(calls.generate.length, 1, 'with consent, exactly one request');
  assert.equal(calls.loader, 1);
}

test('P0-26: without accepted consent an Elise launch reads no image and sends nothing', () => checkConsentIsRequired());

test('NC-ELVTO-05: bypassing consent on an Elise launch is caught', async () => {
  await expectRed(
    () => checkConsentIsRequired({
      mutate: {
        [STORE]: mutateOpt(
          STORE,
          '  if (!options.generate && options.consentGranted !== true) return;\n  const current = snapshot;',
          '  const current = snapshot;',
        ),
      },
    }),
    'consent backstop removed from start',
  );
});

/** P0-25 + NC-ELVTO-06. */
async function checkPersonMustBeExplicitlyChosen(o = {}) {
  const { store, calls } = loadStore(o);
  // The customer opened the sheet from an Elise offer and has chosen nothing.
  assert.equal(store.getVtoSnapshot().person, null);
  await store.startVtoGeneration(suppliedOptions(calls, { consentGranted: true }));
  assert.equal(calls.generate.length, 0, 'no person photo, no generation');
  assert.equal(calls.loader, 0, 'and the garment image is not read');
  assert.equal(store.getVtoSnapshot().status, 'failed');
  assert.equal(store.getVtoSnapshot().failure.code, 'invalid_person_input');
  assert.equal(store.getVtoSnapshot().person, null, 'the garment upload was never adopted as the person');
}

test('P0-25 / P0-30: with no explicitly chosen person photo there is no generation, and the garment is never used as one', async () => {
  await checkPersonMustBeExplicitlyChosen();
  // The offer path has no way to supply a person at all.
  for (const rel of [COMPONENT, SOURCE, BINDINGS, OFFER]) {
    assert.doesNotMatch(
      stripComments(read(rel)),
      /setVtoPersonInput|adoptPerson|pickVtoPersonInput|personDataUri|VtoPersonInput|launchImageLibrary|expo-image-picker/,
      `${rel} touches the person input`,
    );
  }
});

test('NC-ELVTO-06: auto-using the Elise garment upload as the person image is caught', async () => {
  await expectRed(
    () => checkPersonMustBeExplicitlyChosen({
      mutate: {
        [STORE]: mutateOpt(
          STORE,
          '  const person = current.person;\n  if (!person) {',
          "  const person = current.person ?? ({ source: 'photo_library', sanitizedUri: options.garment.imageUrl, width: null, height: null, metadataStripped: true, sanitizerVersion: 'x' } as VtoPersonInput);\n  if (!person) {",
        ),
      },
    }),
    'garment adopted as person',
  );
});

test('P0-27: the garment bytes cross the paid boundary only inside an explicit, consented generation', async () => {
  const { store, calls } = loadStore();
  store.setVtoPersonInput(PERSON, SUPPLIED_GARMENT, 'elise');
  assert.equal(calls.loader, 0, 'choosing a person photo reads no garment bytes');
  assert.equal(calls.generate.length, 0);

  await store.startVtoGeneration(suppliedOptions(calls, { consentGranted: true }));
  assert.equal(calls.generate.length, 1);
  const sent = calls.generate[0];
  assert.equal(sent.origin, 'elise');
  assert.equal(sent.garmentDataUri, GARMENT_DATA_URI);
  assert.equal(sent.personDataUri, 'data:image/jpeg;base64,PERSONPAYLOAD');
  assert.notEqual(sent.personDataUri, sent.garmentDataUri, 'the person image is never the garment image');

  // The transient garment payload is not kept anywhere after the call.
  const snapshot = JSON.stringify(store.getVtoSnapshot());
  assert.equal(snapshot.includes(GARMENT_DATA_URI.slice(30, 90)), false, 'the data URI is not in the store snapshot');
  assert.equal(store.getVtoSnapshot().status, 'success');
});

test('a garment that is no longer the offered one stops the attempt before the person image is prepared', async () => {
  for (const [label, loadInlineGarment] of [
    ['loader says no', async () => ({ ok: false })],
    ['loader throws', async () => { throw new Error('disk'); }],
    ['no loader supplied', undefined],
  ]) {
    const { store, calls } = loadStore();
    store.setVtoPersonInput(PERSON, SUPPLIED_GARMENT, 'elise');
    await store.startVtoGeneration({ garment: SUPPLIED_GARMENT, origin: 'elise', loadInlineGarment, consentGranted: true });
    assert.equal(calls.generate.length, 0, `${label}: no request`);
    assert.equal(calls.buildPayload, 0, `${label}: the person image was not prepared`);
    assert.equal(store.getVtoSnapshot().status, 'failed', label);
    assert.equal(store.getVtoSnapshot().failure.code, 'invalid_garment_input', label);
    assert.equal(store.getVtoSnapshot().failure.retryable, false, `${label}: never offered as a retry`);
    assert.ok(store.getVtoSnapshot().person, `${label}: the chosen photo is kept`);
  }
  // A commerce garment never consults a loader, even if one is present.
  const { store, calls } = loadStore();
  const commerce = { productRef: 'prod_1', imageUrl: 'https://cdn.example.com/coat.jpg', category: 'wool coat', brand: null, commerceSource: null };
  store.setVtoPersonInput(PERSON, commerce, 'commerce_product');
  await store.startVtoGeneration({
    garment: commerce, origin: 'commerce_product', consentGranted: true,
    loadInlineGarment: async () => { calls.loader += 1; return { ok: true, dataUri: GARMENT_DATA_URI }; },
  });
  assert.equal(calls.loader, 0);
  assert.equal(calls.generate.length, 1);
  assert.equal('garmentDataUri' in calls.generate[0], false);
});

// ── The transport (P1-16/17/18 regression, and what an upload sends) ────────

function loadClient() {
  const invocations = [];
  let respond = () => ({ data: null, error: null });
  const typesVto = runModule(TYPES, {}, { jsx: false });
  const client = runModule(
    CLIENT,
    {
      '../supabaseClient': {
        supabase: {
          functions: {
            invoke: async (name, options) => {
              invocations.push({ name, options });
              return respond(options);
            },
          },
        },
      },
      '../authenticatedFunctionSession': {
        resolveAuthenticatedFunctionSession: async () => ({ ok: true, accessToken: 'token-a' }),
      },
      './vtoFailures': runModule(FAILURES, { '../../types/vto': typesVto }, { jsx: false }),
    },
    { jsx: false },
  );
  return { client, invocations, typesVto, setResponse: (fn) => { respond = fn; } };
}

test('an uploaded garment sends its fingerprint, category and bytes -- and no device-local identity', async () => {
  const { client, invocations, setResponse } = loadClient();
  setResponse((options) => ({
    data: {
      requestId: options.body.requestId,
      status: 'success',
      provider: 'mock',
      garmentSource: options.body.garment.source,
      result: { dataUri: 'data:image/png;base64,AAAA', mediaType: 'image/png', width: 1, height: 1, latencyMs: 1 },
    },
    error: null,
  }));
  const outcome = await client.requestVtoGeneration({
    requestId: 'vtoreq_1',
    origin: 'elise',
    garment: SUPPLIED_GARMENT,
    personDataUri: 'data:image/jpeg;base64,PERSON',
    garmentDataUri: GARMENT_DATA_URI,
    requestGeneration: '3',
  });
  assert.equal(outcome.ok, true);
  assert.equal(invocations.length, 1);
  const body = invocations[0].options.body;
  assert.equal(invocations[0].name, 'vto-generate', 'the existing endpoint');
  assert.equal(body.origin, 'elise');
  assert.deepEqual(Object.keys(body.garment).sort(), ['category', 'dataUri', 'source']);
  assert.deepEqual(body.garment.source, SUPPLIED_GARMENT.source);
  assert.deepEqual(Object.keys(body.garment.source).sort(), ['contentHash', 'contentHashVersion', 'type']);
  assert.equal(body.garment.dataUri, GARMENT_DATA_URI);
  assert.equal(body.garment.category, 'dress');
  assert.deepEqual(Object.keys(body).sort(), ['garment', 'origin', 'person', 'requestGeneration', 'requestId']);
  const wire = JSON.stringify({ ...body, garment: { ...body.garment, dataUri: '' }, person: {} });
  assert.doesNotMatch(wire, /file:|candidate|productRef|localBinding|userId|provider|a1b2c3d4e5f60718293a4b5c6d7e8f90/);
});

test('the transport refuses to send a missing or oversized garment, and binds a result to its source', async () => {
  const { client, invocations, setResponse } = loadClient();
  const base = { requestId: 'vtoreq_1', origin: 'elise', garment: SUPPLIED_GARMENT, personDataUri: 'data:image/jpeg;base64,PERSON' };
  for (const garmentDataUri of [undefined, '', `data:image/jpeg;base64,${'A'.repeat(client.VTO_GARMENT_TRANSPORT_MAX_CHARS)}`]) {
    assert.deepEqual(await client.requestVtoGeneration({ ...base, garmentDataUri }), { ok: false, code: 'invalid_garment_input' });
  }
  assert.equal(invocations.length, 0, 'nothing was sent');
  // An unknown source type is not silently sent as a commerce product.
  assert.deepEqual(
    await client.requestVtoGeneration({ ...base, garment: { ...SUPPLIED_GARMENT, source: { type: 'closet_candidate', candidateId: 'c' } } }),
    { ok: false, code: 'invalid_garment_input' },
  );
  assert.equal(invocations.length, 0);

  const success = (garmentSource) => (options) => ({
    data: {
      requestId: options.body.requestId, status: 'success', provider: 'mock',
      ...(garmentSource === undefined ? {} : { garmentSource }),
      result: { dataUri: 'data:image/png;base64,AAAA', mediaType: 'image/png', width: 1, height: 1, latencyMs: 1 },
    },
    error: null,
  });
  for (const echoed of [
    undefined,
    { type: 'user_supplied_garment', contentHash: 'd'.repeat(64), contentHashVersion: 'sha256-normalized-v1' },
    { type: 'closet_item', closetItemId: 'x' },
    { type: 'user_supplied_garment', contentHash: SUPPLIED_GARMENT.source.contentHash, contentHashVersion: 'other' },
  ]) {
    setResponse(success(echoed));
    assert.deepEqual(
      await client.requestVtoGeneration({ ...base, garmentDataUri: GARMENT_DATA_URI }),
      { ok: false, code: 'invalid_output' },
      `a result echoing ${JSON.stringify(echoed)} is not this garment's result`,
    );
  }
});

test('P1-17 / P1-18: commerce and owned-Closet requests are byte-for-byte what they were', async () => {
  const { client, invocations, setResponse } = loadClient();
  setResponse((options) => ({
    data: {
      requestId: options.body.requestId, status: 'success', provider: 'mock',
      ...(options.body.garment.source ? { garmentSource: options.body.garment.source } : {}),
      result: { dataUri: 'data:image/png;base64,AAAA', mediaType: 'image/png', width: 1, height: 1, latencyMs: 1 },
    },
    error: null,
  }));
  const commerce = { productRef: 'prod_1', imageUrl: 'https://cdn.example.com/coat.jpg', category: 'wool coat', brand: 'Example', commerceSource: 'example' };
  assert.equal((await client.requestVtoGeneration({
    requestId: 'r1', origin: 'commerce_product', garment: commerce, personDataUri: 'data:image/jpeg;base64,P',
    // A stray garment payload on a commerce request is never sent.
    garmentDataUri: GARMENT_DATA_URI,
  })).ok, true);
  assert.deepEqual(invocations[0].options.body.garment, commerce);

  const owned = {
    source: { type: 'closet_item', closetItemId: '3f2b8c1e-5d4a-4b6c-9e7f-0a1b2c3d4e5f' },
    productRef: 'closet_item:3f2b8c1e-5d4a-4b6c-9e7f-0a1b2c3d4e5f', imageUrl: 'file:///closet/a.jpg',
    category: 'top', brand: null, commerceSource: null, ownedMediaReady: true,
  };
  assert.equal((await client.requestVtoGeneration({
    requestId: 'r2', origin: 'closet_item', garment: owned, personDataUri: 'data:image/jpeg;base64,P',
  })).ok, true);
  assert.deepEqual(invocations[1].options.body.garment, { source: owned.source });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. The server's garment validation, executed (P0-17 / P0-18 / P0-19)
// ═════════════════════════════════════════════════════════════════════════════

function loadServerGarment(o = {}) {
  const contract = runModule(SERVER_CONTRACT, {}, { jsx: false });
  const garment = runModule(
    SERVER_GARMENT,
    { './vtoContract.ts': contract },
    { jsx: false, mutate: o.mutate ? o.mutate[SERVER_GARMENT] : undefined },
  );
  return { contract, garment };
}

function serverGarment(base64, overrides = {}) {
  return {
    source: { type: 'user_supplied_garment', contentHash: sha256(base64), contentHashVersion: 'sha256-normalized-v1' },
    dataUri: `data:image/jpeg;base64,${base64}`,
    category: 'dress',
    ...overrides,
  };
}

test('P0-17 / P0-19: malformed base64, a wrong media type and a hash mismatch are refused by the server module', async () => {
  const { garment } = loadServerGarment();
  const base64 = jpegBase64(3);
  assert.equal((await garment.resolveUserSuppliedVtoGarment(serverGarment(base64))).ok, true);

  const refusals = [
    ['garment_media_encoding', serverGarment(base64, { dataUri: `data:image/jpeg;base64,${base64}!!` })],
    ['garment_media_encoding', serverGarment(base64, { dataUri: `data:image/jpeg;base64,${base64.slice(0, -1)}` })],
    ['garment_media_encoding', serverGarment(base64, { dataUri: 'data:image/jpeg;base64,' })],
    ['garment_media_type', serverGarment(base64, { dataUri: `data:image/png;base64,${base64}` })],
    ['garment_media_type', serverGarment(base64, { dataUri: 'https://cdn.example.com/dress.jpg' })],
    ['garment_media_missing', serverGarment(base64, { dataUri: undefined })],
    ['garment_hash_mismatch', serverGarment(base64, {
      source: { type: 'user_supplied_garment', contentHash: sha256(jpegBase64(4)), contentHashVersion: 'sha256-normalized-v1' },
    })],
    ['garment_hash_shape', serverGarment(base64, {
      source: { type: 'user_supplied_garment', contentHash: 'nope', contentHashVersion: 'sha256-normalized-v1' },
    })],
    ['garment_media_too_small', serverGarment(jpegBase64(3, 300))],
  ];
  for (const [detail, input] of refusals) {
    const resolved = await garment.resolveUserSuppliedVtoGarment(input);
    assert.deepEqual(resolved, { ok: false, code: 'invalid_garment_input', detail });
  }
});

/** P0-18 + NC-ELVTO-08. */
async function checkGarmentPayloadIsBounded(o = {}) {
  const { garment, contract } = loadServerGarment(o);
  // A real, correctly hashed JPEG-shaped image that is simply too large.
  const oversized = jpegBase64(9, contract.VTO_INLINE_GARMENT_MAX_BYTES + 3000);
  assert.ok(oversized.length + 23 > contract.VTO_GARMENT_PAYLOAD_MAX_CHARS);
  const resolved = await garment.resolveUserSuppliedVtoGarment(serverGarment(oversized));
  assert.equal(resolved.ok, false, 'an oversized garment payload must never be handed on to a provider adapter');
  assert.equal(resolved.detail, 'garment_media_too_large');
}

test('P0-18: a garment payload over its bound is refused before it can reach a provider', () => checkGarmentPayloadIsBounded());

test('NC-ELVTO-08: letting an oversized garment payload through to the provider adapter is caught', async () => {
  await expectRed(
    () => checkGarmentPayloadIsBounded({
      mutate: {
        [SERVER_GARMENT]: (source) => source
          .split("  if (dataUri.length > VTO_GARMENT_PAYLOAD_MAX_CHARS) return refuse('garment_media_too_large');\n").join('')
          .split("  if (bytes.length > VTO_INLINE_GARMENT_MAX_BYTES) return refuse('garment_media_too_large');\n").join(''),
      },
    }),
    'garment bounds removed',
  );
});

test('the garment ceilings are one number on every side, and the body ceiling is derived, not chosen', () => {
  const { contract } = loadServerGarment();
  const { client, typesVto } = loadClient();
  const candidateTypes = runModule(CANDIDATE_TYPES, {}, { jsx: false });
  assert.equal(typesVto.VTO_GARMENT_PAYLOAD_MAX_CHARS, contract.VTO_GARMENT_PAYLOAD_MAX_CHARS);
  assert.equal(client.VTO_GARMENT_TRANSPORT_MAX_CHARS, contract.VTO_GARMENT_PAYLOAD_MAX_CHARS);
  assert.equal(typesVto.VTO_USER_SUPPLIED_GARMENT_SOURCE_TYPE, contract.VTO_USER_SUPPLIED_GARMENT_SOURCE_TYPE);
  assert.equal(typesVto.VTO_GARMENT_CONTENT_HASH_VERSION, contract.VTO_GARMENT_CONTENT_HASH_VERSION);
  assert.equal(candidateTypes.CLOSET_CANDIDATE_CONTENT_HASH_VERSION, contract.VTO_GARMENT_CONTENT_HASH_VERSION);
  assert.deepEqual([...contract.VTO_INLINE_GARMENT_MEDIA_TYPES], ['image/jpeg']);
  // One person image + one garment image + the envelope. Nothing else.
  assert.equal(contract.VTO_REQUEST_BODY_MAX_CHARS, contract.VTO_PERSON_PAYLOAD_MAX_CHARS + contract.VTO_REQUEST_ENVELOPE_MAX_CHARS);
  assert.equal(
    contract.VTO_INLINE_GARMENT_REQUEST_BODY_MAX_CHARS,
    contract.VTO_PERSON_PAYLOAD_MAX_CHARS + contract.VTO_GARMENT_PAYLOAD_MAX_CHARS + contract.VTO_REQUEST_ENVELOPE_MAX_CHARS,
  );
  // The decoded bound is what the encoded one implies.
  assert.equal(contract.VTO_INLINE_GARMENT_MAX_BYTES, (contract.VTO_GARMENT_PAYLOAD_MAX_CHARS / 4) * 3);
  // The hash the device computes is the hash the server recomputes.
  assert.equal(contract.VTO_GARMENT_CONTENT_HASH_VERSION, 'sha256-normalized-v1');
});

test('the device and the server compute the same content identity for the same bytes', async () => {
  const { world, candidate, block } = await offeredWorld();
  const launch = await world.source.resolveEliseVtoOfferLaunch(block.localBindingId);
  const payload = await launch.loadInlineGarment(launch.garment);
  const { garment } = loadServerGarment();
  const resolved = await garment.resolveUserSuppliedVtoGarment({
    source: launch.garment.source,
    dataUri: payload.dataUri,
    category: launch.garment.category,
  });
  assert.equal(resolved.ok, true, 'what the bridge loads is exactly what the server accepts');
  assert.equal(resolved.garment.source.contentHash, candidate.contentHash);
  assert.equal(resolved.garment.productRef, `user_supplied_garment:${candidate.contentHash}`);
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. Through the real conversation hook: what is stored, and the transcripts
// ═════════════════════════════════════════════════════════════════════════════

function createConversation(world, o = {}) {
  const observed = { savedMessages: [], providerCalls: [], spoken: [] };
  const reply = (content) => ({
    status: 'success',
    message: { sender: 'assistant', content, model: 'test-model', tokenEstimate: 10 },
    usage: { messagesUsed: 1, messagesLimit: 25 },
    ...(o.actions ? { actions: o.actions } : {}),
  });
  const runtime = createHookRuntime();
  const frame = runModule(FRAME, {}, { jsx: false });
  const requireMap = {
    react: runtime.react,
    '../services/style-chat/providers/edgeStyleChatProvider': {
      EdgeStyleChatProvider: class {
        async generateReply(request) {
          observed.providerCalls.push(request);
          return reply(typeof o.reply === 'function' ? o.reply(observed.providerCalls.length) : o.reply);
        }
      },
    },
    '../constants/featureFlags': { ELISE_CONCIERGE_V1: false },
    '../services/concierge/conciergeModel': { buildConciergeResult: () => ({ presentation: 'none' }) },
    '../services/style-chat/styleChatRepository': {
      getStyleChatSession: async (sessionId) => ({ id: sessionId, title: 'Styling', mode: 'general', createdAt: 'x', updatedAt: 'x' }),
      listStyleChatMessages: async () => [],
      saveStyleChatMessage: async (input) => {
        observed.savedMessages.push(JSON.parse(JSON.stringify(input)));
        return {
          id: `${input.sender}-${observed.savedMessages.length}`,
          sessionId: input.sessionId,
          sender: input.sender,
          content: input.content,
          referencedScanIds: [], referencedSavedItemIds: [], referencedDressingRoomIds: [], referencedCatalogItems: [],
          uiBlocks: input.uiBlocks ?? [],
          provider: input.provider ?? 'mock',
          tokenEstimate: input.tokenEstimate ?? 0,
          createdAt: new Date().toISOString(),
        };
      },
      readStyleChatDailyUsage: async () => ({ messagesUsed: 0, messagesLimit: 25 }),
    },
    '../services/style-chat/styleChatErrors': { getFriendlyStyleChatError: (err) => String(err?.message ?? err) },
    '../services/weather/todayWeatherStore': { saveTodayWeather: async () => {} },
    '../constants/styleChat': {
      STYLE_CHAT_COPY: { errorGeneric: 'Something went wrong.', systemLimitNotice: 'Daily limit reached.', burstLimitNotice: 'Too fast.' },
      STYLE_CHAT_DAILY_MESSAGE_LIMIT: 25,
    },
    '../types/styleChatAttachments': { buildAttachmentUiBlock: () => ({ type: 'stylechat_attachments', items: [] }) },
    '../services/style-chat/styleChatRetryState': runModule('services/style-chat/styleChatRetryState.ts', {}, { jsx: false }),
    '../services/style-chat/styleChatOutcome': { classifyStyleChatOperationalFailure: () => null },
    '../contexts/AuthSessionContext': { useAuthSession: () => ({ user: { id: world.env.actorId } }) },
    '../services/actorScope': world.actorScope,
    '../services/style-chat/eliseConversationFrame': frame,
    '../services/style-chat/eliseConversationTelemetry': runModule(
      'services/style-chat/eliseConversationTelemetry.ts', {}, { jsx: false },
    ),
    './useStylistIdentity': {
      useStylistIdentity: () => ({ identity: { avatarId: 'elise_default', displayName: 'Elise' }, isLoading: false }),
    },
    './useScreenReaderEnabled': { useScreenReaderEnabled: () => false, useScreenReaderReady: () => true },
    '../constants/stylistIdentity': { getStylistVoiceProfile: () => 'feminine' },
    '../services/avatarSpeech': {
      speakAvatarMessage: async (payload) => { observed.spoken.push(payload); },
      stopAvatarSpeechPlayback: async () => {},
    },
    './useVoiceResponsesPreference': { useVoiceResponsesPreference: () => ({ enabled: false, loading: false }) },
    '../services/style-chat/styleChatGreeting': {
      ensureSessionGreeting: async () => ({ inserted: false, message: null }),
      waitForSessionGreeting: async (promise) => promise,
      markSessionGreeted: () => {},
      isSessionGreeted: () => true,
      getGreetingTextForUser: () => 'Hi, I am Elise.',
      getPendingGreetingSpeechMessageId: () => null,
      claimGreetingSpeechAttempt: () => null,
      noteInsertedGreetingForSpeech: () => {},
    },
  };
  const { useStyleChat } = runModule(HOOK, requireMap, { jsx: false, mutate: world.mutationFor(HOOK) });

  let api;
  const render = () => {
    runtime.beginRender();
    api = useStyleChat(o.sessionId ?? SESSION_1, {});
    runtime.flushEffects();
  };
  const quiesce = async () => {
    for (let i = 0; i < 20; i += 1) {
      await settle(2);
      if (!runtime.dirty) break;
      runtime.clearDirty();
      render();
    }
  };
  return {
    observed,
    async start() {
      render();
      await quiesce();
      assert.ok(api.canSend, 'the conversation must be sendable');
    },
    /** Sends exactly as the screen does: the snapshot plus a preparer bound to it. */
    async sendWithUploads(text, drafts, focus = {}) {
      const sentContext = world.sentContext(drafts);
      const sent = await api.sendMessage(text, {
        attachments: {
          references: [],
          drafts,
          fashionContext: sentContext,
          prepareVtoOffer: () => world.source.prepareEliseVtoOffer({
            sessionId: o.sessionId ?? SESSION_1,
            drafts,
            sentContext,
            focusedDraftId: focus.focusedDraftId ?? null,
            focusExplicit: focus.focusExplicit === true,
          }),
        },
      });
      await quiesce();
      return sent;
    },
    async sendText(text) {
      const sent = await api.sendMessage(text);
      await quiesce();
      return sent;
    },
    assistant: () => observed.savedMessages.filter((message) => message.sender === 'assistant'),
    transcript(offerCopy) {
      return observed.savedMessages.map((message) => {
        const who = message.sender === 'user' ? 'CUSTOMER' : 'ELISE   ';
        const lines = [`${who}  ${message.content}`];
        for (const block of message.uiBlocks ?? []) {
          if (block.type === 'elise_vto_offer') {
            lines.push(`K SCAN    ${offerCopy.invitation}   [ ${offerCopy.cta} ]   (app-owned block; binding ${'•'.repeat(8)})`);
          }
        }
        return lines.join('\n');
      }).join('\n');
    },
  };
}

test('P2-01: an eligible upload gets normal advice, then the app-owned invitation and CTA for that exact garment', async (t) => {
  const world = createWorld();
  const candidate = world.addCandidate({ category: 'dress', title: 'Silk slip dress' });
  const chat = createConversation(world, {
    reply: 'That slip dress is a lovely base. Add a cropped cardigan and block heels for dinner.',
  });
  await chat.start();
  assert.equal(await chat.sendWithUploads('How should I style this for dinner?', [world.draft(candidate)]), true);

  const [assistant] = chat.assistant();
  assert.equal(assistant.content, 'That slip dress is a lovely base. Add a cropped cardigan and block heels for dinner.');
  const offers = assistant.uiBlocks.filter((block) => block.type === 'elise_vto_offer');
  assert.equal(offers.length, 1, 'at most one automatic offer per assistant turn');
  assert.deepEqual(Object.keys(offers[0]).sort(), ['contractVersion', 'localBindingId', 'type']);
  // The offer resolves to the exact garment that was uploaded.
  const launch = await world.source.resolveEliseVtoOfferLaunch(offers[0].localBindingId);
  assert.equal(launch.ok, true);
  assert.equal(launch.garment.source.contentHash, candidate.contentHash);
  // Nothing about the device-local garment reached the cloud row or the model.
  const persisted = JSON.stringify(chat.observed.savedMessages);
  const sentToModel = JSON.stringify(chat.observed.providerCalls);
  for (const secret of [candidate.candidateId, candidate.contentHash, candidate.candidateImageUri]) {
    assert.equal(persisted.includes(secret), false, 'the stored conversation carries no local garment identity');
    assert.equal(sentToModel.includes(secret), false, 'the model is given no local garment identity');
  }
  assert.equal(sentToModel.includes(offers[0].localBindingId), false, 'the model never sees the binding');
  assert.equal(sentToModel.includes('prepareVtoOffer'), false);
  assert.equal(world.env.calls.fileReads, 0, 'P0-27: an upload and an offer read no garment bytes');
  t.diagnostic(`ELIGIBLE_TRANSCRIPT\n${chat.transcript(world.offer.ELISE_VTO_OFFER_COPY)}`);
});

test('P2-02: an ineligible upload gets normal advice and no invitation, no CTA', async (t) => {
  const world = createWorld();
  const sneakers = world.addCandidate({ category: 'sneakers', title: 'White leather sneakers' });
  const chat = createConversation(world, {
    reply: 'Those sneakers sharpen up nicely with tapered trousers and a relaxed overshirt.',
  });
  await chat.start();
  assert.equal(await chat.sendWithUploads('What goes with these?', [world.draft(sneakers)]), true);
  const [assistant] = chat.assistant();
  assert.equal(assistant.content, 'Those sneakers sharpen up nicely with tapered trousers and a relaxed overshirt.');
  assert.deepEqual(assistant.uiBlocks.filter((block) => block.type === 'elise_vto_offer'), []);
  assert.deepEqual(world.storedBindings(), []);
  assert.doesNotMatch(JSON.stringify(chat.observed.savedMessages), /try that on|TRY IT ON|elise_vto_offer/i);
  t.diagnostic(`INELIGIBLE_TRANSCRIPT\n${chat.transcript(world.offer.ELISE_VTO_OFFER_COPY)}`);
});

test('P2-03: with several eligible uploads the offer is for the explicitly focused garment, or there is none', async (t) => {
  // No explicit focus: advice, no offer.
  const ambiguous = createWorld();
  const a1 = ambiguous.addCandidate({ category: 'dress', title: 'Black midi dress' });
  const a2 = ambiguous.addCandidate({ category: 'blazer', title: 'Camel blazer' });
  const first = createConversation(ambiguous, { reply: 'Both work. The blazer over the midi dress is the stronger look.' });
  await first.start();
  const ambiguousDrafts = [ambiguous.draft(a1), ambiguous.draft(a2)];
  await first.sendWithUploads('Which of these should I wear?', ambiguousDrafts, {
    focusedDraftId: ambiguousDrafts[0].draftId, focusExplicit: false,
  });
  assert.deepEqual(first.assistant()[0].uiBlocks.filter((block) => block.type === 'elise_vto_offer'), []);
  t.diagnostic(`MULTI_ATTACHMENT_TRANSCRIPT (no explicit focus)\n${first.transcript(ambiguous.offer.ELISE_VTO_OFFER_COPY)}`);

  // The customer taps the blazer, then sends: the offer is for the blazer.
  const focused = createWorld();
  const f1 = focused.addCandidate({ category: 'dress', title: 'Black midi dress' });
  const f2 = focused.addCandidate({ category: 'blazer', title: 'Camel blazer' });
  const second = createConversation(focused, { reply: 'The camel blazer is the one. Keep everything under it tonal.' });
  await second.start();
  const focusedDrafts = [focused.draft(f1), focused.draft(f2)];
  await second.sendWithUploads('What about this one?', focusedDrafts, {
    focusedDraftId: focusedDrafts[1].draftId, focusExplicit: true,
  });
  const offers = second.assistant()[0].uiBlocks.filter((block) => block.type === 'elise_vto_offer');
  assert.equal(offers.length, 1);
  const launch = await focused.source.resolveEliseVtoOfferLaunch(offers[0].localBindingId);
  assert.equal(launch.garment.source.contentHash, f2.contentHash, 'the blazer, not the first attachment');
  assert.equal(launch.garment.category, 'blazer');
  t.diagnostic(`MULTI_ATTACHMENT_TRANSCRIPT (blazer explicitly focused)\n${second.transcript(focused.offer.ELISE_VTO_OFFER_COPY)}`);
});

test('P0-03 (through the hook): a model invitation is removed before it is stored, and creates no CTA', async () => {
  // Text-only conversation: the model invites a try-on with nothing to try.
  const world = createWorld();
  const chat = createConversation(world, {
    reply: 'A camel blazer would suit that. Would you like to try that on?',
  });
  await chat.start();
  assert.equal(await chat.sendText('What jacket should I get?'), true);
  const [assistant] = chat.assistant();
  assert.equal(assistant.content, 'A camel blazer would suit that.');
  assert.deepEqual(assistant.uiBlocks, [], 'the guard never creates a block');
  assert.deepEqual(world.storedBindings(), []);

  // An ineligible upload: the model invites anyway. Still removed, still no CTA.
  const shoes = createWorld();
  const sneakers = shoes.addCandidate({ category: 'sneakers' });
  const shoeChat = createConversation(shoes, { reply: 'Great trainers. Want to see them on you?\nPair them with straight denim.' });
  await shoeChat.start();
  await shoeChat.sendWithUploads('Thoughts?', [shoes.draft(sneakers)]);
  assert.equal(shoeChat.assistant()[0].content, 'Great trainers.\nPair them with straight denim.');
  assert.deepEqual(shoeChat.assistant()[0].uiBlocks.filter((block) => block.type === 'elise_vto_offer'), []);

  // An ELIGIBLE upload where the model also invites: its sentence is removed
  // and the application's own block supplies the one canonical invitation.
  const dressWorld = createWorld();
  const dress = dressWorld.addCandidate({ category: 'dress' });
  const dressChat = createConversation(dressWorld, { reply: 'Gorgeous dress. Would you like to try that on?' });
  await dressChat.start();
  await dressChat.sendWithUploads('Do you like it?', [dressWorld.draft(dress)]);
  assert.equal(dressChat.assistant()[0].content, 'Gorgeous dress.');
  assert.equal(dressChat.assistant()[0].uiBlocks.filter((block) => block.type === 'elise_vto_offer').length, 1);
});

test('P0-01 (through the hook): a model action cannot become the offer, and a model-shaped block is never stored as one', async () => {
  const world = createWorld();
  const sneakers = world.addCandidate({ category: 'sneakers' });
  // Whatever the server's validated actions array carries, it is stored under
  // the separate stylechat_actions block -- never as an elise_vto_offer.
  const chat = createConversation(world, {
    reply: 'Nice pair.',
    actions: [{ type: 'elise_vto_offer', contractVersion: '1', localBindingId: 'a'.repeat(32) }],
  });
  await chat.start();
  await chat.sendWithUploads('Thoughts?', [world.draft(sneakers)]);
  const blocks = chat.assistant()[0].uiBlocks;
  assert.deepEqual(blocks.filter((block) => block.type === 'elise_vto_offer'), []);
  assert.deepEqual(blocks.map((block) => block.type), ['stylechat_actions']);
});

test('the screen binds the offer to the send snapshot, and the conversation hook holds no VTO dependency', () => {
  const screen = stripComments(read(SCREEN));
  assert.match(
    screen,
    /prepareVtoOffer: async \(\) =>\s*\(await prepareEliseVtoOffer\(\{\s*sessionId,\s*drafts: snapshot\.drafts,\s*sentContext: snapshot\.fashionContext,\s*focusedDraftId: snapshot\.focusedDraftId,\s*focusExplicit: snapshot\.focusedDraftExplicit,\s*\}\)\)/,
  );
  const hook = stripComments(read(HOOK));
  assert.doesNotMatch(hook, /eliseVtoUploadSource|eliseVtoOfferBindings|services\/vto|closetCandidate|AsyncStorage/);
  assert.match(hook, /if \(hasAttachments && trimmedAssistant && sendAttachments\?\.prepareVtoOffer\) \{/);
  assert.match(hook, /guardEliseVtoInvitationProse\(result\.message\.content\)\.text\.trim\(\)/);
  // Explicit focus is recorded only by the customer's own focus action.
  const attachments = stripComments(read('hooks/useStyleChatAttachments.ts'));
  assert.equal([...attachments.matchAll(/explicitFocusBySession\.set\(/g)].length, 1);
  assert.match(
    attachments,
    /explicitFocusBySession\.set\(sessionId, draftId\);\s*setFocusedDraftId\(sessionId, draftId\);/,
  );
  assert.match(attachments, /explicitFocusBySession\.get\(sessionId\) === getFocusedDraftId\(sessionId\)/);
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. One launcher, one sheet, one provider, no hidden mutation
// ═════════════════════════════════════════════════════════════════════════════

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

test('P1-16 / P1-17 / P1-18: one VirtualTryOnSheet mount in the app, reached by every entry through the shared host', () => {
  // One pass over the UI tree: each file is read once.
  const mounts = [];
  const hostUsers = [];
  for (const rel of [...sourceFiles('app'), ...sourceFiles('components')]) {
    const raw = read(rel);
    if (!raw.includes('VirtualTryOnSheet') && !raw.includes('VtoLaunchHost')) continue;
    const code = stripComments(raw);
    if (/<VirtualTryOnSheet\b/.test(code)) mounts.push(rel);
    if (/<VtoLaunchHost\b/.test(code)) hostUsers.push(rel);
  }
  hostUsers.sort();
  assert.deepEqual(mounts, [HOST], 'no second sheet, and no second place that mounts it');
  assert.equal([...stripComments(read(HOST)).matchAll(/<VirtualTryOnSheet\b/g)].length, 1);

  assert.deepEqual(hostUsers, [COMPONENT, ENTRY].sort(), 'the product control and the Elise offer -- the same lifecycle');

  // The existing entry points still render the product control, unchanged.
  for (const rel of ['components/ProductShelf.tsx', 'components/scan-results/PurchaseOptionsPanel.tsx', 'app/closet/try-on.tsx']) {
    assert.match(read(rel), /<TryItOnEntry\b/, `${rel} still mounts the product control`);
  }
  // And there is still no standalone VTO destination.
  assert.equal(sourceFiles('app').some((rel) => /vto|try-?on/i.test(rel) && rel !== 'app/closet/try-on.tsx' && rel !== 'app/dev-n1-diagnostic.tsx'), false);
});

test('P1-21: there is no second VTO provider, endpoint or eligibility system for Elise', () => {
  const providers = fs.readdirSync(path.join(ROOT, 'supabase/functions/vto-generate/providers')).sort();
  assert.deepEqual(providers, [
    'aiLabToolsProvider.test.ts', 'aiLabToolsProvider.ts', 'index.ts',
    'mockProvider.test.ts', 'mockProvider.ts', 'mockResultAsset.ts',
  ]);
  const functions = fs.readdirSync(path.join(ROOT, 'supabase/functions'));
  assert.deepEqual(functions.filter((name) => /elise/i.test(name)), [], 'no Elise-specific Edge Function');
  // The try-on functions are exactly the two that already existed.
  assert.deepEqual(
    functions.filter((name) => /vto|try.?on/i.test(name)).sort(),
    ['tryon-clothes-pro', 'vto-generate'],
    'no new VTO backend',
  );
  for (const rel of [SOURCE, COMPONENT]) {
    const code = stripComments(read(rel));
    assert.doesNotMatch(code, /fetch\(|supabase|functions\.invoke|XMLHttpRequest/, `${rel} opens no network path of its own`);
  }
  // Category is canonicalized by the existing authority, on both sides.
  assert.match(stripComments(read(SOURCE)), /toCanonicalVtoCategory\(candidate\.category\)/);
  assert.match(stripComments(read(SOURCE)), /evaluateVtoEligibility\(\{/);
  for (const rel of [SOURCE, OFFER, BINDINGS, COMPONENT]) {
    assert.doesNotMatch(
      stripComments(read(rel)),
      /\b(shirts?|blouses?|jackets?|coats?|dress(es)?|jeans|trousers)\b.*\b(shirts?|blouses?|jackets?|coats?)\b/i,
      `${rel} carries a category list of its own`,
    );
  }
  assert.match(read('supabase/functions/vto-generate/vtoEligibility.ts'), /import \{ normalizeCategory \} from '\.\.\/_shared\/scanHelpers\.ts';/);
});

test('HIDDEN_CLOSET_MUTATION=NO: the offer path reads the candidate store and writes nothing to the Closet', () => {
  for (const rel of [SOURCE, OFFER, BINDINGS, COMPONENT, HOST]) {
    assert.doesNotMatch(
      stripComments(read(rel)),
      /createClosetCandidate|updateClosetCandidate|transitionClosetCandidate|deleteClosetCandidate|promoteSelectedClosetCandidates|finalizeClosetCandidatePromotion|rejectClosetCandidate|closetLibrary|addClosetItem|saveToCloset|user_closet_items|saved_scans|writeAsStringAsync|deleteAsync|copyAsync|moveAsync/,
      `${rel} mutates the Closet, a candidate or a file`,
    );
  }
  // The only candidate API the bridge names is the read.
  const bridge = stripComments(read(SOURCE));
  assert.match(bridge, /import \{ getClosetCandidate \} from '\.\.\/closetCandidateLibrary';/);
  assert.equal([...bridge.matchAll(/closetCandidateLibrary/g)].length, 1);
});

test('P1-22: Live VTO is untouched -- no EAS profile enables it, and the offer hands the sheet no capability', () => {
  const eas = JSON.parse(read('eas.json'));
  for (const [name, profile] of Object.entries(eas.build ?? {})) {
    const env = profile?.env ?? {};
    assert.equal('EXPO_PUBLIC_LIVE_VTO_ENABLED' in env, false, `profile ${name} sets the Live VTO flag`);
    assert.equal('EXPO_PUBLIC_LIVE_VTO_HARNESS' in env, false, `profile ${name} sets the Live harness flag`);
  }
  const component = stripComments(read(COMPONENT));
  assert.doesNotMatch(component, /useVtoLiveCapability|LIVE_VTO|capability=/);
});

test('the consent wording covers both images, and the sheet still asks before anything is sent', () => {
  const consent = read('services/vto/vtoConsent.ts');
  assert.match(consent, /export const VTO_CONSENT_VERSION = 'vto-third-party-v2';/);
  assert.match(consent, /sends the photo you chose, together with the garment image, to an external AI service: /);
  assert.doesNotMatch(stripComments(consent), /product image/);
  assert.match(consent, /VTO_CONSENT_COPY_LEGAL_REVIEW_REQUIRED=YES/);
  // No new retention or processing claim.
  assert.doesNotMatch(stripComments(consent), /delete[sd]? (it|them|your)|not (stored|retained|kept) by|garment[- ]only|background removed|isolat/i);
  const sheet = stripComments(read(SHEET));
  assert.match(sheet, /const requestGenerate = useCallback\(\(\) => \{\s*if \(hasVtoConsent\(\)\) \{\s*vto\.generate\(\);/);
  assert.match(stripComments(read('hooks/useVirtualTryOn.ts')), /consentGranted: hasVtoConsent\(\)/);
});
