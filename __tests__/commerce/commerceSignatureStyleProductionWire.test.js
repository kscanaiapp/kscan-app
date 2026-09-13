/**
 * Signature Style reaches Commerce on the REAL app path (continuation brief §6).
 *
 * The brief is explicit that calling `buildActivationEvidence()` directly is not
 * evidence for this flag, and it is right: the activation module has accepted a
 * `loadSignatureStyleTokens` dependency since #410, and the production call site
 * in `hooks/useStyleChat.ts` simply never supplied one. Every direct-module test
 * passed the whole time, because the hole was in the wiring, not the module.
 *
 * So these tests EXECUTE the real hook, let it run a real send, and inspect the
 * dependency object it actually handed to `runCommerceActivation`. The real
 * `parseShoppingIntentWire` decides whether a shopping turn happened, and the
 * real `buildActivationEvidence` turns the tokens into a contribution.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const { settle, createHookRuntime } = require('../helpers/hookRuntime');

const ROOT = path.resolve(__dirname, '../..');
const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACTOR = '11111111-1111-1111-1111-111111111111';

function loadTsModule(relativePath, requireMap) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const module = { exports: {} };
  const sandbox = {
    __DEV__: false,
    console, Date, Error, Promise, Set, Map, Array, Object, JSON, Number, String,
    Boolean, RegExp, Math, isNaN, setTimeout, clearTimeout, setImmediate,
    module,
    exports: module.exports,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      return require(id);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(output, sandbox, { filename });
  return module.exports;
}

/**
 * A harness whose ONLY interesting observation is the deps object the hook
 * builds for Commerce. Everything else is the minimum needed for a send.
 */
function createHarness(options = {}) {
  const observed = { activationDeps: [], evidence: [], savedMessages: [] };

  // The real actor authority, reached through the real actor scope — the
  // actor-binding assertions below would be worthless against a stub.
  const actorContext = require(path.join(ROOT, 'services/actorContext.js'));
  actorContext.__resetActorContextForTests();
  const actorScope = loadTsModule('services/actorScope.ts', { './actorContext': actorContext });
  actorContext.advanceActorEpoch(ACTOR);

  // The real activation module, with only the network replaced — so the real
  // `parseShoppingIntentWire` and the real `buildActivationEvidence` run.
  const activation = require(path.join(ROOT, 'services/style-chat/commerceActivation.ts'));
  const commerceActivationStub = {
    ...activation,
    runCommerceActivation: async (input) => {
      observed.activationDeps.push(input.deps);
      return activation.runCommerceActivation({
        ...input,
        deps: {
          ...input.deps,
          fetchCommerce: async (evidence) => {
            observed.evidence.push(evidence);
            return {
              status: 'empty',
              purchaseOptions: [],
              enrichmentCandidates: [],
              cacheHit: false,
              retryable: true,
            };
          },
        },
      });
    },
  };

  const providerReply = {
    status: 'success',
    message: {
      sender: 'assistant',
      content: 'Let me find options that prioritise black.',
      model: 'gemini-3.6-flash',
      tokenEstimate: 20,
    },
    usage: { messagesUsed: 1, messagesLimit: 25 },
    ...(options.shoppingIntent === null
      ? {}
      : {
          shoppingIntent: options.shoppingIntent ?? {
            blockType: 'commerce_shopping_intent',
            state: {
              stateVersion: 1,
              category: 'footwear',
              color: 'black',
              colorStrength: 'STRONG_EXPLICIT_PREFERENCE',
              budget: null,
              exclusions: [],
              functionalRequirements: [],
              turns: 1,
              lastShownPrices: null,
            },
            needsBudgetReference: false,
          },
        }),
    ...(options.signatureStyleTokens === undefined
      ? {}
      : { signatureStyleTokens: options.signatureStyleTokens }),
  };

  const requireMap = {
    react: null,
    '../services/style-chat/providers/edgeStyleChatProvider': {
      EdgeStyleChatProvider: class {
        async generateReply() {
          return providerReply;
        }
      },
    },
    '../constants/featureFlags': { ELISE_CONCIERGE_V1: false },
    '../services/concierge/conciergeModel': { buildConciergeResult: () => ({ presentation: 'none' }) },
    '../services/style-chat/styleChatRepository': {
      getStyleChatSession: async (sessionId) => ({
        id: sessionId,
        title: 'Styling',
        mode: 'general',
        createdAt: '2026-09-02T00:00:00.000Z',
        updatedAt: '2026-09-02T00:00:00.000Z',
      }),
      listStyleChatMessages: async () => [],
      saveStyleChatMessage: async (input) => {
        observed.savedMessages.push(input);
        return {
          id: `${input.sender}-${observed.savedMessages.length}`,
          sessionId: input.sessionId,
          sender: input.sender,
          content: input.content,
          referencedScanIds: [],
          referencedSavedItemIds: [],
          referencedDressingRoomIds: [],
          referencedCatalogItems: [],
          uiBlocks: input.uiBlocks ?? [],
          provider: input.provider ?? 'mock',
          tokenEstimate: 0,
          createdAt: new Date().toISOString(),
        };
      },
      readStyleChatDailyUsage: async () => ({ messagesUsed: 0, messagesLimit: 25 }),
    },
    '../services/style-chat/styleChatErrors': { getFriendlyStyleChatError: (e) => String(e) },
    '../services/weather/todayWeatherStore': { saveTodayWeather: async () => {} },
    '../constants/styleChat': {
      STYLE_CHAT_COPY: {
        errorGeneric: 'Something went wrong.',
        systemLimitNotice: 'Daily limit reached.',
        burstLimitNotice: 'Too fast.',
      },
      STYLE_CHAT_DAILY_MESSAGE_LIMIT: 25,
    },
    '../types/styleChatAttachments': { buildAttachmentUiBlock: () => ({ type: 'attachments' }) },
    '../services/style-chat/styleChatRetryState': loadTsModule(
      'services/style-chat/styleChatRetryState.ts',
      {},
    ),
    '../services/style-chat/styleChatOutcome': { classifyStyleChatOperationalFailure: () => null },
    '../contexts/AuthSessionContext': { useAuthSession: () => ({ user: { id: ACTOR } }) },
    '../services/actorScope': actorScope,
    '../services/style-chat/commerceActivation': commerceActivationStub,
    '../services/commerceHydration': {
      fetchDeferredCommerce: async () => {
        throw new Error('the hook must route Commerce through runCommerceActivation');
      },
    },
    '../services/ownedClosetItems': {
      listOwnedClosetItems: async () => options.closet ?? [],
    },
    './useStylistIdentity': {
      useStylistIdentity: () => ({
        identity: { avatarId: 'elise_default', displayName: 'Elise' },
        isLoading: false,
      }),
    },
    './useScreenReaderEnabled': {
      useScreenReaderEnabled: () => false,
      useScreenReaderReady: () => true,
    },
    '../constants/stylistIdentity': { getStylistVoiceProfile: () => 'feminine' },
    '../services/avatarSpeech': {
      speakAvatarMessage: async () => {},
      stopAvatarSpeechPlayback: async () => {},
    },
    './useVoiceResponsesPreference': { useVoiceResponsesPreference: () => ({ enabled: false, loading: false }) },
    '../services/style-chat/styleChatGreeting': {
      ensureSessionGreeting: async () => ({ inserted: false, message: null }),
      waitForSessionGreeting: async (p) => p,
      markSessionGreeted: () => {},
      isSessionGreeted: () => true,
      getGreetingTextForUser: () => 'Hi, I am Elise.',
      getPendingGreetingSpeechMessageId: () => null,
      claimGreetingSpeechAttempt: () => null,
      noteInsertedGreetingForSpeech: () => {},
    },
  };

  return {
    observed,
    loadHook(reactImpl) {
      requireMap.react = reactImpl;
      return loadTsModule('hooks/useStyleChat.ts', requireMap).useStyleChat;
    },
  };
}

