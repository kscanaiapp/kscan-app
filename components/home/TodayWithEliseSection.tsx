/**
 * Build 5 — the Home mount point for Today with Elise V1.
 *
 * THE KILL SWITCH LIVES HERE, ABOVE EVERYTHING ELSE. `TODAY_WITH_ELISE_ACTIVE`
 * is checked before the surface is created and before any Today hook is called,
 * so a flag-OFF build performs no orchestration, reads no Closet, reads no
 * Saved Look, creates no session and emits no Today analytics — it renders
 * `null` and Home is byte-for-byte the pre-Build-5 screen.
 *
 * WHY THE GATE IS ITS OWN COMPONENT: React evaluates hooks unconditionally
 * inside a component, so a Today hook called in Home itself would run its
 * effects even with the card conditionally rendered. The gate returns before
 * the surface component exists, which is the only shape that makes "flag OFF
 * means no orchestration" structural rather than a rule every future edit has
 * to remember.
 *
 * Containment wraps the surface, never the gate: a boundary above the flag
 * check would suggest the disabled path can fail, and it cannot — there is
 * nothing there to fail.
 */

import React, { useEffect, useRef } from 'react';
import { Platform, Text } from 'react-native';
import { TODAY_WITH_ELISE_ACTIVE } from '../../constants/featureFlags';
import { useTodayWithElise } from '../../hooks/useTodayWithElise';
import { reportTodayCardCommitted } from '../../services/todayWithElise/reporting';
import { TodayWithEliseBoundary } from './TodayWithEliseBoundary';
import { TodayWithEliseCard } from './TodayWithEliseCard';

export type TodayWithEliseSectionProps = {
  /**
   * Test seam ONLY. Production callers pass nothing and the build-time flag
   * decides. Never wired to a runtime toggle: Build 5 adds no rollout service.
   */
  enabledOverride?: boolean;
};

/**
 * The orchestrated surface. Reached only through the gate below.
 *
 * ONE REPORT PER COMMITTED GENERATION. `reportedRef` holds the generation token
 * that has already reported, so a rerender caused by focus, layout, Dynamic
 * Type or a parent state change re-renders the card without emitting a second
 * impression. A refused commit never reaches here at all, so a stale result
 * emits nothing — the effect is keyed on the token of a card that committed.
 */
function TodayWithEliseSurface() {
  const view = useTodayWithElise();
  const reportedRef = useRef<string | null>(null);
  /**
   * The stable focus target for a return from a Today-originated destination.
   * The heading is used rather than a button because a button may not exist in
   * the state the user comes back to.
   */
  const headingRef = useRef<Text | null>(null);
  const token = view.card?.generationToken ?? null;

  useEffect(() => {
    const card = view.card;
    if (!card || !token) return;
    if (reportedRef.current === token) return;
    reportedRef.current = token;
    reportTodayCardCommitted({ card, platform: Platform.OS });
    // `token` is the dependency that matters: the card object identity can
    // change on a projection rerender while describing the same generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <TodayWithEliseCard
      loading={view.loading}
      card={view.card}
      presentation={view.presentation}
      onPrimaryPress={view.onPrimaryPress}
      onSecondaryPress={view.onSecondaryPress}
      busy={view.busy}
      actionError={view.actionError}
      headingRef={headingRef}
    />
  );
}

export function TodayWithEliseSection({ enabledOverride }: TodayWithEliseSectionProps = {}) {
  const enabled = enabledOverride === undefined ? TODAY_WITH_ELISE_ACTIVE : enabledOverride;
  if (!enabled) return null;

  return (
    <TodayWithEliseBoundary>
      <TodayWithEliseSurface />
    </TodayWithEliseBoundary>
  );
}

export default TodayWithEliseSection;
