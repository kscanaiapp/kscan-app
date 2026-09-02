import { captureActorScope, isActorScopeCurrent } from '../actorScope';

export type StyleChatSessionLaunchGuard = {
  tryBegin: () => boolean;
  getPendingSessionId: () => string | null;
  rememberSession: (sessionId: string) => void;
  releaseForRetry: () => void;
  resetOnFocus: () => void;
};

export type StyleChatSessionLaunchResult =
  | { status: 'navigated'; sessionId: string }
  | { status: 'ignored' }
  | { status: 'cancelled'; sessionId: string }
  | { status: 'failed'; error: unknown };

export async function launchStyleChatSession(input: {
  guard: StyleChatSessionLaunchGuard;
  createSession: () => Promise<{ id?: string | null }>;
  navigate: (sessionId: string) => void;
  /**
   * Optional ADDITIONAL caller condition (Home also requires its screen to
   * still be active). The actor boundary is NOT delegated to this callback —
   * see the scope check inside — because a caller that forgets it would
   * silently lose the guarantee, which is exactly how ELISE-002 arose.
   */
  isCurrent?: () => boolean;
  /**
   * Resolves the conversation to resume, or null when the user has none.
   * Omitted by callers whose affordance means "start a new one" explicitly.
   *
   * A rejection here fails the launch rather than falling through to create:
   * a transient lookup error must not silently strand the existing
   * conversation behind a brand-new empty one.
   */
  resolveExistingSessionId?: () => Promise<string | null>;
}): Promise<StyleChatSessionLaunchResult> {
  const { guard } = input;
  if (!guard.tryBegin()) return { status: 'ignored' };

  // ELISE-002 — captured BEFORE the lookup / creation round trip below. The
  // epoch (not the actor id) is the discriminator, so an A -> B -> A cycle is
  // rejected too. Every exit from here on is gated on it.
  const launchActorScope = captureActorScope();

  try {
    let sessionId = guard.getPendingSessionId();
    if (!sessionId && input.resolveExistingSessionId) {
      const existingSessionId = await input.resolveExistingSessionId();
      if (existingSessionId) {
        sessionId = existingSessionId;
        guard.rememberSession(sessionId);
      }
    }
    if (!sessionId) {
      const session = await input.createSession();
      if (!session?.id) throw new Error('StyleChat session creation returned no session ID.');
      sessionId = session.id;
      guard.rememberSession(sessionId);
    }

    // resetOnFocus() (not releaseForRetry()) on a cancel: the remembered id
    // belongs to the departed actor and must never be reused by the arriving
    // one, while the next tap must still be able to begin a fresh launch.
    if (!isActorScopeCurrent(launchActorScope)) {
      guard.resetOnFocus();
      return { status: 'cancelled', sessionId };
    }

    if (input.isCurrent && !input.isCurrent()) {
      guard.resetOnFocus();
      return { status: 'cancelled', sessionId };
    }

    input.navigate(sessionId);
    return { status: 'navigated', sessionId };
  } catch (error: unknown) {
    // A navigation failure retains the remembered ID, so retry opens the
    // already-created session instead of creating an orphan duplicate.
    guard.releaseForRetry();
    return { status: 'failed', error };
  }
}

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
