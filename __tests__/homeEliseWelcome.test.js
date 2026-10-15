const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
function load(file, mocks = {}) {
  const output = ts.transpileModule(fs.readFileSync(path.join(ROOT, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', output)((name) => {
    if (name in mocks) return mocks[name];
    throw new Error(`Unexpected dependency: ${name}`);
  }, mod, mod.exports);
  return mod.exports;
}
const { createHomeEliseWelcome } = load('services/homeEliseWelcome.ts');
const GREETING = 'Hi, Morgan. I’m Elise. How can I help style you today?';
function greeting(sessionId = 'session') {
  return { id: 'greeting', sessionId, sender: 'assistant', content: GREETING, uiBlocks: [{ type: 'greeting' }] };
}
function harness(overrides = {}) {
  const records = new Map();
  const log = [];
  const observers = new Set();
  let bound;
  let current = true;
  let today = '2026-10-15T10:00:00Z';
  const deps = {
    read: async (actor) => ({ ...(records.get(actor) ?? { version: 1 }) }),
    write: async (actor, record) => { log.push(['write', actor, { ...record }]); records.set(actor, { ...record }); },
    hasConsent: async () => true,
    onboardingComplete: async () => true,
    latestSession: async () => { log.push(['latest']); return { id: 'session' }; },
    ownedSession: async (id, actor) => { log.push(['owned', id, actor]); return { id }; },
    createSession: async (actor) => { log.push(['create', actor]); return { id: 'created' }; },
    messages: async (id, actor) => { log.push(['messages', id, actor]); return [greeting(id)]; },
    ensureGreeting: async (_actor, id) => { log.push(['ensure', id]); return { message: greeting(id), inserted: true }; },
    observeSpeech: (callback) => { observers.add(callback); return () => observers.delete(callback); },
    speak: async (payload) => { log.push(['speak', payload]); },
    stop: async (binding) => { log.push(['stop', binding]); },
    now: () => new Date(today),
    ...overrides,
  };
  let start = createHomeEliseWelcome(deps);
  const input = (changes = {}) => ({
    actorId: 'actor-A', avatarId: 'elise_default', text: GREETING, eligible: true,
    isCurrent: () => current, onBinding: (value) => { bound = value; }, ...changes,
  });
  return {
    records, log, deps, input,
    start: (changes) => start(input(changes)),
    restart: () => { start = createHomeEliseWelcome(deps); },
    changeDay: (day) => { today = day; },
    stale: () => { current = false; },
    emit: (changes) => { for (const fn of [...observers]) fn({ ...bound, stylistId: bound?.avatarId, phase: 'playing', ...changes }); },
    observers: () => observers.size,
  };
}
const count = (h, name) => h.log.filter((entry) => entry[0] === name).length;

test('Home dispatch uses persisted owned greeting, durable attempt precedes paid call, success waits for native playing', async () => {
  const h = harness();
  await h.start().done;
  assert.equal(count(h, 'create'), 0);
  assert.equal(count(h, 'ensure'), 0);
  const [attempt, paid] = h.log.filter(([kind]) => kind === 'write' || kind === 'speak');
  assert.equal(attempt[0], 'write');
  assert.equal(attempt[2].attemptDay, '2026-10-15');
  assert.equal(attempt[2].playedDay, undefined);
  assert.equal(paid[1].messageId, 'greeting');
  assert.equal(paid[1].actorId, 'actor-A');
  assert.equal(paid[1].source, 'greeting');
  for (const phase of ['requesting', 'ready', 'error', 'idle']) h.emit({ phase });
  h.emit({ actorId: 'actor-B' });
  h.emit({ messageId: 'another-message' });
  h.emit({ avatarId: 'another-avatar' });
  h.emit({ stylistId: 'another-avatar' });
  assert.equal(count(h, 'write'), 1);
  h.emit({});
  assert.equal(h.records.get('actor-A').playedDay, '2026-10-15');
  assert.equal(h.observers(), 0);
});

test('concurrent calls, remount, foreground and A -> B -> A cannot repeat an automatic attempt', async () => {
  const h = harness();
  await Promise.all([h.start().done, h.start().done, h.start().done]);
  assert.equal(count(h, 'speak'), 1);
  await h.start({ actorId: 'actor-B' }).done;
  await h.start().done;
  assert.equal(count(h, 'speak'), 2);
  assert.equal(h.log.filter(([kind, payload]) => kind === 'speak' && payload.actorId === 'actor-A').length, 1);
});

test('durable attempt suppresses same-day cold restart even when provider or success persistence fails', async () => {
  const h = harness({ speak: async () => { throw new Error('provider unavailable'); } });
  await h.start().done;
  assert.equal(h.records.get('actor-A').attemptDay, '2026-10-15');
  h.restart();
  await h.start().done;
  assert.equal(count(h, 'latest'), 1);
  const h2 = harness();
  await h2.start().done;
  h2.deps.write = async () => { throw new Error('disk unavailable'); };
  h2.emit({});
  await Promise.resolve();
  h2.restart();
  await h2.start().done;
  assert.equal(count(h2, 'speak'), 1);
});

test('a new UTC day can reuse the verified envelope without creating or changing chat history', async () => {
  const h = harness();
  await h.start().done;
  h.emit({});
  h.changeDay('2026-10-16T00:00:01Z');
  h.restart();
  await h.start().done;
  assert.equal(count(h, 'speak'), 2);
  assert.equal(count(h, 'create'), 0);
  assert.equal(count(h, 'ensure'), 0);
  assert.deepEqual(h.log.find(([kind]) => kind === 'owned'), ['owned', 'session', 'actor-A']);
});

test('no session exists: creates one owned greeting envelope, then reuses it after restart', async () => {
  const h = harness({ latestSession: async () => null });
  await h.start().done;
  assert.equal(count(h, 'create'), 1);
  assert.deepEqual(h.log.find(([kind]) => kind === 'create'), ['create', 'actor-A']);
  assert.equal(count(h, 'ensure'), 1);
  h.changeDay('2026-10-16T10:00:00Z');
  h.restart();
  await h.start().done;
  assert.equal(count(h, 'create'), 1);
  assert.equal(count(h, 'speak'), 2);
});

test('legacy nonempty/name-mismatching history is never rewritten or spoken as the current welcome', async () => {
  const h = harness({ messages: async () => [{ ...greeting(), content: 'Hi, OldName.' }] });
  await h.start().done;
  assert.equal(count(h, 'create'), 1);
  assert.equal(h.log.find(([kind]) => kind === 'speak')[1].sessionId, 'created');
  assert.equal(h.log.find(([kind]) => kind === 'ensure')[1], 'created');
});

test('empty owned session uses greeting guard, conflict loser cannot speak or claim', async () => {
  for (const inserted of [true, false]) {
    const h = harness({
      messages: async () => [],
      ensureGreeting: async () => ({ message: greeting(), inserted }),
    });
    await h.start().done;
    assert.equal(count(h, 'create'), 0);
    assert.equal(count(h, 'speak'), inserted ? 1 : 0);
    assert.equal(count(h, 'write'), inserted ? 1 : 0);
  }
});

test('Free, voice off, silent identity and screen reader are text-only and never re-arm when toggled', async () => {
  for (const reason of ['free', 'voice-off', 'silent-avatar', 'screen-reader', 'locked-account', 'flag-off']) {
    const h = harness();
    await h.start({ eligible: false }).done;
    await h.start().done;
    assert.deepEqual(h.log, [], reason);
  }
});

test('no consent or incomplete onboarding cannot reach session mutation or provider', async () => {
  for (const overrides of [{ hasConsent: async () => false }, { onboardingComplete: async () => false }]) {
    const h = harness(overrides);
    await h.start().done;
    await h.start().done;
    assert.deepEqual(h.log, []);
  }
});

test('storage read corruption/failure or attempt-write failure always fails closed before Speech', async () => {
  for (const overrides of [
    { read: async () => { throw new Error('corrupt'); } },
    { write: async () => { throw new Error('full'); } },
  ]) {
    const h = harness(overrides);
    await h.start().done;
    assert.equal(count(h, 'speak'), 0);
  }
});

test('blur/account epoch change while reading prevents mutation; cancel stops exact message including consent wait', async () => {
  let release;
  const h = harness({ read: () => new Promise((resolve) => { release = resolve; }) });
  const attempt = h.start();
  h.stale();
  release({ version: 1 });
  await attempt.done;
  assert.deepEqual(h.log, []);

  const h2 = harness();
  const ready = h2.start();
  await ready.done;
  ready.cancel();
  h2.emit({});
  assert.equal(h2.observers(), 0);
  assert.equal(h2.records.get('actor-A').playedDay, undefined);
  assert.deepEqual(h2.log.find(([kind]) => kind === 'stop')[1], {
    actorId: 'actor-A', sessionId: 'session', messageId: 'greeting', avatarId: 'elise_default',
  });
  await h2.start().done;
  assert.equal(count(h2, 'speak'), 1);
});

test('actor change during attempt write cannot dispatch old welcome or mark success', async () => {
  const h = harness();
  h.deps.write = async () => h.stale();
  await h.start().done;
  assert.equal(count(h, 'speak'), 0);
  assert.equal(h.observers(), 0);
});

test('Home hook/card integration keeps visible canonical text, actor-scoped V10 and existing navigation', () => {
  const source = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');
  const home = source('components/home/HomeLuxuryTechV1.tsx');
  const card = source('components/home/HomeStylistCard.tsx');
  const hook = source('hooks/useHomeEliseWelcome.ts');
  assert.match(home, /welcomeText=\{welcome.text\}/);
  assert.match(home, /welcomeBinding=\{welcome.binding\}/);
  assert.match(home, /entitlement: packingKPlusState/);
  assert.match(card, /mouthState=\{visual.mouthState\}/);
  assert.match(card, /motion=\{visual.motion\}/);
  assert.match(card, /messageId: welcomeBinding\?\.messageId/);
  assert.match(hook, /getGreetingTextForUser\(user, identity\)/);
  assert.match(hook, /isActorScopeCurrent\(scope\)/);
  assert.match(hook, /entitlement === 'active'/);
  assert.match(hook, /!screenReader/);
  assert.match(hook, /!remoteFetchFailed/);
  assert.doesNotMatch(hook, /router\.|navigate\(|setTimeout|setInterval/);
});
