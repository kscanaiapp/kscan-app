/**
 * Client-side read of the VTO remote control row.
 *
 * UX ONLY. This decides whether the app renders a Try It On affordance; it
 * decides nothing about whether a generation may happen. The server re-reads
 * the same `app_config` row with the service role and refuses anything it
 * disagrees with, so a stale or tampered client can at worst show a button
 * that then fails closed with `feature_disabled`.
 *
 * DELIBERATELY NOT CACHED. featureFreeze.ts caches its config so the app is
 * usable offline, and that is right for a freeze switch: the cached answer is
 * the conservative one. Here the cached answer would be the permissive one --
 * a kill switch that keeps showing the feature for as long as a device holds
 * a stale "enabled" is not a kill switch. An unreadable config is disabled.
 */

import { supabase } from '../supabaseClient';
import { VTO_CONFIG_KEY } from '../../constants/featureFlags';
import { DEFAULT_VTO_SUPPORTED_CATEGORIES } from './vtoEligibility';
import { DEFAULT_LIVE_VTO_SUPPORTED_CATEGORIES } from './vtoLiveGarment';

const FETCH_TIMEOUT_MS = 2500;

export interface VtoRemoteConfig {
  enabled: boolean;
  supportedCategories: readonly string[];
  /**
   * LIVE VTO operator switch, read from the SAME app_config row rather than a
   * new control provider (P3-C Section 13: do not introduce one solely for
   * this lane). Additive and independent: `enabled` continues to govern the
   * generative surface exactly as before, and neither value can turn the
   * other on or off.
   *
   * Absent, malformed, or non-boolean all read as FALSE. A row written before
   * this field existed -- which is every row in every environment today --
   * therefore leaves Live off, which is the intended launch posture.
   */
  liveEnabled: boolean;
  /** Categories Live may render, narrowable by config. Never widened past what
   *  the native runtime implements -- see services/vto/vtoLiveGarment.ts. */
  liveSupportedCategories: readonly string[];
}

export const DISABLED_VTO_REMOTE_CONFIG: VtoRemoteConfig = Object.freeze({
  enabled: false,
  supportedCategories: DEFAULT_VTO_SUPPORTED_CATEGORIES,
  liveEnabled: false,
  liveSupportedCategories: DEFAULT_LIVE_VTO_SUPPORTED_CATEGORIES,
});

export function normalizeVtoRemoteConfig(payload: unknown): VtoRemoteConfig {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return DISABLED_VTO_REMOTE_CONFIG;
  }
  const raw = payload as Record<string, unknown>;
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) {
    return DISABLED_VTO_REMOTE_CONFIG;
  }
  const categories = normalizeCategoryList(raw.supportedCategories, DEFAULT_VTO_SUPPORTED_CATEGORIES);

  // The Live block is read from a nested `live` object rather than sibling
  // keys, so an operator editing the generative row cannot enable Live by
  // accident, and so a row that predates Live parses to "off" rather than to
  // something ambiguous.
  const live =
    raw.live && typeof raw.live === 'object' && !Array.isArray(raw.live)
      ? (raw.live as Record<string, unknown>)
      : null;

  return {
    enabled: raw.enabled === true,
    supportedCategories: categories,
    liveEnabled: live?.enabled === true,
    liveSupportedCategories: normalizeCategoryList(
      live?.supportedCategories,
      DEFAULT_LIVE_VTO_SUPPORTED_CATEGORIES,
    ),
  };
}

/**
 * An allow-list is taken from config only when EVERY entry is a usable string:
 * a partially-malformed list falls back to the conservative default whole,
 * rather than silently shipping the subset that happened to parse.
 */
function normalizeCategoryList(
  value: unknown,
  fallback: readonly string[],
): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  const entries = value.filter(
    (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
  );
  if (entries.length !== value.length) return fallback;
  return entries.map((entry) => entry.trim().toLowerCase());
}

function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('VTO config fetch timed out')), timeoutMs);
    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

type ConfigRowReader = () => PromiseLike<{ data: { value?: unknown } | null; error: unknown }>;

const defaultReader: ConfigRowReader = () =>
  supabase
    .from('app_config')
    .select('value')
    .eq('key', VTO_CONFIG_KEY)
    .maybeSingle<{ value?: unknown }>();

export async function fetchVtoRemoteConfig(deps?: {
  read?: ConfigRowReader;
}): Promise<VtoRemoteConfig> {
  try {
    const read = deps?.read ?? defaultReader;
    const { data, error } = await withTimeout(read(), FETCH_TIMEOUT_MS);
    if (error) return DISABLED_VTO_REMOTE_CONFIG;
    return normalizeVtoRemoteConfig(data?.value);
  } catch {
    return DISABLED_VTO_REMOTE_CONFIG;
  }
}

/**
 * Short-lived in-memory memo, so a shelf of ten product cards asks once
 * instead of ten times.
 *
 * In memory only and deliberately brief: this is a kill switch, and a switch
 * whose "off" takes an app restart to arrive is not one. It is never written
 * to storage, so it cannot survive a relaunch.
 */
export const VTO_CONFIG_MEMO_TTL_MS = 60_000;

let memo: { value: VtoRemoteConfig; expiresAt: number } | null = null;
let inFlight: Promise<VtoRemoteConfig> | null = null;

export function resetVtoRemoteConfigCache(): void {
  memo = null;
  inFlight = null;
}

export async function getVtoRemoteConfig(deps?: {
  read?: ConfigRowReader;
  nowMs?: number;
}): Promise<VtoRemoteConfig> {
  const now = deps?.nowMs ?? Date.now();
  if (memo && memo.expiresAt > now) return memo.value;
  if (inFlight) return inFlight;

  inFlight = fetchVtoRemoteConfig(deps)
    .then((value) => {
      // A failed read is NOT memoized: retrying a disabled answer costs one
      // query, whereas caching it would hide a feature that is actually on.
      // `liveEnabled` counts here too -- a row that enables only Live is still
      // a successful read, and re-querying it every call would be a needless
      // request storm on a shelf of product cards.
      if (value.enabled || value.liveEnabled) {
        memo = { value, expiresAt: (deps?.nowMs ?? Date.now()) + VTO_CONFIG_MEMO_TTL_MS };
      }
      return value;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}
