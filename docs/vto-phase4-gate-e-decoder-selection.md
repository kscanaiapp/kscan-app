# VTO Phase 4.1 — Image Decoder Selection Record

Task addendum §A2/§4/§5. Timeboxed decision, not an open-ended survey.

## Decision

```
DECODER:                    @jsquash/webp
VERSION:                    1.5.0 (pinned exact)
LICENSE:                    Apache-2.0
WHY SELECTED:                see below
FORMATS SUPPORTED (used):    WebP decode only (this pipeline never encodes)
NATIVE DEPENDENCY:            NO — pure WASM, no native binary
NETWORK REQUIRED AT DECODE TIME: NO
AVIF:                        NOT added as a dependency (§A3 — see below)
```

## Order followed (§A2)

1. **Reuse an existing suitable repository decoder** — none exists.
   `docs/vto-phase4-corpus-discovery.md` §1 already established, grep-
   confirmed, that this monorepo has zero occurrences of `sharp`, `jimp`,
   `canvas`, or any other image-decode library anywhere in
   `package.json`/`package-lock.json` outside this Phase 4 package's own
   `pngjs`/`jpeg-js`, neither of which decodes WebP.
2. **Evaluate a small shortlist** — two real candidates, per §A2's own
   suggested primary candidates:
   - `sharp` (libvips, native binary)
   - a maintained WASM WebP decoder

No third option was seriously evaluated: hand-rolling a WebP/VP8 decoder is
explicitly out of scope for a "simplest viable local/batch" pipeline
(the same posture that governed picking `pngjs`/`jpeg-js` originally), and
this monorepo's own prior policy record (`kscan-live-vto`'s closed decision,
cited in `docs/vto-phase4-corpus-discovery.md` §2: "No JPEG decoder will be
implemented. No image-decoding dependency will be added") already rules out
writing one from scratch.
3. **Select one and proceed.**

## Evaluation against §A2's priority order

