import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  CORE_FEATURE_SET,
  DEFAULT_FEATURE_FREEZE_CONFIG,
  DEV_FEATURE_FREEZE_OVERRIDE,
  FEATURE_FREEZE_CONFIG_KEY,
  type FeatureKey,
} from '../constants/featureFlags';
import { supabase } from './supabaseClient';

const CACHE_KEY = '@kscan/mobile_feature_freeze_config';
const FETCH_TIMEOUT_MS = 2500;

export type FeatureFreezeConfig = {
  schemaVersion: 1;
  featureFreeze: boolean;
  freezeMessage: string;
  updatedAt: string | null;
};

type RemoteAppConfigRow = {
  value?: unknown;
};

export function normalizeFeatureFreezeConfig(payload: unknown): FeatureFreezeConfig {
  if (!payload || typeof payload !== 'object') {
    return { ...DEFAULT_FEATURE_FREEZE_CONFIG };
  }

  const raw = payload as Record<string, unknown>;
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) {
    return { ...DEFAULT_FEATURE_FREEZE_CONFIG };
  }

  return {
    schemaVersion: 1,
    featureFreeze: typeof raw.featureFreeze === 'boolean' ? raw.featureFreeze : false,
    freezeMessage:
      typeof raw.freezeMessage === 'string' && raw.freezeMessage.trim()
        ? raw.freezeMessage.trim()
        : DEFAULT_FEATURE_FREEZE_CONFIG.freezeMessage,
    updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt.trim() ? raw.updatedAt : null,
  };
}

export function applyDevFeatureFreezeOverride(config: FeatureFreezeConfig): FeatureFreezeConfig {
  if (typeof __DEV__ !== 'undefined' && __DEV__ && DEV_FEATURE_FREEZE_OVERRIDE !== null) {
    return {
      ...config,
      featureFreeze: DEV_FEATURE_FREEZE_OVERRIDE,
    };
  }

  return config;
}

export function isFeatureEnabledForFreeze(featureKey: FeatureKey, isFrozen: boolean): boolean {
  // Beta implementation: featureFreeze is a global non-core kill switch.
  // Core features always return enabled. Non-core features return disabled
  // only when featureFreeze is true. Per-feature remote controls are deferred.
  if (!isFrozen) return true;
  return CORE_FEATURE_SET.has(featureKey);
}

export async function readCachedFeatureFreezeConfig(): Promise<FeatureFreezeConfig | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = normalizeFeatureFreezeConfig(JSON.parse(raw));
    return parsed.schemaVersion === 1 ? parsed : null;
  } catch (error) {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.warn('[K-SCAN FeatureFreeze] cache read failed');
    }
    return null;
  }
}

export async function cacheFeatureFreezeConfig(config: FeatureFreezeConfig): Promise<void> {
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(config));
  } catch {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.warn('[K-SCAN FeatureFreeze] cache write failed');
    }
  }
}

function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Feature freeze config fetch timed out')), timeoutMs);
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

export async function fetchRemoteFeatureFreezeConfig(): Promise<FeatureFreezeConfig> {
  const request = supabase
    .from('app_config')
    .select('value')
    .eq('key', FEATURE_FREEZE_CONFIG_KEY)
    .maybeSingle<RemoteAppConfigRow>();

  const { data, error } = await withTimeout(request, FETCH_TIMEOUT_MS);

  if (error) throw error;

  return normalizeFeatureFreezeConfig(data?.value);
}

export async function loadFeatureFreezeConfig(): Promise<{
  config: FeatureFreezeConfig;
  source: 'remote' | 'cache' | 'default';
}> {
  const cached = await readCachedFeatureFreezeConfig();

  try {
    const remote = await fetchRemoteFeatureFreezeConfig();
    await cacheFeatureFreezeConfig(remote);
    return { config: applyDevFeatureFreezeOverride(remote), source: 'remote' };
  } catch {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      // The cache/default path is an expected, non-blocking startup fallback.
      // Keep it observable without creating a React Native LogBox badge.
      console.info('[K-SCAN FeatureFreeze] remote fetch failed; using cache/default');
    }
    if (cached) {
      return { config: applyDevFeatureFreezeOverride(cached), source: 'cache' };
    }
    return { config: applyDevFeatureFreezeOverride({ ...DEFAULT_FEATURE_FREEZE_CONFIG }), source: 'default' };
  }
}
