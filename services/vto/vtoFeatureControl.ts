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

const FETCH_TIMEOUT_MS = 2500;

export interface VtoRemoteConfig {
  enabled: boolean;
  supportedCategories: readonly string[];
}

export const DISABLED_VTO_REMOTE_CONFIG: VtoRemoteConfig = Object.freeze({
  enabled: false,
  supportedCategories: DEFAULT_VTO_SUPPORTED_CATEGORIES,
});

export function normalizeVtoRemoteConfig(payload: unknown): VtoRemoteConfig {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return DISABLED_VTO_REMOTE_CONFIG;
  }
  const raw = payload as Record<string, unknown>;
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) {
    return DISABLED_VTO_REMOTE_CONFIG;
  }
  const categories = Array.isArray(raw.supportedCategories)
    ? raw.supportedCategories.filter(
        (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
      )
    : null;
  return {
    enabled: raw.enabled === true,
    supportedCategories:
      categories && categories.length === (raw.supportedCategories as unknown[]).length
        ? categories.map((entry) => entry.trim().toLowerCase())
        : DEFAULT_VTO_SUPPORTED_CATEGORIES,
  };
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
      if (value.enabled) {
        memo = { value, expiresAt: (deps?.nowMs ?? Date.now()) + VTO_CONFIG_MEMO_TTL_MS };
      }
      return value;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}
