# Live VTO Native Runtime N1 — Defect / Divergence Ledger

Format follows the mission's own P0-P10 severity bands. Only real findings recorded here -- see section 59/62 of the N1 mission for repair authority.

## N1-ENV-001 (P2) -- amendment B1 conflicts with an existing merged governance test

**Found:** N1-A setup, before any eas.json edit was made.

**What:** Amendment B1 authorizes setting `EXPO_PUBLIC_LIVE_VTO_ENABLED=true` in the `development` EAS build profile so the dev-client APK can reach the Live entry point. But `__tests__/vtoLiveFeatureGate.test.js` ("flag: no EAS profile sets it -- production and staging included") iterates **every** profile in `eas.json` and asserts none of them defines `EXPO_PUBLIC_LIVE_VTO_ENABLED` or `EXPO_PUBLIC_LIVE_VTO_HARNESS` -- no profile is exempted, `development` included. This test is part of the already-merged, hostile-audited P3-C Live VTO contract (integration `4365cebf`, pre-N1), not something N1 authored.

**Root cause:** the mission's amendment B1 was written before (or without accounting for) the P3-C contract's own launch-posture test. The two are drafted from different vantage points: B1 assumes no such test exists; the merged codebase already closes exactly this door, deliberately, with a named test.

**Resolution (per amendment B3 -- "if scaffold and merged contract diverge, the merged contract governs, record the divergence"):** did **not** edit `eas.json`. `development` keeps `EXPO_PUBLIC_LIVE_VTO_ENABLED` absent, same as every other profile; `vtoLiveFeatureGate.test.js` stays green, unmodified. N1's own local verification builds use a gitignored `.env.local` instead (see the environment doc) -- Expo's local dev/build tooling reads `EXPO_PUBLIC_*` from `.env.local`/shell env for a local `expo run:android`/gradle build, which never touches the committed eas.json profiles the test inspects. This gives N1 a real way to exercise the flagged-on code path for its own verification without weakening the customer-facing launch posture the test protects.

**Outcome:** not a bug to fix -- a policy conflict between an amendment and a merged test, resolved in the merged test's favor. If the owner wants the dev-client APK itself (the section 49 installable deliverable) to ship with Live reachable out of the box, that requires either amending `vtoLiveFeatureGate.test.js` itself (an explicit, reviewed decision to narrow its assertion) or accepting that the dev-client APK needs the same local `.env.local`/`--build-env` treatment at install time. Deferred to an owner decision at N1-G, not resolved unilaterally here.

## N1-ENV-002 (P2) -- mission's illustrative capability JSON diverges from the merged native-module TS contract

**Found:** N1-A implementation, before writing the Kotlin module.

**What:** Mission section 5 gives an illustrative initial capability payload:
```json
{ "moduleAvailable": true, "runtimeReady": false }
```
The actual merged application adapter (`services/vto/liveVtoNativeModule.ts`, `LiveVtoNativeSelfCheck`) defines the real, tested shape as:
```ts
{ capable: boolean; runtimeReady: boolean; runtimeVersion?: string | null }
```
There is no `moduleAvailable` field anywhere in the merged contract -- module presence is a fact the JS **adapter** derives from whether `requireOptionalNativeModule` found anything at all (`LiveVtoNativeCapability.present`), not something the native `getCapability()` call reports about itself.

**Resolution (per amendment B3):** the Kotlin module's `getCapability()` returns `{capable, runtimeReady, runtimeVersion}` -- the real, merged, tested field names -- not the mission's illustrative ones. Both `capable` and `runtimeReady` are `false` at N1-A: no device-eligibility check has been implemented yet, and claiming `capable: true` with nothing behind it would repeat exactly the "registration is not capability" mistake `liveVtoNativeModule.ts`'s own header comment warns against. `capable` becomes a real, evidenced device check no earlier than the gate that actually implements one (not yet decided which -- likely N1-E/N1-F, alongside the perception/camera capability checks).

**Outcome:** resolved in the merged contract's favor, no test or app-layer change needed. Recorded so a later session doesn't "fix" the native module back toward the mission's illustrative shape.

