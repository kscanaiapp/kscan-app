// ELISE-NC-005 — Elise sends no account identity or auth metadata with a turn.
//
// Section 19: the request that carries a user's message must not also carry an
// email, phone, Supabase user id, auth token, device or push id, or precise
// location, merely because those values are convenient to reach. Actor identity
// is derived SERVER-SIDE from the verified JWT (stylechat-generate resolves it
// from auth.getUser()); the body has no business restating it, and a body that
// did would be trusted-looking data the server must then learn to ignore.
//
// The provider is executed against a stand-in Supabase client, so this asserts
// the bytes actually handed to functions.invoke, not the shape of the source.

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
    Date,
    Error,
    Promise,
    Array,
    Object,
    JSON,
    Number,
    String,
    Boolean,
    RegExp,
    Math,
    setTimeout,
    clearTimeout,
    AbortController,
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

const ACTOR_ID = '11111111-1111-1111-1111-111111111111';
const SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCESS_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.super-secret-token';
const EMAIL = 'stylist.customer@example.com';
const PHONE = '+15555550123';
const PUSH_TOKEN = 'ExponentPushToken[abcdefghijklmnopqrstuv]';

/**
 * Every identity / credential value the app holds at send time. None of them is
 * an input to the provider, so any appearance in the body would be a leak the
 * provider introduced on its own.
 */
const FORBIDDEN_VALUES = [ACTOR_ID, ACCESS_TOKEN, EMAIL, PHONE, PUSH_TOKEN];

const FORBIDDEN_KEY_PATTERN =
  /(^|_|\b)(email|phone|password|token|jwt|apikey|api_key|secret|credential|deviceid|device_id|pushtoken|push_token|userid|user_id|actorid|actor_id|uid)($|_|\b)/i;

function collectKeys(value, keys = []) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectKeys(entry, keys));
    return keys;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

function loadProvider(onInvoke) {
  const supabase = {
    // A live, fully populated session — the values below are reachable, which
    // is exactly why "the provider does not send them" has to be asserted.
    auth: {
      getSession: async () => ({
        data: {
          session: {
            access_token: ACCESS_TOKEN,
            refresh_token: 'refresh-secret',
            user: { id: ACTOR_ID, email: EMAIL, phone: PHONE },
          },
        },
      }),
    },
    functions: {
      invoke: async (name, options) => {
        onInvoke({ name, options });
        return {
          data: {
            status: 'success',
            message: { sender: 'assistant', content: 'Wear the navy blazer.', model: 'g', tokenEstimate: 3 },
            usage: { messagesUsed: 1, messagesLimit: 25 },
          },
          error: null,
        };
      },
    },
  };

  return loadTsModule('services/style-chat/providers/edgeStyleChatProvider.ts', {
    '../../supabaseClient': { __esModule: true, supabase },
    '../../../constants/styleChat': {
      STYLE_CHAT_COPY: {
        errorGeneric: 'Something went wrong.',
        systemLimitNotice: 'Daily limit reached.',
        burstLimitNotice: 'Too fast.',
      },
      STYLE_CHAT_DAILY_MESSAGE_LIMIT: 25,
    },
    '../../../constants/featureFlags': { ELISE_ADVICE_METADATA_CLIENT_V1: true },
    '../styleChatErrors': { getFriendlyStyleChatError: (e) => String(e) },
    '../../../types/styleChatAttachments': { STYLECHAT_ATTACHMENT_CONTRACT_VERSION: '2' },
    '../../../types/fashionIdentificationV2': { ELISE_FASHION_CONTEXT_V2: 'v2' },
    '../eliseFashionContextV2': {
      prepareContextForTransport: (context) => ({ kind: 'ok', context }),
    },
  });
}

async function captureBody(input) {
  let captured = null;
  const { EdgeStyleChatProvider } = loadProvider((call) => {
    captured = call;
  });
  await new EdgeStyleChatProvider().generateReply(input);
  assert.ok(captured, 'the provider must actually call the Edge Function');
  return captured;
}

test('ELISE-NC-005: a plain turn carries only the conversation reference and the message', async () => {
  const { name, options } = await captureBody({
    sessionId: SESSION_ID,
    message: 'What should I wear to a gallery opening?',
  });

  assert.equal(name, 'stylechat-generate');
  assert.deepEqual(
    Object.keys(options.body).sort(),
    ['message', 'sessionId'],
    'a text-only turn must be exactly { sessionId, message }',
  );
});

test('ELISE-NC-005: no identity, credential or device value reaches the request body', async () => {
  const { options } = await captureBody({
    sessionId: SESSION_ID,
    message: 'Style this for me.',
    styleDnaContext: { enabled: true, signals: ['tailored', 'monochrome'] },
    genderStylingContext: 'neutral',
    activeContext: {
      source: 'camera',
      // Fields the server-safe projection must strip.
      imageUri: 'file:///private/var/photo.jpg',
      textScanId: 'text-scan-9',
      createdAt: '2026-09-02T00:00:00.000Z',
      category: 'outerwear',
      visualContext: {
        source: 'camera',
        title: 'Black leather biker jacket',
        summary: null,
        category: 'outerwear',
        colors: ['black'],
        materials: ['leather'],
        silhouette: null,
        styleAttributes: null,
        brand: null,
        confidence: null,
      },
    },
    sourceMessageId: 'user-message-1',
  });

  const serialized = JSON.stringify(options.body);
  for (const value of FORBIDDEN_VALUES) {
    assert.equal(
      serialized.includes(value),
      false,
      `the request body must not carry ${value.slice(0, 12)}…`,
    );
  }

  const offendingKeys = collectKeys(options.body).filter((key) => FORBIDDEN_KEY_PATTERN.test(key));
  assert.deepEqual(offendingKeys, [], 'no identity/credential-shaped field may appear in the body');

  // Local media paths and scan ids are not styling context and must not travel.
  assert.equal(serialized.includes('file:///private/var/photo.jpg'), false);
  assert.equal(serialized.includes('text-scan-9'), false);
});

test('ELISE-NC-005: a weather-aware turn sends only a coarse rounded fix, never a raw fine one', async () => {
  const { options } = await captureBody({
    sessionId: SESSION_ID,
    message: 'Is it jacket weather?',
    weatherLocation: {
      enabled: true,
      source: 'gps_foreground',
      roundedLat: 40.7,
      roundedLon: -74,
    },
  });

  const weather = options.body.weatherLocation;
  assert.ok(weather, 'an opted-in weather turn does send the coarse fix');
  assert.deepEqual(
    Object.keys(weather).sort(),
    ['enabled', 'roundedLat', 'roundedLon', 'source'],
    'only the rounded coordinate pair travels',
  );
  const decimals = (n) => (String(n).split('.')[1] ?? '').length;
  assert.ok(decimals(weather.roundedLat) <= 1, 'latitude must stay coarse');
  assert.ok(decimals(weather.roundedLon) <= 1, 'longitude must stay coarse');
});

test('ELISE-NC-005: weather that the user has not enabled is omitted entirely', async () => {
  const { options } = await captureBody({
    sessionId: SESSION_ID,
    message: 'Is it jacket weather?',
    weatherLocation: {
      enabled: false,
      source: 'gps_foreground',
      roundedLat: 40.7,
      roundedLon: -74,
    },
  });

  assert.equal(
    'weatherLocation' in options.body,
    false,
    'a disabled weather preference must send no location at all',
  );
});
