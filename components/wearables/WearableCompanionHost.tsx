import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useRef } from 'react';
import { router } from 'expo-router';
import { useAuthSession } from '../../contexts/AuthSessionContext';
import {
  acknowledgeWearableAction,
  beginWearableCapture,
  completeWearableAction,
  listWearableSessions,
  pollPhoneFrames,
  type WearableFrame,
} from '../../services/wearables/bridge';

const RESULT_CACHE_PREFIX = 'kscan.wearable.result.';
const CANCELLED_PREFIX = 'kscan.wearable.cancelled.';

export function WearableCompanionHost() {
  const { isAuthenticated } = useAuthSession();
  const cursors = useRef(new Map<string, number>());
  const processed = useRef(new Set<string>());

  useEffect(() => {
    if (!isAuthenticated) {
      cursors.current.clear();
      processed.current.clear();
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const sessions = await listWearableSessions();
        for (const session of sessions) {
          const result = await pollPhoneFrames(session.id, cursors.current.get(session.id) ?? 0);
          cursors.current.set(session.id, result.cursor);
          for (const frame of result.frames) {
            const key = `${session.id}:${frame.requestId}:${frame.messageType}`;
            if (processed.current.has(key)) continue;
            processed.current.add(key);
            await handleFrame(session.id, frame);
          }
        }
      } catch {
        // Network/auth recovery is handled by the next bounded poll; no payload is logged.
      } finally {
        if (active) timer = setTimeout(tick, 1_000);
      }
    };
    void tick();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [isAuthenticated]);

  return null;
}

async function handleFrame(sessionId: string, frame: WearableFrame) {
  if (frame.messageType === 'capture.request') {
    const scanId = frame.requestId;
    await beginWearableCapture(sessionId, frame.requestId, scanId);
    router.push({ pathname: '/scan', params: { wearableSessionId: sessionId, wearableRequestId: frame.requestId, wearableScanId: scanId } });
    return;
  }
  if (frame.messageType === 'action.cancel') {
    const scanId = String(frame.payload?.scanId ?? '');
    if (scanId) await AsyncStorage.setItem(CANCELLED_PREFIX + scanId, '1');
    return;
  }
  if (frame.messageType === 'action.retry') {
    const scanId = frame.requestId;
    await beginWearableCapture(sessionId, frame.requestId, scanId);
    router.push({ pathname: '/scan', params: { wearableSessionId: sessionId, wearableRequestId: frame.requestId, wearableScanId: scanId } });
    return;
  }
  if (frame.messageType === 'action.save' || frame.messageType === 'action.open_on_phone') {
    const resultId = String(frame.payload?.resultId ?? '');
    const actionId = String(frame.payload?.actionId ?? '');
    if (!resultId || !actionId) return;
    const actionType = frame.messageType === 'action.save' ? 'save' : 'open_on_phone';
    // actionId must come from the glasses' payload (stable per resultId+type), not
    // frame.requestId, which is a fresh random id on every send/retry — using it
    // here would defeat the backend's actionId-keyed duplicate-save protection.
    const ack = await completeWearableAction(sessionId, actionId, resultId, actionType);
    await AsyncStorage.setItem(RESULT_CACHE_PREFIX + resultId, JSON.stringify(ack.result));
    if (actionType === 'open_on_phone') {
      router.push({ pathname: '/wearable-result', params: { resultId } });
    }
    await acknowledgeWearableAction(sessionId, frame.requestId, ack.result, ack.revision);
  }
}

export async function isWearableScanCancelled(scanId: string): Promise<boolean> {
  return (await AsyncStorage.getItem(CANCELLED_PREFIX + scanId)) === '1';
}

export async function readWearableResult(resultId: string): Promise<any | null> {
  const raw = await AsyncStorage.getItem(RESULT_CACHE_PREFIX + resultId);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
