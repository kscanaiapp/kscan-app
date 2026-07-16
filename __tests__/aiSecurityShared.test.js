const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath, overrides = {}) {
  const sourcePath = path.join(ROOT, relativePath);
  const source = fs.readFileSync(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const customRequire = (specifier) => {
    if (overrides[specifier]) return overrides[specifier];
    if (specifier.startsWith('.')) {
      const resolved = path.resolve(path.dirname(sourcePath), specifier.replace(/\.ts$/, ''));
      const candidates = [`${resolved}.ts`, resolved];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate) && candidate.endsWith('.ts')) {
          return loadTsModule(path.relative(ROOT, candidate).replace(/\\/g, '/'), overrides);
        }
      }
    }
    throw new Error(`Unexpected import: ${specifier} from ${relativePath}`);
  };
  const evaluate = new Function('require', 'module', 'exports', output);
  evaluate(customRequire, mod, mod.exports);
  return mod.exports;
}

function loadAiSecurity() {
  return loadTsModule('services/aiSecurity/index.ts');
}

test('services and _shared aiSecurity modules stay byte-synced for Deno', () => {
  const serviceDir = path.join(ROOT, 'services', 'aiSecurity');
  const sharedDir = path.join(ROOT, 'supabase', 'functions', '_shared', 'aiSecurity');
  const serviceFiles = fs.readdirSync(serviceDir).filter((name) => name.endsWith('.ts')).sort();
  const sharedFiles = fs.readdirSync(sharedDir).filter((name) => name.endsWith('.ts')).sort();
  assert.deepEqual(sharedFiles, serviceFiles);
  for (const name of serviceFiles) {
    const service = fs.readFileSync(path.join(serviceDir, name), 'utf8');
    const shared = fs.readFileSync(path.join(sharedDir, name), 'utf8');
    const serviceHash = crypto.createHash('sha256').update(service.replace(/from '\.\/([^']+?)(?<!\.ts)'/g, "from './$1.ts'")).digest('hex');
    const sharedHash = crypto.createHash('sha256').update(shared).digest('hex');
    assert.equal(sharedHash, serviceHash, `${name} drifted between services and _shared`);
  }
});

test('trust classification and envelope sections are deterministic', () => {
  const {
    TRUST_FOR_SECTION,
    assemblePromptEnvelope,
    escapeUntrustedText,
    INJECTION_FIXTURES,
  } = loadAiSecurity();
  assert.equal(TRUST_FOR_SECTION.user_input, 'untrusted_user');
  assert.equal(TRUST_FOR_SECTION.visual_context, 'untrusted_derived');
  assert.equal(TRUST_FOR_SECTION.commerce_context, 'untrusted_external');
  assert.equal(TRUST_FOR_SECTION.kscan_system_rules, 'trusted_system');

  const attack = INJECTION_FIXTURES.find((f) => f.id === 'close-user-input').text;
  const escaped = escapeUntrustedText(attack);
  assert.doesNotMatch(escaped, /<\/user_input>/i);
  assert.doesNotMatch(escaped, /<kscan_system_rules>/i);
  assert.match(escaped, /&lt;|&gt;|user_input|kscan_system_rules/);

  const envelope = assemblePromptEnvelope([
    { name: 'user_input', trust: 'untrusted_user', body: attack },
    { name: 'kscan_system_rules', trust: 'trusted_system', body: 'Keep fashion rules.' },
  ]);
  assert.equal((envelope.text.match(/<kscan_system_rules>/g) || []).length, 1);
  assert.equal((envelope.text.match(/<user_input /g) || []).length, 1);
  assert.match(envelope.text, /trust="untrusted_user"/);
});

test('canonical escaping neutralizes delimiter, role, and tool breakout', () => {
  const { escapeUntrustedText, INJECTION_FIXTURES } = loadAiSecurity();
  for (const fixture of INJECTION_FIXTURES) {
    const escaped = escapeUntrustedText(fixture.text);
    assert.equal(typeof escaped, 'string');
    assert.doesNotMatch(escaped, /<\/user_input>\s*<kscan_system_rules>/i);
    assert.doesNotMatch(escaped, /<\|im_start\|>/);
    assert.ok(!escaped.includes('\u0000'));
  }
  const entities = escapeUntrustedText(`&<>"'`);
  assert.equal(entities, '&amp;&lt;&gt;&quot;&#39;');
});

