import { useEffect, useRef, useState } from 'react';
import {
  planNextBlink,
  type BlinkPlan,
} from '../services/avatarBlinkScheduler';
import type { AvatarEyeState } from '../services/avatarMotionState';
import { useAvatarAppForeground } from './useAvatarAppForeground';

// Blink driver.
//
// Turns deterministic blink plans into timers and owns their cancellation.
// Exactly one pending timer exists at any moment (the next frame or the next
// blink); every teardown path — unmount, avatar change, capability or flag
// disable, Reduce Motion, app interruption via the foreground gate — clears
// it and snaps the eyes open. The scheduler itself stays pure; only this
// driver touches setTimeout.

export interface UseAvatarBlinkOptions {
  /** Injected for deterministic tests; production uses the real scheduler. */
  plan?: (random: () => number) => BlinkPlan;
  random?: () => number;
}

export function useAvatarBlink(
  enabled: boolean,
  avatarId: string | undefined,
  options: UseAvatarBlinkOptions = {},
): AvatarEyeState {
  const [eyes, setEyes] = useState<AvatarEyeState>('open');
  const foreground = useAvatarAppForeground();
  const active = enabled && foreground;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const plan = options.plan ?? planNextBlink;
  const random = options.random ?? Math.random;

  useEffect(() => {
    if (!active) {
      setEyes('open');
      return;
    }
    let cancelled = false;

    const clearPending = () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const scheduleNext = () => {
      if (cancelled) return;
      const nextPlan = plan(random);
      timerRef.current = setTimeout(() => runFrames(nextPlan, 0), nextPlan.startInMs);
    };

    const runFrames = (currentPlan: BlinkPlan, frameIndex: number) => {
      if (cancelled) return;
      if (frameIndex >= currentPlan.frames.length) {
        setEyes('open');
        scheduleNext();
        return;
      }
      const frame = currentPlan.frames[frameIndex];
      setEyes(frame.eyes);
      const nextOffset =
        frameIndex + 1 < currentPlan.frames.length
          ? currentPlan.frames[frameIndex + 1].atMs - frame.atMs
          : 0;
      timerRef.current = setTimeout(
        () => runFrames(currentPlan, frameIndex + 1),
        Math.max(0, nextOffset),
      );
    };

    scheduleNext();
    return () => {
      cancelled = true;
      clearPending();
      setEyes('open');
    };
  }, [active, avatarId, plan, random]);

  return active ? eyes : 'open';
}
