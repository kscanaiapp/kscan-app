import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { supabase } from '../supabaseClient';

export const WEARABLE_PROTOCOL_VERSION = 1;
export const MAX_WEARABLE_FRAME_BYTES = 65_536;
const DEVICE_ID_KEY = 'kscan.wearable.phoneDeviceId.v1';

export type WearableSession = {
  id: string;
  device_id: string;
  expires_at: string;
  last_seen_at: string;
  wearable_pairings?: { device_model?: string };
};

export type WearableFrame = {
  protocolVersion: number;
  messageType: string;
  requestId: string;
  sessionId: string;
  deviceId: string;
  timestamp: number;
  expiresAt: number | null;
  payload: Record<string, unknown>;
};

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('wearable-bridge', { body });
  if (error || !data || data.ok === false) {
    throw Object.assign(new Error('Wearable service is unavailable.'), { code: data?.code ?? 'WEARABLE_BACKEND_FAILURE' });
  }
  return data as T;
}

export async function getPhoneDeviceId(): Promise<string> {
  const existing = await AsyncStorage.getItem(DEVICE_ID_KEY);
  if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
  const created = Crypto.randomUUID();
  await AsyncStorage.setItem(DEVICE_ID_KEY, created);
  return created;
}

export async function approvePairing(challengeCode: string) {
  return invoke<{ pairingHandle: string; deviceModel: string }>({
    operation: 'pair.approve', challengeCode, phoneDeviceId: await getPhoneDeviceId(),
  });
}

export async function denyPairing(challengeCode: string) {
  return invoke<{ ok: true }>({ operation: 'pair.deny', challengeCode });
}

export async function listWearableSessions(): Promise<WearableSession[]> {
  const data = await invoke<{ sessions: WearableSession[] }>({ operation: 'phone.sessions' });
  return Array.isArray(data.sessions) ? data.sessions : [];
}

export async function revokeWearableSession(sessionId: string, reason: 'user_revoked' | 'sign_out' = 'user_revoked') {
  await invoke({ operation: 'phone.revoke', sessionId, reason });
}

export async function revokeAllWearableSessions() {
  await invoke({ operation: 'phone.revoke_all' });
}

export async function pollPhoneFrames(sessionId: string, after: number) {
  const data = await invoke<{ poll: { cursor: number; frames: string[] } }>({ operation: 'phone.poll', sessionId, after });
  const frames = (data.poll?.frames ?? []).map(parseFrame).filter((value): value is WearableFrame => value != null);
  return { cursor: Number(data.poll?.cursor ?? after), frames };
}

export async function sendPhoneFrame(sessionId: string, frame: WearableFrame) {
  const raw = JSON.stringify(frame);
  if (new TextEncoder().encode(raw).byteLength > MAX_WEARABLE_FRAME_BYTES) throw new Error('Wearable result is too large.');
  await invoke({ operation: 'phone.send', sessionId, frame: raw });
}

export async function buildPhoneFrame(
  sessionId: string,
  messageType: string,
  payload: Record<string, unknown>,
  requestId = Crypto.randomUUID(),
): Promise<WearableFrame> {
  const now = Date.now();
  return {
    protocolVersion: 1,
    messageType,
    requestId,
    sessionId,
    deviceId: await getPhoneDeviceId(),
    timestamp: now,
    expiresAt: now + 60_000,
    payload,
  };
}

export async function beginWearableCapture(sessionId: string, requestId: string, captureId: string) {
  await sendPhoneFrame(sessionId, await buildPhoneFrame(sessionId, 'capture.started', { captureId }, requestId));
}

export async function reportWearableProgress(
  sessionId: string,
  scanId: string,
  stage: 'PRIVACY_PROCESSING' | 'ANALYZING' | 'MATCHING',
  percent: number,
) {
  await sendPhoneFrame(sessionId, await buildPhoneFrame(sessionId, 'scan.progress', { scanId, stage, percent }));
}

export async function startWearableProcessing(sessionId: string, scanId: string) {
  await sendPhoneFrame(sessionId, await buildPhoneFrame(sessionId, 'scan.processing', { scanId }));
}

export async function completeWearableScan(
  sessionId: string,
  requestId: string,
  scanId: string,
  analysis: any,
) {
  const resultId = Crypto.randomUUID();
  const result = normalizeWearableResult(resultId, analysis);
  await sendPhoneFrame(sessionId, await buildPhoneFrame(sessionId, 'capture.completed', { captureId: scanId, captureRef: `local:${scanId}` }, requestId));
  await sendPhoneFrame(sessionId, await buildPhoneFrame(sessionId, 'scan.completed', { scanId, resultId }));
  await sendPhoneFrame(sessionId, await buildPhoneFrame(sessionId, 'result.show', { result }));
  return resultId;
}

export async function failWearableScan(sessionId: string, requestId: string, scanId: string, code: string) {
  await sendPhoneFrame(sessionId, await buildPhoneFrame(sessionId, 'capture.failed', { captureId: scanId, code }, requestId));
}

export async function acknowledgeWearableAction(sessionId: string, requestId: string, result: any, revision: number) {
  await sendPhoneFrame(sessionId, await buildPhoneFrame(sessionId, 'result.update', { result, revision }, requestId));
}

export async function completeWearableAction(
  sessionId: string,
  actionId: string,
  resultId: string,
  actionType: 'save' | 'open_on_phone',
) {
  return invoke<{ result: any; revision: number; duplicate: boolean }>({
    operation: 'phone.action', sessionId, actionId, resultId, actionType,
  });
}

export function normalizeWearableResult(resultId: string, analysis: any) {
  const products = Array.isArray(analysis?.products) ? analysis.products.slice(0, 5).map((product: any) => ({
    title: clean(product?.title ?? product?.name, 80),
    brand: clean(product?.brand ?? product?.retailer, 48),
    price: clean(product?.price, 24),
    currency: clean(product?.currency, 3) || 'USD',
    group: String(product?.group ?? product?.source ?? '').toLowerCase().includes('resale') ? 'RESALE' : 'RETAIL',
    thumbnailUrl: safeThumbnail(product?.thumbnailUrl ?? product?.imageUrl),
  })) : [];
  return {
    resultId,
    summary: clean(analysis?.result ?? analysis?.summary, 220),
    confidence: Math.max(0, Math.min(1, Number(analysis?.metadata?.confidence ?? 0.5))),
    products,
    availableActions: ['SAVE', 'OPEN_ON_PHONE', 'RETRY', 'DISMISS'],
    scanStatus: 'COMPLETED',
    errorCode: null,
  };
}

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '';
}

function safeThumbnail(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('https://')) return null;
  try {
    const url = new URL(value);
    for (const key of url.searchParams.keys()) {
      if (/token|auth|signature|key|session/i.test(key)) return null;
    }
    return value.slice(0, 500);
  } catch { return null; }
}

function parseFrame(raw: string): WearableFrame | null {
  try {
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > MAX_WEARABLE_FRAME_BYTES) return null;
    const frame = JSON.parse(raw);
    if (frame?.protocolVersion !== 1 || typeof frame?.messageType !== 'string' || typeof frame?.requestId !== 'string') return null;
    return frame as WearableFrame;
  } catch { return null; }
}
