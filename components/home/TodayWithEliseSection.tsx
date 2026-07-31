/**
 * Build 5 — the Home mount point for Today with Elise V1.
 *
 * THE KILL SWITCH LIVES HERE, ABOVE EVERYTHING ELSE. `TODAY_WITH_ELISE_ACTIVE`
 * is checked before the card is created and before any Today hook is called, so
 * a flag-OFF build performs no orchestration, reads no Closet, reads no Saved
 * Look, creates no session and emits no Today analytics — it renders `null` and
 * Home is byte-for-byte the pre-Build-5 screen.
 *
 * WHY THE GATE IS A COMPONENT AND NOT AN INLINE CONDITIONAL IN Home: React
 * evaluates hooks unconditionally inside a component, so a hook called in Home
 * itself would run its effects even with the card conditionally rendered. The
 * gate returns before this component's children exist, which is the only shape
 * that makes "flag OFF means no orchestration" structural rather than a rule
 * every future edit has to remember.
 *
 * Containment wraps the card, never this gate: a boundary above the flag check
 * would suggest the disabled path can fail, and it cannot — there is nothing
 * there to fail.
 */

import React from 'react';
import { TODAY_WITH_ELISE_ACTIVE } from '../../constants/featureFlags';
import { TodayWithEliseBoundary } from './TodayWithEliseBoundary';
import { TodayWithEliseCard } from './TodayWithEliseCard';

export type TodayWithEliseSectionProps = {
  /**
   * Test seam ONLY. Production callers pass nothing and the build-time flag
   * decides. Never wired to a runtime toggle: Build 5 adds no rollout service.
   */
  enabledOverride?: boolean;
};

export function TodayWithEliseSection({ enabledOverride }: TodayWithEliseSectionProps = {}) {
  const enabled = enabledOverride === undefined ? TODAY_WITH_ELISE_ACTIVE : enabledOverride;
  if (!enabled) return null;

  return (
    <TodayWithEliseBoundary>
      <TodayWithEliseCard loading />
    </TodayWithEliseBoundary>
  );
}

export default TodayWithEliseSection;
