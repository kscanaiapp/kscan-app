/**
 * Discovery of, and the thin application adapter around, the optional Live
 * VTO native module.
 *
 * SAFE ABSENCE IS THE POINT. No build in existence today ships this module,
 * and the app must be completely unaffected by that. Three things make it so:
 *
 *   1. `requireOptionalNativeModule` -- Expo's own optional-module lookup,
 *      which RETURNS NULL for a missing module where `requireNativeModule`
 *      throws. This is the safest discovery mechanism the current Expo native
 *      architecture offers and is why it is used instead of a try/catch around
 *      the throwing variant.
 *   2. The lookup is LAZY. Nothing native is touched while this module is
 *      being imported, so a resolution problem cannot participate in app
 *      startup at all -- it can only affect the first caller that asks about
 *      capability, which is a VTO surface the customer opened.
 *   3. Every call into the module is wrapped. A native method that throws,
 *      returns a nonsense shape, or hangs is a capability answer of "no", not
 *      an exception escaping into a React render.
 *
 * REGISTRATION IS NOT CAPABILITY. A module can be present and still be unable
 * to run: no model on disk, no camera, a runtime that failed to initialize.
 * `describeLiveVtoNativeCapability` therefore requires the module's own
 * self-check to affirm BOTH that it is capable and that its runtime resources
 * are ready. Anything short of an explicit yes is a no, and AI Photo stays the
 * fallback. See docs/vto-integration-defect-ledger.md (VTO-LIVE-001).
 */

import { Platform } from 'react-native';

import { LIVE_VTO_NATIVE_MODULE_NAME } from '../../constants/featureFlags';
import {
  assertNoRawLiveData,
  type LiveVtoCapturedFrame,
  type LiveVtoEvent,
  type LiveVtoGarmentDescriptor,
} from '../../types/vtoLive';

/** Platforms a Live runtime could exist on at all. Web/other are not a
 *  "missing module" problem -- there is no native runtime concept there. */
export const LIVE_VTO_SUPPORTED_PLATFORMS: readonly string[] = ['ios', 'android'];

/**
 * The self-check answer. `capable` is the module's opinion of the device;
 * `runtimeReady` is its opinion of itself (model/assets/permissions-independent
 * initialization). Both must be true.
 */
export interface LiveVtoNativeSelfCheck {
  capable: boolean;
  runtimeReady: boolean;
  /** Opaque module build identifier, telemetry/debug only. */
  runtimeVersion?: string | null;
}

/** The surface a future native module must expose. Intentionally small: every
 *  command in LIVE_VTO_COMMANDS, one self-check, and one event subscription. */
export interface LiveVtoNativeModule {
  getCapability(): LiveVtoNativeSelfCheck;
  addListener(name: string, listener: (event: unknown) => void): { remove(): void };
  start(): void;
  pause(): void;
  resume(): void;
  stop(): void;
  loadGarment(descriptor: LiveVtoGarmentDescriptor): void;
  switchGarment(descriptor: LiveVtoGarmentDescriptor): void;
  capturePersonFrame(): Promise<LiveVtoCapturedFrame>;
  capturePreview(): Promise<LiveVtoCapturedFrame>;
  dispose(): void;
}

export type LiveVtoNativeAbsenceReason =
  | 'unsupported_platform'
  | 'module_missing'
  | 'lookup_failed';

/**
 * Where a capability answer came from.
 *
 * The distinction is load-bearing, not decorative: a simulated answer must be
 * traceable through every consumer so the Photoreal handoff can refuse to
 * reach the real backend under it. This module emits 'native' and nothing
 * else -- asserted in __tests__/vtoLiveHarnessInertness.test.js -- so a
 * 'simulated' value can only have been constructed by the dev harness.
 */
export type LiveVtoCapabilityProvenance = 'native' | 'simulated';

export type LiveVtoNativeCapability =
  | {
      present: true;
      capable: boolean;
      runtimeReady: boolean;
      runtimeVersion: string | null;
      /** Evidence provenance. Every value this module produces is 'native';
       *  'simulated' can only be constructed by the development harness, and
       *  the router reads this field rather than trusting a caller to declare
       *  the source. See services/vto/vtoLiveHarness.ts. */
      provenance: LiveVtoCapabilityProvenance;
      reason: null;
    }
  | {
      present: false;
      capable: false;
      runtimeReady: false;
      runtimeVersion: null;
      provenance: LiveVtoCapabilityProvenance;
      reason: LiveVtoNativeAbsenceReason;
    };

function absent(reason: LiveVtoNativeAbsenceReason): LiveVtoNativeCapability {
  return {
    present: false,
    capable: false,
    runtimeReady: false,
    runtimeVersion: null,
    provenance: 'native',
    reason,
  };
}

