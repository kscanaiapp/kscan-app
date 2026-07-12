const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

test('app_config grants mobile roles table read access before RLS filtering', () => {
  const migration = fs.readFileSync(
    path.join(ROOT, 'supabase/migrations/20260714000002_app_config_read_grants.sql'),
    'utf8',
  );

  assert.match(
    migration,
    /grant\s+select\s+on\s+table\s+public\.app_config\s+to\s+anon\s*,\s*authenticated\s*;/i,
  );
});

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
    process: { env: {} },
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      throw new Error(`Unexpected require: ${id}`);
    },
  };

  vm.runInNewContext(output, sandbox, { filename });
  return module.exports;
}

function loadFeatureFreezeService({ cachedValue = null, remoteResult }) {
  const constants = loadTsModule('constants/featureFlags.ts');
  const storage = {
    value: cachedValue,
    async getItem() {
      return this.value;
    },
    async setItem(_key, value) {
      this.value = value;
    },
  };
  const supabase = {
    from() {
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        maybeSingle() {
          return Promise.resolve(remoteResult);
        },
      };
    },
  };

  const service = loadTsModule('services/featureFreeze.ts', {
    '@react-native-async-storage/async-storage': { __esModule: true, default: storage },
    '../constants/featureFlags': constants,
    './supabaseClient': { supabase },
  });

  return { constants, service, storage };
}

test('featureFreeze false enables core and non-core features', () => {
  const { service } = loadFeatureFreezeService({
    remoteResult: { data: { value: { schemaVersion: 1, featureFreeze: false } }, error: null },
  });

  assert.equal(service.isFeatureEnabledForFreeze('scan', false), true);
  assert.equal(service.isFeatureEnabledForFreeze('dressingRooms', false), true);
});

test('featureFreeze true keeps core features enabled and disables non-core features', () => {
  const { service } = loadFeatureFreezeService({
    remoteResult: { data: { value: { schemaVersion: 1, featureFreeze: true } }, error: null },
  });

  assert.equal(service.isFeatureEnabledForFreeze('scan', true), true);
  assert.equal(service.isFeatureEnabledForFreeze('privacy', true), true);
  assert.equal(service.isFeatureEnabledForFreeze('dressingRooms', true), false);
  assert.equal(service.isFeatureEnabledForFreeze('priceDiscovery', true), false);
});

test('invalid remote payload falls back safely', () => {
  const { service } = loadFeatureFreezeService({
    remoteResult: { data: { value: { schemaVersion: 2, featureFreeze: true } }, error: null },
  });

  const config = service.normalizeFeatureFreezeConfig({ schemaVersion: 2, featureFreeze: true });
  assert.equal(config.featureFreeze, false);
  assert.equal(config.schemaVersion, 1);
});

test('minimal beta payload without schemaVersion can enable freeze', () => {
  const { service } = loadFeatureFreezeService({
    remoteResult: { data: { value: { featureFreeze: true } }, error: null },
  });

  const config = service.normalizeFeatureFreezeConfig({ featureFreeze: true });
  assert.equal(config.featureFreeze, true);
  assert.equal(config.schemaVersion, 1);
});

test('remote failure with no cache defaults to not frozen', async () => {
  const { service } = loadFeatureFreezeService({
    remoteResult: { data: null, error: new Error('network unavailable') },
  });

  const result = await service.loadFeatureFreezeConfig();
  assert.equal(result.source, 'default');
  assert.equal(result.config.featureFreeze, false);
});

test('remote failure with valid cache uses cache', async () => {
  const cached = JSON.stringify({
    schemaVersion: 1,
    featureFreeze: true,
    freezeMessage: 'Cached freeze',
    updatedAt: '2026-05-23T00:00:00Z',
  });
  const { service } = loadFeatureFreezeService({
    cachedValue: cached,
    remoteResult: { data: null, error: new Error('network unavailable') },
  });

  const result = await service.loadFeatureFreezeConfig();
  assert.equal(result.source, 'cache');
  assert.equal(result.config.featureFreeze, true);
  assert.equal(result.config.freezeMessage, 'Cached freeze');
});
