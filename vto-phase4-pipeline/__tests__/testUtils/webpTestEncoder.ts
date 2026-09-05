import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * TEST-ONLY WebP encoder. Never imported by `src/` — the production
 * pipeline only ever DECODES WebP (see `codec.ts`), since Phase 4 never
 * produces WebP output. This exists purely to manufacture valid,
 * synthetic (non-retailer) WebP byte fixtures at test time, the same role
 * `encodePng`/`createImage` play for PNG fixtures elsewhere in this suite.
 *
 * Uses the same manual-WASM-instantiation workaround as `codec.ts`'s
 * decoder (see that file's `ensureWebpDecoder` doc comment) — the
 * package's default auto-init instantiates via `fetch()` of a `file://`
 * URL, which Node's built-in fetch does not support.
 */

interface JSquashEncodeModule {
  init: (module?: WebAssembly.Module) => Promise<void>;
  default: (imageData: { data: Uint8ClampedArray; width: number; height: number }, options?: Record<string, unknown>) => Promise<ArrayBuffer>;
}

let encoderModule: JSquashEncodeModule | null = null;
let encoderInitPromise: Promise<void> | null = null;

async function ensureEncoder(): Promise<JSquashEncodeModule> {
  if (!encoderModule) {
    encoderModule = (await import('@jsquash/webp/encode.js')) as unknown as JSquashEncodeModule;
  }
  if (!encoderInitPromise) {
    const module = encoderModule;
    encoderInitPromise = (async () => {
      // wasm-feature-detect's simd() check does a synchronous WebAssembly.validate
      // (no I/O), so a Promise.resolve import keeps this simple and deterministic
      // by just always using the non-SIMD encoder — perfectly adequate for tiny
      // synthetic test fixtures where encode speed is irrelevant.
      // Compiled output lives at dist/__tests__/testUtils/webpTestEncoder.js;
      // node_modules sits three levels up from there, at the package root.
      const wasmPath = join(__dirname, '..', '..', '..', 'node_modules', '@jsquash', 'webp', 'codec', 'enc', 'webp_enc.wasm');
      const wasmModule = await WebAssembly.compile(readFileSync(wasmPath));
      await module.init(wasmModule);
    })();
  }
  await encoderInitPromise;
  return encoderModule;
}

/** Encodes a solid-color W x H RGBA buffer as WebP — enough to exercise a real decode round-trip. */
export async function encodeSyntheticWebp(width: number, height: number, rgba: [number, number, number, number] = [40, 120, 200, 255]): Promise<Buffer> {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgba[0];
    data[i * 4 + 1] = rgba[1];
    data[i * 4 + 2] = rgba[2];
    data[i * 4 + 3] = rgba[3];
  }
  const encoder = await ensureEncoder();
  const buffer = await encoder.default({ data, width, height });
  return Buffer.from(buffer);
}
