# Build 3 Phase 4 — Private Dressing Room Elise orchestration

Working record for the Phase 4 pre-commit gates. The deployment authorization
package is appended at the end of the phase.

Baselines: iOS `a6070d8`, Android `af9cf96`.

---

## Gate 1 — Endpoint, schema version, contract location

### Chosen Edge Function

    style-outfit-generate

### Rejected alternative

    stylechat-generate

### Reason

Source and production evidence, in the order it changed the decision:

1. **`style-outfit-generate` is deployed.** Its header comment says
   `SOURCE ONLY — NOT DEPLOYED in this build`, and that comment is **stale**.
   The Supabase project `wyyuqfdxucjksghsmhry` reports the function `ACTIVE` at
   `version 1`. Phase 4 is therefore a *redeploy of an existing function*, not
   the activation of a new one.
2. **Its production dependencies already exist.** Both SECURITY DEFINER quota
   RPCs it calls — `check_and_increment_style_outfit_burst(p_limit integer)` and
   `increment_style_outfit_daily_usage(p_limit integer)` — are present in the
   production database. **No database migration is required**, so the Phase 4
   stop condition for schema change is not reached.
3. **It already owns the machinery Phase 4 needs**: anchor-aware outfit requests,
   occasion and dress-code inputs, Gemini invocation with timeout and one safe
   retry, structured output validated against an *exclusive* candidate pool,
   normalized safe errors, kill switch, and metadata-only logging.
4. **Its live traffic is effectively zero.** The only client caller,
   `services/styleOutfits.ts`, is gated on
   `AI_STYLIST_UI_ENABLED && AI_STYLIST_BACKEND_ENABLED`; both are OFF in every
   production profile, and the client already treats service-unavailable as a
   first-class outcome. A redeploy cannot regress a live user surface.
5. **`stylechat-generate` is the riskier host.** It is live at `version 83`
   serving real StyleChat sessions, its `index.ts` is 108 KB, and its wardrobe
   context is derived through `eliseWardrobeRetrieval.ts`. Adding a versioned
   branch there would mean editing a hot production path for no architectural
   gain — Phase 4 wants none of its speech, attachment or visual-context
   machinery.
6. **It already carries the mirrored-contract convention** Phase 4 extends
   (`reasoningContract.ts` ↔ `types/fashionReasoning.ts`, kept honest by
   `__tests__/styleOutfitEdgeContract.test.js`).

### Existing unversioned dispatch path

`index.ts` reads the body, then calls
`validation.ts#parseStyleOutfitRequest(body)`, which requires **both**
`contractVersion === '1'` **and** a valid `mode` from
`['style_item','style_event','swap_item','restyle_remaining']`. The candidate
pool is then built server-side from `saved_scans` + `inspiration_items`; client
candidate arrays are never read.

### New versioned dispatch boundary

Immediately after `await req.json()` and **before** `parseStyleOutfitRequest`,
on the presence of a **different top-level key**:

| `schemaVersion`                     | Behaviour                                    |
| ----------------------------------- | -------------------------------------------- |
| absent                              | existing unversioned path, byte-unchanged     |
| `private-dressing-room-elise-v1`    | Phase 4 branch                                |
| any other value                     | governed `unsupported` rejection, no provider |

### Backward-compatibility strategy

The two contracts dispatch on **disjoint keys**. No existing caller sends
`schemaVersion`, and no Phase 4 request carries a `mode`, so neither body can be
reinterpreted as the other. The unversioned code path is not edited.

### Locked schema version

    private-dressing-room-elise-v1

Held in one governing constant,
`PRIVATE_DRESSING_ROOM_ELISE_SCHEMA_VERSION`, imported by the client, the shared
contract, the Edge Function and every test. The literal is not duplicated across
unrelated files.

### Shared contract location, and why it is a mirror

| Role             | Path                                                                   |
| ---------------- | ---------------------------------------------------------------------- |
| Governing source | `types/privateDressingRoomElise.ts`                                     |
| Edge mirror      | `supabase/functions/style-outfit-generate/privateDressingRoomEliseContract.ts` |
| Parity gate      | `__tests__/privateDressingRoomEliseContract.test.js`                     |
| Deno runtime gate| `supabase/functions/style-outfit-generate/privateDressingRoomEliseContract.test.ts` |