/** Drive one real send through the real hook. */
async function sendOneTurn(harness, message) {
  const runtime = createHookRuntime();
  const useStyleChat = harness.loadHook(runtime.react);
  let api;
  const render = () => {
    runtime.beginRender();
    api = useStyleChat(SESSION, {});
    runtime.flushEffects();
  };
  render();
  for (let i = 0; i < 20; i += 1) {
    await settle(2);
    if (!runtime.dirty) break;
    runtime.clearDirty();
    render();
  }
  await api.sendMessage(message);
  await settle(6);
}

// ── The wire itself ────────────────────────────────────────────────────────

test('the production hook supplies a Signature Style loader when the server sent tokens', async () => {
  const harness = createHarness({ signatureStyleTokens: ['navy', 'tan', 'wool'] });
  await sendOneTurn(harness, 'Only black boots please.');

  assert.equal(harness.observed.activationDeps.length, 1, 'the shopping turn reached Commerce');
  const deps = harness.observed.activationDeps[0];
  assert.equal(
    typeof deps.loadSignatureStyleTokens,
    'function',
    'SIGNATURE_STYLE_PRODUCTION_WIRE: the real call site must supply the loader',
  );
  assert.deepEqual(await deps.loadSignatureStyleTokens(), ['navy', 'tan', 'wool']);
});

test('the tokens reach the outbound Commerce context as a SIGNATURE_STYLE contribution', async () => {
  const harness = createHarness({ signatureStyleTokens: ['navy', 'tan', 'wool'] });
  await sendOneTurn(harness, 'Only black boots please.');

  const [evidence] = harness.observed.evidence;
  assert.ok(evidence, 'Commerce was invoked');
  const signature = (evidence.shoppingContext ?? []).find((c) => c.provenance === 'SIGNATURE_STYLE');
  assert.ok(signature, 'the contribution is actually assembled, not just loaded');
  assert.deepEqual(signature.signatureStyleTokens, ['navy', 'tan', 'wool']);
  assert.equal(signature.actorId, ACTOR, 'scoped to the authenticated actor');
});

