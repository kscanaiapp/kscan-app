// Binds the orchestration layer in services/metaWearableDevice.ts to the real
// native adapter.
//
// This file exists purely so that metaWearableDevice.ts can stay free of
// runtime imports and therefore unit-testable in plain Node. Everything here
// is wiring; the decisions all live next door.

import { KScanMetaWearableModule } from '../modules/kscan-meta-wearable';
import type {
  MetaCameraConfig,
  MetaCapture,
  MetaDisplayPayload,
} from '../modules/kscan-meta-wearable/src/KScanMetaWearable.types';
import {
  captureFromGlasses,
  negotiateCapabilities,
  selectExperience,
  toDisplayPayload,
  type CaptureHandle,
  type MetaCapabilities,
  type MetaExperience,
} from './metaWearableDevice';

/** True when the DAT adapter was compiled into this binary at all. */
export function isMetaAdapterLinked(): boolean {
  return Boolean(KScanMetaWearableModule);
}

/**
 * Brings the adapter up. Safe to call repeatedly.
 *
 * Returns `false` rather than throwing when the adapter is absent, because
 * "no glasses support in this build" is an ordinary state for K Scan — the
 * phone-camera path remains fully functional.
 */
export async function initializeMetaAdapter(): Promise<boolean> {
  if (!KScanMetaWearableModule) return false;
  try {
    const status = await KScanMetaWearableModule.initialize();
    return status.initState === 'READY';
  } catch {
    return false;
  }
}

export function getMetaCapabilities(): MetaCapabilities {
  return negotiateCapabilities(KScanMetaWearableModule);
}

export function getMetaExperience(): MetaExperience {
  return selectExperience(getMetaCapabilities());
}

/** Starts a glasses capture. Returns null when no glasses are usable. */
export function startMetaGlassesCapture(options: {
  camera?: MetaCameraConfig;
  timeoutMs?: number;
} = {}): CaptureHandle | null {
  if (!KScanMetaWearableModule) return null;
  if (getMetaExperience() === 'UNAVAILABLE') return null;
  return captureFromGlasses(KScanMetaWearableModule, {
    ...options,
    // A capture that lands after a cancel is deleted immediately. The native
    // side wrote it to app-private storage; leaving it there would mean a
    // cancelled scan still left the wearer's image on disk.
    onDiscardLateCapture: (capture: MetaCapture) => {
      void discardMetaCapture(capture.uri);
    },
  });
}

/**
 * Renders a result on the glasses when — and only when — the device reported
 * display capability. On camera-first hardware this is a no-op and the phone
 * remains the surface, which is the correct behaviour, not a degraded one.
 */
export async function renderMetaResultOnGlasses(
  result: Record<string, unknown> | null,
): Promise<boolean> {
  if (!KScanMetaWearableModule) return false;
  if (!getMetaCapabilities().display) return false;
  const payload: MetaDisplayPayload | null = toDisplayPayload(result);
  if (!payload) return false;
  try {
    await KScanMetaWearableModule.attachDisplay();
    const rendered = await KScanMetaWearableModule.renderResult(payload);
    return rendered.rendered === true;
  } catch {
    // A display failure must never fail the scan: the result is already safe
    // on the phone.
    return false;
  }
}

export async function clearMetaGlassesDisplay(): Promise<void> {
  if (!KScanMetaWearableModule) return;
  try {
    await KScanMetaWearableModule.clearDisplay();
  } catch {
    /* best effort */
  }
}

/** Deletes a native capture file. Best-effort; never throws into a scan flow. */
export async function discardMetaCapture(uri: string | null | undefined): Promise<void> {
  if (!uri) return;
  try {
    const { File } = await import('expo-file-system');
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    /* best effort */
  }
}

export { toDisplayPayload };