A single module imported by both runtimes is not available here: the React
Native bundle and the deployable Deno tree resolve differently, and the parity
manifest models a function bundle as files under `supabase/functions/`. The
repository's established answer is one governing source plus a static parity
test, and Phase 4 uses it. The mirror is **generated** from the governing source,
so the shared body is byte-identical by construction rather than by
transcription, and the test asserts that byte-identity on every run.

**Import safety is proven, not asserted.** Both modules are executed by the test
through a `require` shim that throws on *any* specifier, so a future import fails
the suite instead of silently pulling client code into a function bundle. The
comment-stripped source is additionally checked for `import`, `require`, `Deno`,
runtime globals and client-only APIs.

### Temporary alias format

    item_<requestFragment>_<index>          e.g. item_3f9a2b1c_1

`requestFragment` is the first 8 hex characters of the request id and is derived
from **nothing else** — not the Closet id, actor id, user id, session id or any
storage key. Indexes run 1…20. Shape validation is necessary but never
sufficient: resolution is by membership in the request's own in-memory map, so a
syntactically perfect alias from another request is rejected.

### Sanitized fields included

`ref`, `slot`, `category`, `clothingType`, `subtype`, `color`, `material`,
`isAnchor`, `isLocked`.

Every one exists on `services/closetItemProjection.ts#ClosetItemProjection` or is
derived by `services/privateDressingRoomSlots.ts#classifyClosetItemSlot`.

### Fields explicitly excluded

**Absent from the authoritative Closet record — so never invented**, despite
appearing in the Phase 4 recommended shape:

    texture, silhouette, fit, occasionCompatibility

**Present on the record but withheld under minimization:**

    id, title, notes, brand, size, origin, imageUri, thumbnailUri,
    createdAt, updatedAt, displaySummary, taxonomyUnknown, secondaryColors

**Never transmitted under any circumstance** (enumerated in
`PRIVATE_ELISE_FORBIDDEN_REQUEST_FIELDS` and asserted by the privacy suite):
actor / user / owner ids, session ids, Closet ids, email, access and refresh
tokens, raw images, image paths, storage keys, signed URLs, and the Closet
record's internal provenance ids.

### Occasion vocabulary — Elise selects, it never invents

Elise may return only `Work`, `Dinner`, `Weekend`, `Event`, `Travel`, `Smart`.
The first five are the route's own chips
(`app/stylist/dressing-room/index.tsx#OCCASIONS`); `Smart` is a verified token in
the composer's own `OCCASION_GROUPS` table. A test asserts every one of them
resolves through the production `occasionGroupFor()` to a supported group, so an
accepted occasion is always one the user could have chosen manually and the
composer already understands.

---

## Gate 2 — Edge Function testability

    LOCAL EDGE FUNCTION TESTING AVAILABLE

| Capability                    | Evidence                                             |
| ----------------------------- | ---------------------------------------------------- |
| Deno runtime                  | `deno 2.8.2` (v8 14.9.207.2, typescript 6.0.3)        |
| Supabase CLI                  | `2.109.1`                                             |
| Governed backend test runner  | `scripts/run-backend-tests.js` → `npm run test:backend`|
| Baseline before Phase 4       | **197 passed / 0 failed**                             |
| Existing harness convention   | 20+ `.test.ts` suites across `scan-identify`, `stylechat-generate`, `_shared` |

Tests import function modules directly and assert on pure functions and on
source wiring; `Deno.serve` is never invoked and no network permission is
granted (`deno test --allow-read`).

`style-outfit-generate` was **added to the governed list** in this phase. It had
no backend coverage at all beforehand, which is how the drift recorded below went
unnoticed.

### Consequence for the final verdict

Pre-deployment evidence will cover schema dispatch, request validation, intent
routing, server-wardrobe bypass, provider-call construction, response
validation, backward compatibility and logging redaction — all under the real
Deno runtime. It will **not** cover the deployed function. Those cases are
reported as:

    BACKEND RUNTIME: NOT DEPLOYED

---

## Discovery finding — pre-existing cross-branch drift (not caused by Phase 4)

`supabase/functions/style-outfit-generate/index.ts` **differs between the
platform branches**, and the function is outside the parity gate, so nothing in
the repository objected.

| Branch                     | Model routing                                              |
| -------------------------- | ---------------------------------------------------------- |
| iOS `a6070d8`              | imports `./modelRouting.ts`, allowlist-validated `getConfiguredModel(...)` |
| Android `af9cf96`          | **no `modelRouting.ts` at all**; retired `gemini-2.5-flash` default and generic `GEMINI_MODEL` precedence |
| **Deployed `version 1`**   | **matches the iOS branch**                                  |