test('with no tokens the loader is absent and the request is unchanged', async () => {
  const harness = createHarness({ signatureStyleTokens: undefined });
  await sendOneTurn(harness, 'Only black boots please.');

  const deps = harness.observed.activationDeps[0];
  assert.equal(deps.loadSignatureStyleTokens, undefined, 'no profile means no dependency at all');
  const [evidence] = harness.observed.evidence;
  assert.equal(
    (evidence.shoppingContext ?? []).some((c) => c.provenance === 'SIGNATURE_STYLE'),
    false,
    'nothing is fabricated for a customer with no Signature Style',
  );
});

test('an empty or malformed token payload degrades without inventing a profile', async () => {
  for (const payload of [[], ['', '  '], 'navy', { colors: ['navy'] }, null, [42, true]]) {
    const harness = createHarness({ signatureStyleTokens: payload });
    await sendOneTurn(harness, 'Only black boots please.');
    const [evidence] = harness.observed.evidence;
    assert.equal(
      (evidence.shoppingContext ?? []).some((c) => c.provenance === 'SIGNATURE_STYLE'),
      false,
      `${JSON.stringify(payload)} must not become a style profile`,
    );
  }
});

test('a non-shopping turn carries no Signature Style anywhere', async () => {
  const harness = createHarness({ shoppingIntent: null, signatureStyleTokens: ['navy'] });
  await sendOneTurn(harness, 'What should I wear to a gallery opening?');
  assert.deepEqual(harness.observed.activationDeps, [], 'Commerce never ran');
  assert.deepEqual(harness.observed.evidence, [], 'and no provider request was made');
});

// ── Precedence: Signature Style may never outrank the customer ─────────────

test('the explicit request outranks Signature Style end to end', async () => {
  // Style says brown and tan; the customer said black. The contribution that
  // travels must carry BOTH, with the explicit colour at the higher rank — the
  // ranker then settles it, and the ranking tests assert the outcome.
  const harness = createHarness({ signatureStyleTokens: ['brown', 'tan'] });
  await sendOneTurn(harness, 'Only black boots please.');

  const [evidence] = harness.observed.evidence;
  const explicit = evidence.shoppingContext.find((c) => c.provenance === 'USER_EXPLICIT');
  const signature = evidence.shoppingContext.find((c) => c.provenance === 'SIGNATURE_STYLE');

  assert.equal(explicit.color, 'black', 'what the customer said travels as USER_EXPLICIT');
  assert.equal(explicit.colorStrength, 'STRONG_EXPLICIT_PREFERENCE');
  assert.deepEqual(signature.signatureStyleTokens, ['brown', 'tan']);
  assert.equal(signature.color, undefined, 'Signature Style never writes the colour axis');
});

test('Signature Style loses to the explicit colour inside the real ranker', async () => {
  const edge = (n) => require(path.join(ROOT, 'supabase/functions/scan-identify', n));
  const { buildShoppingIntent, parseContextContributions } = edge('commerceShoppingIntent.ts');
  const { scoreContextualFit } = edge('commerceContextualRanking.ts');

  const harness = createHarness({ signatureStyleTokens: ['brown', 'tan'] });
  await sendOneTurn(harness, 'Only black boots please.');
  const [evidence] = harness.observed.evidence;
  const intent = buildShoppingIntent(parseContextContributions(evidence.shoppingContext), ACTOR);

  const product = (id, title) => ({
    id, title, price: '$150.00', currency: 'USD', type: 'retail', source: 'Farfetch',
    imageUrl: `https://img.cdn.io/${id}.jpg`,
    productUrl: `https://www.farfetch.com/p/${id}`,
  });
  const black = scoreContextualFit(product('b', 'Black Leather Chelsea Boot'), intent);
  const brown = scoreContextualFit(product('r', 'Brown Leather Chelsea Boot'), intent);

  assert.ok(black.delta > brown.delta, 'the stated colour beats the wardrobe habit');
  assert.ok(
    brown.facts.includes('signature_style_aligned'),
    'and the habit still counts — it is a tie-break, not a veto',
  );
});

// ── Privacy boundary (section 21) ──────────────────────────────────────────

test('no wardrobe identifiers or raw profile text leave with the tokens', async () => {
  const harness = createHarness({
    signatureStyleTokens: ['navy', 'wool'],
    closet: [
      { id: 'closet-uuid-1', title: 'Navy Wool Overcoat', category: 'outerwear', color: 'navy', material: 'wool' },
    ],
  });
  await sendOneTurn(harness, 'Only black boots please.');

  const [evidence] = harness.observed.evidence;
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes('closet-uuid-1'), false, 'no Closet record id');
  // The actor id appears ONLY as the scoping field the context contract
  // requires; it must never reach the outbound identification.
  assert.equal(JSON.stringify(evidence.identification).includes(ACTOR), false, 'no actor id outbound');
  assert.equal(serialized.includes(SESSION), false, 'no conversation id');
  assert.equal(/Only black boots please/.test(serialized), false, 'no raw transcript');
  for (const contribution of evidence.shoppingContext ?? []) {
    if (contribution.provenance !== 'SIGNATURE_STYLE') continue;
    for (const token of contribution.signatureStyleTokens) {
      assert.match(token, /^[a-z][a-z -]*$/, 'tokens are short descriptors, not prose');
      assert.ok(token.length <= 32);
    }
  }
});
