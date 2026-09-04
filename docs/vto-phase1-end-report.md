# Live VTO — Phase 1 End Report

Authority-hardening, real-asset discovery, and program-hold closure pass.
Branch `claude/kscan-live-vto-phase1-phase2-lcqyg9`, PR #291 — draft,
unmerged, isolated, not production-authorized. Phase 2 not begun.

---

## Program gate dashboard

| Gate | Status |
|---|---|
| **GATE A — STATIC GARMENT ENGINE** | **PASS — SYNTHETIC FIXTURES** |
| **GATE B — REAL PRODUCT ASSET PIPELINE** | **HOLD — OWNER FIXTURE CORPUS REQUIRED** |
| **GATE C — NATIVE CAMERA / PERCEPTION** | **HOLD — NATIVE-CAPABLE EXECUTION REQUIRED** |
| **GATE D — GENERATIVE AI VTO** | **IMPLEMENTED — LIVE DEPLOYMENT STATE NOT VERIFIED** |

### Gate A — what the PASS covers, and what it does not

Human-validated static preview review package #2 at `37470ca`
(`docs/vto-visual-verdicts.md` entry 2). It proves static rendering mechanics
on controlled synthetic inputs: attachment, scale, orientation, deformation,
mirroring, layering, occlusion semantics, edge composition.

It does **not** prove real catalog ingestion, real pose, real segmentation,
native runtime, or physical-device behavior. Nothing in this pass changes
that boundary.

### Gate B — why HOLD

Zero authorized real apparel product images exist in the repository. Full
candidate records, provenance state, and search coverage are in
`docs/fixture-consent-log.md`. Summary: the eight `assets/qa_fixtures/` JPEGs
are classification-QA inputs with no provenance recorded anywhere in the repo
(the only "top" is a model-worn hoodie carrying both an identifiable face and
a third-party wordmark); the six `assets/catalog-images/` PNGs are K Scan's
own artwork but are category **placeholder line-art**, not product
photography, shared 10-products-to-an-image across `data/catalog.json`.

The hard gate (≈3 authorized apparel images) is not met, so the real-asset
execution lane stopped. Nothing was generated, scraped, downloaded, or
API-fetched to manufacture a corpus.

### Gate C — unchanged, and not a code failure

No macOS host is possible in this Linux container, and Android is blocked by
a live 403 on `dl.google.com` plus absent `/dev/kvm`. Recorded in
`docs/vto-native-device-handoff.md` §0. No further speculative Swift/Kotlin
was written this pass, per instruction.

### Gate D — the generative VTO chain, read-only

```
GENERATIVE_CLIENT_CODE:        PRESENT — components/vto/ (5 files),
                               hooks/useVirtualTryOn.ts,
                               hooks/useVtoAvailability.ts,
                               services/vto/ (10 files), types/vto.ts.
                               On the integration authority branch; absent
                               from master.
GENERATIVE_BACKEND_CODE:       PRESENT — supabase/functions/vto-generate/
                               (18 files): handler, contract, eligibility,
                               entitlement, reservation, result validation,
                               telemetry, guards, feature control, provider
                               registry, and tests.
CURRENT_PROVIDER_ADAPTER:      ailabtools_tryon_clothes_pro — AILabTools
                               "Try On Clothes Pro" via RapidAPI
                               (providers/aiLabToolsProvider.ts), registered
                               in providers/index.ts. A mock provider also
                               exists, reachable only when an operator names
                               it explicitly AND a deployment permission is
                               set; it is never a silent fallback.
STAGING_CONFIG_FROM_SOURCE:    Source seeds app_config.vto_generation with
                               provider "mock" and fails closed
                               (20260830174616_vto_feature_control.sql).
                               providers/index.ts states in-source that
                               staging's LIVE row already names
                               ailabtools_tryon_clothes_pro with
                               enabled: true — that is a claim about runtime
                               config, not a source fact, and is recorded
                               here as such.
PRODUCTION_CLIENT_FLAG:        OFF. EXPO_PUBLIC_VTO_UI_ENABLED is unset in
                               the production, staging, preview and
                               development EAS profiles; it is "true" in
                               staging-certification only. Production
                               therefore ships no VTO UI affordance.
LIVE_PRODUCTION_DEPLOYMENT_STATE: NOT VERIFIED. Determining it requires
                               reading live Supabase deployment and
                               app_config state, which this lane does not
                               query and must not mutate.
```