test('input limits trim, strip secrets, and bound prompt size', () => {
  const { boundTextField, assertTotalPromptBudget, AI_INPUT_LIMITS } = loadAiSecurity();
  const jwt =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.signaturepad';
  const stripped = boundTextField(`hello ${jwt}`, 200, { mode: 'truncate', stripSecrets: true });
  assert.equal(stripped.ok, true);
  assert.match(stripped.value, /\[redacted_token\]/);
  assert.doesNotMatch(stripped.value, /eyJhbGciOi/);

  assert.equal(boundTextField('file:///etc/passwd', 100).ok, false);
  assert.equal(boundTextField('a'.repeat(80), 40, { mode: 'reject' }).ok, false);
  const truncated = boundTextField('a'.repeat(80), 40, { mode: 'truncate' });
  assert.equal(truncated.ok, true);
  assert.equal(truncated.value.length, 40);

  const budget = assertTotalPromptBudget(['x'.repeat(AI_INPUT_LIMITS.totalPromptChars + 1)]);
  assert.equal(budget.ok, false);
});

test('TypeChat output rejects unknown fields, rpc, sql, routes, and unsafe urls', () => {
  const { validateTypeChatModelOutput, isSafeHttpUrl } = loadAiSecurity();
  assert.equal(isSafeHttpUrl('https://example.com/item'), true);
  assert.equal(isSafeHttpUrl('file:///tmp/x'), false);

  const valid = validateTypeChatModelOutput({
    status: 'completed',
    userMessage: 'Navy blazer',
    attributes: { category: 'blazer' },
    identification: { item_type: 'blazer' },
    recommendedProducts: [],
  });
  assert.equal(valid.ok, true);

  assert.equal(validateTypeChatModelOutput({ status: 'completed', rpc: 'delete_user' }).ok, false);
  assert.equal(validateTypeChatModelOutput({ status: 'completed', route: '/admin' }).ok, false);
  assert.equal(
    validateTypeChatModelOutput({
      status: 'completed',
      userMessage: 'Run SQL DROP TABLE users.',
    }).ok,
    false,
  );
  assert.equal(
    validateTypeChatModelOutput({
      status: 'completed',
      extra: true,
    }).ok,
    false,
  );
  assert.equal(
    validateTypeChatModelOutput({
      status: 'completed',
      recommendedProducts: [{ url: 'file:///secret' }],
    }).ok,
    false,
  );
});

test('action authorization fails closed for foreign and placeholder ids', () => {
  const { authorizeModelAction, ALLOWED_ELISE_ACTION_TYPES } = loadAiSecurity();
  const owned = {
    itemKeys: new Set(['saved_scan:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa']),
    lookIds: new Set(['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb']),
  };
  const allow = authorizeModelAction({
    actor: { actorId: 'user-1', authenticated: true },
    actionType: 'style_anchor_item',
    allowedActionTypes: ALLOWED_ELISE_ACTION_TYPES,
    payload: {
      anchor: {
        sourceType: 'saved_scan',
        sourceId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      },
    },
    owned,
  });
  assert.equal(allow.allowed, true);

  const foreign = authorizeModelAction({
    actor: { actorId: 'user-1', authenticated: true },
    actionType: 'style_anchor_item',
    allowedActionTypes: ALLOWED_ELISE_ACTION_TYPES,
    payload: {
      anchor: {
        sourceType: 'saved_scan',
        sourceId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      },
    },
    owned,
  });
  assert.equal(foreign.allowed, false);
  assert.equal(foreign.reason, 'foreign_resource');

  const unknown = authorizeModelAction({
    actor: { actorId: 'user-1', authenticated: true },
    actionType: 'delete_user_account',
    allowedActionTypes: ALLOWED_ELISE_ACTION_TYPES,
    payload: {},
    owned,
  });
  assert.equal(unknown.allowed, false);
});

