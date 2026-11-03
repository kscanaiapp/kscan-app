// Gemini consent denial reaches the user as a consent state, not as a generic,
// network, account or attachment failure. Each REAL client module is evaluated
// with only its Supabase transport mocked; the denial body is the exact shape
// the gated Edge Functions return (supabase/functions/_shared/geminiConsent.ts).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const CODE = 'AI_PROCESSING_CONSENT_REQUIRED';
const DENIAL = { error: 'AI processing consent required.', errorCode: CODE };

/** Transpiles a repository module; unmapped imports resolve to empty stubs. */
function loadTsModule(relativePath, requireMap = {}) {
  const output = ts.transpileModule(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const sandbox = {
    module: { exports: {} },
    require: (spec) => {
      if (spec in requireMap) return requireMap[spec];
      if (/(^|\/)geminiConsentDenial$/.test(spec)) return loadTsModule('services/geminiConsentDenial.ts');
      return {};
    },
    __DEV__: false,
    console: { warn() {}, log() {}, error() {} },
    setTimeout, clearTimeout, AbortController, JSON, Array, Object, String, Boolean, Number, Promise, Date, Math,
    Error, isNaN, Set, Map, RegExp, Symbol,
  };
  sandbox.exports = sandbox.module.exports;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(output, sandbox, { filename: relativePath });
  return sandbox.module.exports;
}

/** The supabase-js FunctionsHttpError shape: the unconsumed Response on `.context`. */
function httpError(status, body) {
  return { name: 'FunctionsHttpError', message: 'Edge Function returned a non-2xx status code',
    context: new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }) };
}
const invoking = (error) => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' }, access_token: 't' } } }) },
    functions: { invoke: async () => ({ data: null, error }) },
  },
});

const consent = loadTsModule('services/geminiConsentDenial.ts');

test('the client code is the one the backend consent gate emits with HTTP 403', () => {
  const gate = fs.readFileSync(path.join(ROOT, 'supabase/functions/_shared/geminiConsent.ts'), 'utf8');
  assert.match(gate, new RegExp(`errorCode: '${consent.GEMINI_CONSENT_REQUIRED_CODE}' \\}, 403\\)`));
  assert.equal(consent.isGeminiConsentDenial(403, DENIAL), true);
  assert.equal(consent.isGeminiConsentDenial(503, { errorCode: 'AI_PROCESSING_CONSENT_UNAVAILABLE' }), false);
  assert.equal(consent.isGeminiConsentDenial(403, { error: { code: CODE } }), false);
  assert.equal(consent.isGeminiConsentDenial(400, DENIAL), false);
});

function loadScanner(error) {
  return loadTsModule('services/scanIdentification.ts', {
    './supabaseClient': invoking(error),
    '../constants/build': { SCAN_DIAGNOSTICS_ENABLED: false },
  });
}

test('Scanner: consent denial shows the consent state and carries the code, not "account unavailable"', async () => {
  const out = await loadScanner(httpError(403, DENIAL)).identifyScanImage('data:image/jpeg;base64,QUJD', { source: 'camera' });
  assert.equal(out.status, 'failed');
  assert.equal(out.userMessage, consent.GEMINI_CONSENT_REQUIRED_MESSAGE);
  assert.equal(out.contractErrorCode, CODE);
  assert.equal(out.httpStatus, 403);
});