**Chain, current line:**

```
components/vto/TryItOnEntry.tsx  ·  VirtualTryOnSheet.tsx
        │  (UX affordance gated by EXPO_PUBLIC_VTO_UI_ENABLED
        │   + a non-cached read of app_config.vto_generation)
        ▼
hooks/useVirtualTryOn.ts  ·  hooks/useVtoAvailability.ts
        ▼
services/vto/vtoClient.ts   ← client VTO contract (types/vto.ts)
        ▼
supabase/functions/vto-generate/vtoHandler.ts
        ├── vtoFeatureControl.ts   (server re-reads app_config, fails closed)
        ├── vtoEligibility.ts / vtoEntitlement.ts / vtoReservation.ts
        ▼
providers/index.ts  (registry — server-side selection only)
        ▼
providers/aiLabToolsProvider.ts   ← current real adapter
        ▼
vtoResultValidation.ts → result contract → client
```

**RETIRED vs CURRENT.** `tryon-clothes-pro` — the older compatibility/anon-key
bypass handler — is retired and refuses. `vto-generate` is the current
governed path. **Retirement of the old handler is not retirement of generative
VTO**, and this report does not classify generative VTO as dead: the code is
present, the provider is registered, and the benchmark below records a real
billed round trip.

Source indicates: provider **is** registered; credentials **are** required
(read from `Deno.env` inside the adapter, never from a request body);
provider selection **is** config-driven server-side (the client never
chooses); the production UI flag **is** off. No external calls were made and
no configuration was changed by this pass.

---

## Existing provider benchmark — summarized, not re-run

`docs/vto-provider-benchmark.md` already exists on the integration authority
branch. Its own recorded state, quoted rather than re-derived:

- **Provider access ACTIVE.** A full real submit → async task → poll →
  complete → result round trip ran live against the AILabTools RapidAPI
  listing, with **real billed usage**, and one real bug was found and fixed
  from that live evidence.
- The document records a **first pass that went stale within the same
  session** — an initial probe returned "not subscribed" and concluded
  NO-GO; a re-check found the subscription active. Worth knowing before
  anyone cites the earlier conclusion.
- **Alternatives were not tested:** FASHN v1.6, fal.ai (CatVTON / Kolors /
  FLUX), Replicate `idm-vton`, Google Vertex VTO — no account, no key for
  any. Their cost/latency figures in that table are **vendor-published or
  community-reported**, not measured by K Scan.
- **`vto-generate` had not been deployed to staging** as of that document;
  the live proofs went through a temporary diagnostic function.
- Its blocker: *"quality-meaningful Discovery blocked only on real
  test-person imagery."*

No provider benchmark was run under this pass; no money was spent. Any future
vendor benchmark needs separate authority, bounded spend, the same authorized
fixture pairs, quality + latency + cost, provider-neutral, no customer
images.

> **Cross-cutting finding.** The governed generative VTO lane and this
> isolated Live VTO lane are blocked on *the same missing input* — authorized
> real imagery. Generative needs real test-**person** images; Live VTO needs
> real **garment** images. One owner decision on fixture authorization
> unblocks measurable progress in both lanes at once. That is the highest-
> leverage item on this report.

---

## Package #2 limitation disposition

The four accepted limitations from the static PASS, given owners and target
phases so they stop being open-ended debt.

