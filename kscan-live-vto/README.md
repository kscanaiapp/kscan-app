# K Scan Live VTO — Phase 1-2 isolated research line

Isolated engineering workspace for the K Scan AI Live VTO Phase 1-2
build plan. Every file under this directory is R&D, not a production
dependency of `kscan-app`'s root `package.json`/build.

## Authority boundary (read this first)

This program is authorized to inspect the authoritative `kscan-app`
source and build experimental code inside this directory. **It is not
authorized to modify, deploy, merge into, expose, or otherwise change the
existing K Scan AI production application, staging VTO, production VTO,
Commerce production path, Supabase production/staging state, or existing
generative VTO behavior.** See `docs/source-authority.md` (repo root) for
the recorded baseline this line was built from, and
`kscan-live-vto/tools/protected-paths.json` +
`.github/workflows/live-vto-protected-paths.yml` for the mechanical
guardrail that enforces it on every commit — not just this paragraph.

Status tracking lives at repo root: `docs/vto-phase1-status.md` (weekly
status), `docs/vto-risk-register.md`, `docs/vto-visual-verdicts.md`
(human PASS/FAIL/HOLD log — currently empty, nothing has been rendered
yet), `docs/fixture-consent-log.md`.

## Layout

```
kscan-live-vto/
├── apps/sandbox/         Dev-client-only Expo app, not run in this session
├── packages/
│   ├── live-vto-contract/    @kscan-live-vto/contract — BodyFrame, guidance
│   │                          states, native-view command/event surface,
│   │                          privacy phase, device-capability levels
│   ├── garment-contract/     @kscan-live-vto/garment-contract — GarmentDescriptor,
│   │                          .ksgarment manifest schema + validation
│   ├── body-model/           @kscan-live-vto/body-model — One Euro filter,
│   │                          ephemeral BodyProxy derivation
│   ├── asset-pipeline/       @kscan-live-vto/asset-pipeline — shot-class stub,
│   │                          QC composition, affine-MLS control-point
│   │                          deformation math
│   └── evaluation/           @kscan-live-vto/evaluation — fixture manifest
│                              schema, metrics, golden-sequence runner,
│                              synthetic BodyFrame generator
├── native/                Expo Modules native-view scaffold (Swift + Kotlin),
│                          UNBUILT — see native/README.md
├── fixtures/               people/ (empty — no consented footage exists),
│                          garments/ (manifest-only), sequences/ (3 synthetic
│                          golden sequences with real generated reports)
├── tests/privacy/          dependency-boundary + local-only-data-class guardrails
└── tools/                 protected-path validator + config
```

## What's real vs. scaffolding

Every package under `packages/` is real, buildable TypeScript with a real
`node --test` suite — 66 tests passing as of this README's last update
(`npm test` from this directory). The affine-MLS deformation math and the
One Euro Filter are correctness-verified implementations of published
algorithms, not toy stand-ins.

Everything under `native/` is **unbuilt, uncompiled scaffolding** — no
camera, physical device, or Xcode/Android Studio toolchain was available
in the session that wrote it. See `native/README.md` before treating any
Swift/Kotlin file here as evidence of a working pipeline.

## Running things

```sh
cd kscan-live-vto
npm install
npm run build   # builds packages in dependency order: garment-contract -> contract -> body-model -> asset-pipeline -> evaluation
npm test        # builds + runs every package's tests, then tests/privacy
npm run guard:protected-paths   # Section 8.2 mechanical guardrail, same check CI runs
```
