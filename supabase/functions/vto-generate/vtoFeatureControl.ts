/**
 * VTO remote feature control.
 *
 * Reuses the existing governed control surface -- the `app_config` key/value
 * table that already carries `mobile_feature_freeze` -- rather than inventing
 * a feature-flag platform or a VTO-specific table. One new row, one new RLS
 * read policy; see supabase/migrations/*_vto_feature_control.sql.
 *
 * FAILS CLOSED. A missing row, an unreadable table, a malformed value, or an
 * unexpected schemaVersion all resolve to disabled. Generation costs real
 * money and sends a user's photo to a third party: "we could not read the
 * switch" must never mean "proceed".
 */

import { rest } from '../_shared/deletion/common.ts';

export const VTO_CONFIG_KEY = 'vto_generation';

/** Mirrors DEFAULT_VTO_SUPPORTED_CATEGORIES in services/vto/vtoEligibility.ts.
 *  Pinned by __tests__/vtoContractParity.test.js. */
export const DEFAULT_VTO_SUPPORTED_CATEGORIES: readonly string[] = [
  'top',
  'outerwear',
  'blazer',
  'dress',
];

export interface VtoFeatureConfig {
  enabled: boolean;
  provider: string;
  supportedCategories: readonly string[];
  /** Mock-only pacing knob, so an operator can slow or speed the development
   *  provider without a deploy. Ignored by real adapters. */
  mockLatencyMs: number | null;
  /** Mock-only default scenario. */
  mockScenario: string | null;
}

export const DISABLED_VTO_CONFIG: VtoFeatureConfig = Object.freeze({
  enabled: false,
  provider: 'mock',
  supportedCategories: DEFAULT_VTO_SUPPORTED_CATEGORIES,
  mockLatencyMs: null,
  mockScenario: null,
});

function normalizeCategories(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return DEFAULT_VTO_SUPPORTED_CATEGORIES;
  const cleaned = value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim().toLowerCase());
  // An explicitly empty allowlist is a legitimate operator decision ("no
  // category is enabled right now"); only a malformed value falls back.
  return cleaned.length === value.length ? cleaned : DEFAULT_VTO_SUPPORTED_CATEGORIES;
}

export function normalizeVtoFeatureConfig(payload: unknown): VtoFeatureConfig {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return DISABLED_VTO_CONFIG;
  }
  const raw = payload as Record<string, unknown>;
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) {
    return DISABLED_VTO_CONFIG;
  }
  const provider = typeof raw.provider === 'string' && raw.provider.trim()
    ? raw.provider.trim()
    : 'mock';
  const latency = typeof raw.mockLatencyMs === 'number' && Number.isFinite(raw.mockLatencyMs)
    ? Math.max(0, Math.min(60_000, Math.round(raw.mockLatencyMs)))
    : null;
  return {
    enabled: raw.enabled === true,
    provider,
    supportedCategories: normalizeCategories(raw.supportedCategories),
    mockLatencyMs: latency,
    mockScenario: typeof raw.mockScenario === 'string' && raw.mockScenario.trim()
      ? raw.mockScenario.trim()
      : null,
  };
}

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

export async function readVtoFeatureConfig(deps?: { rest?: Fetcher }): Promise<VtoFeatureConfig> {
  const read = deps?.rest ?? rest;
  try {
    const response = await read(
      `app_config?key=eq.${encodeURIComponent(VTO_CONFIG_KEY)}&select=value`,
      { method: 'GET' },
    );
    if (!response.ok) return DISABLED_VTO_CONFIG;
    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length === 0) return DISABLED_VTO_CONFIG;
    return normalizeVtoFeatureConfig(rows[0]?.value);
  } catch {
    return DISABLED_VTO_CONFIG;
  }
}
