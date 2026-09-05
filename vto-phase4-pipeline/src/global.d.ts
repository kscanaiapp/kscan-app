/**
 * Node has a real, always-present global `WebAssembly` object (part of the
 * WebAssembly JS API spec — an engine feature, not a DOM/browser feature),
 * but TypeScript's non-DOM libs don't declare it (`lib.dom.d.ts` and
 * `lib.webworker.d.ts` are the only TS libs that do). Rather than pull in
 * the whole DOM lib — which would also shadow Node's own `fetch`/`URL`/etc.
 * globals with browser-flavored versions — this declares only the two
 * members `codec.ts` actually uses to manually instantiate the WebP
 * decoder's WASM module (see `codec.ts`'s `ensureWebpDecoder`).
 */
declare global {
  namespace WebAssembly {
    class Module {
      private readonly __webAssemblyModuleBrand: unique symbol;
    }
    function compile(bytes: Uint8Array | ArrayBuffer): Promise<Module>;
  }
}

export {};
