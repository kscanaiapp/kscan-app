/**
 * Resolves whether a VTO entry point should be offered for a given item.
 *
 * NO LONGER THE CUSTOMER-ENTRY AUTHORITY (VTO V2). This hook answers the
 * GENERATIVE half only, which is exactly why it could not stay the entry
 * point's gate: an item with a governed Live asset was hidden whenever the
 * generative half was off. `resolveVtoMode`
 * (services/vto/vtoModeAuthority.ts), bound by `hooks/useVtoMode.ts`, is now
 * the ONE decision every customer surface asks, and it consumes the same
 * `evaluateVtoEligibility` this hook does -- so the generative rule still has
 * exactly one definition, and it is still the client mirror the server
 * re-derives and wins over. Nothing under `components/` may call this hook;
 * `__tests__/vtoModeAuthority.test.js` asserts that.
 *
 * Composes the four independent questions -- does this build carry VTO, is
 * the feature remotely on, does this actor hold K+, and is this item the kind
 * of thing we can visualize -- into one eligibility answer, so no component
 * re-derives any of them.
 *
 * Every unresolved state is treated as NOT available: loading, an error, a
 * signed-out actor, an unreadable remote config. Nothing here can invent
 * access the server would refuse.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { VTO_UI_ENABLED } from '../constants/featureFlags';
import { useAuthSession } from '../contexts/AuthSessionContext';
import { useKPlusEntitlement } from './useKPlusEntitlement';
import {
  DISABLED_VTO_REMOTE_CONFIG,
  getVtoRemoteConfig,
  type VtoRemoteConfig,
} from '../services/vto/vtoFeatureControl';
import { evaluateVtoEligibility } from '../services/vto/vtoEligibility';
import type { VtoEligibility } from '../types/vto';

export interface UseVtoAvailabilityArgs {
  category: string | null | undefined;
  imageUrl: string | null | undefined;
  productRef: string | null | undefined;
}

export interface UseVtoAvailabilityResult {
  /** True only when the affordance should be rendered as usable. */
  available: boolean;
  /** True when the item is otherwise fine and the ONLY thing missing is K+ --
   *  the one ineligibility worth converting on rather than hiding. */
  upgradeOpportunity: boolean;
  eligibility: VtoEligibility;
  loading: boolean;
  /**
   * LIVE VTO's half of the same remote row, surfaced ADDITIVELY so the Live
   * capability router can reuse the config read this hook already performs
   * instead of issuing a second one.
   *
   * Deliberately raw: this is the operator switch, not a decision. Nothing
   * here says Live is available -- services/vto/vtoLiveCapability.ts is the
   * only place that question is answered, and it needs the native self-check,
   * the garment and the permission state as well. Both fields are false/
   * conservative whenever the config is unread, disabled, or unreadable.
   */
  liveRemoteEnabled: boolean;
  liveSupportedCategories: readonly string[];
}

const UNAVAILABLE: VtoEligibility = { eligible: false, reason: 'feature_disabled' };

export function useVtoAvailability(args: UseVtoAvailabilityArgs): UseVtoAvailabilityResult {
  const { isAuthenticated } = useAuthSession();
  const { isActive: hasKPlus, state: kplusState } = useKPlusEntitlement();
  const [config, setConfig] = useState<VtoRemoteConfig | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    if (!VTO_UI_ENABLED || !isAuthenticated) {
      setConfig(DISABLED_VTO_REMOTE_CONFIG);
      return;
    }
    const generation = ++generationRef.current;
    let cancelled = false;
    void getVtoRemoteConfig().then((next) => {
      // Late resolution after an actor change or unmount must not enable an
      // affordance on somebody else's screen.
      if (cancelled || generation !== generationRef.current) return;
      setConfig(next);
    });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  return useMemo(() => {
    const loading = VTO_UI_ENABLED && isAuthenticated && (config === null || kplusState === 'loading');
    if (!VTO_UI_ENABLED || !isAuthenticated || !config) {
      return {
        available: false,
        upgradeOpportunity: false,
        eligibility: UNAVAILABLE,
        loading,
        liveRemoteEnabled: DISABLED_VTO_REMOTE_CONFIG.liveEnabled,
        liveSupportedCategories: DISABLED_VTO_REMOTE_CONFIG.liveSupportedCategories,
      };
    }

    const eligibility = evaluateVtoEligibility({
      category: args.category,
      imageUrl: args.imageUrl,
      productRef: args.productRef,
      featureEnabled: config.enabled,
      hasEntitlement: hasKPlus,
      supportedCategories: config.supportedCategories,
    });

    // "Would this be eligible if the user had K+" -- asked by re-running the
    // same decision with entitlement granted, so the upgrade prompt can never
    // drift from the real rule.
    const eligibleWithKPlus = evaluateVtoEligibility({
      category: args.category,
      imageUrl: args.imageUrl,
      productRef: args.productRef,
      featureEnabled: config.enabled,
      hasEntitlement: true,
      supportedCategories: config.supportedCategories,
    }).eligible;

    return {
      available: eligibility.eligible,
      upgradeOpportunity: !eligibility.eligible && !loading && eligibleWithKPlus,
      eligibility,
      loading,
      liveRemoteEnabled: config.liveEnabled === true,
      liveSupportedCategories: config.liveSupportedCategories,
    };
  }, [args.category, args.imageUrl, args.productRef, config, hasKPlus, isAuthenticated, kplusState]);
}
