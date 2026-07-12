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
  refresh: () => Promise<void>;
  isFeatureEnabled: (featureKey: FeatureKey) => boolean;
};

const FeatureFreezeContext = createContext<FeatureFreezeContextValue | null>(null);

export function FeatureFreezeProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState<FeatureFreezeConfig>(
    applyDevFeatureFreezeOverride({ ...DEFAULT_FEATURE_FREEZE_CONFIG }),
  );
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = await loadFeatureFreezeConfig();
      setConfig(result.config);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    const initialize = async () => {
      const cached = await readCachedFeatureFreezeConfig();
      if (mounted && cached) {
        setConfig(applyDevFeatureFreezeOverride(cached));
      }

      const result = await loadFeatureFreezeConfig();
      if (mounted) {
        setConfig(result.config);
        setIsLoading(false);
      }
    };

    void initialize();

    return () => {
      mounted = false;
    };
  }, []);

  const value = useMemo<FeatureFreezeContextValue>(() => {
    const isFrozen = config.featureFreeze;
    return {
      config,
      isFrozen,
      isLoading,
      message: config.freezeMessage,
      refresh,
      isFeatureEnabled: (featureKey) => isFeatureEnabledForFreeze(featureKey, isFrozen),
    };
  }, [config, isLoading, refresh]);

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