/** Memoized lookup result. `undefined` means "not looked up yet"; `null` means
 *  "looked up, and there is no module". */
let cachedModule: LiveVtoNativeModule | null | undefined;

export function resetLiveVtoNativeModuleCache(): void {
  cachedModule = undefined;
}

/**
 * Resolves the optional module, once.
 *
 * The `require` is inside the function rather than at module scope so this
 * file can be imported (and unit-tested) with no native environment at all.
 */
export function getLiveVtoNativeModule(): LiveVtoNativeModule | null {
  if (cachedModule !== undefined) return cachedModule;
  if (!LIVE_VTO_SUPPORTED_PLATFORMS.includes(Platform.OS)) {
    cachedModule = null;
    return cachedModule;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const core = require('expo-modules-core') as {
      requireOptionalNativeModule?: <T>(name: string) => T | null;
    };
    cachedModule = typeof core?.requireOptionalNativeModule === 'function'
      ? core.requireOptionalNativeModule<LiveVtoNativeModule>(LIVE_VTO_NATIVE_MODULE_NAME) ?? null
      : null;
  } catch {
    // A resolution failure is indistinguishable from absence for our purposes,
    // and both mean the same thing: no Live.
    cachedModule = null;
  }
  return cachedModule;
}

/**
 * The conservative capability answer.
 *
 * Deliberately synchronous and total: it never awaits, never retries, and
 * never throws. A capability question that can hang is a VTO sheet that can
 * hang, and the honest answer while we do not know is "no".
 */
export function describeLiveVtoNativeCapability(
  deps?: { module?: LiveVtoNativeModule | null; platformOS?: string },
): LiveVtoNativeCapability {
  const platformOS = deps?.platformOS ?? Platform.OS;
  if (!LIVE_VTO_SUPPORTED_PLATFORMS.includes(platformOS)) {
    return absent('unsupported_platform');
  }

  const nativeModule = deps?.module !== undefined ? deps.module : getLiveVtoNativeModule();
  if (!nativeModule) return absent('module_missing');
  if (typeof nativeModule.getCapability !== 'function') return absent('lookup_failed');

  let selfCheck: LiveVtoNativeSelfCheck | null = null;
  try {
    selfCheck = nativeModule.getCapability();
  } catch {
    return absent('lookup_failed');
  }
  if (!selfCheck || typeof selfCheck !== 'object') return absent('lookup_failed');

  // `=== true` rather than truthiness: a module returning a string, a number,
  // or a Promise must not read as an affirmation.
  return {
    present: true,
    capable: selfCheck.capable === true,
    runtimeReady: selfCheck.runtimeReady === true,
    runtimeVersion:
      typeof selfCheck.runtimeVersion === 'string' ? selfCheck.runtimeVersion : null,
    provenance: 'native',
    reason: null,
  };
}

/** The single predicate the router asks. Both halves required -- see the
 *  module header on why registration alone is not capability. */
export function isLiveVtoNativeCapable(capability: LiveVtoNativeCapability): boolean {
  return capability.present === true && capability.capable === true && capability.runtimeReady === true;
}

// ─── Command adapter ─────────────────────────────────────────────────────────

/**
 * Wraps one command so a native throw becomes a boolean, never an exception
 * in a React event handler. Commands are fire-and-forget by contract: the
 * runtime reports what actually happened through events, not return values.
 */
export function sendLiveVtoCommand(
  nativeModule: LiveVtoNativeModule | null,
  run: (target: LiveVtoNativeModule) => void,
): boolean {
  if (!nativeModule) return false;
  try {
    run(nativeModule);
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalizes one inbound native event and enforces the raw-data boundary on
 * it before anything else in the app can see it.
 *
 * Returns null for anything malformed or forbidden. Dropping is deliberate:
 * a payload carrying a mask is a contract violation, and the correct handling
 * of a contract violation is to not propagate it -- not to render it, and not
 * to log it (logging camera-derived data is exactly what Section 17 forbids).
 */
export function normalizeLiveVtoEvent(raw: unknown): LiveVtoEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as { type?: unknown; timestamp?: unknown; payload?: unknown };
  if (typeof candidate.type !== 'string') return null;
  const payload = candidate.payload ?? {};
  try {
    assertNoRawLiveData(payload, candidate.type);
  } catch {
    return null;
  }
  return {
    type: candidate.type as LiveVtoEvent['type'],
    timestamp: typeof candidate.timestamp === 'number' ? candidate.timestamp : Date.now(),
    payload: payload as LiveVtoEvent['payload'],
  };
}
