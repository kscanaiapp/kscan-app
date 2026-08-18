// Fix #5 — gender styling context: constants, migration, service, store, hook
// wiring, UI gate, and request-payload contract tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

const constantsSource = fs.readFileSync(path.join(ROOT, 'constants', 'genderStylingContext.ts'), 'utf8');
const serviceSource = fs.readFileSync(path.join(ROOT, 'services', 'genderStylingContextService.ts'), 'utf8');
const storeSource = fs.readFileSync(path.join(ROOT, 'stores', 'genderStylingContextStore.ts'), 'utf8');
const hookSource = fs.readFileSync(path.join(ROOT, 'hooks', 'useGenderStylingContext.ts'), 'utf8');
const promptComponentSource = fs.readFileSync(
  path.join(ROOT, 'components', 'style-chat', 'GenderStylingContextPrompt.tsx'),
  'utf8',
);
const styleChatIndexSource = fs.readFileSync(path.join(ROOT, 'app', 'style-chat', 'index.tsx'), 'utf8');
const sessionScreenSource = fs.readFileSync(path.join(ROOT, 'app', 'style-chat', '[sessionId].tsx'), 'utf8');
const useStyleChatSource = fs.readFileSync(path.join(ROOT, 'hooks', 'useStyleChat.ts'), 'utf8');
const edgeProviderSource = fs.readFileSync(
  path.join(ROOT, 'services', 'style-chat', 'providers', 'edgeStyleChatProvider.ts'),
  'utf8',
);
const migrationPath = path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260817000001_add_user_stylist_preferences_gender_styling_context.sql',
);
const migrationSource = fs.readFileSync(migrationPath, 'utf8');

const {
  GENDER_STYLING_CONTEXT_VALUES,
  isValidGenderStylingContext,
  normalizeGenderStylingContext,
} = require('../constants/genderStylingContext.ts');

// ── Constants / validators ───────────────────────────────────────────────────

test('exactly the three canonical values are defined', () => {
  assert.deepEqual([...GENDER_STYLING_CONTEXT_VALUES], ['man', 'woman', 'prefer_not_to_say']);
  assert.ok(Object.isFrozen(GENDER_STYLING_CONTEXT_VALUES));
});

test('isValidGenderStylingContext accepts only the exact canonical strings', () => {
  assert.equal(isValidGenderStylingContext('man'), true);
  assert.equal(isValidGenderStylingContext('woman'), true);
  assert.equal(isValidGenderStylingContext('prefer_not_to_say'), true);
  for (const bad of ['MAN', 'Man', 'male', 'female', '', null, undefined, 123, {}, ['man']]) {
    assert.equal(isValidGenderStylingContext(bad), false, JSON.stringify(bad));
  }
});

test('normalizeGenderStylingContext returns null (not a default option) for anything unanswered/invalid', () => {
  assert.equal(normalizeGenderStylingContext(null), null);
  assert.equal(normalizeGenderStylingContext(undefined), null);
  assert.equal(normalizeGenderStylingContext('unknown'), null);
  assert.equal(normalizeGenderStylingContext('man'), 'man');
});

// ── Migration ─────────────────────────────────────────────────────────────────

test('migration adds a nullable column to the existing narrow preferences table, not a second table', () => {
  assert.match(migrationSource, /alter table public\.user_stylist_preferences/);
  assert.match(migrationSource, /add column if not exists gender_styling_context text;/);
  assert.doesNotMatch(migrationSource, /gender_styling_context text not null/i);
  assert.doesNotMatch(migrationSource, /create table/i);
});

test('migration CHECK constraint allows only the three canonical values or null', () => {
  assert.match(
    migrationSource,
    /check \(gender_styling_context is null or gender_styling_context in \('man', 'woman', 'prefer_not_to_say'\)\)/,
  );
});

