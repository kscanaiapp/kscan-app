const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const providerSource = fs.readFileSync(
  path.join(ROOT, 'services', 'style-chat', 'providers', 'edgeStyleChatProvider.ts'),
  'utf8',
);
const hookSource = fs.readFileSync(path.join(ROOT, 'hooks', 'useStyleChat.ts'), 'utf8');
const bubbleSource = fs.readFileSync(
  path.join(ROOT, 'components', 'style-chat', 'StyleChatBubble.tsx'),
  'utf8',
);
const edgeFunctionSource = fs.readFileSync(
  path.join(ROOT, 'supabase', 'functions', 'stylechat-generate', 'index.ts'),
  'utf8',
);
const styleChatConstants = require('../constants/styleChat.ts');

function loadTranspiledModule(source, customRequire) {
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const evaluate = new Function('require', 'module', 'exports', output);
  evaluate(customRequire, mod, mod.exports);
  return mod.exports;
}

function loadStyleChatErrors() {
  const source = fs.readFileSync(
    path.join(ROOT, 'services', 'style-chat', 'styleChatErrors.ts'),
    'utf8',
  );
  return loadTranspiledModule(source, (specifier) => {
    if (specifier === '../../constants/styleChat') return styleChatConstants;
    throw new Error(`Unexpected styleChatErrors import: ${specifier}`);
  });
}

function loadStyleChatOutcome() {
  const source = fs.readFileSync(
    path.join(ROOT, 'services', 'style-chat', 'styleChatOutcome.ts'),
    'utf8',
  );
  return loadTranspiledModule(source, (specifier) => {
    if (specifier === '../../constants/styleChat') return styleChatConstants;
    throw new Error(`Unexpected styleChatOutcome import: ${specifier}`);
  });
}

function loadProvider(invoke) {
  const output = ts.transpileModule(providerSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const logs = { info: [], warn: [] };
  const testConsole = {
    ...console,
    info: (...args) => logs.info.push(args),
    warn: (...args) => logs.warn.push(args),
  };
  const customRequire = (specifier) => {
    if (specifier === '../../supabaseClient') return { supabase: { functions: { invoke } } };
    if (specifier === '../../../constants/styleChat') return styleChatConstants;
    if (specifier === '../styleChatErrors') return loadStyleChatErrors();
    if (specifier === '../../../types/styleChatAttachments') {
      return require('../types/styleChatAttachments.ts');
    }
    throw new Error(`Unexpected provider import: ${specifier}`);
  };
  const mod = { exports: {} };
  const evaluate = new Function('require', 'module', 'exports', 'console', '__DEV__', output);
  evaluate(customRequire, mod, mod.exports, testConsole, true);
  return { Provider: mod.exports.EdgeStyleChatProvider, logs };
}

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const PROMPT = 'What color pants go well with white polo shirt';

test('text-only request sends one exact actor-neutral v1 payload and parses success', async () => {
  const calls = [];
  const { Provider, logs } = loadProvider(async (name, options) => {
    calls.push({ name, options });
    return {
      data: {
        status: 'success',
        message: {
          sender: 'assistant',
          content: 'Navy, khaki, gray, or black pants all pair well with a white polo.',
          model: 'test-model',
          tokenEstimate: 18,
        },
        usage: { messagesUsed: 1, messagesLimit: 50 },
      },
      error: null,
    };
  });

  const result = await new Provider().generateReply({ sessionId: SESSION_ID, message: PROMPT });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'stylechat-generate');
  assert.deepEqual(calls[0].options.body, { sessionId: SESSION_ID, message: PROMPT });
  assert.equal('userId' in calls[0].options.body, false);
  assert.equal('attachments' in calls[0].options.body, false);
  assert.equal('avatarId' in calls[0].options.body, false);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(result.status, 'success');
  assert.match(result.message.content, /Navy/);
  assert.equal(logs.warn.length, 0);
});

test('active visual context strips local URI and client-only identity fields before invoke', async () => {
  const calls = [];
  const { Provider } = loadProvider(async (name, options) => {
    calls.push({ name, options });
    return {
      data: {
        status: 'success',
        message: { sender: 'assistant', content: 'Style it with charcoal trousers.', model: 'test', tokenEstimate: 10 },
        usage: { messagesUsed: 1, messagesLimit: 50 },
      },
      error: null,
    };
  });

  await new Provider().generateReply({
    sessionId: SESSION_ID,
    message: PROMPT,
    activeContext: {
      source: 'upload',
      imageUri: 'file:///private/raw-picker.jpg',
      textScanId: 'local-only-id',
      createdAt: '2026-07-15T00:00:00.000Z',
      visualContext: {
        source: 'upload',
        title: 'Purple lace top',
        colors: ['purple'],
      },
    },
  });

  assert.equal(calls.length, 1);
  const activeContext = calls[0].options.body.activeContext;
  assert.equal(activeContext.visualContext.title, 'Purple lace top');
  assert.equal('imageUri' in activeContext, false);
  assert.equal('textScanId' in activeContext, false);
  assert.equal('createdAt' in activeContext, false);
  assert.doesNotMatch(JSON.stringify(calls[0].options.body), /file:\/\/|raw-picker/);
});