`reasoningContract.ts` and `validation.ts` match across branches; only `index.ts`
diverges, plus the file `modelRouting.ts` that exists on iOS only.

This is the same defect class Phase 2A found and Phase 2A.5 closed for
`scan-identify` and `stylechat-generate` — an independently deployable copy
drifting per branch. Deploying Phase 4 from the Android branch as it stands would
ship a **model-routing regression** relative to what is already live.

**Handling.** iOS is canonical (it matches production). Android is reconciled to
it in Commit 2, and `style-outfit-generate` is brought inside the parity manifest
and the governed backend test runner so this cannot recur silently. No behaviour
of the unversioned path changes on iOS; on Android the change restores it to the
deployed baseline.

Extending the manifest is **required, not optional**:
`scripts/deploy-edge-functions.js` refuses to deploy any function absent from
`manifest.parity.expectedFunctions` — *"This wrapper only deploys functions whose
source parity it can prove."*

---

## Gate 4 — Casualness transition

    CASUALNESS TRANSITION PROVEN

Proven by `__tests__/privateDressingRoomCasualness.test.js`, not argued from
source alone:

| Requirement                                        | Evidence                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------ |
| a supported group maps to a supported casualer one  | ladder `evening → work → smart_casual → casual`, each step round-trips through `occasionGroupFor()` |
| the composer consumes the group                     | `buildPools(…, group)`, `assemble(…, group, …)`, `scoreOccasion(group, bySlot) * 10` — the dominant scoring term |
| the change can affect composition                   | the real composer, run over one synthetic Closet, returns **different look sets** for evening and casual |
| the anchor is preserved                             | every look in the post-transition composition still contains the anchor    |
| it is not a no-op claiming success                  | an unsupported outcome carries no occasion, so there is nothing to apply   |

`travel` and `neutral` sit off the formality ladder and return a governed
unsupported result. `casual` returns `already_most_casual`, which has its own
copy and is deliberately not the generic retry message.

---

## Deployment authorization package

**Nothing has been deployed.** The Edge Function source is complete and verified
under the real Deno runtime; the deployed function is still `version 1`.

### Source

| Item                     | Value                                                    |
| ------------------------ | -------------------------------------------------------- |
| iOS final SHA            | `7d1291b` on `feature/ios-dressing-rooms-v1`              |
| Android final SHA        | `12097e2` on `feature/android-dressing-rooms-v1`          |
| iOS baseline             | `a6070d8`                                                 |
| Android baseline         | `af9cf96`                                                 |
| Changed Edge Function    | `style-outfit-generate`                                   |
| Both branches            | clean, pushed, 0 ahead / 0 behind                         |

Commit sequence (iOS / Android):

    1  862f373 / 9876040   versioned contracts and validators
    2  dab19a2 / 4471004   Edge Function versioned handling
    3  73750da / b411203   client adapter and request lifecycle
    4  182f9ec / 3f00690   Dressing Room integration
    5  7d1291b / 12097e2   production-path and regression tests

### Edge Function bundle

    bundleHash  5769a0020d3963201c5125de1364cac38335926378587f7b620a016dadd83c4a
    treeHash    c7a9c0505dc2f4ac5f168a9d0874a32706d9367a7353b5f5afd7aef170d8e6c1
    6 deployable files, 8 in tree, remote specifier npm:@supabase/supabase-js@2.105.4

Deployed: `index.ts`, `modelRouting.ts`, `privateDressingRoomEliseContract.ts`,
`privateDressingRoomEliseHandler.ts`, `reasoningContract.ts`, `validation.ts`.
The two `.test.ts` files are governed for drift and are **not** deployed.

### Request schema

```jsonc
{
  "schemaVersion": "private-dressing-room-elise-v1",   // required, exact
  "requestId":     "<opaque, <=64 chars>",             // required
  "intent":        "interpret_occasion" | "build_around_item",
  "instruction":   "<=200 chars, user text>",
  "context": {                                          // optional
    "occasion":      "<=120 chars>",
    "occasionGroup": "casual|smart_casual|work|evening|travel|neutral",
    "dressCode":     "relaxed|smart_casual|dressy|formal"
  },
  "candidates": [                                       // <=20; omitted for interpret_occasion
    {
      "ref":          "item_<8 hex>_<1-20>",
      "slot":         "top|bottom|dress|outerwear|footwear|accessory",
      "category":     "<=80>",  "clothingType": "<=80>",  "subtype": "<=80>",
      "color":        "<=60>",  "material": ["<=60>", "...<=8 entries"],
      "isAnchor":     true,     "isLocked": true
    }
  ],
  "anchorRef":  "item_<8 hex>_<n>",   // required for build_around_item, forbidden otherwise
  "lockedRefs": ["item_<8 hex>_<n>"]  // empty, or exactly the anchor
}
```

