// Build 34 closure — Wardrobe Concierge certification-gate contract.
//
// WHY THIS EXISTS. `staging-certification` declared the Concierge PRESENTATION
// child (EXPO_PUBLIC_ELISE_CONCIERGE_V1) while the TRANSPORT parent
// (EXPO_PUBLIC_ELISE_ADVICE_METADATA_CLIENT_V1) was absent from every profile,
// including the `staging` profile it extends. The certification profile
// therefore CLAIMED Concierge was enabled while the composed runtime capability
// was still dark: the provider refused the adviceMetadata the presentation
// layer needs, so the certification artifact could never have certified the
// feature. Nothing failed, because no test evaluated the COMPOSED gate.
//
// TWO COOPERATING FORMS OF PROOF, because neither alone is sufficient:
//
//   Part A — profile resolution. `EXPO_PUBLIC_*` values are build-time inputs,
//   so the effective environment must be resolved through `extends` rather than
//   read off a child profile's raw `env` object.
//
//   Part B — real composition. Part A only proves which strings are in a JSON
//   file. Part B feeds those effective values into the REAL modules and asks
//   whether a Concierge block would actually be produced:
//
//     constants/featureFlags.ts                  (real flag resolver, per env)
//       -> services/style-chat/providers/edgeStyleChatProvider.ts
//                                                (real transport decision)
//       -> services/concierge/conciergeModel.ts  (real presentation projector)
//
//   The composed Boolean is deliberately NOT restated in this file. Concierge
//   has no single composed constant — the composition is the two real decision
//   points above — so re-deriving it here would prove only that the test agrees
//   with itself. Instead the real provider is executed against a stubbed
//   backend turn and the real projector consumes whatever the provider chose to
//   hand it, exactly as hooks/useStyleChat.ts does.
//
// This test asserts CONFIGURATION REACHABILITY only. It makes no claim about
// entitlement: K+ remains an independent server-side requirement, which the
// final case below pins.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const { resolveEasBuildProfile } = require('../scripts/resolve-eas-build-profiles');

const ROOT = path.resolve(__dirname, '..');
const EAS_PATH = path.join(ROOT, 'eas.json');

const eas = JSON.parse(fs.readFileSync(EAS_PATH, 'utf8'));

const TRANSPORT_KEY = 'EXPO_PUBLIC_ELISE_ADVICE_METADATA_CLIENT_V1';
const PRESENTATION_KEY = 'EXPO_PUBLIC_ELISE_CONCIERGE_V1';
const KPLUS_EARLY_ACCESS_KEY = 'EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED';

// ── Part A · effective profile resolution ────────────────────────────────────

/**
 * The effective environment of an EAS profile, with `extends` resolved.
 *
 * A child profile's raw `env` is NOT its environment: `staging-certification`
 * extends `staging` and inherits every key it does not itself override. Reading
 * the raw object is precisely the mistake that let the transport parent go
 * missing without anything objecting.
 *
 * Inheritance is resolved through the repository's canonical helper — the same
 * one easConfigIntegrity and the other profile suites already use — rather than
 * a second private copy of the merge rules, so this test can never disagree
 * with how the rest of the repo (and the EAS CLI) reads the same file.
 */
function effectiveEnv(profileName) {
  const resolved = resolveEasBuildProfile(eas, profileName);
  assert.ok(resolved, `eas.json is missing the "${profileName}" build profile`);
  return resolved.env ?? {};
}

test('Part A: staging-certification effectively declares BOTH Concierge parents', () => {
  const env = effectiveEnv('staging-certification');

  assert.equal(
    env[TRANSPORT_KEY],
    'true',
    'certification must declare the advice-metadata transport parent',
  );
  assert.equal(
    env[PRESENTATION_KEY],
    'true',
    'certification must declare the Concierge presentation child',
  );
  // Recorded because it is a direct neighbour of the certification claim, not
  // because Concierge reads it: K+ entitlement is resolved server-side.
  assert.equal(env[KPLUS_EARLY_ACCESS_KEY], 'true');
});

test('Part A: the certification profile genuinely extends staging', () => {
  assert.equal(eas.build['staging-certification'].extends, 'staging');
});

