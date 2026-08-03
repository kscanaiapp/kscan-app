# Product Match — Checkpoint 5A

Live scanner mount, instrumentation, and Android runtime validation handoff.

## What changed

The similar-item candidate provider built in Checkpoint 4.5 had **zero callers
outside its own test file**. Checkpoint 5A mounts it into the real scanner
dispatch path on both platform lines, behind a flag that is off by default.

| Concern | Where |
| --- | --- |
| Mount point (shared, byte-identical) | `services/scannerScanRequest.ts` → `runScannerIdentification` |
| Attach rule + fail-open contract (shared, byte-identical) | `services/scannerSimilarityAttachment.ts` |
| Platform loader binding (**divergent by design**) | `services/scannerSimilarityBinding.ts` |
| Client flag | `constants/featureFlags.ts` → `SCAN_SIMILAR_ITEM_ENABLED` |
| Development inspector | `app/dev/similarity-inspector.tsx` |

## The attach rule

Candidates are attached **only once a specific garment identity has been
resolved** — whether that came from an ordinary single-item scan or from an
explicit multi-item selection.

Both flows reach `runScannerIdentification` with
`mode === 'identify_selected_item'`, because **neither platform auto-selects**:

- Android — `hooks/useKScan.js`: "Candidate review: render immediately after
  detection. No commerce request, **no auto-selection**." A photo with exactly
  one garment still produces one candidate the user confirms.
- iOS — `buildOutfitConfirmationCandidates` returns one entry for one detected
  garment; `analyzeSelectedCandidate` dispatches the follow-up request.

So one mount point covers both flows. The initial `detect_items` request is
excluded: at that moment the client does not know what it is looking at, and
pruning against a guessed garment is exactly what this checkpoint forbids.

### Known limitation — the legacy single-request path

The backend emits `detectedGarments` only when `SCAN_MULTI_ITEM_ENABLED=true`
(`supabase/functions/scan-identify/index.ts`, `useMultiItemDetectionProvider`).
If that server flag is **off**, a scan resolves its identity in the one
`detect_items` response and there is no second request to attach candidates to.
Such a scan produces no similarity comparison. It is not an error and nothing
fails — it is simply out of scope, because attaching candidates to that request
would mean pruning against an identity that does not exist yet.

**This is a backend-environment dependency, not a client defect.** Confirm
`SCAN_MULTI_ITEM_ENABLED=true` in the deployed environment before concluding
that a runtime test "saw no candidates" indicates a mount failure.

## Safety properties, and where each is proven

All in `__tests__/scannerSimilarityMount.test.js` unless noted.

| Property | Test |
| --- | --- |
| Provider reachable from real dispatch | `MOUNT — an enabled selected-item dispatch reaches the provider…` |
| Detection loads/attaches nothing | `MULTI-ITEM — the initial detection request loads nothing…` |
| Candidates load only after selection | `MULTI-ITEM — candidates load only AFTER a selection…` |
| Flag off = no loader call | `ROLLBACK — flag off invokes neither loader…` |
| Flag off = byte-identical request | `ROLLBACK — flag off produces a request byte-identical to no binding at all` |
| Cap enforced client-side (120 → 20) | `CAP — 120 eligible records are bounded…` |
| No private field reaches the wire | `PRIVACY — private fields on stored records never reach the request` |
| Loader failure fails open | `FAIL-OPEN — a throwing Closet loader still dispatches the scan…` |
| Hang bounded by configurable guard | `FAIL-OPEN — a hanging loader is bounded by the configurable guard` |
| No duplicate dispatch on resume | `LIFECYCLE — a resumed duplicate dispatch does not attach…` |
| No candidate substitution across scans | `LIFECYCLE — no substitution…` |
| Product ranking unchanged | `PRODUCT FLOW — the response is passed through untouched…` |
| Dev diagnostics contained | `__tests__/scannerSimilarityContainment.test.js` |
| Action safety | `__tests__/scannerSimilarityContainment.test.js` |

**Non-vacuity is verified:** deleting the `attachSimilarityCandidates(...)` call
from `scannerScanRequest.ts` takes the mount suite from 25 passing to 7 passing
with 18 failures.

## Instrumentation

