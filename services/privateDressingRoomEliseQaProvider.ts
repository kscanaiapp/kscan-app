/**
 * Controlled DEVELOPMENT-ONLY Elise provider for pre-deployment device QA.
 *
 * WHY THIS EXISTS. The Phase 4 backend is not deployed. Without a controlled
 * provider, the success, clarification, unsupported, race, cancellation and
 * timeout paths cannot be exercised on a device at all — production answers a
 * versioned body with a legacy rejection, which only ever proves the
 * capability-unavailable path.
 *
 * WHAT IT IS NOT. It is not a production mock-routing switch. Two independent
 * conditions must BOTH hold, and the release build cannot satisfy the first:
 *
 *     __DEV__ === true
 *     EXPO_PUBLIC_PRIVATE_DRESSING_ROOM_ELISE_QA_PROVIDER === 'controlled'
 *
 * The scenario table is built inside a `__DEV__` branch, mirroring
 * constants/qaFixtures.js, so Metro eliminates it from release bundles rather
 * than shipping dormant mock code. Outside `__DEV__` this module exports a
 * factory that can only return null, and the caller then has nothing to select
 * but the real provider. `__tests__/privateDressingRoomEliseQaProvider.test.js`
 * proves release selection resolves to production regardless of the variable.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *   - it does not bypass the response validator; it returns a BODY, and
 *     sendEliseRequest validates it exactly as it validates the real one
 *   - it does not modify any URL, Supabase client or production dispatch
 *   - it requires no secret and no provider key
 *   - it persists nothing
 *
 * It also never invents a request. It receives the same fully built, already
 * validated Phase 4 body the production provider would receive, which is what
 * makes the request-inspection evidence below trustworthy.
 */

import {
  PRIVATE_DRESSING_ROOM_ELISE_SCHEMA_VERSION,
  PRIVATE_ELISE_CANDIDATE_FIELDS,
  PRIVATE_ELISE_FORBIDDEN_REQUEST_FIELDS,
} from '../types/privateDressingRoomElise';

/** The only value that arms the seam. Anything else leaves production selected. */
export const ELISE_QA_PROVIDER_SETTING = 'controlled';

export const ELISE_QA_PROVIDER_ENV = 'EXPO_PUBLIC_PRIVATE_DRESSING_ROOM_ELISE_QA_PROVIDER';

/** Structurally identical to the client's EliseInvoke; declared locally to avoid a cycle. */
type ControlledInvoke = (
  name: string,
  options: { body: unknown; signal?: AbortSignal },
) => Promise<{ data: unknown; error: unknown }>;

function isDevRuntime(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__ === true;
}

/**
 * FAILS CLOSED. Both gates are required, and the `__DEV__` gate is evaluated
 * first so a release build never even reads the variable.
 */
export function isControlledEliseProviderEnabled(): boolean {
  if (!isDevRuntime()) return false;
  return process.env[ELISE_QA_PROVIDER_ENV] === ELISE_QA_PROVIDER_SETTING;
}

// ── Scenario triggers ────────────────────────────────────────────────────────

export const ELISE_QA_SCENARIOS = [
  'qa supported occasion',
  'qa clarification',
  'qa unsupported',
  'qa backend unavailable',
  'qa safe failure',
  'qa unknown alias',
  'qa delayed response a',
  'qa immediate response b',
  'qa timeout',
] as const;
export type EliseQaScenario = (typeof ELISE_QA_SCENARIOS)[number];

/** Delay for the race scenario, long enough to supersede by hand on a device. */
export const ELISE_QA_DELAY_MS = 4000;

function matchScenario(instruction: unknown): EliseQaScenario | null {
  if (typeof instruction !== 'string') return null;
  const text = instruction.trim().toLowerCase();
  // Longest first, so "qa unsupported" cannot shadow nothing and
  // "qa delayed response a" is not matched by a shorter prefix.
  const ordered = [...ELISE_QA_SCENARIOS].sort((a, b) => b.length - a.length);
  for (const scenario of ordered) {
    if (text === scenario || text.startsWith(scenario)) return scenario;
  }
  return null;
}

// ── Request inspection (QA evidence, sanitized) ──────────────────────────────

export type EliseQaRequestInspection = {
  schemaVersion: string;
  intent: string;
  aliasFormat: string;
  candidateCount: number;
  bodyBytes: number;
  includedFashionFields: string[];
  forbiddenFieldsFound: string[];
  privacy: 'PASS' | 'FAIL';
};

/**
 * Inspects the body the provider actually received.
 *
 * Reports the sanitized shape and, critically, whether ANY forbidden field
 * appears anywhere in the serialized body. This is the device-side counterpart
 * to the local-serving privacy evidence.
 */
