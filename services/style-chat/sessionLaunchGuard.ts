export type StyleChatSessionLaunchGuard = {
  tryBegin: () => boolean;
  getPendingSessionId: () => string | null;
  rememberSession: (sessionId: string) => void;
  releaseForRetry: () => void;
  resetOnFocus: () => void;
};

export function createStyleChatSessionLaunchGuard(): StyleChatSessionLaunchGuard {
  let inFlight = false;
  let pendingSessionId: string | null = null;

  return {
    tryBegin() {
      if (inFlight) return false;
      inFlight = true;
      return true;
    },
    getPendingSessionId() {
      return pendingSessionId;
    },
    rememberSession(sessionId) {
      pendingSessionId = sessionId;
    },
    releaseForRetry() {
      inFlight = false;
    },
    resetOnFocus() {
      inFlight = false;
      pendingSessionId = null;
    },
  };
}