## N1-ENV-003 (P2, build infrastructure) -- literal `--` inside XML manifest comments breaks every local Gradle Android build

**Found:** N1-A, first `./gradlew :app:assembleDebug` attempt in this worktree.

**Reproduction:** `./gradlew :app:processDebugMainManifest --stacktrace` -> `com.android.manifmerger.ManifestMerger2$MergeFailureException: Error parsing android/app/src/main/AndroidManifest.xml` -> `Caused by: org.xml.sax.SAXParseException; lineNumber: 31; columnNumber: 55; The string "--" is not permitted within comments.`

**Root cause:** the XML 1.0 spec forbids the two-character string `--` anywhere inside a comment body, not only at its `<!--`/`-->` boundaries. Android's manifest-merger parses with a strict validating Xerces SAX parser that enforces this as a fatal error rather than tolerating it (many lenient XML/HTML tools do tolerate it, which is presumably why this survived unnoticed). `android/app/src/main/AndroidManifest.xml` line 31 (the mailto `<queries>` rationale comment) and six more occurrences across `android/app/src/certification/AndroidManifest.xml`'s Voice Scan comment block all used `--` as a prose parenthetical dash -- the same style used throughout this codebase's `.ts`/`.js` comments, where it is perfectly legal.

**Scope:** blocks the `main` and `certification` manifest variants of every local Gradle Android build (`assembleDebug`, `bundleRelease`, etc.) on any machine, regardless of which module or lane is being worked on. Not specific to N1 or to the new native module -- discovered only because N1-A was the first lane in the visible history to attempt a genuine from-scratch local Gradle build through to final packaging (prior verification was consistently EAS-cloud-shaped; see the environment doc).

**Repair:** replaced each literal `--` with a comma or semicolon, preserving the comments' meaning exactly. No permission, activity, intent-filter, or `tools:node` directive touched in either file.

**Regression:** `./gradlew :app:processDebugMainManifest` -- BUILD SUCCESSFUL (was FAILED) after the fix, both manifests.

**Outcome:** fixed, committed (`510cbdb`), declared in the integration manifest's authorized boundary (new rows for both `AndroidManifest.xml` paths -- neither was covered by any existing pattern).

## N1-ENV-004 (P1, native renderer) -- mixed normalized/pixel units collapsed every control point onto the body axis

**Found:** N1-B, first on-device run of `LiveVtoGarmentAttachment.kt` against the real governed fixture, caught via `Log.d` evidence (`evidence/vto-live-native-n1/n1b-*.json`), not by inspection -- the bug was invisible in the source diff review.

**Reproduction:** on-device result showed `scale=0.0036` (should be ~0.98, matching the Node oracle) and all 11 control-point targets clustered within a few pixels of the canvas centerline (x in [359.6, 360.4]) instead of spanning roughly [230, 490] as the oracle computes. Gate failed with `left_right_inversion`, `upside_down`, `gross_scale_error` -- all three, simultaneously, on a perfectly ordinary front-facing canned pose.

**Root cause:** porting the P3-A reference's texture-pixel-space conversion (the oracle's `attachment.ts` explicitly converts garment (u,v) to real texture pixels via `textureWidth`/`textureHeight` before any vector math -- see its own doc comment: "a similarity transform between two normalized spaces of different aspect ratios is not a similarity at all"), an earlier pass fixed the DENOMINATOR of `lateralFrac` (`seamSpanTexture`, scaled to real pixels) but left the NUMERATOR (`cp.u - garmentMidU`) in raw normalized `[0,1]` units. Since the texture is 271px wide, this made every lateral offset ~271x too small, collapsing all control points toward the body-axis centerline regardless of their actual authored position. The same partial-fix pattern also left `vShoulder`/`vHem`/`vSpan` (used for the longitudinal placement and the aspect-protection ratio) in normalized units while `lateralScale` was already in pixel units -- a second instance of the identical mistake.