export function inspectEliseQaRequest(body: unknown): EliseQaRequestInspection {
  const record = (body ?? {}) as Record<string, unknown>;
  const serialized = JSON.stringify(record ?? {});
  const candidates = Array.isArray(record.candidates) ? record.candidates : [];

  const includedFashionFields: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    for (const key of Object.keys(candidate)) {
      if (PRIVATE_ELISE_CANDIDATE_FIELDS.includes(key) && !includedFashionFields.includes(key)) {
        includedFashionFields.push(key);
      }
    }
  }

  const forbiddenFieldsFound = PRIVATE_ELISE_FORBIDDEN_REQUEST_FIELDS.filter((field) =>
    new RegExp(`"${field}"\\s*:`).test(serialized),
  );

  const firstRef =
    candidates.length > 0 && candidates[0] && typeof candidates[0] === 'object'
      ? String((candidates[0] as Record<string, unknown>).ref ?? '')
      : String(record.anchorRef ?? '');
  const aliasFormat = firstRef ? firstRef.replace(/[0-9a-f]{8}/, '<fragment>') : 'none';

  return {
    schemaVersion: String(record.schemaVersion ?? 'absent'),
    intent: String(record.intent ?? 'absent'),
    aliasFormat,
    candidateCount: candidates.length,
    bodyBytes: serialized.length,
    includedFashionFields: includedFashionFields.sort(),
    forbiddenFieldsFound,
    privacy: forbiddenFieldsFound.length === 0 ? 'PASS' : 'FAIL',
  };
}

// ── The controlled provider ──────────────────────────────────────────────────

/**
 * Deterministic synthetic responses, keyed off the QA instruction.
 *
 * Built inside a `__DEV__` branch so release bundles do not carry it. Every
 * response is a plain body: the production validator decides whether it is
 * acceptable, which is why "qa unknown alias" is able to fail the way a hostile
 * backend would.
 */
const SCENARIOS = isDevRuntime()
  ? {
      respond(scenario: EliseQaScenario, body: Record<string, unknown>): unknown {
        const base = {
          schemaVersion: PRIVATE_DRESSING_ROOM_ELISE_SCHEMA_VERSION,
          requestId: body.requestId,
          intent: body.intent,
        };
        const anchorRef = typeof body.anchorRef === 'string' ? body.anchorRef : undefined;
        const success =
          body.intent === 'build_around_item'
            ? { ...base, status: 'success', anchorRef, normalizedOccasion: 'Dinner', occasionGroup: 'evening' }
            : { ...base, status: 'success', normalizedOccasion: 'Dinner', occasionGroup: 'evening' };

        switch (scenario) {
          case 'qa supported occasion':
          case 'qa delayed response a':
            return success;
          case 'qa immediate response b':
            return body.intent === 'build_around_item'
              ? { ...base, status: 'success', anchorRef, normalizedOccasion: 'Work', occasionGroup: 'work' }
              : { ...base, status: 'success', normalizedOccasion: 'Work', occasionGroup: 'work' };
          case 'qa clarification':
            return { ...base, status: 'clarification_required' };
          case 'qa unsupported':
            return { ...base, status: 'unsupported' };
          case 'qa safe failure':
            return { ...base, status: 'safe_failure' };
          case 'qa backend unavailable':
            // Exactly what a pre-Phase-4 deployment answers a versioned body
            // with: no schemaVersion, so the client reads it as capability
            // unavailable rather than reinterpreting it.
            return { error: 'Unsupported mode' };
          case 'qa unknown alias':
            // A hostile-shaped success naming an alias this request never sent.
            return { ...success, anchorRef: 'item_deadbeef_1', selectedRefs: ['item_deadbeef_1'] };
          default:
            return success;
        }
      },
    }
  : null;

/**
 * Returns the controlled provider, or null when it must not be used.
 *
 * Null is the release answer, and it is the ONLY answer a release build can
 * produce — so the caller has nothing to fall back to but the real provider.
 */
export function createControlledEliseInvoke(): ControlledInvoke | null {
  if (!isControlledEliseProviderEnabled() || !SCENARIOS) return null;

  return (name, options) => {
    const body = (options?.body ?? {}) as Record<string, unknown>;
    const scenario = matchScenario(body.instruction);

    // QA evidence. Metadata and a privacy verdict only — never the payload.
    const inspection = inspectEliseQaRequest(body);
    console.log(
      `[elise-qa] fn=${name} scenario=${scenario ?? 'default'} ` +
        `version=${inspection.schemaVersion} intent=${inspection.intent} ` +
        `alias=${inspection.aliasFormat} candidates=${inspection.candidateCount} ` +
        `bodyBytes=${inspection.bodyBytes} fields=[${inspection.includedFashionFields.join('|')}] ` +
        `forbidden=[${inspection.forbiddenFieldsFound.join('|')}] privacy=${inspection.privacy}`,
    );

    const signal = options?.signal;

    if (scenario === 'qa timeout') {
      // Never settles on its own: the caller's own timeout or cancellation must
      // be what ends it, which is the behaviour under test.
      return new Promise((resolve) => {
        const onAbort = () => resolve({ data: null, error: { message: 'aborted' } });
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });
    }

    const data = SCENARIOS.respond(scenario ?? 'qa supported occasion', body);
    const delayMs = scenario === 'qa delayed response a' ? ELISE_QA_DELAY_MS : 0;

    if (delayMs === 0) return Promise.resolve({ data, error: null });

    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ data, error: null }), delayMs);
      const onAbort = () => {
        clearTimeout(timer);
        resolve({ data: null, error: { message: 'aborted' } });
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  };
}
