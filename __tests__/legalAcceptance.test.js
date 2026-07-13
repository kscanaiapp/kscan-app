const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath, requireMap = {}) {
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
    exports: module.exports,
    module,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return module.exports;
}

function createMockClient({ session = null, upsertError = null } = {}) {
  const upsertCalls = [];
  return {
    _upsertCalls: upsertCalls,
    auth: {
      getSession: async () => ({
        data: { session },
        error: session ? null : new Error('No session'),
      }),
    },
    from: (tableName) => ({
      upsert: async (rows, options) => {
        upsertCalls.push({ tableName, rows, options });
        return { error: upsertError };
      },
    }),
  };
}

function loadService(mockClient) {
  return loadTsModule('services/legalAcceptance.ts', {
    './supabaseClient': { supabase: mockClient },
    '../constants/legal': {
      TERMS_VERSION: '1.0',
      PRIVACY_VERSION: '1.0',
      AGE_VERSION: '1.0',
    },
    '../src/utils/errorLogger': { logError: () => {} },
  });
}

function createAcceptanceReadClient(rows, error = null) {
  const calls = [];
  return {
    _calls: calls,
    from: (tableName) => ({
      select: (columns) => ({
        eq: async (column, value) => {
          calls.push({ tableName, columns, column, value });
          return { data: rows, error };
        },
      }),
    }),
  };
}

test('recognizes an existing account only when all current legal versions are present', async () => {
  const client = createAcceptanceReadClient([
    { acceptance_type: 'terms', policy_version: '1.0' },
    { acceptance_type: 'privacy', policy_version: '1.0' },
    { acceptance_type: 'minimum_age', policy_version: '1.0' },
  ]);
  const { hasCurrentLegalAcceptances } = loadService(client);

  assert.equal(await hasCurrentLegalAcceptances('private-user', client), true);
  assert.deepEqual(client._calls[0], {
    tableName: 'legal_acceptances',
    columns: 'acceptance_type, policy_version',
    column: 'user_id',
    value: 'private-user',
  });
});

test('does not skip onboarding for a new or partially accepted OAuth identity', async () => {
  const client = createAcceptanceReadClient([
    { acceptance_type: 'terms', policy_version: '1.0' },
    { acceptance_type: 'privacy', policy_version: '1.0' },
  ]);
  const { hasCurrentLegalAcceptances } = loadService(client);

  assert.equal(await hasCurrentLegalAcceptances('private-user', client), false);
});

// ─── Input validation ───────────────────────────────────────────────────────

test('rejects empty termsVersion', async () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const { recordLegalAcceptances } = loadService(client);
  const result = await recordLegalAcceptances({
    termsVersion: '',
    privacyVersion: '1.0',
    minimumAgeVersion: '1.0',
  }, client);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Unable to save your preferences. Please try again.');
});

test('rejects empty privacyVersion', async () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const { recordLegalAcceptances } = loadService(client);
  const result = await recordLegalAcceptances({
    termsVersion: '1.0',
    privacyVersion: '',
    minimumAgeVersion: '1.0',
  }, client);
  assert.equal(result.ok, false);
});

test('rejects empty minimumAgeVersion', async () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const { recordLegalAcceptances } = loadService(client);
  const result = await recordLegalAcceptances({
    termsVersion: '1.0',
    privacyVersion: '1.0',
    minimumAgeVersion: '',
  }, client);
  assert.equal(result.ok, false);
});

// ─── Auth session ────────────────────────────────────────────────────────────

test('rejects missing authenticated user', async () => {
  const client = createMockClient({ session: null });
  const { recordLegalAcceptances } = loadService(client);
  const result = await recordLegalAcceptances({
    termsVersion: '1.0',
    privacyVersion: '1.0',
    minimumAgeVersion: '1.0',
  }, client);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Unable to save your preferences. Please try again.');
});

// ─── Upsert behavior ────────────────────────────────────────────────────────

test('builds exactly three legal acceptance rows', async () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const { recordLegalAcceptances } = loadService(client);
  await recordLegalAcceptances({
    termsVersion: '1.0',
    privacyVersion: '2.0',
    minimumAgeVersion: '3.0',
  }, client);

  assert.equal(client._upsertCalls.length, 1);
  const call = client._upsertCalls[0];
  assert.equal(call.tableName, 'legal_acceptances');
  assert.equal(call.rows.length, 3);
});