| # | Limitation | Current severity | Disposition | Target phase |
|---|---|---|---|---|
| 1 | **Armpit gap** — with arms away or crossed, a wedge of the person's own clothing shows between sleeve underside and torso. No gusset geometry; the frame does not model the sleeve/body join as a surface. | Medium — visible in 2 of 6 synthetic cases; would be more visible on a real body in motion | **FIX DURING NATIVE LIVE PHASE** | Phase 2 (live deformation), because the fix needs the sleeve/body join modelled as a surface, which is the same work live drape requires. Fixing it in the static evaluation renderer alone would be throwaway. |
| 2 | **Residual aspect deviation on stress bodies** — 1.155 (broad), 0.864 (narrow) | Low — bounded by `MAX_LONGITUDINAL_ASPECT_DEVIATION`, and partly *intended*: a garment adapting to an unusual torso should deviate | **ACCEPT FOR PHASE 1** | Re-measure against real bodies before deciding whether the bound is right. Not a defect at synthetic scale. |
| 3 | **Broad fixture is deliberately outside realistic human range** (torso 0.84× shoulder span) | Low — a deliberately extreme stress case, not a body-diversity claim | **REPLACE TEST FIXTURE** | Phase 1, when a consented real-body fixture set exists. Until then the extreme fixture stays, because a stress case that no longer stresses anything is worse than one that is unrealistic. |
| 4 | **Boxy lower-torso taper** — linear below `TORSO_WIDTH_HOLD_T`, models no drape | Medium — the most likely of the four to read as "wrong" to a customer | **FIX DURING NATIVE LIVE PHASE** | Phase 2. Drape is a cloth-behavior problem; approximating it with a nonlinear taper in the static renderer would be a cosmetic patch over a missing model. |

None is disposed as `PRODUCT LIMITATION` and none as `FIX DURING ASSET
EXPANSION`. Items 1 and 4 are the two that must not be forgotten at the start
of Phase 2 — both are explicitly deferred *into* it, not away from it.

---

## Pose provider — interface only, no selection

No pose provider is chosen, and none can be defensibly chosen without device
measurement. What is settled is the **interface**, which is already
provider-neutral in source: `BodyFrame`
(`kscan-live-vto/packages/live-vto-contract/src/bodyFrame.ts`) is the only
shape downstream code sees, and `PerceptionProvider`
(`native/ios/LiveVTOPerceptionProvider.swift` and its Kotlin mirror) is the
adapter seam. No downstream package imports provider-specific landmark IDs.

Decision criteria, to be answered with measurements rather than preference:
local/on-device execution; front-camera support; landmark coverage
sufficient to populate `BodyFrame` without fabrication; whether the same
runtime also emits a segmentation mask; licensing compatible with commercial
store distribution; model size against app download budget; latency within
the perception budget alongside render; native-platform support across the
intended device floor.

Candidate classes already researched in this program are recorded in
`docs/vto-native-device-handoff.md` §2 (Apple Vision body pose; MediaPipe
Pose Landmarker; ARKit body tracking, rejected on the fact that it is
rear-camera only). **No benchmark numbers are asserted as fact here**, and no
further uncompiled native adapter was written this pass.

---

## Segmentation tooling check

```
EXISTING LOCAL SEGMENTATION:  NONE usable by this program.
DEPENDENCY / TOOL:            No segmentation, background-removal, or ML
                              runtime dependency exists in either the root
                              or the integration-branch package.json — no
                              rembg, u2net, MediaPipe, TensorFlow/TFLite,
                              ONNX, OpenCV, sharp, jimp, or body-pix.
USED ELSEWHERE:               The Mirror feature references Apple Vision's
                              VNGeneratePersonSegmentationRequest (iOS 15+)
                              in native code and parity tests. That is
                              PERSON segmentation on iOS, not garment
                              segmentation, and it is unreachable from this
                              Node sandbox. Source explicitly notes garment
                              segmentation does not exist behind the flag.
LICENSE NOTES FOUND:          None — there is no LICENSE, NOTICE, or
                              attribution file anywhere in the repository.
```

No ML model was installed under this pass. Consequently:
**AUTOMATIC GARMENT SEGMENTATION: NOT VALIDATED.** No cloud
background-removal or segmentation provider received any imagery.

---

## Human input dashboard

The inputs no amount of further autonomous work can supply.

| Input | State | What unblocks it |
|---|---|---|
| **REAL PRODUCT FIXTURE CORPUS** | **BLOCKING GATE B.** Zero authorized apparel product images exist. | Owner authorizes specific images, or supplies a small licensed set — flat lay / ghost mannequin / clean studio, T-shirts and simple tops. Highest leverage item on this report. |
| **NATIVE-CAPABLE EXECUTION ENVIRONMENT** | **BLOCKING GATE C.** | A macOS host with Xcode (iOS), or an Android SDK + KVM-capable host + egress to `dl.google.com` (Android). |
| **CONSENTED HUMAN/PERSON FIXTURES** | **BLOCKING** both the Live VTO person path and, per its own document, the generative provider's quality benchmark. | Consented capture logged in `docs/fixture-consent-log.md` before first use. |
| **TARGET DEVICE MATRIX** | Not chosen. | Owner names the device floor: one current iPhone, one older supported iPhone, one mid-range Android, one stronger Android, per §30. |
| **PRODUCTION VTO ENABLEMENT DECISION** | Not made, and correctly not made by this lane. | Owner decision, separate from any R&D outcome here. |