test('Part A: production declares NEITHER Concierge activation flag', () => {
  const env = effectiveEnv('production');
  assert.equal(env[TRANSPORT_KEY], undefined);
  assert.equal(env[PRESENTATION_KEY], undefined);
});

test('Part A: ordinary staging, preview and development remain Concierge-dark', () => {
  for (const profile of ['staging', 'preview', 'development']) {
    const env = effectiveEnv(profile);
    assert.equal(env[TRANSPORT_KEY], undefined, `${profile} must not declare transport`);
    assert.equal(env[PRESENTATION_KEY], undefined, `${profile} must not declare presentation`);
  }
});

test('Part A: the transport parent is confined to staging-certification alone', () => {
  const declaring = Object.keys(eas.build).filter(
    (name) => (eas.build[name].env || {})[TRANSPORT_KEY] !== undefined,
  );
  assert.deepEqual(declaring, ['staging-certification']);
});

// ── Part B · real composition ────────────────────────────────────────────────

/** Transpiles and evaluates a real repository module in an isolated context. */
function loadTsModule(relativePath, { env = {}, requireMap = {} } = {}) {
  const filename = path.join(ROOT, relativePath);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const sandbox = {
    module: { exports: {} },
    exports: {},
    require: (spec) => {
      if (spec in requireMap) return requireMap[spec];
      return {};
    },
    process: { env },
    __DEV__: false,
    console: { warn() {}, log() {}, error() {} },
    setTimeout,
    clearTimeout,
    AbortController,
    JSON,
    Array,
    Object,
    String,
    Boolean,
    Number,
    Promise,
    Date,
    Math,
    isNaN,
  };
  sandbox.module.exports = sandbox.exports;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(output, sandbox, { filename: relativePath });
  return sandbox.module.exports;
}

/** The REAL flag resolver, evaluated against one profile's effective env. */
function loadFlags(env) {
  return loadTsModule('constants/featureFlags.ts', { env });
}

/**
 * A backend turn that DOES carry Concierge evidence.
 *
 * The server only emits this shape for a K+-entitled caller whose Closet
 * matched; that entitlement decision is server-side and is not what this test
 * varies. Holding the payload constant across every profile is the point: the
 * only variable under test is build-time configuration.
 */
function conciergeTurn() {
  return {
    status: 'success',
    message: { sender: 'assistant', content: 'Try the brown loafers.', model: 'gemini', tokenEstimate: 12 },
    usage: { used: 1, limit: 20 },
    adviceContractVersion: 'elise_advice_v2',
    adviceMetadata: {
      contractVersion: 'elise_advice_v2',
      wardrobeContextMode: 'closet',
      focusedItem: {
        evidenceId: null,
        actorRelationship: 'owned',
        displayFacts: {
          title: 'Brown loafers',
          category: 'loafers',
          brand: 'Aldo',
          primaryColor: 'brown',
          clientId: 'closet-item-1',
        },
      },
      recommendations: [],
    },
  };
}

/**
 * Executes the REAL transport for one effective environment and reports
 * whether adviceMetadata survived the provider's own gate.
 */
async function runRealTransport(env, turn) {
  const flags = loadFlags(env);
  const provider = loadTsModule('services/style-chat/providers/edgeStyleChatProvider.ts', {
    env,
    requireMap: {
      '../../supabaseClient': {
        supabase: {
          functions: { invoke: async () => ({ data: turn, error: null }) },
        },
      },
      '../../../constants/featureFlags': flags,
      '../../../constants/styleChat': {
        STYLE_CHAT_COPY: { errorGeneric: 'e', burstLimitNotice: 'b', systemLimitNotice: 's' },
        STYLE_CHAT_DAILY_MESSAGE_LIMIT: 20,
      },
      '../styleChatErrors': { getFriendlyStyleChatError: () => 'error' },
      '../../../types/styleChatAttachments': { STYLECHAT_ATTACHMENT_CONTRACT_VERSION: '2' },
      '../../../types/fashionIdentificationV2': { ELISE_FASHION_CONTEXT_V2: '2' },
      '../eliseFashionContextV2': { prepareContextForTransport: (v) => v },
    },
  });

  const result = await new provider.EdgeStyleChatProvider(1000).generateReply({
    sessionId: 'session-1',
    message: 'what should I wear',
  });
  return { flags, result };
}