**Repair:** rewrote `computeControlPointTargets` so every garment-space quantity converts to real texture-pixel units (`cp.u * textureWidth`, `cp.v * textureHeight`) at first use and stays in that space for the rest of the function, rather than converting some quantities and not others.

**Regression:** on-device `Log.d` after the fix (see `evidence/vto-live-native-n1/n1b-first-render-roundtrip.json`) shows `scale≈0.98`, `rotationRadians≈0`, gate `passed:true`, and control-point targets spanning the expected range, matching the Node oracle's own computed values within the tolerance recorded there.

**Outcome:** fixed. Recorded because it is exactly the class of bug the mission's own conformance-comparison requirement (compare against the oracle before N1-B closes) exists to catch -- it was invisible in a source read and only surfaced by actually running the code and comparing numbers.

## N1-ENV-005 (P1, native renderer) -- lateral axis picked the wrong perpendicular, mirroring every control point left/right

**Found:** N1-B, the run immediately after N1-ENV-004's fix. Oracle comparison: scale now matched the Node reference exactly (0.98258823 vs 0.9825882352941173), but rotation was 180 degrees off (pi radians vs 0) and the rigid gate correctly failed with `left_right_inversion` + `upside_down`.

**Reproduction:** on-device `leftShoulder` target landed at x=460.2 and `rightShoulder` at x=259.8 -- swapped almost exactly against the oracle's `leftShoulder` x=259.3 / `rightShoulder` x=459.7 (residual difference from hand-copied manifest float precision, not a real divergence).

**Root cause:** `lateralAxis`, the perpendicular used to place every control point left/right of the body axis, was defined as `PointF(-bodyAxis.y, bodyAxis.x)`. Of the two possible perpendiculars to a given axis, this one happens to point toward the body's own RIGHT for a control point on the garment's lower-u (wearer's-own-left, by this whole system's mirrored-camera u/v convention) side -- i.e. it mapped garment-left onto body-right and vice versa. A pure sign error: it did not corrupt scale (which only depends on magnitude) or the longitudinal placement (a different axis entirely), which is exactly why N1-ENV-004's fix could look completely correct on the scale check alone while this defect was still live.

**Repair:** flipped to the other perpendicular, `PointF(bodyAxis.y, -bodyAxis.x)`, verified against the concrete canned-pose numbers (not just "the sign looked right").

**Regression:** on-device result after the fix (see `evidence/vto-live-native-n1/n1b-first-render-roundtrip.json`) shows `rotationRadians≈0`, gate `passed:true, findings:[]`, and every control point's x-coordinate within ~0.5px of the oracle's.

**Outcome:** fixed. Two real geometry defects (N1-ENV-004, N1-ENV-005) in one porting pass is the concrete argument for why amendment B2's "compare against the oracle, not just against the source" requirement exists -- a source-only review of either function would have looked plausible.

## N1-ENV-006 (P2, native renderer) -- `.d.ts` signatures are not the implementation; three real algorithmic divergences found once the compiled source was actually read

**Found:** N1-B, after N1-ENV-005's fix made scale and rotation match the oracle exactly but hem/torso/armpit control points still landed 13-14px off. The earlier port (this file, pre-rewrite) was written from `attachment.d.ts` (type signatures + doc comments) plus the summarized research-agent report -- neither carries the actual formulas. Once `attachment.js` (the compiled output in the reference-oracle checkout) was read directly, three concrete divergences turned up:

1. **Hem width.** The port computed `widthAtHem` from the garment's OWN texture-space hem/shoulder ratio scaled uniformly (`hemSpanTexturePx * lateralScale`). The reference instead sizes the hem to the BODY's actual hip width (`hipHalfWidth = |rightHip-leftHip|/2`, `hemHalfWidthIntended = hipHalfWidth + shoulderSpanPx*0.04`, then solved backward through the hem control point's own lateral fraction) -- a hip-length tee hugs the hips it is actually worn on, not a fixed scale-up of its own flat-lay proportions.
2. **Lateral axis.** The port derived the shoulder->shoulder ("lateral") direction as a perpendicular of the ALREADY-DERIVED shoulder->hem ("longitudinal") axis. The reference derives the shoulder direction (`rightDir`) directly from the raw shoulder anchors FIRST, and derives the perpendicular (`upDir`) from THAT -- consistent with a tilted body carrying the garment with it, and not exactly interchangeable with the port's order in general (only coincidentally close for an untilted pose, which is why N1-ENV-005's sign-only fix produced a matching scale/rotation but still-wrong lateral spread for non-shoulder points).
3. **`evaluateRigidGate`** gates against the garment's RIGID-transformed control points (`applySimilarity(placement, cp)`), not the deformed targets `computeControlPointTargets` produces. The port had been gating against a mix of targets and ad-hoc rotated vectors.

