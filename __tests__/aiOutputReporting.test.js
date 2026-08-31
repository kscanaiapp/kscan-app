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
  vm.runInNewContext(output, {
    exports: module.exports,
    module,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      throw new Error(`Unexpected require: ${id}`);
    },
  }, { filename });
  return module.exports;
}

function loadService(submitContentReport) {
  return loadTsModule('services/reportAiOutput.ts', {
    './contentReports': { submitContentReport },
  });
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('AI-output reporting: a selected reason submits the legitimate ai_output contract', async () => {
  const calls = [];
  const { submitAiOutputReport } = loadService(async (input) => {
    calls.push(input);
    return { ok: true, serverAccepted: true, duplicate: false };
  });

  const result = await submitAiOutputReport({
    request: {
      feature: 'StyleChat',
      sessionId: 'session-1',
      messageId: 'assistant-message-1',
    },
    reasonId: 'incorrect_or_misleading',
    notes: '  The stated material is wrong.  ',
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(plain(calls[0]), {
    targetType: 'ai_output',
    targetId: 'assistant-message-1',
    reasonCategory: 'other',
    notes: 'The stated material is wrong.',
    aiOutputContext: {
      feature: 'StyleChat',
      reason_detail: 'incorrect_or_misleading',
      session_id: 'session-1',
      message_id: 'assistant-message-1',
    },
  });
  assert.equal('reporterUserId' in calls[0], false, 'the client must not be able to impersonate a reporter');
});

test('AI-output reporting: item identifiers support Scan Results without persisting scan media', async () => {
  const calls = [];
  const { submitAiOutputReport } = loadService(async (input) => {
    calls.push(input);
    return { ok: true, serverAccepted: true, duplicate: false };
  });

  await submitAiOutputReport({
    request: { feature: 'Scan Results', itemId: 'saved-scan-1' },
    reasonId: 'biased',
  });

  assert.equal(calls[0].targetId, 'saved-scan-1');
  assert.deepEqual(plain(calls[0].aiOutputContext), {
    feature: 'Scan Results',
    reason_detail: 'biased',
    item_id: 'saved-scan-1',
  });
  assert.equal(JSON.stringify(calls[0]).includes('image'), false);
});

test('AI-output reporting: a response without a stable identifier fails before backend submission', async () => {
  let calls = 0;
  const { submitAiOutputReport } = loadService(async () => {
    calls += 1;
    return { ok: true, serverAccepted: true, duplicate: false };
  });

  const result = await submitAiOutputReport({
    request: { feature: 'StyleChat' },
    reasonId: 'other',
  });

  assert.equal(result.ok, false);
  assert.equal(calls, 0);
});

test('AI-output reporting: backend failures remain retryable and do not become success', async () => {
  const { submitAiOutputReport } = loadService(async () => ({
    ok: false,
    serverAccepted: false,
    error: new Error('Report could not be sent.'),
  }));

  const result = await submitAiOutputReport({
    request: { feature: 'StyleChat', messageId: 'assistant-message-1' },
    reasonId: 'other',
  });

  assert.equal(result.ok, false);
  assert.equal(result.serverAccepted, false);
});

test('AI-output reporting: the submission gate rejects duplicate rapid taps', async () => {
  const { createAiOutputReportSubmissionGate } = loadService(async () => ({
    ok: true,
    serverAccepted: true,
    duplicate: false,
  }));
  const gate = createAiOutputReportSubmissionGate();
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });

  const first = gate.run(async () => {
    calls += 1;
    await pending;
    return 'sent';
  });
  const second = await gate.run(async () => {
    calls += 1;
    return 'duplicate';
  });

  assert.deepEqual(plain(second), { started: false });
  assert.equal(calls, 1);
  release();
  assert.deepEqual(plain(await first), { started: true, value: 'sent' });
});