/**
 * The composed Concierge capability for one effective environment.
 *
 * Mirrors hooks/useStyleChat.ts: the presentation flag decides whether the
 * block is built at all, and the REAL projector decides whether the metadata
 * the REAL transport delivered renders anything. A profile is Concierge-
 * reachable only when a block actually results.
 */
async function conciergeEffective(env, turn = conciergeTurn()) {
  const { flags, result } = await runRealTransport(env, turn);
  const { buildConciergeResult } = require('../services/concierge/conciergeModel.ts');

  if (!flags.ELISE_CONCIERGE_V1) return false;
  const projected = buildConciergeResult(result.adviceMetadata ?? null);
  return projected.presentation !== 'none';
}

test('Part B: certification effective env composes to a reachable Concierge', async () => {
  assert.equal(await conciergeEffective(effectiveEnv('staging-certification')), true);
});

test('Part B: production effective env composes to a DARK Concierge', async () => {
  assert.equal(await conciergeEffective(effectiveEnv('production')), false);
});

test('Part B: ordinary staging, preview and development compose to a dark Concierge', async () => {
  for (const profile of ['staging', 'preview', 'development']) {
    assert.equal(await conciergeEffective(effectiveEnv(profile)), false, profile);
  }
});

test('Part B: presentation WITHOUT transport is not reachable (the audited defect)', async () => {
  // This is the exact pre-repair state of staging-certification.
  assert.equal(await conciergeEffective({ [PRESENTATION_KEY]: 'true' }), false);
});

test('Part B: transport WITHOUT presentation is not reachable', async () => {
  assert.equal(await conciergeEffective({ [TRANSPORT_KEY]: 'true' }), false);
});

test('Part B: malformed or missing parent values fail closed', async () => {
  const MALFORMED = ['TRUE', 'True', '1', 'yes', 'on', '', ' true', 'true ', 'false', undefined];
  for (const value of MALFORMED) {
    assert.equal(
      await conciergeEffective({ [TRANSPORT_KEY]: value, [PRESENTATION_KEY]: 'true' }),
      false,
      `transport=${String(value)} must not activate Concierge`,
    );
    assert.equal(
      await conciergeEffective({ [TRANSPORT_KEY]: 'true', [PRESENTATION_KEY]: value }),
      false,
      `presentation=${String(value)} must not activate Concierge`,
    );
  }
});

test('Part B: an empty environment is not reachable', async () => {
  assert.equal(await conciergeEffective({}), false);
});

// ── K+ independence ──────────────────────────────────────────────────────────

test('build-time configuration alone does not grant Concierge: a non-entitled turn stays dark', async () => {
  // A non-K+ caller's turn carries no wardrobe context, because the server
  // resolves entitlement via has_active_k_plus() and fails closed. Even with
  // BOTH certification flags on, that turn must render no Concierge surface --
  // build configuration exposes the capability, entitlement authorizes it.
  const nonEntitledTurn = conciergeTurn();
  nonEntitledTurn.adviceMetadata = {
    contractVersion: 'elise_advice_v2',
    wardrobeContextMode: 'none',
  };
  assert.equal(
    await conciergeEffective(effectiveEnv('staging-certification'), nonEntitledTurn),
    false,
  );
});

test('the client never invents entitlement: entitlement is resolved server-side', () => {
  // Pins the boundary in source. The client has no K+ predicate of its own to
  // consult here; it renders only what the server's metadata already claims.
  const hook = fs.readFileSync(path.join(ROOT, 'hooks', 'useStyleChat.ts'), 'utf8');
  assert.match(hook, /if \(ELISE_CONCIERGE_V1\) \{/);
  assert.match(hook, /buildConciergeResult\(result\.adviceMetadata \?\? null\)/);

  const server = fs.readFileSync(
    path.join(ROOT, 'supabase', 'functions', 'stylechat-generate', 'index.ts'),
    'utf8',
  );
  assert.match(server, /has_active_k_plus/);
});
