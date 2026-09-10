/**
 * PH35-R3 — the canonical K Scan analytics event registry.
 *
 * ENGINEERING AUTHORITY ONLY. This is not regulatory documentation; it is the
 * machine-readable source of truth the runtime boundary
 * (analyticsBoundary.ts) enforces, and the thing a future event-wiring lane
 * extends.
 *
 * COMPOSED, NOT COPIED. Every event name and property key here is imported
 * from the feature telemetry module that already owns it. Re-typing those
 * lists would create a second authority that drifts the first time somebody
 * edits one and not the other — so the registry adds governance metadata
 * around the existing allowlists rather than restating them.
 *
 * PROPERTY SCOPE IS PER SURFACE, NOT PER EVENT. That is what the shipped
 * sinks actually enforce today: `closetTelemetry` validates any of its 40
 * events against one shared property allowlist. Narrowing to per-event
 * property sets would mean inventing 80 contracts from the outside and
 * guessing which call site passes what — a large speculative change with real
 * odds of silently dropping a live property. Recorded as a known limitation
 * and left to the event-wiring lane, which can tighten each event as it is
 * actually reviewed. See DEFERRED in the PR.
 */

import { CLOSET_CANDIDATE_EVENTS, CLOSET_CANDIDATE_EVENT_PROPERTIES } from '../closetTelemetry';
import { KPLUS_EVENTS, KPLUS_EVENT_PROPERTIES } from '../kplus/kplusTelemetry';
import {
  TODAY_WITH_ELISE_EVENTS,
  TODAY_WITH_ELISE_EVENT_PROPERTIES,
} from '../todayWithElise/analytics';
import { VOICE_EVENTS, VOICE_EVENT_PROPERTIES } from '../voice/voiceTelemetry';
import { VTO_EVENTS, VTO_EVENT_PROPERTIES } from '../vto/vtoTelemetry';

/** Primitive kinds a governed property value may take. */
export type AnalyticsValueKind = 'enum' | 'bucket' | 'boolean' | 'number' | 'null';

export type AnalyticsSurface = 'closet' | 'kplus' | 'today_with_elise' | 'voice' | 'vto';

export interface AnalyticsSurfaceContract {
  surface: AnalyticsSurface;
  /** The module that owns and pre-validates these events. */
  owner: string;
  events: readonly string[];
  properties: readonly string[];
  valueKinds: readonly AnalyticsValueKind[];
  /** Every governed event is emittable without an authenticated session. */
  anonymousAllowed: boolean;
  purpose: string;
  /** How damaging a property-allowlist mistake on this surface would be. */
  privacySensitivity: 'low' | 'medium' | 'high';
  commerceSensitivity: 'none' | 'low';
}

export const ANALYTICS_SURFACE_CONTRACTS: readonly AnalyticsSurfaceContract[] = [
  {
    surface: 'closet',
    owner: 'services/closetTelemetry.ts',
    events: CLOSET_CANDIDATE_EVENTS,
    properties: CLOSET_CANDIDATE_EVENT_PROPERTIES,
    valueKinds: ['enum', 'bucket', 'boolean', 'number', 'null'],
    anonymousAllowed: true,
    purpose:
      'Closet candidate intake, classification, cloud sync/restore/migration, and the local Mirror Selfie extraction pipeline — shape and outcome only.',
    // Highest of the five: it is the surface closest to user photographs, so
    // an allowlist mistake here is the one that would matter most.
    privacySensitivity: 'high',
    commerceSensitivity: 'none',
  },
  {
    surface: 'kplus',
    owner: 'services/kplus/kplusTelemetry.ts',
    events: KPLUS_EVENTS,
    properties: KPLUS_EVENT_PROPERTIES,
    valueKinds: ['enum', 'null'],
    anonymousAllowed: true,
    purpose: 'K+ early-access discovery, gating and activation funnel.',
    privacySensitivity: 'low',
    // Entitlement state only — never a price, order, SKU or retailer.
    commerceSensitivity: 'low',
  },
  {
    surface: 'today_with_elise',
    owner: 'services/todayWithElise/analytics.ts',
    events: TODAY_WITH_ELISE_EVENTS,
    properties: TODAY_WITH_ELISE_EVENT_PROPERTIES,
    valueKinds: ['enum', 'bucket', 'boolean', 'number', 'null'],
    anonymousAllowed: true,
    purpose: 'Today with Elise card funnel: eligibility, impression, action, dressing-room handoff.',
    privacySensitivity: 'medium',
    commerceSensitivity: 'none',
  },
  {
    surface: 'voice',
    owner: 'services/voice/voiceTelemetry.ts',
    events: VOICE_EVENTS,
    properties: VOICE_EVENT_PROPERTIES,
    valueKinds: ['enum', 'boolean', 'number', 'null'],
    anonymousAllowed: true,
    purpose: 'Voice scan permission, on-device availability and transcription outcome.',
    // Adjacent to speech, so the "no transcript" boundary matters here.
    privacySensitivity: 'high',
    commerceSensitivity: 'none',
  },
  {
    surface: 'vto',
    owner: 'services/vto/vtoTelemetry.ts',
    events: VTO_EVENTS,
    properties: VTO_EVENT_PROPERTIES,
    valueKinds: ['enum', 'bucket', 'boolean', 'number', 'null'],
    anonymousAllowed: true,
    purpose: 'Virtual Try-On entry, request lifecycle, retries and result interaction.',
    // Adjacent to person imagery.
    privacySensitivity: 'high',
    commerceSensitivity: 'none',
  },
] as const;

export interface RegisteredEvent {
  event: string;
  surface: AnalyticsSurface;
  properties: ReadonlySet<string>;
  anonymousAllowed: boolean;
}

function buildRegistry(): ReadonlyMap<string, RegisteredEvent> {
  const registry = new Map<string, RegisteredEvent>();
  for (const contract of ANALYTICS_SURFACE_CONTRACTS) {
    const properties: ReadonlySet<string> = new Set(contract.properties);
    for (const event of contract.events) {
      // A name colliding across surfaces would make the winning contract
      // depend on declaration order. Keep the first and let the governance
      // test fail loudly rather than silently widening a property set.
      if (registry.has(event)) continue;
      registry.set(event, {
        event,
        surface: contract.surface,
        properties,
        anonymousAllowed: contract.anonymousAllowed,
      });
    }
  }
  return registry;
}

export const ANALYTICS_EVENT_REGISTRY = buildRegistry();

export function isRegisteredAnalyticsEvent(event: string): boolean {
  return ANALYTICS_EVENT_REGISTRY.has(event);
}

export function registeredAnalyticsEventCount(): number {
  return ANALYTICS_EVENT_REGISTRY.size;
}

/** Every event name declared across all surfaces, duplicates included. */
export function declaredAnalyticsEventNames(): string[] {
  return ANALYTICS_SURFACE_CONTRACTS.flatMap((contract) => [...contract.events]);
}
