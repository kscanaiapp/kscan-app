/**
 * Dev-only capture provider (Phase 16 alpha).
 *
 * Returns a tiny deterministic 1x1 JPEG data URL so the bridge flow can be
 * exercised end-to-end without glasses hardware.
 *
 * DEV ONLY. This provider:
 * - uses a hardcoded known-safe 1x1 pixel JPEG fixture,
 * - contains no real photos,
 * - does not use the Android/iOS phone camera,
 * - does not use Meta DAT,
 * - does not upload to any backend,
 * - does not write to disk.
 */

import { JPEG_DATA_URL_PREFIX } from './validateBridgePayload.ts';

/** Hardcoded 1x1 pixel baseline JPEG (deterministic, ~330 bytes). */
const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof' +
  'Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB' +
  'AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAAEAAD8AVN//2Q==';

export const DEV_CAPTURE_FIXTURE_DATA_URL = `${JPEG_DATA_URL_PREFIX}${TINY_JPEG_BASE64}`;

export type DevCaptureProvider = {
  readonly name: string;
  capture(): Promise<string>;
};

export const devCaptureProvider: DevCaptureProvider = {
  name: 'dev-fixture-capture',
  async capture(): Promise<string> {
    return DEV_CAPTURE_FIXTURE_DATA_URL;
  },
};
