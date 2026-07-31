# Build 2.5 Mirror Selfie — physical-device testing backlog

**Status: NOTHING IN THIS DOCUMENT HAS BEEN RUN.**

Every cell below is empty on purpose. This is the matrix a later testing cycle
has to fill, not a record of results. No value here may be quoted as evidence
until it has been measured on the hardware named beside it.

Source state this backlog applies to:

| | |
|---|---|
| Android branch | `feature/android-build-2.5-mirror-extraction` |
| iOS branch | `feature/ios-build-2.5-mirror-extraction` |
| Feature flag | `MIRROR_SELFIE_V1` = false in every profile |
| Backend | `scan-identify` v141, untouched |

---

## 1. What has NOT been done

| Evidence | Status | Blocker |
|---|---|---|
| iOS native compilation | **DEFERRED** | macOS/Xcode unavailable in this environment |
| iOS native unit tests (`ios/Tests`) | **DEFERRED** | same |
| iOS simulator smoke test | **DEFERRED** | same |
| iOS physical extraction | **DEFERRED** | no device |
| Android physical extraction | **DEFERRED** | no device |
| Android emulator extraction | **DEFERRED** | not run this cycle |
| Latency | **NOT MEASURED** | needs hardware |
| Peak memory | **NOT MEASURED** | needs hardware |
| Android binary-size delta (ML Kit pose) | **NOT MEASURED** | needs a measured build |
| Extraction accuracy | **NOT MEASURED** | needs real photographs |

**Android native compilation and the module's JVM unit tests DID run** and
succeeded — that is the one piece of native evidence this build has. It proves
the Kotlin compiles and the ML Kit artifact resolves. It proves nothing about
what the detector finds.

---

## 2. Scenario matrix

Run every row on both platforms. Record the outcome, not an impression.

| # | Scenario | Expected behaviour | Android | iOS |
|---|---|---|---|---|
| 1 | Single full-body subject | upper + lower + feet regions | | |
| 2 | Upper-body crop only | upper region; no lower, no feet | | |
| 3 | Visible footwear | left/right foot regions present and on the shoes | | |
| 4 | Layered outfit (coat over jumper) | ONE upper region, flagged `review` | | |
| 5 | Long dress / full-length garment | may split at the hip — record whether the split is useful | | |
| 6 | Side-facing subject | regions follow the body, not the frame | | |
| 7 | Partially occluded subject | occluded band absent or `review`, never invented | | |
| 8 | Two subjects, one dominant | the near subject selected silently | | |
| 9 | Two ambiguous subjects | STOPS and asks; no crop before the choice | | |
| 10 | Background person, no visible face | Android: not a candidate (face-derived). iOS: may be. **Record the divergence.** | | |
| 11 | Mirror reflection plus another person | reflection must not become a second subject | | |
| 12 | Rotated gallery image | crops upright; no sideways garment | | |
| 13 | Low light | degraded confidence → `review`, not wrong regions | | |
| 14 | Large source image (≥12 MP) | no OOM; the 20 MB pre-decode guard behaves | | |
| 15 | Cancel during inference | instant UI cancel; no file survives | | |
| 16 | Background and resume mid-session | crops survive; session intact | | |
| 17 | Actor change during inference | session destroyed; no crop reaches the new account | | |

**Scenario 10 is the one to watch.** Android derives its person candidates from
the bundled face detector because ML Kit pose returns a single subject; iOS
enumerates people directly with `VNDetectHumanRectanglesRequest`. A person
facing away is therefore visible to iOS and invisible to Android. Both fail
safe — Android simply sees one fewer reason to interrupt — but the behaviours
differ and the difference must be measured rather than assumed harmless.

---

## 3. Measurements

Per platform, over the scenario set. Do not average across platforms.

| Measurement | Definition | Android | iOS |
|---|---|---|---|
| Person-selection accuracy | correct subject chosen ÷ multi-person cases | | |
| Useful-region rate | regions a user would keep ÷ regions emitted | | |
| Ambiguous-region rate | regions containing >1 garment ÷ regions emitted | | |
| Major-cutoff rate | regions clipping most of the intended garment | | |
| Duplicate-region rate | pairs a user would call the same crop | | |
| Zero-region rate | sessions producing nothing from a valid selfie | | |
| Latency | source selected → review shown, p50 / p95 | | |
| Peak memory | during inference and crop generation | | |
| Binary-size delta | AAB/IPA with the module vs without | | |
| Crop readability | crops that open and show the intended region | | |
| Metadata removal | Exif/GPS/IPTC absent from every crop, verified externally | | |
| Temporary-media cleanup | session directory empty after each terminal state | | |

The geometry layer has already been evaluated over controlled landmark
fixtures — `node scripts/mirror-region-quality.js`. Those numbers describe the
derivation rules only. They are **not** a prediction of any row above.

---

## 4. The quality gate this feeds

Owner decision, Step 3 §3:

```
Geometric crop quality supports controlled Step 4 testing
→ continue to Step 4 after owner review

Geometric crops are frequently unusable or contain several garments
→ stop and return FASHION SEGMENTATION MODEL DECISION REQUIRED
```

That call needs rows 1–7 and the useful-region / ambiguous-region rates. It
cannot be made from source-level evidence, and this build does not attempt it.

---

## 5. Metadata verification method

The in-pipeline inspector (`services/mirror/jpegMetadata.ts`) is fail-closed and
destroys any crop carrying Exif, GPS, IPTC or a comment segment. Device testing
should verify it from OUTSIDE the app rather than trusting it:

1. Pull a session's crops off the device.
2. Run `exiftool` (or equivalent) over each.
3. Confirm: no GPS, no capture time, no device make/model, no original filename.
4. Confirm the picker-owned original still HAS its metadata — untouched is the
   contract, not sanitized.

Step 4 must never receive a crop that fails step 3.