### Response schema

```jsonc
{
  "schemaVersion": "private-dressing-room-elise-v1",
  "requestId":     "<echoes the request>",
  "intent":        "<echoes the request>",
  "status":        "success|clarification_required|unsupported|invalid_request|safe_failure",
  "normalizedOccasion": "Work|Dinner|Weekend|Event|Travel|Smart",
  "dressCode":     "relaxed|smart_casual|dressy|formal",
  "occasionGroup": "casual|smart_casual|work|evening|travel|neutral",
  "anchorRef":     "<must be an alias the request supplied>",
  "selectedRefs":  ["<aliases the request supplied>"],
  "clarification": "<=200 chars>",
  "displayCopy":   "<=200 chars>"
}
```

`clarification` and `displayCopy` are validated and bounded but **never
rendered**: all user-facing copy is chosen locally from `status`. A test asserts
that neither the UI nor the orchestration layer reads them.

### Synthetic examples

Sanitized request (`build_around_item`):

```json
{
  "schemaVersion": "private-dressing-room-elise-v1",
  "requestId": "3f9a2b1c8d7e6f5a4b3c2d1e0f9a8b7c",
  "intent": "build_around_item",
  "instruction": "dinner with clients on Thursday",
  "context": { "occasion": "Work", "occasionGroup": "work" },
  "anchorRef": "item_3f9a2b1c_1",
  "lockedRefs": ["item_3f9a2b1c_1"],
  "candidates": [
    { "ref": "item_3f9a2b1c_1", "slot": "outerwear", "category": "Outerwear",
      "clothingType": "Blazer", "color": "navy", "material": ["wool"],
      "isAnchor": true, "isLocked": true },
    { "ref": "item_3f9a2b1c_2", "slot": "footwear", "category": "Shoes",
      "clothingType": "Loafers", "color": "black" }
  ]
}
```

Valid, clarification, unsupported and safe-failure responses:

```json
{ "schemaVersion": "private-dressing-room-elise-v1", "requestId": "3f9a2b1c8d7e6f5a4b3c2d1e0f9a8b7c",
  "intent": "build_around_item", "status": "success",
  "anchorRef": "item_3f9a2b1c_1", "normalizedOccasion": "Dinner", "occasionGroup": "evening" }

{ "schemaVersion": "private-dressing-room-elise-v1", "requestId": "3f9a2b1c8d7e6f5a4b3c2d1e0f9a8b7c",
  "intent": "interpret_occasion", "status": "clarification_required" }

{ "schemaVersion": "private-dressing-room-elise-v1", "requestId": "3f9a2b1c8d7e6f5a4b3c2d1e0f9a8b7c",
  "intent": "interpret_occasion", "status": "unsupported" }

{ "schemaVersion": "private-dressing-room-elise-v1", "requestId": "3f9a2b1c8d7e6f5a4b3c2d1e0f9a8b7c",
  "intent": "interpret_occasion", "status": "safe_failure" }
```

### Privacy report

**Transmitted:** schema version, request id, intent, the user's bounded
description, optional current occasion / occasion group / dress code, and up to
20 candidates carrying only `ref`, `slot`, `category`, `clothingType`, `subtype`,
`color`, `material`, `isAnchor`, `isLocked`.

**Excluded because the authoritative record does not carry them, so they are
never invented:** `texture`, `silhouette`, `fit`, `occasionCompatibility`.

**Excluded although the record carries them, under minimization:** Closet id,
title, notes, brand, size, origin, image URI, thumbnail URI, timestamps,
`displaySummary`, `taxonomyUnknown`, secondary colours.

**Never transmitted:** actor / user / owner ids, session ids, email, access and
refresh tokens, raw images, image paths, storage keys, signed URLs, and the
Closet record's internal provenance ids.

**Alias generation:** `item_<requestFragment>_<index>`, where the fragment is the
first 8 hex characters of the request id and is derived from nothing else.
Resolution is by membership in an in-memory `Map` scoped to a single request,
released when that request succeeds, fails, times out, is cancelled, or is
superseded. Never serialized, never persisted, never placed in the interaction
record, never sent to analytics.

