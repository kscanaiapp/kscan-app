// ELISE-003 — behavioural coverage for the Elise stale-completion guard.
//
// Sections 10, 11 and 15 of the Build 34 Elise contract: a reply that arrives
// after the actor changed, after the session changed, or after the screen was
// left must be discarded with ZERO mutation — not persisted, not spoken, not
// appended anywhere.
//
// hooks/useStyleChat.ts implements that with isCurrentSend(), which requires
// BOTH the per-[actor, session] send-scope version AND the monotonic actor
// epoch. Before this suite, replacing isCurrentSend() with `() => true` left
// the ENTIRE governed suite green, so the guard was unprotected: the only
// tests naming it matched its source text.
//
// These tests EXECUTE the real hook (see __tests__/helpers/hookRuntime.js) and
// observe the actual side effects a stale completion would cause — a persisted
// assistant row and avatar speech.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const { renderHook, settle } = require('./helpers/hookRuntime');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath, requireMap, sandboxExtras = {}) {
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
    console,
    Date,
    Error,
    Promise,
    Set,
    Map,
    Array,
    Object,
    JSON,
    Number,
    String,
    Boolean,
    RegExp,
    Math,
    isNaN,
    setTimeout,
    clearTimeout,
    setImmediate,
    AbortController,
    exports: module.exports,
    module,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require: ${id}`);
    },
    ...sandboxExtras,
  };
  vm.runInNewContext(output, sandbox, { filename });
  return module.exports;
}

const ACTOR_A = '11111111-1111-1111-1111-111111111111';
const ACTOR_B = '22222222-2222-2222-2222-222222222222';
const SESSION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/**
 * The real actor authority (services/actorContext.js), reached through the real
 * services/actorScope.ts. Not a stub: the epoch semantics under test are its own.
 */
function loadActorScope() {
  const actorContext = require('../services/actorContext.js');
  actorContext.__resetActorContextForTests();
  const actorScope = loadTsModule('services/actorScope.ts', {
    './actorContext': actorContext,
  });
  return { actorContext, actorScope };
}

function createHarness(options = {}) {
  const { actorContext, actorScope } = loadActorScope();
  const observed = {
    savedMessages: [],
    spoken: [],
    stoppedSpeech: [],
    greetingsInserted: 0,
  };

  let actorId = options.actorId ?? ACTOR_A;
  actorContext.advanceActorEpoch(actorId);

  // Resolves only when the test releases it, so the account/session switch can
  // land squarely inside the provider round trip.
  let releaseProvider;
  const providerGate = new Promise((resolve) => {
    releaseProvider = resolve;
  });

  const providerReply = {
    status: 'success',
    message: {
      sender: 'assistant',
      content: 'A tailored navy blazer would work here.',
      model: 'gemini-2.5-flash',
      tokenEstimate: 42,
    },
    usage: { messagesUsed: 1, messagesLimit: 25 },
  };

  const requireMap = {
    react: null, // filled in by the runtime below
    '../services/style-chat/providers/edgeStyleChatProvider': {
      EdgeStyleChatProvider: class {
        async generateReply() {
          await providerGate;
          return providerReply;
        }
      },
    },
    '../constants/featureFlags': { ELISE_CONCIERGE_V1: false },
    '../services/concierge/conciergeModel': {
      buildConciergeResult: () => ({ presentation: 'none' }),
    },
    '../services/style-chat/styleChatRepository': {
      getStyleChatSession: async (sessionId) => ({
        id: sessionId,
        title: 'Styling',
        mode: 'general',
        createdAt: '2026-09-02T00:00:00.000Z',
        updatedAt: '2026-09-02T00:00:00.000Z',
      }),
      listStyleChatMessages: async () => [],
      saveStyleChatMessage: async (input, expectedUserId) => {
        observed.savedMessages.push({ ...input, expectedUserId });
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
          tokenEstimate: input.tokenEstimate ?? 0,
          createdAt: new Date().toISOString(),
        };
      },
      readStyleChatDailyUsage: async () => ({ messagesUsed: 0, messagesLimit: 25 }),
    },
    '../services/style-chat/styleChatErrors': {
      getFriendlyStyleChatError: (err) => String(err && err.message ? err.message : err),
    },
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
    '../contexts/AuthSessionContext': { useAuthSession: () => ({ user: { id: actorId } }) },
    '../services/actorScope': actorScope,
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
      speakAvatarMessage: async (payload) => {
        observed.spoken.push(payload);
      },
      stopAvatarSpeechPlayback: async (scope) => {
        observed.stoppedSpeech.push(scope ?? null);
      },
    },
    './useVoiceResponsesPreference': {
      useVoiceResponsesPreference: () => ({ enabled: true, loading: false }),
    },
    '../services/style-chat/styleChatGreeting': {
      ensureSessionGreeting: async () => {
        observed.greetingsInserted += 1;
        return { inserted: false, message: null };
      },
      waitForSessionGreeting: async (promise) => promise,
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
    actorContext,
    releaseProvider: () => releaseProvider(),
    signIn(nextActorId) {
      actorId = nextActorId;
      // Mirrors AuthSessionContext.resetActorScopedRuntimeState, which advances
      // the epoch on EVERY authentication transition.
      actorContext.advanceActorEpoch(nextActorId);
    },
    loadHook(reactImpl) {
      requireMap.react = reactImpl;
      return loadTsModule('hooks/useStyleChat.ts', requireMap).useStyleChat;
    },
  };
}

test('ELISE-NC-002: a reply that lands after an account switch is never persisted or spoken', async () => {
  const harness = createHarness();
  const { createHookRuntime } = require('./helpers/hookRuntime');
  const runtime = createHookRuntime();
  const useStyleChat = harness.loadHook(runtime.react);

  let api;
  const render = () => {
    runtime.beginRender();
    api = useStyleChat(SESSION_A, {});
    runtime.flushEffects();
  };
  render();
  for (let i = 0; i < 20; i += 1) {
    await settle(2);
    if (!runtime.dirty) break;
    runtime.clearDirty();
    render();
  }

  assert.ok(api.canSend, 'the conversation must be sendable before the switch');

  const sendPromise = api.sendMessage('What should I wear to a gallery opening?');
  await settle(3);

  // The user message is persisted before the provider is called; that is the
  // pre-switch state and is legitimately Actor A's.
  const savedBeforeSwitch = harness.observed.savedMessages.length;
  assert.equal(savedBeforeSwitch, 1);
  assert.equal(harness.observed.savedMessages[0].sender, 'user');

  // Actor A signs out; Actor B signs in — WHILE the reply is in flight.
  harness.signIn(ACTOR_B);

  harness.releaseProvider();
  await sendPromise;
  await settle(4);

  const assistantWrites = harness.observed.savedMessages.filter((m) => m.sender === 'assistant');
  assert.deepEqual(
    assistantWrites,
    [],
    "a reply generated for the departed actor must not be persisted after the switch",
  );
  assert.deepEqual(
    harness.observed.spoken,
    [],
    'the departed actor’s reply must never begin speaking for the arriving actor',
  );
});

test('ELISE-NC-002 control: with no account switch the same reply IS persisted and spoken', async () => {
  const harness = createHarness();
  const { createHookRuntime } = require('./helpers/hookRuntime');
  const runtime = createHookRuntime();
  const useStyleChat = harness.loadHook(runtime.react);

  let api;
  const render = () => {
    runtime.beginRender();
    api = useStyleChat(SESSION_A, {});
    runtime.flushEffects();
  };
  render();
  for (let i = 0; i < 20; i += 1) {
    await settle(2);
    if (!runtime.dirty) break;
    runtime.clearDirty();
    render();
  }

  const sendPromise = api.sendMessage('What should I wear to a gallery opening?');
  await settle(3);
  harness.releaseProvider();
  const sent = await sendPromise;
  await settle(4);

  assert.equal(sent, true, 'an undisturbed send must report success');
  const assistantWrites = harness.observed.savedMessages.filter((m) => m.sender === 'assistant');
  assert.equal(assistantWrites.length, 1, 'the reply is persisted exactly once');
  assert.equal(harness.observed.spoken.length, 1, 'the reply is spoken exactly once');
  assert.equal(harness.observed.spoken[0].actorId, ACTOR_A);
  assert.equal(harness.observed.spoken[0].sessionId, SESSION_A);
});

test('ELISE-NC-003: a reply that lands after leaving the session never reaches another session', async () => {
  const harness = createHarness();
  const { createHookRuntime } = require('./helpers/hookRuntime');
  const runtime = createHookRuntime();
  const useStyleChat = harness.loadHook(runtime.react);

  let sessionId = SESSION_A;
  let api;
  const render = () => {
    runtime.beginRender();
    api = useStyleChat(sessionId, {});
    runtime.flushEffects();
  };
  render();
  for (let i = 0; i < 20; i += 1) {
    await settle(2);
    if (!runtime.dirty) break;
    runtime.clearDirty();
    render();
  }

  const sendPromise = api.sendMessage('Style this for me.');
  await settle(3);

  // The user navigates to a different conversation while the reply is in flight.
  sessionId = SESSION_B;
  render();
  await settle(2);

  harness.releaseProvider();
  await sendPromise;
  await settle(4);

  const assistantWrites = harness.observed.savedMessages.filter((m) => m.sender === 'assistant');
  assert.deepEqual(
    assistantWrites,
    [],
    'session A’s reply must not be written while session B owns the screen',
  );
  assert.deepEqual(
    harness.observed.spoken,
    [],
    'session A’s reply must not speak over session B',
  );
});

test('ELISE-NC-002: an A -> B -> A cycle still discards the first generation’s reply', async () => {
  const harness = createHarness();
  const { createHookRuntime } = require('./helpers/hookRuntime');
  const runtime = createHookRuntime();
  const useStyleChat = harness.loadHook(runtime.react);

  let api;
  const render = () => {
    runtime.beginRender();
    api = useStyleChat(SESSION_A, {});
    runtime.flushEffects();
  };
  render();
  for (let i = 0; i < 20; i += 1) {
    await settle(2);
    if (!runtime.dirty) break;
    runtime.clearDirty();
    render();
  }

  const sendPromise = api.sendMessage('Style this for me.');
  await settle(3);

  // Same actor id at the end — only the epoch distinguishes the generations.
  harness.signIn(ACTOR_B);
  harness.signIn(ACTOR_A);

  harness.releaseProvider();
  await sendPromise;
  await settle(4);

  const assistantWrites = harness.observed.savedMessages.filter((m) => m.sender === 'assistant');
  assert.deepEqual(
    assistantWrites,
    [],
    'a matching actor id from an earlier generation must still be stale',
  );
  assert.deepEqual(harness.observed.spoken, []);
});