**Repair:** rewrote `computeControlPointTargets`, added `applySimilarity`, and rewrote `evaluateRigidGate` as a line-for-line port of `attachment.js`, including the exact hem-width derivation, axis order, sleeve fallback-direction formula (`-upDir + rightDir*outward*0.35`), and the "perpendicular pointing away from `shoulderMidBody`" sign correction for sleeve offset.

**Regression:** on-device result now matches the oracle within ~0.5px on every one of the 11 control points (see `evidence/vto-live-native-n1/n1b-first-render-roundtrip.json`), gate `passed:true, findings:[]`.

**Outcome:** fixed. The reusable lesson: for a disjoint-history reference package, `git show <sha>:path` on the COMPILED output (`dist/*.js`), not just the `.d.ts`, is required before claiming a port is faithful -- type signatures and doc comments describe the contract, not the arithmetic.

## N1-ENV-007 (P2, native renderer) — the native runtime invented hips where the reference refuses

**Found:** N1-C, first cross-runtime comparison over the golden refusal cases. Invisible until the absence paths were actually exercised: every N1-B evidence run used a pose with both hips present.

**What:** `extractBodyAnchors` substituted a shoulder-derived estimate when a hip landmark was absent:

```kotlin
val leftHip = frame.leftHip.pointOrNull()?.toCanvasPx(...)
  ?: Vec2(leftShoulder.x, leftShoulder.y + shoulderSpanPx * 1.1f)
```

The P3-A reference instead returns `{ok: false, reason: 'missing_hips'}` and the whole placement fails.

**Root cause:** the fallback was written as defensive robustness. It is the opposite. Hips set `hemMidBody`, `hipHalfWidth`, `hemHalfWidthIntended` and `torsoHeightPx` — the entire lower half of the garment's placement. Substituting an estimate means the runtime renders a garment onto a body half that was never observed, and reports it as a successful render, with nothing downstream able to tell the difference. The reference's own `bodyFrame.ts` states the rule this violated: "Never substitute a guessed (0,0) or a stale value here — represent absence explicitly and let consumers decide."

**Repair:** `extractBodyAnchors` now returns a discriminated `AnchorResult`, mirroring the reference's own `{ok:true,anchors} | {ok:false,reason}`, and fails closed with `missing_hips`. `neckCenter` keeps its fallback — that one is in the reference too, and neckline is a gate tolerance, not a placement input.

**Negative control:** goldens `missing-left-hip` and `missing-hips`. Both now refuse, and the comparison tool asserts the native and reference refusal decisions agree.

**Regression:** refusal agreement 10 of 14, with the remaining 4 being N1-ENV-008 only.

**Outcome:** fixed. The general lesson: a fallback that lets a pipeline continue is only robustness if the substituted value is *knowable*. Here it was not, and "robustness" meant "renders confidently onto guessed anatomy".

## N1-ENV-008 (P1, REFERENCE implementation — not repaired here) — the reference's rigid stop gate passes all-NaN geometry

**Found:** N1-C, comparing the `nan-shoulder` and `infinite-hip` goldens across runtimes. Native refused; the reference did not.

**Reproduction:** run `tools/run-reference-oracle.mjs` over the golden set and read the `nan-shoulder` record:

```
failure=null  gatePassed=true  findings=[]  scale=NaN  leftShoulder=[NaN,NaN]  rightHem=[NaN,NaN]
```