**Persistence:** none. No Phase 4 module touches AsyncStorage, SecureStore, the
filesystem, or any of the three private stores, so no Elise state can survive
process death.

**Logging:** a sanitized envelope only — schema version, intent, an 8-character
request fragment, candidate count, duration, outcome class. Never the
instruction, candidates, prompt, or provider body. Asserted by a test that sends
a request containing a venue name and a personal name and checks the log line.

**Transport authentication:** the normal Supabase authorization header. Identity
is derived server-side from the verified JWT and is never read from the body.

**Server wardrobe bypass:** the versioned branch returns before the `saved_scans`
and `inspiration_items` queries, and the handler is passed no Supabase client, so
it cannot query one. Both facts are proven from source by test.

### Backward compatibility

| Caller                                    | Evidence                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| Unversioned `style-outfit-generate`       | dispatch is on `schemaVersion`, which no existing caller sends; the legacy step order is pinned by test |
| A Phase 4 body reaching the legacy parser | rejected — it carries no `mode` — proven by test                          |
| A legacy body reaching the Phase 4 branch | not routed there; `isVersionedEliseRequest` is false, proven by test       |
| `stylechat-generate`                      | not modified in this phase at all                                         |
| Saved-scan / inspiration-item flows       | unversioned path unedited; `services/styleOutfits.ts` unchanged in behaviour and unaware of `schemaVersion` |

    EXISTING CALLER UNIT/STATIC COMPATIBILITY: PASS
    EXISTING CALLER LOCAL FUNCTION RUNTIME:    NOT EXERCISED
    EXISTING CALLER DEPLOYED RUNTIME:          PENDING DEPLOYMENT

### Certification

| Gate                    | iOS                    | Android                  |
| ----------------------- | ---------------------- | ------------------------ |
| Full suite              | **3723 / 3723**        | **3852 / 3852**          |
| Required floor          | 3628 (+95)             | 3757 (+95)               |
| TypeScript              | **0**                  | **exactly 82**           |
| Backend (Deno)          | 225 / 225              | 225 / 225                |
| Edge parity gate        | PASS                   | PASS                     |
| Edge parity tests       | 17 / 17                | 17 / 17                  |
| Expo export             | PASS (5.67 MB .hbc)    | PASS (5.64 MB .hbc)      |
| Worktree                | clean, pushed          | clean, pushed            |
| Shared-file parity      | 0 mismatches across 15 governed shared files             ||
| App version / build no. | unchanged                                               ||
| Lockfiles / EAS profiles| unchanged                                               ||
| Phase 4 production flag | OFF — absent from every profile                         ||

The backend suite grew 197 to 225. No test was removed or weakened. Two existing
assertions were updated and both became stricter: modal dismissability now
derives its count from the modals actually present, and the governed-function
list assertions name the third function explicitly.

### Deployment

Project target, from `supabase/config.toml` and matched against the manifest's
`approvedProjectRef`:

    wyyuqfdxucjksghsmhry