test('Scanner: any other 403 keeps its existing account copy', async () => {
  const out = await loadScanner(httpError(403, { error: 'Account unavailable.', errorCode: 'ACCOUNT_PENDING_DELETION' }))
    .identifyScanImage('data:image/jpeg;base64,QUJD', { source: 'camera' });
  assert.match(out.userMessage, /account can't use scanning/i);
  assert.equal(out.contractErrorCode, undefined);
});

function loadTextScan(error) {
  return loadTsModule('services/textScanEdge.ts', {
    './supabaseClient': invoking(error),
    './textScan': { validateTextScanQuery: () => ({ valid: true }) },
  });
}

test('TextScan: consent denial is not reported as a bad fashion query', async () => {
  const mod = loadTextScan(httpError(403, DENIAL));
  const fn = Object.values(mod).find((v) => typeof v === 'function' && /analy|scan/i.test(v.name));
  await assert.rejects(fn('black leather ankle boots'), (err) => {
    assert.equal(err.message, 'TEXTSCAN_CONSENT_REQUIRED');
    assert.equal(err.userMessage, consent.GEMINI_CONSENT_REQUIRED_MESSAGE);
    return true;
  });
});

test('TextScan: an ordinary failure keeps the existing copy', async () => {
  const mod = loadTextScan(httpError(500, { error: 'x' }));
  const fn = Object.values(mod).find((v) => typeof v === 'function' && /analy|scan/i.test(v.name));
  await assert.rejects(fn('black leather ankle boots'), (err) => err.message === 'TEXTSCAN_ANALYSIS_FAILED');
});

function loadPacking(error) {
  return loadTsModule('services/packing/packingClient.ts', {
    '../supabaseClient': invoking(error),
    '../../types/packing': { PACKING_REQUEST_SCHEMA_VERSION: 'v1' },
    './packingResponse': { parsePackingResponse: (d) => d },
  });
}
const trip = { sessionId: 's1', trip: { destination: 'Paris', startDate: '2026-12-01', endDate: '2026-12-04',
  tripType: 'leisure', activities: [], note: '' } };

test('Packing: consent denial is final and names the setting, not the connection', async () => {
  const out = await loadPacking(httpError(403, DENIAL)).requestPackingPlan(trip);
  assert.equal(out.status, 'error');
  assert.equal(out.errorCode, CODE);
  assert.equal(out.retryable, false);
  assert.equal(out.message, consent.GEMINI_CONSENT_REQUIRED_MESSAGE);
});

test('Packing: a transport error keeps the existing retryable copy', async () => {
  const out = await loadPacking(httpError(502, {})).requestPackingPlan(trip);
  assert.equal(out.errorCode, 'PACKING_TRANSPORT_ERROR');
  assert.equal(out.retryable, true);
});

function loadElise(error) {
  return loadTsModule('services/style-chat/providers/edgeStyleChatProvider.ts', {
    '../../supabaseClient': invoking(error),
    '../../../constants/featureFlags': { ELISE_ADVICE_METADATA_CLIENT_V1: false },
    '../../../constants/styleChat': {
      STYLE_CHAT_COPY: { errorGeneric: 'GENERIC', burstLimitNotice: 'b', systemLimitNotice: 's' },
      STYLE_CHAT_DAILY_MESSAGE_LIMIT: 20,
    },
    '../styleChatErrors': { getFriendlyStyleChatError: () => 'FRIENDLY' },
    '../../../types/styleChatAttachments': { STYLECHAT_ATTACHMENT_CONTRACT_VERSION: '2' },
    '../../../types/fashionIdentificationV2': { ELISE_FASHION_CONTEXT_V2: '2' },
    '../eliseFashionContextV2': { prepareContextForTransport: (v) => v },
  });
}

test('Elise: consent denial becomes the retryable-error banner with the consent copy', async () => {
  const provider = loadElise(httpError(403, DENIAL));
  const result = await new provider.EdgeStyleChatProvider(1000).generateReply({ sessionId: 's1', message: 'what should I wear' });
  assert.equal(result.status, 'error');
  assert.equal(result.errorCode, CODE);
  assert.equal(result.message.content, consent.GEMINI_CONSENT_REQUIRED_MESSAGE);
});

test('Elise: with attachments the denial is not misreported as an attachment rejection', async () => {
  const provider = loadElise(httpError(403, DENIAL));
  const result = await new provider.EdgeStyleChatProvider(1000).generateReply({
    sessionId: 's1', message: 'does this work?',
    attachments: [{ kind: 'scan', id: 'scan-1' }],
  });
  assert.equal(result.status, 'error');
  assert.equal(result.errorCode, CODE);
});

test('Elise: an unrelated attachment 403 keeps the attachment-rejected outcome', async () => {
  const provider = loadElise(httpError(403, { errorCode: 'ATTACHMENT_NOT_OWNED' }));
  const result = await new provider.EdgeStyleChatProvider(1000).generateReply({
    sessionId: 's1', message: 'does this work?',
    attachments: [{ kind: 'scan', id: 'scan-1' }],
  });
  assert.equal(result.status, 'attachments_rejected');
});