test('ordered visual collection sends every safe entry and requires backend acknowledgement', async () => {
  const calls = [];
  const { Provider } = loadProvider(async (name, options) => {
    calls.push({ name, options });
    return {
      data: {
        status: 'success',
        visualCollectionContractVersion: '1',
        message: { sender: 'assistant', content: 'All three references work together.', model: 'test', tokenEstimate: 12 },
        usage: { messagesUsed: 1, messagesLimit: 50 },
      },
      error: null,
    };
  });
  const evidence = [1, 2, 3].map((order) => ({
    id: `e-${order}`,
    order,
    source: order === 1 ? 'scan' : 'upload',
    title: `Item ${order}`,
    colors: [`color-${order}`],
    rawImageUri: `file:///private/${order}.jpg`,
    actorKey: 'user:secret',
  }));
  const result = await new Provider().generateReply({
    sessionId: SESSION_ID,
    message: PROMPT,
    activeContext: {
      source: 'camera',
      visualCollection: { evidence, focusEvidenceId: 'e-2' },
    },
  });
  const sent = calls[0].options.body.activeContext.visualCollection;
  assert.equal(sent.evidence.length, 3);
  assert.deepEqual(sent.evidence.map((entry) => entry.id), ['e-1', 'e-2', 'e-3']);
  assert.equal(sent.focusEvidenceId, 'e-2');
  assert.doesNotMatch(JSON.stringify(sent), /rawImageUri|file:\/\/|actorKey|user:secret/);
  assert.equal(result.status, 'success');
});

test('visual collection success without capability acknowledgement is rejected client-side', async () => {
  const { Provider } = loadProvider(async () => ({
    data: {
      status: 'success',
      message: { sender: 'assistant', content: 'Attachment-blind answer', model: 'old', tokenEstimate: 5 },
      usage: { messagesUsed: 1, messagesLimit: 50 },
    },
    error: null,
  }));
  const result = await new Provider().generateReply({
    sessionId: SESSION_ID,
    message: PROMPT,
    activeContext: {
      source: 'camera',
      visualCollection: {
        evidence: [{ id: 'e-1', order: 1, source: 'scan', title: 'Item 1' }],
      },
    },
  });
  assert.equal(result.status, 'visual_collection_unsupported');
});

test('structured HTTP error is parsed without a development warning', async () => {
  const response = new Response(
    JSON.stringify({
      status: 'error',
      errorCode: 'PROVIDER_TIMEOUT',
      message: { sender: 'assistant', content: 'Elise took too long to respond. Try again in a moment.' },
      usage: { messagesUsed: 1, messagesLimit: 50 },
    }),
    { status: 500, headers: { 'content-type': 'application/json' } },
  );
  const { Provider, logs } = loadProvider(async () => ({
    data: null,
    error: { message: 'Edge Function returned a non-2xx status code', context: response },
  }));

  const result = await new Provider().generateReply({ sessionId: SESSION_ID, message: PROMPT });

  assert.equal(result.status, 'error');
  assert.equal(result.errorCode, 'PROVIDER_TIMEOUT');
  assert.match(result.message.content, /too long/);
  assert.equal(logs.warn.length, 0);
});

test('unstructured local 503 is retryable and does not trigger the warning overlay path', async () => {
  const response = new Response(JSON.stringify({ message: 'Service unavailable' }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });
  const { Provider, logs } = loadProvider(async () => ({
    data: null,
    error: { message: 'Edge Function returned a non-2xx status code', context: response },
  }));

  const result = await new Provider().generateReply({ sessionId: SESSION_ID, message: PROMPT });

  assert.equal(result.status, 'error');
  assert.equal(result.errorCode, 'EDGE_HTTP_503');
  assert.equal(logs.warn.length, 0);
  assert.equal(logs.info.length, 1);
  assert.match(logs.info[0].join(' '), /handled operational failure.*http_503/);
});

