/**
 * Build 5 — render containment for the Today with Elise Home surface.
 *
 * WHY A BOUNDARY AND NOT A try/catch: a throw during the Today card's render or
 * commit phase unmounts the whole React tree above it, which on Home means the
 * user loses Scan, Closet, Recent Scans and Dressing Rooms because one
 * recommendation card failed. React error boundaries are the only construct
 * that can stop a render-phase throw, and they must be class components.
 *
 * FAILURE IS SILENT BY DESIGN. Today is additive: it exists to offer one extra
 * action, so when it cannot render, the correct outcome is that Home looks
 * exactly as it did before Build 5 — not an apology block explaining an
 * internal fault the user cannot act on. No error text, no stack, no retry
 * loop, and no analytics event (the card never committed, so there is nothing
 * truthful to report about it).
 *
 * The boundary never recovers on its own. A subsequent Home mount gets a fresh
 * boundary instance, which is the only retry that exists.
 */

import React from 'react';

export type TodayWithEliseBoundaryProps = {
  children: React.ReactNode;
  /** Test seam only: observe that containment fired. Never user-facing. */
  onContained?: (error: unknown) => void;
};

type State = { failed: boolean };

export class TodayWithEliseBoundary extends React.Component<
  TodayWithEliseBoundaryProps,
  State
> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    // Best effort, and deliberately not analytics: a card that never committed
    // has no impression, no state and no priority to report.
    try {
      this.props.onContained?.(error);
    } catch {
      /* containment must not itself throw */
    }
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      // eslint-disable-next-line no-console
      console.warn('[TodayWithElise] card render contained; Home is unaffected');
    }
  }

  render(): React.ReactNode {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

export default TodayWithEliseBoundary;