Deliberately **not** listed as unresolved: "provider decision." The current
provider is established in source and live-verified. The open item is a
different one:

```
CURRENT PROVIDER IMPLEMENTATION:        ailabtools_tryon_clothes_pro —
                                        implemented, registered, live-verified
                                        with real billed usage.
FUTURE PROVIDER BENCHMARK / REPLACEMENT: OPEN — requires separate authority
                                        and bounded spend. Untested
                                        alternatives carry vendor-published
                                        figures only.
```

---

## Near-term customer-value candidates (not implemented)

Per the drift check: the isolated R&D program must not consume the entire VTO
roadmap. Three improvements to the **existing governed generative VTO** that
would create customer value without Live VTO, without native camera
validation, and without disturbing the provider-neutral architecture. These
are **candidates for separate authority**, not work started here, and none
belongs inside PR #291.

1. **Close the real-person fixture gap for the generative lane.** Its own
   benchmark says quality Discovery is blocked *only* on real test-person
   imagery. A small consented fixture set converts an already-working,
   already-billed provider integration into measurable quality evidence. Same
   owner decision that unblocks Gate B; cheapest path to a real customer-
   facing answer.
2. **Deploy and exercise the governed `vto-generate` path end to end on
   staging.** The benchmark records that live proofs ran through a *temporary
   diagnostic function*, not the governed function with its entitlement,
   quota, idempotency and reservation controls. Those controls are exactly
   what protects a paid provider from a runaway bill, and they have not been
   exercised against a real provider call on the real path.
3. **Make the mock-vs-real provider distinction unmistakable in the UI.**
   Source shows real care here already (the mock needs an explicit deployment
   permission; unknown providers fail visibly rather than falling back). The
   residual risk it names is a placeholder vignette labelled "AI
   VISUALIZATION" reaching a real person against their own K+ quota. A
   client-visible provenance marker on any mock-sourced result would close
   the remaining gap between "fails closed in the backend" and "a customer
   can tell what they are looking at."

---

## Test and guardrail invariants

```
NO EXISTING TEST DELETED:                  confirmed
NO EXISTING TEST WEAKENED:                 confirmed
NO EXISTING TEST SKIPPED TO FORCE GREEN:   confirmed
STATIC PACKAGE #2 REMAINS REPRODUCIBLE:    confirmed
PROTECTED-PATH CHECK REMAINS GREEN:        confirmed
PRODUCTION / STAGING MUTATION:             NO
```

Reproducibility was verified by re-running `tools/render-static-review.js`
against the current tree: **all 35 evidence PNGs came back byte-identical.**
The only diff was each manifest's `gitSha` field, and that churn was reverted
rather than committed — it would have rewritten human-reviewed evidence for no
semantic gain.

> One provenance quirk, recorded so it is never mistaken for tampering: the
> committed package-#2 manifests carry `gitSha: ee29858`, which is package
> **#1's** commit. The renderer stamps `git rev-parse HEAD` at render time,
> and the render necessarily happens *before* the commit that will contain
> it — so the stamp always lags its own content by one commit. The pixels are
> package #2's; the stamp names the parent. Worth fixing properly (stamp at
> commit time, or record "rendered from tree-ish + dirty flag") if evidence
> provenance ever needs to be machine-checkable.

New this pass: `kscan-live-vto/tests/guardrail/protectedPathSemantics.test.js`
(7 tests), wired in as `npm run test:guardrail`. It protects meaningful new
behavior — the prefix-vs-existence semantics of the guardrail — rather than
padding a count. `tools/validate-protected-paths.js` gained an exported
`classifyPath()` and a `require.main` guard so it can be exercised with
synthetic input; its CLI behavior is unchanged.
