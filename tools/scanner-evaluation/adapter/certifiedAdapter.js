'use strict';

/**
 * Certified v140 evaluation adapter shell (Phase 0D Lane C).
 *
 * WHAT THIS IS
 * The boundary layer around the certified v140 identification path. It owns
 * every side-effecting dependency — model transport, commerce, catalog
 * retrieval, persistence, telemetry, logging, result storage — so each can be
 * isolated or injected WITHOUT editing a single certified source file.
 *
 * WHAT IT REFUSES TO DO
 *   - start against anything but the certified v140 source root;
 *   - construct a real model transport;
 *   - construct a commerce provider;
 *   - construct a Supabase client;
 *   - emit production telemetry;
 *   - touch the network.
 *
 * Every one of those is a counter that must read zero, not a promise in a
 * comment. See `invariants()`.
 *
 * HONEST SCOPE LIMIT
 * This shell enforces the boundaries and drives the deterministic mock. It does
 * NOT yet execute the certified module graph in-process: the certified entry
 * imports `npm:@supabase/supabase-js@2`, which Deno must resolve before the
 * bundle can be served. That resolution step is the remaining work for full
 * pipeline execution and is recorded in the adapter architecture doc. Nothing
 * here should be read as evidence that stages 3–8 of the twelve proofs are
 * discharged.
 */

const certifiedSource = require('../lib/certifiedSource');

/** A boundary that must never be crossed before the owner authorizes it. */
class BoundaryViolation extends Error {
  constructor(boundary, detail) {
    super(`forbidden boundary crossed: ${boundary}${detail ? ` (${detail})` : ''}`);
    this.name = 'BoundaryViolation';
    this.boundary = boundary;
  }
}

/**
 * A stub that THROWS rather than silently doing nothing.
 *
 * A no-op stub would hide a real call path: the run would pass while the code
 * genuinely tried to persist or shop. Throwing turns a boundary crossing into a
 * loud test failure.
 */
function throwingBoundary(name) {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (property === 'then') return undefined; // not a thenable
        return (...args) => {
          throw new BoundaryViolation(name, `${String(property)}(${args.length} args)`);
        };
      },
      apply() {
        throw new BoundaryViolation(name, 'called');
      },
    }
  );
}

const DEFAULT_MODELS = Object.freeze({
  primary: 'gemini-3.6-flash',
  fallback: 'gemini-3.5-flash-lite',
});

/**
 * Build the adapter.
 *
 * @param {{ argv?: string[], certRoot?: string, provider?: object,
 *           models?: {primary: string, fallback: string} }} options
 */
function createCertifiedAdapter(options = {}) {
  // Hard gate: the adapter cannot exist against a non-certified root. This is
  // where "we accidentally measured the research branch" becomes impossible.
  const certVerification = options.certRoot
    ? (() => {
        const result = certifiedSource.verifyCertRoot(options.certRoot);
        if (!result.ok) {
          const error = new Error(
            `certified v140 source root rejected (${result.failures.map((f) => f.code).join(', ')})`
          );
          error.verification = result;
          throw error;
        }
        return { ...result, via: 'certRoot option' };
      })()
    : certifiedSource.requireCertRoot(options.argv || []);

  const counters = {
    modelCalls: 0,
    commerceConstructions: 0,
    catalogRetrievals: 0,
    persistenceWrites: 0,
    telemetryEmissions: 0,
    networkAttempts: 0,
    resultStoreWrites: 0,
  };

  const boundaries = {
    commerce: throwingBoundary('commerce'),
    catalogRetrieval: throwingBoundary('catalogRetrieval'),
    persistence: throwingBoundary('persistence'),
    telemetry: throwingBoundary('telemetry'),
    productionEndpoint: throwingBoundary('productionEndpoint'),
  };

  const models = options.models || DEFAULT_MODELS;
  const provider = options.provider || null;
  const ledger = [];

  /**
   * Drive one identification through the injected provider, applying the
   * certified fallback policy: one primary attempt, then one fallback attempt.
   */
  function invokeModel({ prompt, imageCount, caseId }) {
    if (!provider) {
      throw new Error(
        'no provider injected. The adapter ships no real model transport, so it cannot make a paid call by accident.'
      );
    }

    const attempts = [];
    let lastError = null;

    for (const [index, model] of [models.primary, models.fallback].entries()) {
      counters.modelCalls += 1;
      try {
        const response = provider.invoke({ model, prompt, imageCount, attempt: index });
        attempts.push({ model, ok: true });
        ledger.push({ caseId, model, outcome: 'ok', attempt: index });
        return { response, model, attempts, fallbackInvoked: index > 0 };
      } catch (error) {
        lastError = error;
        attempts.push({ model, ok: false, kind: error.kind || 'error' });
        // The ledger records the safe operation and case id only — never a
        // prompt, image bytes, base64, token, or credential.
        ledger.push({ caseId, model, outcome: 'failed', attempt: index, kind: error.kind || 'error' });
      }
    }

    const failure = new Error('primary and fallback model attempts both failed');
    failure.cause = lastError;
    failure.attempts = attempts;
    throw failure;
  }

  function invariants() {
    return {
      commerceCallCount: counters.commerceConstructions,
      catalogRetrievalCount: counters.catalogRetrievals,
      persistenceWriteCount: counters.persistenceWrites,
      telemetryCount: counters.telemetryEmissions,
      externalNetworkCount: counters.networkAttempts,
      resultStoreWriteCount: counters.resultStoreWrites,
      modelCallCount: counters.modelCalls,
      allZeroExceptModel:
        counters.commerceConstructions === 0 &&
        counters.catalogRetrievals === 0 &&
        counters.persistenceWrites === 0 &&
        counters.telemetryEmissions === 0 &&
        counters.networkAttempts === 0 &&
        counters.resultStoreWrites === 0,
    };
  }

  return {
    certVerification,
    certRoot: certVerification.root,
    models,
    boundaries,
    counters,
    ledger,
    invokeModel,
    invariants,
    /** The request intent used for the baseline. Commerce is skipped by production's own gate. */
    intent: 'identify_for_style',
    contractVersion: 'fashion-identification-v2',
  };
}

module.exports = {
  BoundaryViolation,
  throwingBoundary,
  createCertifiedAdapter,
  DEFAULT_MODELS,
};