test('uses acceptance_type values: terms, privacy, minimum_age', async () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const { recordLegalAcceptances } = loadService(client);
  await recordLegalAcceptances({
    termsVersion: '1.0',
    privacyVersion: '2.0',
    minimumAgeVersion: '3.0',
  }, client);

  const types = client._upsertCalls[0].rows.map((r) => r.acceptance_type);
  assert.ok(types.includes('terms'));
  assert.ok(types.includes('privacy'));
  assert.ok(types.includes('minimum_age'));
});

test('uses source: mobile', async () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const { recordLegalAcceptances } = loadService(client);
  await recordLegalAcceptances({
    termsVersion: '1.0',
    privacyVersion: '2.0',
    minimumAgeVersion: '3.0',
  }, client);

  const rows = client._upsertCalls[0].rows;
  assert.equal(rows[0].source, 'mobile');
  assert.equal(rows[1].source, 'mobile');
  assert.equal(rows[2].source, 'mobile');
});

test('uses app_version null when unavailable', async () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const { recordLegalAcceptances } = loadService(client);
  await recordLegalAcceptances({
    termsVersion: '1.0',
    privacyVersion: '2.0',
    minimumAgeVersion: '3.0',
  }, client);

  const rows = client._upsertCalls[0].rows;
  assert.equal(rows[0].app_version, null);
  assert.equal(rows[1].app_version, null);
  assert.equal(rows[2].app_version, null);
});

test('uses app_version when provided', async () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const { recordLegalAcceptances } = loadService(client);
  await recordLegalAcceptances({
    termsVersion: '1.0',
    privacyVersion: '2.0',
    minimumAgeVersion: '3.0',
    appVersion: '1.2.3',
  }, client);

  const rows = client._upsertCalls[0].rows;
  assert.equal(rows[0].app_version, '1.2.3');
  assert.equal(rows[1].app_version, '1.2.3');
  assert.equal(rows[2].app_version, '1.2.3');
});

test('uses upsert on user_id,acceptance_type,policy_version', async () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const { recordLegalAcceptances } = loadService(client);
  await recordLegalAcceptances({
    termsVersion: '1.0',
    privacyVersion: '2.0',
    minimumAgeVersion: '3.0',
  }, client);

  const options = client._upsertCalls[0].options;
  assert.equal(options.onConflict, 'user_id,acceptance_type,policy_version');
});

test('uses ignoreDuplicates: true', async () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const { recordLegalAcceptances } = loadService(client);
  await recordLegalAcceptances({
    termsVersion: '1.0',
    privacyVersion: '2.0',
    minimumAgeVersion: '3.0',
  }, client);

  const options = client._upsertCalls[0].options;
  assert.equal(options.ignoreDuplicates, true);
});

test('maps Supabase error to safe app-level error', async () => {
  const client = createMockClient({
    session: { user: { id: 'user-1' } },
    upsertError: new Error('RLS violation'),
  });
  const { recordLegalAcceptances } = loadService(client);
  const result = await recordLegalAcceptances({
    termsVersion: '1.0',
    privacyVersion: '2.0',
    minimumAgeVersion: '3.0',
  }, client);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Unable to save your preferences. Please try again.');
});

test('derives user_id from session user, not from caller', async () => {
  const client = createMockClient({ session: { user: { id: 'user-abc-123' } } });
  const { recordLegalAcceptances } = loadService(client);
  await recordLegalAcceptances({
    termsVersion: '1.0',
    privacyVersion: '2.0',
    minimumAgeVersion: '3.0',
  }, client);

  const rows = client._upsertCalls[0].rows;
  assert.equal(rows[0].user_id, 'user-abc-123');
  assert.equal(rows[1].user_id, 'user-abc-123');
  assert.equal(rows[2].user_id, 'user-abc-123');
});

test('trims policy versions before persisting', async () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const { recordLegalAcceptances } = loadService(client);
  await recordLegalAcceptances({
    termsVersion: '  1.0  ',
    privacyVersion: '  2.0  ',
    minimumAgeVersion: '  3.0  ',
  }, client);

  const rows = client._upsertCalls[0].rows;
  assert.equal(rows[0].policy_version, '1.0');
  assert.equal(rows[1].policy_version, '2.0');
  assert.equal(rows[2].policy_version, '3.0');
});

test('returns ok: true on success', async () => {
  const client = createMockClient({ session: { user: { id: 'user-1' } } });
  const { recordLegalAcceptances } = loadService(client);
  const result = await recordLegalAcceptances({
    termsVersion: '1.0',
    privacyVersion: '2.0',
    minimumAgeVersion: '3.0',
  }, client);
  assert.equal(result.ok, true);
  assert.equal(result.error, undefined);
});
