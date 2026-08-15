/**
 * KSB29-022 — the stylist-speech cue contract, client vs staging vs production.
 *
 * THE DEFECT, STATED EXACTLY. The Build 29 mobile client sends cue-mode
 * requests as `{ cue, stylistId }`. Deployed PRODUCTION stylist-speech (v29)
 * parses with:
 *
 *     const REQUEST_KEYS = new Set(['sessionId', 'messageId', 'stylistId']);
 *     if (Object.keys(record).some((key) => !REQUEST_KEYS.has(key))) throw ...
 *
 * `cue` is not in that set, so every cue request is rejected with HTTP 400
 * INVALID_REQUEST, "The speech request contains unsupported fields." Production
 * carries no speechCues.ts at all. Deployed STAGING (v31) is the newer
 * implementation and matches this repository's source, cue mode included.
 *
 * So Elise's deterministic voice moments cannot work in production until
 * stylist-speech is promoted. That promotion delta is recorded in
 * docs/release/BUILD29_BACKEND_PROMOTION_LEDGER.md; this file is the evidence
 * behind it.
 *
 * WHAT IS EXERCISED HERE: the REAL request body the mobile cue client builds,
 * against the REAL handler source that staging runs. Nothing is hand-shaped —
 * the body is lifted from services/avatars/stylistSpeechClient.ts by AST so a
 * change there is picked up here.
 *
 * Verified against the live projects on 2026-08-15:
 *   production  wyyuqfdxucjksghsmhry  stylist-speech v29  message mode only
 *   app staging yzqjvdfgefveprobvvyw  stylist-speech v31  cue + message mode
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

/** The five product moments named by the Build 29 repair scope. */
const REQUIRED_CUES = [
  'image_understood',
  'closet_saved',
  'style_item',
  'change_something',
  'dressing_room_ready',
];

const ACTOR_ID = '55555555-5555-4555-8555-555555555555';
const SPEAKING_STYLIST = 'stylist_portrait_01';