**Root cause:** a NaN landmark is `present`, so `toPixels` returns `{x: NaN, y: NaN}` rather than null, and no absence check fires. `shoulderSpanPx` becomes NaN, and the guard `if (shoulderSpanPx < 1)` does not trip, because every comparison with NaN is false. NaN then propagates through every stage. `evaluateRigidGate` inherits the same property: all five of its checks are comparisons (`<= 0`, `< 0.55 || > 1.8`, `> tolerance`), and each is false against NaN, so it returns `passed: true, findings: []`. The gate whose entire purpose is to answer "is this garment semantically attached to this body at all" certifies fully-undefined geometry as correctly attached.

**Scope:** the P3-A static reference renderer, not this repository. It is reachable from any perception provider that can emit a NaN — which is most of them, on a degenerate frame.

**Decision:** the native runtime deliberately does NOT match this. It refuses with `non_finite_landmark`, checked at the boundary before any arithmetic. Matching the reference to improve a conformance number would mean shipping a runtime that renders undefined geometry on a faulty perception frame, which mission sections 11 and D13 forbid.

The divergence is recorded in `compare-conformance.mjs`'s `DOCUMENTED_REFERENCE_DEFECTS`, printed on every run, and classified as `documented_reference_defect` in the summary. It is never suppressed and never folded into the "agreeing" count.

**Follow-up owed (not this lane):** the reference implementation should reject non-finite landmarks at `toPixels`. Raised here rather than fixed because the reference is a disjoint, unmerged history this lane has no authority over, and because amendment D4's point stands on its own — conformance to a reference is not evidence the reference is correct.

## N1-ENV-009 (P2, native replay) — entering ERROR left renderable geometry in the latest-state slot

**Found:** N1-D, by `switchingToAnInvalidGarmentFailsClosedWithoutCorruptingTheSession` — the test failed on the first run, which is what it exists for.

**Reproduction:** start replay, produce frames, then `selectGarment` with invalid texture dimensions. Session correctly transitions to `ERROR`, but `slot.depth` was still 1.

**Root cause:** the error path transitioned state and returned without clearing the slot. A renderer that `peek()`s rather than `consume()`s — which the draw path does, so it can redraw the same state on a UI-driven repaint — would keep drawing the last good frame indefinitely while the session behind it was broken. A stale render that is pixel-identical to a working one, with no signal anywhere that anything failed.

**Repair:** the `transition` helper clears the slot on entry to `ERROR`.

