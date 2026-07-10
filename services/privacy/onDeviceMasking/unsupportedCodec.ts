import type { LocalImageCodec, RgbaImageBuffer } from './types';
import { UnsupportedCodecError } from './errors';

/**
 * Explicitly unsupported local image codec.
 *
 * No installed dependency can safely decode and encode images locally without
 * native changes in this phase. This codec documents that blocker and refuses
 * to fabricate output.
 */
export const unsupportedLocalImageCodec: LocalImageCodec = {
  codecVersion: 'unsupported-1.0.0',
  supported: false,

  async decode(): Promise<RgbaImageBuffer> {
    throw new UnsupportedCodecError(
      'No supported local image codec is installed. JPEG/PNG decode requires a native codec or approved pure-JS dependency.',
    );
  },

  async encode(): Promise<{ outputUri?: string; outputBase64?: string; mimeType: string }> {
    throw new UnsupportedCodecError(
      'No supported local image codec is installed. JPEG/PNG encode requires a native codec or approved pure-JS dependency.',
    );
  },
};