| Priority | `sharp` (libvips) | `@jsquash/webp` (WASM) |
|---|---|---|
| 1. Reliable decoding | Yes — mature, widely used | Yes — wraps libwebp itself (Google's own reference decoder), same underlying codec sharp would use for WebP |
| 2. CI/runtime compatibility | Ships ~15 per-platform native prebuilt binaries (`@img/sharp-{platform}-{arch}`) as optional deps — works via npm's platform-optionalDependencies resolution, but is exactly the kind of cross-platform native-binary surface this package has avoided everywhere else. This session's own dev environment is Windows; CI runs on GitHub Actions Linux runners — two different native binaries, two different failure surfaces. | No native binary at all. One `.wasm` file, same on every platform/architecture/OS. Verified working from this exact Windows dev environment during evaluation. |
| 3. Security/maintenance | Actively maintained, large user base, but a bigger native attack surface (compiled C/C++ via libvips, historically the subject of CVEs in the broader libvips/ImageMagick family) | Actively maintained (jSquash / Jamie Sinclair), WASM sandboxed — a WASM module cannot make arbitrary syscalls the way a native addon can |
| 4. Predictable memory behavior | Native, tied to libvips' own allocator | WASM linear memory, bounded by the module's own allocation — this pipeline additionally gates dimensions *before* decode either way (§9/§A5), independent of decoder choice |
| 5. Portability | Requires the right prebuilt binary per platform+arch+libc (glibc vs musl is a known sharp pain point) | Fully portable — same `.wasm` bytes everywhere |
| 6. Format coverage | Broad (WebP, AVIF, TIFF, GIF, SVG, …) — but this pipeline needs exactly one new format | WebP only (the `@jsquash` family ships AVIF as a **separate** package, `@jsquash/avif`) |
| 7. Decode speed | Fast (native) | Slower (WASM) — irrelevant at this lane's 150-300 product cohort scale, exactly as §A13 anticipates ("do not invent a hard <100ms/500ms PASS threshold... performance becomes an economic/scaling observation") |

`sharp`'s only real advantage over the WASM option is decode speed and
broader format coverage — neither of which this lane needs (§7 says decode
speed is secondary at this scale; §A3 forbids reaching for AVIF via a
second dependency). Its native-binary footprint is exactly the
cross-platform CI/local-dev risk §A2 explicitly asks to weigh, and this
package has avoided that class of dependency everywhere else. `@jsquash/
webp` wins on priorities 2-5 without giving up anything this lane actually
needs on priorities 1, 6, or 7.

## AVIF (§A3)

WebP was mandatory because it was **actually observed** — 99/99 real
products from the authorized commerce path during the prior Gate E session
(`docs/vto-phase4-gate-e-access-probe.md`). AVIF was not observed at all.

`@jsquash/webp` does not support AVIF; AVIF decode lives in a **separate**
package (`@jsquash/avif`), which would be a second WASM dependency, not a
capability already present in the one just added. §A3 is explicit: "ELSE:
DO NOT add a separate AVIF-only dependency in this lane." AVIF is therefore
positively identified (by its ISOBMFF `ftyp`/`avif` box signature — see
`codec.ts`'s `detectFormat`) and routed to
`SYSTEM_ERROR:UNSUPPORTED_IMAGE_FORMAT` with `format: "AVIF"`, never
silently treated as a decode failure and never as a garment rejection.

## Node-compatibility fixes required (beyond `npm install`)

Two real incompatibilities were found and fixed during evaluation — both
documented in detail in `codec.ts`'s own `ensureWebpDecoder` comment, and
verified against a synthetic (non-retailer) encode/decode round-trip before
being relied on for the real pipeline:

1. **ESM-only package, CommonJS pipeline.** `@jsquash/webp`'s
   `package.json` declares `"type": "module"`; this pipeline compiles to
   CommonJS (`tsconfig.json`'s `"module": "commonjs"`). `require()`-ing an
   ESM package throws `ERR_REQUIRE_ESM`. Fixed with a dynamic `import()`,
   which TypeScript preserves as a real dynamic import under a CommonJS
   module target (not downleveled to `require`) — Node's documented
   CJS→ESM interop path.
2. **`fetch(file://...)` is unimplemented in Node's built-in fetch.** The
   package's default auto-init instantiates its WASM module via `fetch()`
   of a `file://` URL. Node's built-in `fetch` (undici) does not support
   the `file:` scheme at all — reproduced directly on Node v24 during
   evaluation (`TypeError: fetch failed` / `not implemented... yet...`).
   Fixed by reading the `.wasm` file with `readFileSync`, compiling it with
   `WebAssembly.compile`, and passing the compiled module into the
   library's own documented `init(module)` override — which bypasses the
   internal fetch path entirely. No network access occurs at decode time
   either way (`EXTERNAL CV / GENERATIVE CALLS: 0` holds regardless of why
   this override was needed).

Both fixes are Node-version/environment findings, not defects in the
library itself, and are cited at their exact call site in `codec.ts` so a
future upgrade of `@jsquash/webp` (or of Node) can re-verify whether either
workaround is still necessary.

## What was NOT done

- No native binary was added anywhere in this pipeline.
- No general-purpose image-processing library (`sharp`, `jimp`, `canvas`)
  was added — the normalized-pixel-contract principle (addendum §6) still
  holds: one small decode-only dependency per format actually observed,
  nothing more.
- Encoding was not added to the production pipeline — `@jsquash/webp`'s
  encoder is used only by a clearly-labeled TEST-ONLY helper
  (`__tests__/testUtils/webpTestEncoder.ts`) to manufacture synthetic WebP
  fixtures for the decode test matrix, mirroring how `encodePng` already
  manufactures synthetic PNG fixtures elsewhere in this suite. `src/`
  itself never imports `@jsquash/webp/encode.js`.