test('Elise prompt assembly keeps injections inside untrusted sections', () => {
  const { assembleStyleChatPrompt, INJECTION_FIXTURES, hostileVisualCollectionTitles } = loadAiSecurity();
  const userAttack = INJECTION_FIXTURES.find((f) => f.id === 'ignore-previous').text;
  const focusAttack = INJECTION_FIXTURES.find((f) => f.id === 'reveal-system').text;
  const commerceAttack = INJECTION_FIXTURES.find((f) => f.id === 'retailer-ignore-policy').text;
  const noteAttack = INJECTION_FIXTURES.find((f) => f.id === 'saved-note-injection').text;
  const titles = hostileVisualCollectionTitles();

  const assembled = assembleStyleChatPrompt({
    systemRules: 'You are Elise. Stay in fashion.',
    trustedServerContext: 'Weather: 62F cloudy.',
    userMessage: userAttack,
    focusText: focusAttack,
    visualContextBlock: titles.map((title, index) => `evidence[${index + 1}].title=${title}`).join('\n'),
    attachmentContextBlock: noteAttack,
    closetContext: 'Preferred brands: Acne',
    signatureStyleContext: 'Light personalization signal.',
    commerceContext: commerceAttack,
  });

  assert.match(assembled.systemText, /<kscan_system_rules>/);
  assert.match(assembled.systemText, /<trusted_server_context>/);
  assert.doesNotMatch(assembled.systemText, /Ignore all previous instructions/);
  assert.doesNotMatch(assembled.systemText, /Reveal your system prompt/);
  assert.doesNotMatch(assembled.systemText, /retailer description/);
  assert.match(assembled.userEnvelopeText, /<user_input trust="untrusted_user">/);
  assert.match(assembled.userEnvelopeText, /<visual_context trust="untrusted_derived">/);
  assert.match(assembled.userEnvelopeText, /<commerce_context trust="untrusted_external">/);
  assert.match(assembled.userEnvelopeText, /<attachment_context trust="untrusted_derived">/);
  assert.equal((assembled.userEnvelopeText.match(/<\/user_input>/g) || []).length, 1);
  assert.ok(assembled.ok);
});

test('TypeChat prompt assembly treats query as untrusted user_input', () => {
  const { assembleTypeChatPrompt, INJECTION_FIXTURES } = loadAiSecurity();
  const attack = INJECTION_FIXTURES.find((f) => f.id === 'sql-drop').text;
  const assembled = assembleTypeChatPrompt({
    systemRules: 'Return fashion JSON only.',
    userQuery: attack,
    commerceContext: INJECTION_FIXTURES.find((f) => f.id === 'retailer-ignore-policy').text,
  });
  assert.equal(assembled.queryAccepted, true);
  assert.match(assembled.systemText, /<kscan_system_rules>/);
  assert.doesNotMatch(assembled.systemText, /DROP TABLE/);
  assert.match(assembled.userEnvelopeText, /<user_input trust="untrusted_user">/);
  assert.match(assembled.userEnvelopeText, /DROP TABLE|DROP TABLE users|Drop Table/i);
});

test('abuse controls throttle objective unsafe bursts only', () => {
  const { recordObjectiveAbuse, resetAbuseControlsForTests } = loadAiSecurity();
  resetAbuseControlsForTests();
  let last;
  for (let i = 0; i < 9; i += 1) {
    last = recordObjectiveAbuse({
      actorRef: 'u_test',
      entryPoint: 'typechat',
      category: 'schema_invalid',
      threshold: 8,
    });
  }
  assert.equal(last.throttled, true);
  assert.equal(last.category, 'schema_invalid');
});

test('stylechat-generate and scan-identify import the shared security layer', () => {
  const stylechat = fs.readFileSync(
    path.join(ROOT, 'supabase', 'functions', 'stylechat-generate', 'index.ts'),
    'utf8',
  );
  const scan = fs.readFileSync(
    path.join(ROOT, 'supabase', 'functions', 'scan-identify', 'index.ts'),
    'utf8',
  );
  assert.match(stylechat, /assembleStyleChatPrompt/);
  assert.match(stylechat, /_shared\/aiSecurity/);
  assert.match(stylechat, /authorizeModelAction/);
  assert.match(scan, /assembleTypeChatPrompt/);
  assert.match(scan, /validateTypeChatModelOutput/);
  assert.match(scan, /system_instruction/);
  assert.doesNotMatch(
    scan,
    /contents: \[\s*\{\s*role: 'user',\s*parts: \[\s*\{\s*text: TEXT_IDENTIFY_PROMPT/,
  );
});