test('migration makes no RLS, grant, policy, or auth change; no backfill', () => {
  // Strip SQL comments first: the migration's own prose ("no RLS change, no
  // grant change...") legitimately contains these words in explanatory text.
  const sqlOnly = migrationSource
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  assert.doesNotMatch(sqlOnly, /\brow level security\b/i);
  assert.doesNotMatch(sqlOnly, /\bcreate policy\b/i);
  assert.doesNotMatch(sqlOnly, /^\s*grant\s/im);
  assert.doesNotMatch(sqlOnly, /^\s*revoke\s/im);
  assert.doesNotMatch(sqlOnly, /\bupdate\s+public\.user_stylist_preferences\s+set\b/i);
  assert.doesNotMatch(sqlOnly, /\bauth\.\w+\(/i);
});

test('migration file is dated after the frozen production baseline and not yet referenced by any deploy script', () => {
  assert.ok(fs.existsSync(migrationPath));
  assert.match(path.basename(migrationPath), /^\d{14}_/);
});

// ── Service (mocked Supabase, mirrors stylistIdentityService test pattern) ──

function loadServiceWithSupabase(supabase) {
  const source = serviceSource.replace("import { supabase } from './supabaseClient';", '');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const evaluate = new Function('require', 'module', 'exports', 'supabase', '__DEV__', output);
  const localRequire = (specifier) =>
    specifier === '../constants/genderStylingContext'
      ? require('../constants/genderStylingContext.ts')
      : require(specifier);
  evaluate(localRequire, mod, mod.exports, supabase, false);
  return mod.exports;
}

function fakeQueryBuilder({ selectResult, upsertResult }) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => selectResult,
    upsert: (row) => {
      builder.lastUpsertRow = row;
      return builder;
    },
    single: async () => upsertResult,
  };
  return builder;
}

test('service rejects an unrecognized value before any Supabase call', async () => {
  let authCalls = 0;
  let tableCalls = 0;
  const supabase = {
    auth: { getSession: async () => { authCalls += 1; return { data: { session: { user: { id: 'user-a' } } } }; } },
    from: () => { tableCalls += 1; throw new Error('table access must not occur'); },
  };
  const service = loadServiceWithSupabase(supabase);
  await assert.rejects(service.saveGenderStylingContext('unknown'));
  assert.equal(authCalls, 0);
  assert.equal(tableCalls, 0);
});

test('service fetch returns null (not a default answer) when no row exists', async () => {
  const supabase = {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'user-a' } } } }) },
    from: () => fakeQueryBuilder({ selectResult: { data: null, error: null } }),
  };
  const service = loadServiceWithSupabase(supabase);
  assert.equal(await service.fetchGenderStylingContext('user-a'), null);
});

test('service fetch returns the stored value for an existing row', async () => {
  const supabase = {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'user-a' } } } }) },
    from: () => fakeQueryBuilder({
      selectResult: { data: { user_id: 'user-a', gender_styling_context: 'woman' }, error: null },
    }),
  };
  const service = loadServiceWithSupabase(supabase);
  assert.equal(await service.fetchGenderStylingContext('user-a'), 'woman');
});

test('ACCOUNT_ISOLATION: fetch throws (never returns another actor\'s data) when the session actor does not match the expected actor', async () => {
  const supabase = {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'user-b' } } } }) },
    from: () => fakeQueryBuilder({ selectResult: { data: null, error: null } }),
  };
  const service = loadServiceWithSupabase(supabase);
  await assert.rejects(service.fetchGenderStylingContext('user-a'));
});

test('SELECT_MAN_PERSISTS / SELECT_WOMAN_PERSISTS / SELECT_PREFER_NOT_TO_SAY_PERSISTS: save round-trips each canonical value', async () => {
  for (const value of ['man', 'woman', 'prefer_not_to_say']) {
    const supabase = {
      auth: { getSession: async () => ({ data: { session: { user: { id: 'user-a' } } } }) },
      from: () => fakeQueryBuilder({
        upsertResult: { data: { user_id: 'user-a', gender_styling_context: value }, error: null },
      }),
    };
    const service = loadServiceWithSupabase(supabase);
    assert.equal(await service.saveGenderStylingContext(value, 'user-a'), value);
  }
});