test('network failure and timeout remain safe, retryable, and warning-free', async () => {
  const network = loadProvider(async () => {
    throw new Error('Network request failed');
  });
  const networkResult = await new network.Provider().generateReply({
    sessionId: SESSION_ID,
    message: PROMPT,
  });
  assert.equal(networkResult.status, 'error');
  assert.equal(networkResult.errorCode, 'NETWORK_OR_CLIENT_FAILURE');
  assert.match(networkResult.message.content, /Connection lost/);
  assert.equal(network.logs.warn.length, 0);

  const timeout = loadProvider((_name, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
  );
  const timeoutResult = await new timeout.Provider(5).generateReply({
    sessionId: SESSION_ID,
    message: PROMPT,
  });
  assert.equal(timeoutResult.status, 'error');
  assert.equal(timeoutResult.errorCode, 'CLIENT_TIMEOUT');
  assert.match(timeoutResult.message.content, /too long/);
  assert.equal(timeout.logs.warn.length, 0);
});

test('malformed success is not accepted as a real assistant response', async () => {
  const { Provider, logs } = loadProvider(async () => ({ data: { unexpected: true }, error: null }));
  const result = await new Provider().generateReply({ sessionId: SESSION_ID, message: PROMPT });
  assert.equal(result.status, 'error');
  assert.equal(result.errorCode, 'MALFORMED_EDGE_RESPONSE');
  assert.equal(logs.warn.length, 1, 'unexpected programmer/contract errors remain warnings');
});

test('operational failure is classified as non-persistable synthetic content', () => {
  const {
    classifyStyleChatOperationalFailure,
    isSyntheticStyleChatFailure,
  } = loadStyleChatOutcome();
  const failure = classifyStyleChatOperationalFailure({
    status: 'error',
    errorCode: 'EDGE_HTTP_503',
    message: { sender: 'assistant', content: 'Try again.', model: 'fallback', tokenEstimate: 0 },
  });
  assert.deepEqual(failure, {
    kind: 'retryable_error',
    message: 'Try again.',
    errorCode: 'EDGE_HTTP_503',
    persistAssistant: false,
  });
  assert.equal(
    isSyntheticStyleChatFailure({ sender: 'assistant', provider: 'fallback', model: 'fallback' }),
    true,
  );
  assert.equal(
    isSyntheticStyleChatFailure({ sender: 'assistant', provider: 'gemini', model: 'test-model' }),
    false,
  );
});

test('hook retains exact text for one-shot retry and never persists an error result as assistant', () => {
  const failureBranch = hookSource.match(
    /const operationalFailure = classifyStyleChatOperationalFailure\(result\);[\s\S]*?\/\/ 4\. success/,
  )?.[0];
  assert.ok(failureBranch);
  assert.match(failureBranch, /retryStateRef\.current\?\.remember\(\{[\s\S]*?content:\s*trimmed/);
  assert.match(failureBranch, /userMessageId:\s*persistedUserMessageId/);
  assert.match(failureBranch, /setError\(operationalFailure\.message\)/);
  assert.doesNotMatch(failureBranch, /saveStyleChatMessage/);
  assert.match(hookSource, /skipUserPersistence:\s*Boolean\(failedSend\.userMessageId\)/);
  assert.match(hookSource, /const failedSend = retryStateRef\.current\?\.consume\(\)/);
});

test('hook defers persistence for visual collections and preserves unsupported sends', () => {
  assert.match(hookSource, /hasVisualCollection/);
  assert.match(hookSource, /requiresContextAcknowledgement/);
  assert.match(hookSource, /visual_collection_unsupported/);
  assert.match(hookSource, /visual_collection_rejected/);
  assert.match(hookSource, /deferUserPersistence = skipUserPersistence \|\| requiresContextAcknowledgement/);
  const burstBranch = hookSource.match(/if \(result\.status === 'burst_limit'\)[\s\S]*?return false;/)?.[0];
  const limitBranch = hookSource.match(/if \(result\.status === 'limit_reached'\)[\s\S]*?return false;/)?.[0];
  assert.match(burstBranch, /requiresContextAcknowledgement[\s\S]*?optimisticUser/);
  assert.match(limitBranch, /requiresContextAcknowledgement[\s\S]*?optimisticUser/);
});

test('synthetic historical failures have no feedback or report controls', () => {
  assert.match(bubbleSource, /const isSyntheticFailure = isSyntheticStyleChatFailure\(message\)/);
  assert.match(bubbleSource, /!isSyntheticFailure[\s\S]*?isStablePersistedId/);
  assert.match(bubbleSource, /message\.sender === 'assistant' && !isSyntheticFailure/);
});

test('Edge Function derives the actor from JWT and validates the same text schema', () => {
  assert.match(edgeFunctionSource, /const authHeader = req\.headers\.get\('Authorization'\)/);
  assert.match(edgeFunctionSource, /userClient\.auth\.getUser\(\)/);
  assert.match(edgeFunctionSource, /const sessionId = typeof body\.sessionId/);
  assert.match(edgeFunctionSource, /const message\s+= typeof body\.message/);
  assert.doesNotMatch(edgeFunctionSource, /body\.userId|body\.user_id/);
});
