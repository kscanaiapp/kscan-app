import { useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';
import { useIsFocused } from '@react-navigation/native';

/**
 * Idle presence ticker.
 *
 * The avatar engine calculates breathing and a slow head drift from a host
 * wall clock. During speech the host already re-renders on every playback
 * progress callback, so those channels advance for free. When nothing is being
 * spoken NOTHING re-renders the header — the speech store is idle and stable —
 * so the clock the engine is handed never moves and the avatar is a completely
 * still photograph. This hook exists solely to move that clock.
 *
 * ─── WHY 2 Hz ───────────────────────────────────────────────────────────────
 *
 * This is presence, not animation, and the budget is battery. The lowest
 * cadence that produces smooth motion wins, and the engine's own amplitudes
 * make that cadence very low:
 *
 *   breathing   ±0.6% scale over a 5.2s cycle → peak 0.0073 scale/second
 *   head drift  ±0.8°   over a 9.8s cycle → peak 0.513°/second
 *
 * At 500ms per step that is at most 0.0036 of scale and 0.26° per update. On
 * the 67pt StyleChat avatar both work out below a quarter of a pixel of
 * movement per step, so there is no visible stepping to buy off with a faster
 * timer. 4 Hz would double the render count for motion nobody can see.
 *
 * Deliberately nowhere near the 80ms speech tick: this must never become a
 * general-purpose animation loop.
 *
 * ─── LIFECYCLE ──────────────────────────────────────────────────────────────
 *
 * The timer runs only while EVERY condition holds, and stops the instant any
 * of them stops. A single effect owns it, keyed on the resolved condition, so
 * repeated focus/blur, background/foreground or mount/unmount cycles can never
 * leave a second timer behind: React tears the previous effect down before
 * running the next one, and the interval id lives in a ref that the same
 * effect clears.
 *
 * It is emphatically NOT enough that StyleChat still exists somewhere in the
 * navigation tree — an unfocused route must not keep waking the JS thread.
 */
export const AVATAR_IDLE_TICK_MS = 500;

export interface AvatarIdlePresenceOptions {
  /**
   * Host-owned gate. False whenever the avatar should not be advancing an idle
   * clock at all — Reduce Motion, or a state that is not idle/listening (the
   * playback path already drives the clock while speaking, and two drivers on
   * one channel is exactly the oscillation this must avoid).
   */
  enabled: boolean;
}

function isForeground(status: AppStateStatus): boolean {
  // 'inactive' is the iOS transitional state (call sheet, app switcher,
  // Control Centre). Treated as background, matching how the speech lifecycle
  // already classifies it.
  return status === 'active';
}

/**
 * Returns a counter that increments while idle presence should be advancing.
 *
 * The value carries no meaning; consumers use it only as a render trigger, so
 * a host that reads `Date.now()` sees a clock that moves. It never resets to a
 * lower value within a mount, so it cannot be mistaken for a timestamp.
 */
export function useAvatarIdlePresence({ enabled }: AvatarIdlePresenceOptions): number {
  const isFocused = useIsFocused();
  const [foreground, setForeground] = useState(() => isForeground(AppState.currentState));
  const [tick, setTick] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // AppState is observed whenever mounted — it is a subscription, not a timer,
  // and it is what lets the interval effect below tear down on background.
  useEffect(() => {
    const subscription: NativeEventSubscription = AppState.addEventListener(
      'change',
      (status) => setForeground(isForeground(status)),
    );
    setForeground(isForeground(AppState.currentState));
    return () => subscription.remove();
  }, []);

  const running = enabled && isFocused && foreground;

  useEffect(() => {
    if (!running) return undefined;
    intervalRef.current = setInterval(() => {
      // A plain counter. No allocation, no engine call, no store mutation, no
      // timeline work — the render it triggers is what advances the clock.
      setTick((value) => (value + 1) % Number.MAX_SAFE_INTEGER);
    }, AVATAR_IDLE_TICK_MS);

    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [running]);

  return tick;
}
