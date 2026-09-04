/**
 * Failure containment for the Live surface.
 *
 * WHAT IT PROTECTS. An exception thrown while rendering the Live panel must
 * cost the customer Live and nothing else. Without a boundary here, React
 * unmounts the whole tree above the throw -- which is the VTO sheet, including
 * the AI Photo experience that was working perfectly well. That is the
 * regression this component exists to make impossible.
 *
 * WHAT IT DELIBERATELY DOES NOT LOG. The error's message and stack are never
 * recorded or reported. A Live runtime's error text can reference camera,
 * mask, landmark or capture state, and this integration logs none of those.
 * The boundary reports only that it caught something.
 */

import React from 'react';

export interface VtoLiveErrorBoundaryProps {
  children: React.ReactNode;
  /** Called once when the boundary trips, so the owner can fall back to AI
   *  Photo rather than leaving the customer on an empty panel. */
  onFallback: () => void;
  fallback: React.ReactNode;
}

interface VtoLiveErrorBoundaryState {
  crashed: boolean;
}

export class VtoLiveErrorBoundary extends React.Component<
  VtoLiveErrorBoundaryProps,
  VtoLiveErrorBoundaryState
> {
  state: VtoLiveErrorBoundaryState = { crashed: false };

  static getDerivedStateFromError(): VtoLiveErrorBoundaryState {
    return { crashed: true };
  }

  componentDidCatch(): void {
    // No arguments read on purpose -- see the module header. The notification
    // carries no payload for the same reason.
    try {
      this.props.onFallback();
    } catch {
      // A failing fallback handler must not re-throw out of the boundary that
      // exists to stop exactly this.
    }
  }

  render(): React.ReactNode {
    if (this.state.crashed) return this.props.fallback;
    return this.props.children;
  }
}
