import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_FEATURE_FREEZE_CONFIG,
  type FeatureKey,
} from '../constants/featureFlags';
import {
  applyDevFeatureFreezeOverride,
  isFeatureEnabledForFreeze,
  loadFeatureFreezeConfig,
  readCachedFeatureFreezeConfig,
  type FeatureFreezeConfig,
} from '../services/featureFreeze';

type FeatureFreezeContextValue = {
  config: FeatureFreezeConfig;
  isFrozen: boolean;
  isLoading: boolean;
  message: string;
  source: 'remote' | 'cache' | 'default';
  remoteError: boolean;
  refresh: () => Promise<void>;
  isFeatureEnabled: (featureKey: FeatureKey) => boolean;
};

const FeatureFreezeContext = createContext<FeatureFreezeContextValue | null>(null);

export function FeatureFreezeProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState<FeatureFreezeConfig>(
    applyDevFeatureFreezeOverride({ ...DEFAULT_FEATURE_FREEZE_CONFIG }),
  );
  const [isLoading, setIsLoading] = useState(true);
  const [source, setSource] = useState<'remote' | 'cache' | 'default'>('default');
  const [remoteError, setRemoteError] = useState(false);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = await loadFeatureFreezeConfig();
      setConfig(result.config);
      setSource(result.source);
      setRemoteError(result.remoteError);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    readCachedFeatureFreezeConfig()
      .then((cached) => {
        if (mounted && cached) {
          setConfig(applyDevFeatureFreezeOverride(cached));
          setSource('cache');
        }
      })
      .finally(() => {
        void refresh();
      });

    return () => {
      mounted = false;
    };
  }, [refresh]);

  const value = useMemo<FeatureFreezeContextValue>(() => {
    const isFrozen = config.featureFreeze;
    return {
      config,
      isFrozen,
      isLoading,
      message: config.freezeMessage,
      source,
      remoteError,
      refresh,
      isFeatureEnabled: (featureKey) => isFeatureEnabledForFreeze(featureKey, isFrozen),
    };
  }, [config, isLoading, remoteError, refresh, source]);

  return (
    <FeatureFreezeContext.Provider value={value}>
      {children}
    </FeatureFreezeContext.Provider>
  );
}

export function useFeatureFreezeContext() {
  const value = useContext(FeatureFreezeContext);
  if (!value) {
    throw new Error('useFeatureFreeze must be used inside FeatureFreezeProvider');
  }
  return value;
}