**Second defect, introduced by the first repair and caught immediately:** the initial fix also cleared on `STOPPED` and `EOF`. That broke two passing tests — the frame-index synchronization test (the final frame vanished before it could be consumed) and the backpressure accounting invariant `produced == rendered + dropped + depth` (a frame was discarded that was counted as neither). Both failures were correct: EOF is a *normal* terminal state and the final frame is the right thing to leave on screen (mission section 20's documented retention contract), and `stop()` already clears explicitly, so routing it through `transition` double-counted. Narrowed to `ERROR` only, with the EOF retention contract documented at the point it is enforced.

**Negative controls:** `switchingToAnInvalidGarmentFailsClosedWithoutCorruptingTheSession` (ERROR clears), `garmentMovesOverTimeAndStaysSynchronisedWithTheFrameIndex` (EOF retains), `producerOutrunningConsumerDropsStaleFramesAndStaysBounded` (accounting invariant holds).

**Outcome:** fixed. Worth recording because the over-broad first fix was only caught by tests that already existed for other reasons — the accounting invariant in particular was written to make backpressure non-vacuous, and it turned out to be the thing that detected an unrelated frame being silently dropped.

## N1-ENV-010 (P1, native renderer) — the deformation stage was a placeholder that did not render a garment

**Found:** N1-C, by rasterizing the frozen mesh for visual review (`tools/render-snapshot.mjs`). Invisible to every numeric gate that existed at the time, and that is the whole point of the finding.

**What:** N1-B shipped stage 5 as an inverse-distance-weighted interpolation of the mesh grid from the 11 control-point targets, labelled in its own doc comment as a deliberate simplification and not claimed as parity. The label was honest; the consequence was not understood. Rendered, the result is not a garment: the neckline caves inward, the sleeves pinch to points, the hem forms a deep V, and the silhouette reads as a starfish.

**Why nothing caught it:** control-point placement (stage 2) and mesh deformation (stage 5) are different stages. Every conformance number measured stage 2. All 308 control points agreed with the oracle to 5.63e-3 px while the surface *between* them was wrong. A gate built only on control points cannot see this, which is exactly the case amendment D2 makes for a render being mandatory rather than supplementary: "does the supposedly-correct geometry actually look like a garment?" is a question the numbers cannot answer.

**Root cause:** the real algorithm — affine moving-least-squares (`deformVertex` in `@kscan-live-vto/asset-pipeline`) — had not been ported. IDW is not an approximation of MLS; it is a different function, with cusps at each control point and collapse between them.

**Repair:** `LiveVtoDeformation.kt`, a line-for-line port of `dist/affineMlsDeformation.js` at reference SHA `266ab1a`, including the exact-interpolation short circuit, the single-control-point translation case, the weighted centroids, the normal equations, and the identity fallback for a singular `S`. Computed in `Double` rather than `Float`: the normal equations accumulate coordinate products weighted by `1/distance^2`, so intermediate magnitudes span many orders of magnitude and float32 loses meaningful precision in `S` before it is inverted; only the final coordinate is narrowed.

**Regression:** the reference oracle runner now emits the reference's OWN deformed mesh, and the comparison measures it. Cross-runtime mesh delta over 1600 vertices / 20 cases: **median 2.51e-5 px, max 1.04e-4 px.** Plus oracle-independent properties in `DeformationTest`: exactness at every control point, exact reproduction of a known affine map everywhere (not just at control points — this is what catches a transposed matrix), pure translation, the singular-configuration fallback, and that the mesh actually tracks the pose rather than degenerating to the rigid placement.

**Outcome:** fixed. The reusable lesson is narrower than "render things": a conformance suite measures the stages it samples. Stage-2 agreement was cited as evidence about a pipeline whose stage 5 had never been compared to anything.

## N1-ENV-011 (P2, native renderer) — `meshDefinition.width` is a VERTEX count, not a cell count

**Found:** N1-C, while porting the deformation — reading the reference's `buildGridMesh` rather than assuming its convention.

**What:** the reference builds its grid as `for (row < rows) for (col < columns)` with `x = (col / (columns - 1)) * textureWidth`, i.e. `meshDefinition.width`/`height` are counts of VERTICES. The native port treated them as counts of CELLS and looped `0..width`, producing a 9x11 grid of 99 vertices where the reference produces 8x10 = 80, with every sample at a different position.

Android's `Canvas.drawBitmapMesh(bitmap, meshWidth, meshHeight, verts, ...)` uses the opposite convention: `meshWidth`/`meshHeight` are CELL counts requiring `(meshWidth + 1) * (meshHeight + 1)` vertices. The two line up only once the distinction is made explicitly, which is why the mistake produced a plausible-looking mesh rather than an obvious crash.

**Repair:** `LiveVtoDeformation.gridSourceVertices` follows the reference exactly, and the snapshot publishes `meshWidth = manifest.width - 1`, `meshHeight = manifest.height - 1` — Canvas cell counts — so the array it publishes and the shape it declares are consistent by construction. Manifest validation now rejects a grid smaller than 2x2 vertices, which previously would have divided by zero.

**Negative control:** `theSnapshotMeshShapeMatchesTheVertexArrayItPublishes` asserts both directions — that the published cell counts imply exactly the published vertex count, and that the vertex grid is the manifest's own. The comparison tool independently reports `mesh_grid_shape_differs` as a semantic divergence if the two runtimes ever disagree on grid shape.

**Prior evidence affected:** the on-device N1-B log recorded `meshVertexCount: 99`. That number was wrong and is superseded; every conformance figure in this ledger and in the conformance document was regenerated after the fix.