`SimilarityAttachmentInstrumentation` is emitted once per attach attempt —
including attempts that attach nothing, because "the flag is off", "the Closet
is empty" and "the read failed" are different facts.

Recorded: Closet load duration, Recent Scans load duration (**independently
measured**, plus their own start/end stamps and a `combinedMs` wall clock),
records loaded per source, loader failure reason, records rejected by named
reason, adaptation/prune/prioritize/dedupe/total stage timings, transmitted
candidate count, and serialized payload bytes.

> **A defect fixed here:** the Checkpoint 4.5 provider timed both loads from a
> single shared start/end pair, so `closetMs` and `recentScansMs` were always
> identical and a slow source was unattributable. Each loader now stamps its
> own start and end.

---

# OWNER-RUN ANDROID RUNTIME VALIDATION

The autonomous environment has **no authenticated Android session**, so runtime
validation could not be executed here. Authentication was not bypassed. Run the
steps below on a device or emulator with a real signed-in account.

## This test answers five questions, not general QA

Everything below maps to one of these. If a step doesn't move one of these five
forward, it's not required to call this validation complete.

1. **Does the real path invoke the loaders?** — flag on: Closet loader runs,
   Recent Scans loader runs, counts appear in diagnostics, candidates are
   capped, `existingItems` appears in the outgoing request. → §3.
2. **Does flag-off rollback truly restore the old flow?** — flag off: no
   similarity loader call, no `existingItems` field, scan behavior unchanged.
   → §2.
3. **Is the multi-item dependency satisfied?** — `SCAN_MULTI_ITEM_ENABLED` is
   active on the test backend, the scan reaches a selection state, and the
   resolved-item request carries candidates only after that selection. → §5,
   and confirm the backend flag under Preconditions before anything else.
