/**
 * Development-only Live capability harness.
 *
 * WHY IT EXISTS. No build in any environment carries a Live VTO native
 * runtime today, so the capability router, the mode selector, the fallback,
 * the permission path and the Live session states have no way to be exercised
 * in a running app. This harness lets a developer put those UI/state paths
 * into a chosen high-level condition. That is its entire purpose.
 *
 * FOUR HARD LIMITS, each mechanical rather than promised:
 *
 *   1. DEVELOPMENT ONLY. LIVE_VTO_HARNESS_ENABLED is computed from an inline
 *      `__DEV__` literal, so in a release build it folds to a constant false
 *      and every entry point below returns "inactive" before reading anything
 *      else. There is no environment variable a production build could carry
 *      that would change that.
 *   2. EXPLICITLY ACTIVATED. Even in development it is inert until
 *      `activateLiveVtoHarness` is called with a scenario. Merely setting the
 *      variable arms the switch; it does not flip it.
 *   3. CANNOT IMPERSONATE NATIVE EVIDENCE. Every capability it produces
 *      carries `provenance: 'simulated'`, and the router derives its
 *      `evidenceSource` from that field rather than from a caller's word. A
 *      harness answer is therefore visible as simulated at every consumer.
 *   4. PROVIDER-INERT. It injects no camera frames -- it has no frame concept
 *      at all, only capability and session STATES -- and
 *      services/vto/vtoPhotorealHandoff.ts refuses to build a generative
 *      request while it is active. A simulated Live session can never spend a
 *      real generation, a real quota attempt, or a real provider call.
 */

import { LIVE_VTO_HARNESS_ENABLED } from '../../constants/featureFlags';
import type { LiveVtoNativeCapability } from './liveVtoNativeModule';
import type { VtoCameraPermissionState } from './vtoLiveCapability';
import type { LiveVtoSessionState } from '../../types/vtoLive';

export const LIVE_VTO_HARNESS_SCENARIOS = [
  'LIVE_AVAILABLE',
  'LIVE_UNAVAILABLE',
  'PERMISSION_DENIED',
  'MODULE_MISSING',
  'TRACKING_LOST',
  'PHOTOREAL_UNAVAILABLE',
] as const;
export type LiveVtoHarnessScenario = (typeof LIVE_VTO_HARNESS_SCENARIOS)[number];

export interface LiveVtoHarnessState {
  scenario: LiveVtoHarnessScenario;
  nativeCapability: LiveVtoNativeCapability;
  cameraPermission: VtoCameraPermissionState;
  /** The session state a simulated Live surface should settle into, or null
   *  when the scenario never reaches a session at all. */
  sessionState: LiveVtoSessionState | null;
  /** Whether a simulated Photoreal request should report unavailable. Note
   *  this is about the SIMULATED outcome; a real request is refused under the
   *  harness regardless, by vtoPhotorealHandoff. */
  photorealUnavailable: boolean;
  /** Always true. Read by the handoff guard and asserted by test. */
  readonly providerInert: true;
}

function simulatedCapable(): LiveVtoNativeCapability {
  return {
    present: true,
    capable: true,
    runtimeReady: true,
    runtimeVersion: 'harness-simulated',
    provenance: 'simulated',
    reason: null,
  };
}

function simulatedAbsent(): LiveVtoNativeCapability {
  return {
    present: false,
    capable: false,
    runtimeReady: false,
    runtimeVersion: null,
    provenance: 'simulated',
    reason: 'module_missing',
  };
}

/** A device that registers the module but reports itself unable to run it --
 *  the case a registration-only capability check would get wrong. */
function simulatedIncapable(): LiveVtoNativeCapability {
  return {
    present: true,
    capable: false,
    runtimeReady: false,
    runtimeVersion: 'harness-simulated',
    provenance: 'simulated',
    reason: null,
  };
}

const SCENARIOS: Readonly<Record<LiveVtoHarnessScenario, Omit<LiveVtoHarnessState, 'scenario'>>> = {
  LIVE_AVAILABLE: {
    nativeCapability: simulatedCapable(),
    cameraPermission: 'granted',
    sessionState: 'TRACKING',
    photorealUnavailable: false,
    providerInert: true,
  },
  LIVE_UNAVAILABLE: {
    nativeCapability: simulatedIncapable(),
    cameraPermission: 'undetermined',
    sessionState: null,
    photorealUnavailable: false,
    providerInert: true,
  },
  PERMISSION_DENIED: {
    nativeCapability: simulatedCapable(),
    cameraPermission: 'denied',
    sessionState: null,
    photorealUnavailable: false,
    providerInert: true,
  },
  MODULE_MISSING: {
    nativeCapability: simulatedAbsent(),
    cameraPermission: 'undetermined',
    sessionState: null,
    photorealUnavailable: false,
    providerInert: true,
  },
  TRACKING_LOST: {
    nativeCapability: simulatedCapable(),
    cameraPermission: 'granted',
    sessionState: 'TRACKING_LOST',
    photorealUnavailable: false,
    providerInert: true,
  },
  PHOTOREAL_UNAVAILABLE: {
    nativeCapability: simulatedCapable(),
    cameraPermission: 'granted',
    sessionState: 'TRACKING',
    photorealUnavailable: true,
    providerInert: true,
  },
};

let active: LiveVtoHarnessScenario | null = null;

/**
 * Arms a scenario. Returns false -- changing nothing -- whenever the harness
 * is not permitted, which in a release build is unconditional.
 */
export function activateLiveVtoHarness(scenario: LiveVtoHarnessScenario): boolean {
  if (!LIVE_VTO_HARNESS_ENABLED) return false;
  if (!(LIVE_VTO_HARNESS_SCENARIOS as readonly string[]).includes(scenario)) return false;
  active = scenario;
  return true;
}

export function deactivateLiveVtoHarness(): void {
  active = null;
}

/** True only in a development build with a scenario explicitly armed. */
export function isLiveVtoHarnessActive(): boolean {
  return LIVE_VTO_HARNESS_ENABLED && active !== null;
}

/**
 * The armed scenario's simulated evidence, or null.
 *
 * Callers substitute this for the real native/permission inputs to the
 * router. They do not need to remember to mark it as simulated: the
 * capability's own `provenance` carries that, and the router reads it.
 */
export function getLiveVtoHarnessState(): LiveVtoHarnessState | null {
  if (!isLiveVtoHarnessActive() || !active) return null;
  return { scenario: active, ...SCENARIOS[active] };
}
