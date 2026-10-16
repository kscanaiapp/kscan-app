/**
 * React binding for the Try-On Studio.
 *
 * The decision is made by the pure model in services/vto/vtoStudio.ts; this
 * hook only gathers its inputs from authorities that already exist (the build
 * flags, the sign-in state, the one memoized remote row every Try It On control
 * shares, the canonical K+ answer, the native Live capability and this
 * account's awareness history) and re-renders when one changes.
 *
 * It cannot start a generation: nothing imported here can reach a provider, a
 * photo chooser or a camera. The only network read is the shared remote row.
 *
 * ACCOUNT SWITCH. History is read per actor and the remote row is reset on
 * sign-out, so one account never renders from another's state. Until the
 * history is read, `everUsed` is unknown (null), and an unknown never claims
 * "returning": the Dressing Rooms action is added only once it is known true.
 */

import { useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';

import { LIVE_VTO_ENABLED, VTO_UI_ENABLED } from '../constants/featureFlags';
import { useAuthSession } from '../contexts/AuthSessionContext';
import { useVtoActorKPlusState } from './useVtoAwareness';
import { getVtoRemoteConfig } from '../services/vto/vtoFeatureControl';
import {
  describeLiveVtoNativeCapability,
  isLiveVtoNativeCapable,
  LIVE_VTO_SUPPORTED_PLATFORMS,
} from '../services/vto/liveVtoNativeModule';
import { getLiveVtoHarnessState } from '../services/vto/vtoLiveHarness';
import { loadVtoAwareness, readVtoAwareness, subscribeVtoAwareness } from '../services/vto/vtoAwareness';
import { resolveVtoStudio, type VtoStudioDecision } from '../services/vto/vtoStudio';

export function useVtoStudio(): VtoStudioDecision {
  const { user, isAuthenticated } = useAuthSession();
  const actorId = isAuthenticated ? user?.id ?? null : null;
  const kplus = useVtoActorKPlusState();
  const [, setRevision] = useState(0);
  const [remote, setRemote] = useState<{ enabled: boolean; liveEnabled: boolean } | null>(null);

  useEffect(() => subscribeVtoAwareness(() => setRevision((revision) => revision + 1)), []);

  useEffect(() => {
    if (!VTO_UI_ENABLED || !actorId) return;
    void loadVtoAwareness();
  }, [actorId]);

  useEffect(() => {
    if (!VTO_UI_ENABLED || !isAuthenticated) {
      setRemote(null);
      return undefined;
    }
    let cancelled = false;
    void getVtoRemoteConfig().then((config) => {
      if (cancelled) return;
      setRemote({ enabled: config.enabled === true, liveEnabled: config.liveEnabled === true });
    });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, actorId]);

  const awareness = actorId ? readVtoAwareness() : null;

  // Live is offered only on a verified NATIVE capability. The development
  // harness is a test double and never counts as customer-facing Live.
  //
  // THE NATIVE PROBE IS THE LAST GATE, NOT THE FIRST. describeLiveVtoNativeCapability
  // calls the native module's getCapability() whenever a module is present, so
  // it is asked only when the build flag, the remote switch and the platform
  // already agree -- the same cheap-gates-first order useVtoLiveCapability uses
  // for its permission read. With Live disabled (every shipped profile today),
  // Home never touches native Live code, and the answer is cached rather than
  // re-probed on every render.
  const harness = getLiveVtoHarnessState();
  const liveGatesOpen =
    LIVE_VTO_ENABLED
    && remote?.enabled === true
    && remote.liveEnabled === true
    && LIVE_VTO_SUPPORTED_PLATFORMS.includes(Platform.OS);
  const liveNativeCapable = useMemo(
    () => liveGatesOpen && harness === null && isLiveVtoNativeCapable(describeLiveVtoNativeCapability()),
    [liveGatesOpen, harness],
  );

  return resolveVtoStudio({
    uiEnabled: VTO_UI_ENABLED,
    authenticated: isAuthenticated,
    remote,
    kplus,
    liveBuildEnabled: LIVE_VTO_ENABLED,
    liveNativeCapable,
    everUsed: awareness ? awareness.initiated === true || awareness.completed === true : null,
  });
}
