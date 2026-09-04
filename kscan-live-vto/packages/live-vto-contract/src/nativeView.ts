/**
 * Section 10 — Expo native-view command/event surface.
 *
 * "JavaScript must NOT receive: camera frames every frame; raw
 * segmentation masks every frame; raw body geometry every frame." This
 * file is the enforcement point for that rule at the type level: it is the
 * ONLY set of messages allowed to cross the JS/native boundary. If a
 * future change wants to send BodyFrame or a mask to JS on every frame,
 * that change has to edit this file and will be visibly wrong against the
 * plan's own text above.
 *
 * The native view (iOS: `native/ios/LiveVTO`, Android:
 * `native/android/livevto`) owns camera -> inference -> state -> rendering
 * internally and only speaks this narrow, low-frequency surface to JS.
 */

import type { GuidanceState } from './guidance';
import type { GarmentDescriptor } from '@kscan-live-vto/garment-contract';

// ─── Commands (JS -> native) ────────────────────────────────────────────────

export interface LiveVTOCommands {
  start(): void;
  stop(): void;
  pause(): void;
  resume(): void;
  loadGarment(garment: GarmentDescriptor, ksgarmentUri: string): void;
  switchGarment(garment: GarmentDescriptor, ksgarmentUri: string): void;
  capture(): void;
  dispose(): void;
}

export type LiveVTOCommandName = keyof LiveVTOCommands;

// ─── Events (native -> JS) ───────────────────────────────────────────────────

export type LiveVTOEventName =
  | 'ready'
  | 'trackingAcquired'
  | 'trackingWeak'
  | 'trackingLost'
  | 'trackingRecovered'
  | 'garmentLoaded'
  | 'captureReady'
  | 'qualityChanged'
  | 'thermalChanged'
  | 'privacyState'
  | 'fatalError';

export interface LiveVTOEventPayloads {
  ready: Record<string, never>;
  trackingAcquired: { confidence: number };
  trackingWeak: { confidence: number; guidance: GuidanceState };
  trackingLost: Record<string, never>;
  trackingRecovered: { confidence: number };
  garmentLoaded: { productId: string; assetVersion: string };
  /** Emitted once a capture (P1-C2) is buffered and ready for local replay — never carries pixel data across the bridge. */
  captureReady: { captureId: string; replayDurationMs: number };
  qualityChanged: { guidance: GuidanceState; meanLuminance: number | null };
  thermalChanged: { level: 'nominal' | 'fair' | 'serious' | 'critical' };
  privacyState: { networkActive: boolean; description: string };
  fatalError: { code: string; message: string; recoverable: boolean };
}

export interface LiveVTOEvent<K extends LiveVTOEventName = LiveVTOEventName> {
  type: K;
  timestamp: number;
  payload: LiveVTOEventPayloads[K];
}

export type LiveVTOEventListener<K extends LiveVTOEventName = LiveVTOEventName> = (
  event: LiveVTOEvent<K>,
) => void;

/**
 * Fields that must NEVER appear in a LiveVTOEventPayloads member. Checked by
 * packages/live-vto-contract's contract test (Section 32-style boundary
 * enforcement, applied to the JS/native boundary rather than network).
 */
export const FORBIDDEN_EVENT_PAYLOAD_KEYS = [
  'frame',
  'pixels',
  'imageData',
  'mask',
  'segmentationMask',
  'landmarks',
  'bodyFrame',
  'pose',
] as const;