4. **What does loading cost on the device?** — Closet load time, Recent Scans
   load time (separately — that's the defect this checkpoint fixed), adaptation
   /prune time, payload size, and full scan duration. Don't judge the feature
   from total scan time alone: if the scan gets slower, the per-stage timings
   say which stage did it. → §3, §9.
5. **Does failure stay invisible to the primary scan?** — candidate loader
   failure, no candidates, network failure, background/resume: identification
   and product results still complete in every case. → §6.

## What this runtime test can and cannot prove

Verified against the deployed project `wyyuqfdxucjksghsmhry` on 2026-08-03:
**`product-match` is not among the deployed Edge Functions.** `scan-identify`
is deployed (v141), and it accepts and sanitizes `existingItems`
unconditionally — but the similarity *comparison* runs in `product-match`, via
the bridge in `productMatchBridge.ts`.

All five questions above are **client-side observable and fully testable**
without it: the loaders running, the candidate bounding, the attached
`existingItems`, the payload bytes, the privacy allowlist, the rollback, and
the fail-open behavior all happen on device, before the request leaves.

What this test **cannot** produce is a returned `potentialSimilarItem` or a
rendered comparison. That is expected and is not a mount failure. Checkpoint 5A
scope ends at "candidates are correctly attached to the real request"; the
advisory response and its notice UI are the next build. Do not deploy
`product-match` to make a comparison appear — that is a separate, owner-gated
decision.

## 0. Preconditions

- Android emulator or device with a **signed-in** KScan account.
- Backend `SCAN_MULTI_ITEM_ENABLED=true` (otherwise see the known limitation).
  This cannot be read from the client; the empirical check is §5 — if the scan
  reaches a selection state, it is on.
- A Closet containing **at least 3 items**, and at least one Recent Scan.
- Branch `product-match/foundation-v1`, and record the exact SHA:

```bash
cd C:\src\KScan-product-match-foundation-v1 && git rev-parse HEAD
```

## 1. Start Metro correctly

A stale Metro on port 8081 and a junctioned `node_modules` each silently serve
the **wrong** bundle. Kill any existing Metro first, and confirm the log line
`Android Bundled` appears before testing.

```bash
cd C:\src\KScan-product-match-foundation-v1 && npx expo start --clear
```

If the emulator cannot reach Supabase, that is an environment fault (missing
`.env`, or an AVD started without `-dns-server`), not an app regression.

## 2. Flag OFF — prove the rollback (do this FIRST)

The flag is off by default, so simply run without setting it.

```bash
cd C:\src\KScan-product-match-foundation-v1 && npx expo start --clear
```

Scan an item that **is** already in the Closet, then confirm:

- [ ] The scan completes normally and product results appear.
- [ ] No similarity notice is shown anywhere.
- [ ] In the Metro console, no similarity instrumentation record is logged.
- [ ] Scan duration is comparable to before this checkpoint.

## 3. Flag ON — local, untracked configuration only

Create a **local, untracked** `.env` (never commit it, and never add the flag to
`eas.json`):

```bash
cd C:\src\KScan-product-match-foundation-v1 && printf 'EXPO_PUBLIC_SCAN_SIMILAR_ITEM_ENABLED=true\n' >> .env && npx expo start --clear
```

Scan the same already-owned item and capture.

**How to read the instrumentation:** each attach attempt logs one line to the
Metro console, `__DEV__` only, prefixed `[similarity]`, carrying the whole
record as JSON. Filter the Metro output with:

```bash
npx react-native log-android | grep --line-buffered "\[similarity\]"
```

One line is emitted per attempt — including attempts that attach nothing, so
"the flag is off" and "the Closet was empty" are visibly different facts.

- [ ] Closet loader ran — record duration from the instrumentation record.
- [ ] Recent Scans loader ran — record duration **separately**.
- [ ] `combinedMs` is less than the sum (proves the loads run concurrently).
- [ ] Transmitted candidate count is **≤ 20**.
- [ ] Serialized payload bytes recorded.
- [ ] Product results still appear and are unchanged in ranking.
- [ ] **No automatic mutation occurred** — nothing merged, deleted, moved
      between Closet and Recent Scans, or re-classified.

## 4. Privacy check on the real request

With the flag on, inspect the outgoing request body (Metro network log or a
proxy) and confirm the `existingItems` array contains **only**:

`id, source, label, imageUri, brand, model, canonicalCategory, color,
material, silhouette, pattern, productUrl, authoritativeId, imageQuality`

- [ ] No `ownerId` / `userId`, no email, no device id.
- [ ] No access or refresh token, no `Authorization` value.
- [ ] No raw base64 image bytes for existing items.
- [ ] No raw database row passed through.

## 5. Multi-item sequence

Scan a photo containing **two or more** garments.

- [ ] The initial detection request asks for selection.
- [ ] **No candidate loading happens at detection** — no loader timing record
      is emitted before the user chooses.
- [ ] After choosing a garment, the selected-item request dispatches.
- [ ] Candidates load only **after** that selection.
- [ ] The comparison is tied to the **selected** garment, not the first one.

## 6. Lifecycle

- [ ] Background the app mid-scan, then resume — no duplicate similarity
      request, and the scan completes or fails cleanly.
- [ ] Resume **after** dispatch — no second candidate set is attached.
- [ ] Cancel a scan mid-flight — no crash, no orphaned request.
- [ ] Enable airplane mode mid-scan — the scan fails normally; similarity is
      never the reported cause.
- [ ] Sign out mid-scan — no candidates from the previous actor are sent.

## 7. Development inspector

- [ ] Navigate to `/dev/similarity-inspector` in the dev build; it renders.
- [ ] Confirm it is **not** reachable from ordinary production navigation.
- [ ] Confirm no internal score or evidence class appears on the normal scan
      result screen.
- [ ] Screenshot the inspector.

## 8. Rollback

Remove the flag line from `.env`, restart with `--clear`, and confirm behavior
returns to step 2 exactly.

## 9. Capture for the record

| Field | Value |
| --- | --- |
| Emulator/device model | |
| Android version | |
| Branch + SHA | |
| Local flag method | untracked `.env` |
| Closet load ms | |
| Recent Scans load ms | |
| Combined load ms | |
| Candidate count transmitted | |
| Payload bytes (with / without) | |
| Total scan duration (flag on / off) | |
| Console errors | |
| Inspector screenshot | |
| Rollback verified | |

## Do NOT do any of the following

- Do not add the flag to `eas.json` or any tracked profile.
- Do not deploy the backend or run a database migration.
- Do not bypass authentication to complete a step — report the blocker instead.
- Do not tune thresholds, weights or evidence classes to make a case pass.