Required function environment — Phase 4 introduces **no new variable**:
`GEMINI_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and optionally
`STYLE_OUTFIT_AI_ENABLED`, `STYLE_OUTFIT_GEMINI_MODEL`,
`STYLE_OUTFIT_DAILY_LIMIT`, `STYLE_OUTFIT_BURST_LIMIT_PER_MINUTE`.

Verify first — this form is a dry run and never deploys:

```bash
node scripts/deploy-edge-functions.js --function style-outfit-generate
```

Deploy, owner-authorized only:

```bash
node scripts/deploy-edge-functions.js --function style-outfit-generate --confirm-deploy style-outfit-generate
```

Expected result: `style-outfit-generate` moves from `version 1` to `version 2`.

### Rollback

Supabase Edge Function rollback is **redeployment of prior source**, not a
server-side version switch. There is no atomic revert.

| Item                        | Value                                                          |
| --------------------------- | -------------------------------------------------------------- |
| Previous known-good version | `version 1`, ACTIVE, `ezbr_sha256` `c45aeb0412b1b9a4f3c0135d970bcebc1ede270078833810ecfa4dc6f6d48feb` |
| Previous known-good source  | iOS `a6070d8`, `supabase/functions/style-outfit-generate/`      |
| Caution                     | Android `af9cf96` is **not** a valid rollback source: its copy predates the model-routing repair and redeploying it would ship a regression |

```bash
git checkout a6070d8 -- supabase/functions/style-outfit-generate
npm run generate:edge-manifest
node scripts/deploy-edge-functions.js --function style-outfit-generate --confirm-deploy style-outfit-generate
```

The manifest must be regenerated for the rolled-back tree, or the parity gate
will refuse the deploy — which is the gate working correctly.

**Rollback triggers:** any unversioned caller regression; Phase 4 requests
reaching `saved_scans` or `inspiration_items`; candidate metadata appearing in
function logs; sustained provider errors above baseline; a latency or timeout
increase on the unversioned path.

### Risk assessment

| Risk | Likelihood | Impact | Mitigation | Detection signal | Rollback trigger |
| --- | --- | --- | --- | --- | --- |
| Versioned dispatch intercepts a legacy request | Very low | High | dispatch on `schemaVersion` alone, checked before the legacy parser; legacy step order pinned by test | legacy requests returning a Phase 4 body shape | immediate |
| Provider response fails structured validation | Medium | Low | fails closed to `safe_failure`; never coerced | rate of `outcome=provider_output_invalid` | no — by design |
| Phase 4 logs leak candidate metadata | Very low | High | sanitized envelope only; asserted against a request carrying a venue and a personal name | log inspection during the smoke test | immediate |
| Server wardrobe retrieval runs unexpectedly | Very low | High | branch returns before the queries; handler holds no Supabase client | `saved_scans` query volume during a Phase 4 smoke test | immediate |
| Alias resolution accepts an unauthorized reference | Very low | High | membership in the request's own map; shape check is secondary; no raw id exists to fall back to | `invalid_alias` rejections | investigate |
| Large payload causes latency or timeout | Low | Low | 20-candidate cap, oversized requests rejected outright; 15 s provider timeout inside a 20 s client budget | p95 duration in the envelope | no |
| Existing StyleChat behaviour regresses | Very low | High | `stylechat-generate` is not modified | StyleChat smoke test | immediate |
| Existing Style Outfit behaviour regresses | Low | Medium | unversioned path unedited; its only client is flag-gated OFF | Style Outfit smoke test | immediate |
| Client enabled before the backend is deployed | Low | Low | a non-validating reply reads as capability-unavailable; shows "Elise is being updated. Try again soon."; no retry, no state change | that copy appearing in QA | no — fails safe |
| Rollback redeployment fails | Low | High | rollback source is the certified `a6070d8` tree, which matches deployed v1 | deploy command exit status | escalate to owner |
| Quota RPC missing in production | Very low | Medium | both RPCs confirmed present in `wyyuqfdxucjksghsmhry` during Gate 1 | `500 Usage check failed` | immediate |

### Post-deployment validation plan — prepared, NOT executed

1. Existing StyleChat smoke test: unchanged replies, unchanged usage counters.
2. Existing Style Outfit smoke test: an unversioned `style_event` request still
   resolves its pool server-side and returns the legacy body.
3. Phase 4 occasion interpretation: a supported description applies through the
   confirmation flow, and the composition is rebuilt by the local composer.
4. Phase 4 Build Around This: the selected anchor appears in every look.
5. Invalid schema version: `400 UNSUPPORTED_SCHEMA_VERSION`, no provider call.
6. Invalid alias: response rejected, no state change.
7. Cancellation: no error copy is shown.
8. Stale response: request A cancelled, B applied, late A rejected.
9. Phase 4 OFF: no Phase 4 UI, no invocation.
10. Deterministic Make It More Casual: no network call in the request log.
11. Authentication continuity across the change.
12. Private Dressing Room deep link, cold and warm.
13. Context change, Cancel and Confirm.
14. Session discard.
15. Function log inspection: envelope fields only, no candidate metadata.

Every runtime claim requires sanitized evidence.

### Known limitations

- `BACKEND RUNTIME: NOT DEPLOYED` — the modified function has never executed in
  production. All backend evidence comes from the Deno suite.
- `LOCAL FUNCTION SERVING: NOT PERFORMED` — the Supabase CLI is installed and
  local serving is possible, but it was not exercised. Backend verification is
  unit-level, under the real Deno runtime.
- No device or simulator QA has been performed on Phase 4. Every UX and
  accessibility claim is a static source assertion or a service-level test. This
  is the standing Build 3 limitation: no macOS host, and the Android emulator has
  no stored authentication session.
- `build_around_item` is reachable only when the session already has an anchor.
  That is deliberate — Phase 4 was not permitted to add a third Build Around This
  entry point, so the existing bounded entry dispatches by anchor presence.