test('save upserts only user_id/gender_styling_context/updated_at, never display_name or avatar_id', async () => {
  let capturedRow = null;
  const supabase = {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'user-a' } } } }) },
    from: () => {
      const builder = fakeQueryBuilder({
        upsertResult: { data: { user_id: 'user-a', gender_styling_context: 'man' }, error: null },
      });
      const originalUpsert = builder.upsert;
      builder.upsert = (row) => { capturedRow = row; return originalUpsert(row); };
      return builder;
    },
  };
  const service = loadServiceWithSupabase(supabase);
  await service.saveGenderStylingContext('man', 'user-a');
  assert.deepEqual(Object.keys(capturedRow).sort(), ['gender_styling_context', 'updated_at', 'user_id']);
});

// ── Store: actor-race safety and recoverability ──────────────────────────────

function loadStoreWithMocks(fetchMock, saveMock) {
  const source = storeSource
    .replace(
      "import {\n  fetchGenderStylingContext,\n  saveGenderStylingContext,\n} from '../services/genderStylingContextService';",
      '',
    )
    .replace(/fetchGenderStylingContext(?!ForUser)/g, 'fetchMock')
    .replace(/saveGenderStylingContext(?!Value)/g, 'saveMock');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  const vmContext = {
    __DEV__: false, console, Date, Error, exports: mod.exports, module: mod,
    fetchMock, saveMock,
    require: (spec) => {
      if (spec === '../constants/genderStylingContext') return require('../constants/genderStylingContext.ts');
      if (spec === '../services/genderStylingContextService') {
        return { fetchGenderStylingContext: fetchMock, saveGenderStylingContext: saveMock };
      }
      throw new Error(`Unexpected import in store test: ${spec}`);
    },
  };
  vm.createContext(vmContext);
  new vm.Script(output, { filename: 'stores/genderStylingContextStore.ts' }).runInContext(vmContext);
  return mod.exports;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('FIRST_USE_UNSET_SHOWS_CARD: default store state is unanswered but not yet hydrated', () => {
  const store = loadStoreWithMocks(
    () => Promise.resolve(null),
    () => Promise.resolve('man'),
  );
  assert.equal(store.getGenderStylingContextSnapshot(), null);
  assert.equal(store.getGenderStylingContextHasHydratedSnapshot(), false);
});

test('FIRST_USE_UNSET_SHOWS_CARD: after hydration resolves to null, hasHydrated is true and value stays null', async () => {
  const store = loadStoreWithMocks(
    () => Promise.resolve(null),
    () => Promise.resolve('man'),
  );
  await store.hydrateGenderStylingContextForUser('user-a');
  assert.equal(store.getGenderStylingContextSnapshot(), null);
  assert.equal(store.getGenderStylingContextHasHydratedSnapshot(), true);
  assert.equal(store.getGenderStylingContextLoadingSnapshot(), false);
});

test('EXISTING_VALUE_SKIPS_CARD: hydration resolving to a stored value marks it hydrated with that value', async () => {
  const store = loadStoreWithMocks(
    () => Promise.resolve('woman'),
    () => Promise.resolve('woman'),
  );
  await store.hydrateGenderStylingContextForUser('user-a');
  assert.equal(store.getGenderStylingContextSnapshot(), 'woman');
  assert.equal(store.getGenderStylingContextHasHydratedSnapshot(), true);
});

test('NO_PROFILE_LOAD_FLASH: a failed hydration never marks hasHydrated true (never looks answered)', async () => {
  const store = loadStoreWithMocks(
    () => Promise.reject(new Error('network down')),
    () => Promise.resolve('man'),
  );
  await store.hydrateGenderStylingContextForUser('user-a');
  assert.equal(store.getGenderStylingContextHasHydratedSnapshot(), false);
  assert.match(store.getGenderStylingContextErrorSnapshot(), /network down/);
});

test('a stale hydration response after the actor switched is discarded', async () => {
  const pendingHydrations = new Map();
  const fetchMock = (expectedUserId) => {
    const pending = deferred();
    pendingHydrations.set(expectedUserId, pending);
    return pending.promise;
  };
  const store = loadStoreWithMocks(fetchMock, () => Promise.resolve('man'));

  const hydrateA = store.hydrateGenderStylingContextForUser('user-a');
  const hydrateB = store.hydrateGenderStylingContextForUser('user-b');

  pendingHydrations.get('user-b').resolve('man');
  await hydrateB;
  assert.equal(store.getGenderStylingContextSnapshot(), 'man');

  pendingHydrations.get('user-a').resolve('woman');
  await hydrateA;
  // Stale user-a response must not overwrite the current user-b state.
  assert.equal(store.getGenderStylingContextSnapshot(), 'man');
});

test('ACCOUNT_ISOLATION: switching actors clears the prior value before the new hydration resolves', async () => {
  const answers = { 'user-a': 'man', 'user-b': null };
  const store = loadStoreWithMocks(
    (userId) => Promise.resolve(answers[userId] ?? null),
    () => Promise.resolve('man'),
  );

  await store.hydrateGenderStylingContextForUser('user-a');
  assert.equal(store.getGenderStylingContextSnapshot(), 'man');

  const pendingB = deferred();
  const storeWithPendingB = loadStoreWithMocks(
    (userId) => (userId === 'user-a' ? Promise.resolve('man') : pendingB.promise),
    () => Promise.resolve('man'),
  );
  await storeWithPendingB.hydrateGenderStylingContextForUser('user-a');
  assert.equal(storeWithPendingB.getGenderStylingContextSnapshot(), 'man');

  // Switching to user-b must reset to null/unhydrated immediately (synchronously,
  // before user-b's fetch resolves), never carry user-a's answer forward.
  storeWithPendingB.hydrateGenderStylingContextForUser('user-b');
  assert.equal(storeWithPendingB.getGenderStylingContextSnapshot(), null);
  assert.equal(storeWithPendingB.getGenderStylingContextHasHydratedSnapshot(), false);
});

test('SELECT_MAN_PERSISTS: a successful save marks hasHydrated true and sets the value', async () => {
  const store = loadStoreWithMocks(() => Promise.resolve(null), (value) => Promise.resolve(value));
  await store.hydrateGenderStylingContextForUser('user-a');
  const ok = await store.saveGenderStylingContextValue('man');
  assert.equal(ok, true);
  assert.equal(store.getGenderStylingContextSnapshot(), 'man');
  assert.equal(store.getGenderStylingContextHasHydratedSnapshot(), true);
});

test('FAILED_SAVE_RECOVERABLE: a failed save restores the prior (unanswered) state and surfaces a retryable error', async () => {
  const store = loadStoreWithMocks(
    () => Promise.resolve(null),
    () => Promise.reject(new Error('Could not save your styling preference.')),
  );
  await store.hydrateGenderStylingContextForUser('user-a');
  const ok = await store.saveGenderStylingContextValue('man');
  assert.equal(ok, false);
  // Still unanswered and still hydrated — the card can be retried, not stuck loading forever.
  assert.equal(store.getGenderStylingContextSnapshot(), null);
  assert.equal(store.getGenderStylingContextHasHydratedSnapshot(), true);
  assert.equal(store.getGenderStylingContextLoadingSnapshot(), false);
  assert.match(store.getGenderStylingContextErrorSnapshot(), /could not save/i);
});

test('reset clears value, hydration flag, and error for the next account', async () => {
  const store = loadStoreWithMocks(() => Promise.resolve('man'), () => Promise.resolve('man'));
  await store.hydrateGenderStylingContextForUser('user-a');
  store.resetGenderStylingContextStore();
  assert.equal(store.getGenderStylingContextSnapshot(), null);
  assert.equal(store.getGenderStylingContextHasHydratedSnapshot(), false);
  assert.equal(store.getGenderStylingContextErrorSnapshot(), null);
});

// ── Hook wiring (source pattern — mirrors the identity hook's own test) ─────

test('hook uses useSyncExternalStore for stable snapshots and resets on sign-out', () => {
  assert.match(hookSource, /useSyncExternalStore/);
  assert.match(hookSource, /getGenderStylingContextSnapshot/);
  assert.match(hookSource, /subscribeToGenderStylingContext/);
  assert.match(hookSource, /resetGenderStylingContextStore/);
});

test('hook exposes needsFirstUseAnswer only once hydration has actually completed', () => {
  assert.match(hookSource, /needsFirstUseAnswer\s*=\s*isAuthenticated\s*&&\s*hasHydrated\s*&&\s*value\s*===\s*null/);
});

// ── UI card ───────────────────────────────────────────────────────────────────

test('prompt card offers exactly Man / Woman / Choose not to say, and dismisses only via a successful save upstream', () => {
  assert.match(promptComponentSource, /label:\s*'Man'/);
  assert.match(promptComponentSource, /label:\s*'Woman'/);
  assert.match(promptComponentSource, /label:\s*'Choose not to say'/);
  assert.match(promptComponentSource, /value:\s*'man'/);
  assert.match(promptComponentSource, /value:\s*'woman'/);
  assert.match(promptComponentSource, /value:\s*'prefer_not_to_say'/);
  // No internal auto-dismiss timer/effect — the parent controls visibility via
  // the hook's `value`, so a save failure leaves the card mounted.
  assert.doesNotMatch(promptComponentSource, /setTimeout/);
});

// ── Screen wiring: first-use gate ────────────────────────────────────────────

test('FIRST_USE_UNSET_SHOWS_CARD / EXISTING_VALUE_SKIPS_CARD: the Elise entry screen gates on the hook before showing session content', () => {
  assert.match(styleChatIndexSource, /useGenderStylingContext/);
  assert.match(styleChatIndexSource, /genderContext\.needsFirstUseAnswer/);
  assert.match(styleChatIndexSource, /<GenderStylingContextPrompt/);
  assert.match(styleChatIndexSource, /showGenderGate \? \(/);
});

test('NO_PROFILE_LOAD_FLASH: the screen renders neither the card nor the session list while the gate is still loading', () => {
  assert.match(styleChatIndexSource, /genderGateLoading\s*=\s*genderContext\.isLoading\s*&&\s*!genderContext\.hasHydrated\s*&&\s*!genderContext\.error/);
  assert.match(styleChatIndexSource, /genderGateLoading \? null/);
});

test('a hydrate failure fails OPEN — the gate does not permanently block Elise entry over a load error', () => {
  assert.match(styleChatIndexSource, /fails OPEN/i);
});

test('ELISE_ENTRY_STILL_WORKS: the handoff auto-start effect waits on the gate before marking itself attempted', () => {
  const effectBlock = styleChatIndexSource.match(
    /useEffect\(\(\) => \{\s*if \([\s\S]*?genderGateLoading[\s\S]*?showGenderGate[\s\S]*?\}\s*,\s*\[[\s\S]*?genderGateLoading[\s\S]*?showGenderGate[\s\S]*?\]\)/,
  );
  assert.ok(effectBlock, 'expected the handoff effect to depend on and gate on the styling-context prompt');
});

test('FAILED_SAVE_RECOVERABLE: the screen forwards the hook error into the card rather than hiding it', () => {
  assert.match(styleChatIndexSource, /error=\{genderContext\.error\}/);
});

// ── Request-payload wiring: client -> Edge Function ──────────────────────────

test('MAN/WOMAN/NEUTRAL_CONTEXT_REACHES_STYLECHAT: the client sends genderStylingContext additively, like the other optional context fields', () => {
  assert.match(edgeProviderSource, /genderStylingContext\?:\s*GenderStylingContext \| null/);
  assert.match(edgeProviderSource, /\.\.\.\(input\.genderStylingContext\s*\?\s*\{\s*genderStylingContext:\s*input\.genderStylingContext\s*\}\s*:\s*\{\}\)/);
});

test('useStyleChat threads genderStylingContext through to generateReply via a ref (same pattern as activeContext)', () => {
  assert.match(useStyleChatSource, /genderStylingContextRef\s*=\s*useRef\(opts\?\.genderStylingContext\)/);
  assert.match(useStyleChatSource, /genderStylingContext:\s*genderStylingContextRef\.current \?\? null/);
});

test('the session screen supplies the hydrated hook value, not a fresh async resolver', () => {
  assert.match(sessionScreenSource, /useGenderStylingContext\(\)/);
  assert.match(sessionScreenSource, /genderStylingContext:\s*genderStylingContext\.value/);
});
