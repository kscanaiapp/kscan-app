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