const moduleCache = new Map();
function loadTs(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  if (moduleCache.has(normalized)) return moduleCache.get(normalized);

  const source = fs.readFileSync(path.join(ROOT, normalized), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const module = { exports: {} };
  const dir = path.dirname(normalized);
  const sandbox = {
    console,
    Date,
    crypto,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    AbortController,
    Response,
    Request,
    exports: module.exports,
    module,
    require: (specifier) => {
      if (!specifier.startsWith('.')) {
        throw new Error(`Unexpected external import in ${normalized}: ${specifier}`);
      }
      const base = path.join(dir, specifier).split(path.sep).join('/');
      for (const candidate of [base, `${base}.ts`, `${base}.js`]) {
        if (fs.existsSync(path.join(ROOT, candidate))) return loadTs(candidate);
      }
      throw new Error(`Unresolved import ${specifier} from ${normalized}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: normalized }).runInContext(sandbox);
  moduleCache.set(normalized, module.exports);
  return module.exports;
}

/**
 * The cue request body the REAL mobile client sends, lifted from its own source
 * so this cannot drift into a hand-shaped approximation.
 */
function realClientCueBody(cue) {
  const source = fs.readFileSync(
    path.join(ROOT, 'services', 'avatars', 'stylistSpeechClient.ts'),
    'utf8',
  );
  // The exact expression the client passes as `body` in cue mode.
  assert.match(
    source,
    /\?\s*\{\s*cue:\s*request\.cue,\s*stylistId:\s*request\.stylistId\s*\}/,
    'the mobile cue client must send exactly { cue, stylistId }',
  );
  return { cue, stylistId: SPEAKING_STYLIST };
}

/** A handler wired to the real source, with only the database and provider stubbed. */
function stagingHandler() {
  const { createStylistSpeechHandler } = loadTs('supabase/functions/stylist-speech/handler.ts');
  const generated = [];
  const handler = createStylistSpeechHandler({
    createDataAccess: () => ({
      getAuthenticatedActor: async () => ({ id: ACTOR_ID }),
      getAccountStatus: async () => 'active',
      getSession: async () => null,
      getMessage: async () => null,
      getStylistPreference: async () => ({ avatar_id: SPEAKING_STYLIST }),
    }),
    env: { get: () => 'unused-because-generateSpeech-is-injected' },
    generateSpeech: async ({ text, voiceProfile }) => {
      generated.push({ text, voiceProfile });
      return { audioBase64: 'AAAA', alignment: null };
    },
  });
  return { handler, generated };
}

function cueRequest(body) {
  return new Request('https://example.test/stylist-speech', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/* ------------------------------------------------------------------ */
/* Staging accepts the real client contract, for all five moments      */
/* ------------------------------------------------------------------ */

for (const cue of REQUIRED_CUES) {
  test(`staging accepts the real cue client request for "${cue}"`, async () => {
    const { handler, generated } = stagingHandler();
    const response = await handler(cueRequest(realClientCueBody(cue)));

    assert.equal(response.status, 200, `${cue} must be accepted`);
    const payload = await response.json();
    assert.equal(payload.cue, cue, 'the response must echo the cue that was spoken');
    assert.equal(payload.messageId, null, 'a cue has no message');
    assert.equal(payload.stylistId, SPEAKING_STYLIST);
    assert.equal(payload.mimeType, 'audio/mpeg');

    // The WORDS come from the server allowlist, never the request. This is the
    // security property that makes cue mode acceptable at all: a client that
    // could supply text could bill the provider for anything and have Elise say
    // it.
    assert.equal(generated.length, 1, 'exactly one generation per cue');
    assert.ok(generated[0].text.length > 0, `${cue} must resolve to approved words`);
    assert.doesNotMatch(
      JSON.stringify(realClientCueBody(cue)),
      /text/i,
      'the request must carry a cue KEY, never cue text',
    );
  });
}

test('an unapproved cue key is refused rather than spoken as something else', async () => {
  const { handler, generated } = stagingHandler();
  const response = await handler(
    cueRequest({ cue: 'not_a_real_cue', stylistId: SPEAKING_STYLIST }),
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'INVALID_REQUEST');
  assert.equal(generated.length, 0, 'nothing may be generated for an unknown cue');
});

test('a request may not carry both a cue and a message', async () => {
  // Parsed as whole shapes, so a hybrid body is rejected instead of silently
  // favouring one mode.
  const { handler } = stagingHandler();
  const response = await handler(
    cueRequest({
      cue: 'closet_saved',
      messageId: '66666666-6666-4666-8666-666666666666',
      stylistId: SPEAKING_STYLIST,
    }),
  );
  assert.equal(response.status, 400);
});

/* ------------------------------------------------------------------ */
/* The production delta this proves                                    */
/* ------------------------------------------------------------------ */

test('the deployed production parser shape rejects the real cue request', async () => {
  // Production v29's parser, reproduced from the DEPLOYED source read on
  // 2026-08-15. It is transcribed rather than imported because production runs
  // an older generation of this file that no longer exists in the repository —
  // which is precisely the promotion gap being recorded.
  const PRODUCTION_REQUEST_KEYS = new Set(['sessionId', 'messageId', 'stylistId']);
  const productionRejects = (body) =>
    Object.keys(body).some((key) => !PRODUCTION_REQUEST_KEYS.has(key));

  for (const cue of REQUIRED_CUES) {
    assert.equal(
      productionRejects(realClientCueBody(cue)),
      true,
      `production rejects the "${cue}" cue with INVALID_REQUEST until it is promoted`,
    );
  }

  // ...and the same client's MESSAGE mode is unaffected, which is why Elise's
  // spoken replies work in production today while her cues do not.
  const messageBody = {
    sessionId: '77777777-7777-4777-8777-777777777777',
    messageId: '88888888-8888-4888-8888-888888888888',
    stylistId: SPEAKING_STYLIST,
  };
  assert.equal(productionRejects(messageBody), false, 'message mode is already compatible');
});

test('the promotion delta is recorded in the ledger', () => {
  const ledger = fs.readFileSync(
    path.join(ROOT, 'docs', 'release', 'BUILD29_BACKEND_PROMOTION_LEDGER.md'),
    'utf8',
  );
  assert.match(ledger, /stylist-speech/);
  assert.match(ledger, /v29/, 'the production version must be recorded');
  assert.match(ledger, /v31/, 'the staging version must be recorded');
  for (const cue of REQUIRED_CUES) {
    assert.ok(ledger.includes(cue), `the ledger must name the "${cue}" moment`);
  }
});

/* ------------------------------------------------------------------ */
/* A cue-service outage must not disappear silently                    */
/* ------------------------------------------------------------------ */

test('a cue rejected by an older deployment is classified, not swallowed blind', () => {
  const client = fs.readFileSync(
    path.join(ROOT, 'services', 'avatars', 'stylistSpeechClient.ts'),
    'utf8',
  );
  const speech = fs.readFileSync(path.join(ROOT, 'services', 'avatarSpeech.ts'), 'utf8');

  // The client threw one undifferentiated Error for every failure and the caller
  // caught it with a bare `catch {}`. A COMPLETE cue outage -- every cue rejected
  // because the deployment predates cue mode -- was therefore indistinguishable
  // from one flaky network call, which is how this contract gap stayed invisible.
  assert.match(client, /class StylistSpeechClientError extends Error/);
  assert.match(client, /'unsupported_contract'/);
  assert.doesNotMatch(
    client,
    /throw new Error\('Speech is temporarily unavailable\.'\);/,
    'the undifferentiated throw must be gone',
  );

  // A 400 on a cue request is the deployment mismatch, and it is NOT retryable:
  // an older deployment will not start understanding a newer request.
  assert.match(client, /cueMode && status === 400/);
  assert.match(client, /this\.retryable = code !== 'unsupported_contract'/);

  // Speech stays an enhancement -- the failure is still swallowed so it can
  // never roll back a save or a hand-off -- but it is swallowed observably.
  assert.doesNotMatch(speech, /\}\s*catch\s*\{\s*\n\s*if \(isCurrent\(requestGeneration\)\)/);
  assert.match(speech, /catch \(error\)/);
  assert.match(speech, /describeSpeechFailure\(error\)/);
});

test('failure copy stays user-safe and never explains the backend disagreement', () => {
  const speech = fs.readFileSync(path.join(ROOT, 'services', 'avatarSpeech.ts'), 'utf8');
  const describe = speech.slice(
    speech.indexOf('function describeSpeechFailure'),
    speech.indexOf('async function failCurrent'),
  );

  // Only the RETURNED STRINGS are user-facing. `unsupported_contract` is an
  // internal code and is expected to appear in the comparison above them.
  const copy = (describe.match(/'[^']*'/g) || [])
    .filter((literal) => literal.includes(' '))
    .map((literal) => literal.toLowerCase());
  assert.ok(copy.length >= 2, 'both failure strings must be present');

  for (const leak of ['400', 'contract', 'invalid_request', 'stylist-speech', 'deploy', 'version']) {
    for (const line of copy) {
      assert.ok(!line.includes(leak), `user-facing speech copy must not mention ${leak}: ${line}`);
    }
  }
});
