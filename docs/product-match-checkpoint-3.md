# Product Match — Checkpoint 3: scan-journey integration

Status: **wired, flag-gated, not deployed.** Three new flags, all default off.
No production deployment, no database mutation, no new provider, no new image
recipient, no paid execution, no EAS build.

Builds on [Checkpoint 2](product-match-checkpoint-2.md).

---

## 1. Hard precondition — deployed-function drift: RESOLVED

Four Edge Functions had been hot-patched in production and never committed. A
redeploy from a clean checkout would have silently reverted all four, reopening
an account-guard hole and a 500. All four deltas are now in committed source.

| function | adopted | why |
|---|---|---|
| `product-search-deals` | static guard import + guard call | the `--use-api` bundler does not follow `await import()`, so the dynamic import left the guard unbundled and the function 500'd |
| `search-vinted-secondhand` | same | same |
| `kickscrew-sneaker-description` | `RAPIDAPI_KEY` → `KICKSCREW_RAPIDAPI_KEY` | separates provider credentials |
| `nike-shoe-details` | **behavioural delta: none. Warning deletion NOT adopted** | see below |

Verified: `product-search-deals`, `search-vinted-secondhand` and
`kickscrew-sneaker-description` are now **byte-identical (CR-normalized) to the
deployed source**. `nike-shoe-details` differs by comment lines only.

### The Nike decision — warning retained, explicitly

Production v68 has the *"Experimental provider… Do not wire into production
flows until a supported URL or endpoint is confirmed"* warning deleted. **That
deletion was reviewed and is not being adopted.**

1. Nothing in the repository, the deploy history, or any commit message records
   who determined the upstream endpoint had started working. Deleting a caveat
   is not evidence that the caveat stopped being true.
2. The claim is unrefuted: no call was made to check, because paid provider
   execution is not authorized.
3. **The warning has no runtime behaviour.** Retaining a comment cannot revert
   production behaviour, so this does not violate the reconciliation rule. Every
   *behavioural* delta from v68 is adopted; this is the only exception and it is
   inert.

The decision, its reasoning, and the retirement criterion ("make one successful
call against a current Nike product URL, record the response, and delete these
lines in a commit that cites it") are recorded **in the file itself**, so the
next person to read it does not have to find this document.

A test asserts the warning is still honoured in practice: `fetchNikeShoeDetails`
has no caller in `app/`, `components/`, `hooks/`, `contexts/`, `stores/` or
`store/`. It reaches only a dev helper.

`__tests__/edgeProviderReconciliation.test.js` pins each adopted fix by naming
the production behaviour that must survive — including that the guard runs
*before* the request body is read, so a deactivated account cannot cost a paid
upstream call.

---

## 2. Hard precondition — multi-item selection contract: RESOLVED

### The defect

The deployed function returns `detectedGarments[]` **and** promotes
`detectedGarments[0]` to the top-level `identification`, `attributes` and
`displayResult`. A client cannot distinguish *"we identified this jacket"* from
*"we found four things and are showing you the first one"*. **The backend was
guessing which garment the user meant, and the guess was indistinguishable from
a real identification.**

### What is now guaranteed

1. **An unambiguous state.** `applicationState: 'MULTI_ITEM_SELECTION_REQUIRED'`
   and `selectionRequired: true` are explicit fields — nothing is inferred from
   an array length.
2. **No guessed primary.** When selection is required, `identification`,
   `attributes`, `displayResult` and `userMessage` are removed, and
   `primarySuppressedReason: 'backend_must_not_guess_selection'` states why.
   `detectedGarments` survives — the candidates *are* the answer.
3. **Lineage that survives the round trip.** Each candidate carries its own
   `selectionToken` (scanId, scanSessionId, imageDigestPrefix, evidenceId,
   candidateId). Per-candidate rather than per-response, so a client cannot pair
   candidate A's id with candidate B's lineage.
4. **The backend validates on return.** `validateSelectedItemRequest` rejects a
   missing token, a missing candidate id, a session mismatch, a digest mismatch,
   and an unknown candidate — every check a **rejection, never a repair**.
   Silently proceeding on a mismatch would mean matching products against an
   image the user is no longer looking at: the same guess, arriving by a
   different door.
5. **Product matching is refused while selection is unresolved.** The bridge
   returns `skipReason: 'selection_required'` and makes no call.

A lineage field the backend does not emit (`detectionDigest`) is *skipped*, not
failed — failing every request over a structurally absent field would take the
journey offline. The field is declared so adding it later is a populated value
rather than a contract change.

### The funnel this repairs

| request_mode | events | completed | with products | last seen |
|---|---|---|---|---|
| `multi_item_detection` | 23 | 19 | **0** | 2026-08-03 |
| `selected_item` | 11 | 10 | 8 | 2026-07-30 |

Multi-item detection was in active use *through the day this was written*, while
the selection step that actually retrieves products had not fired in four days.

---

## 3. Integration — product-match in the scan journey

### An HTTP hop, not an import

Importing product-match into `scan-identify` would merge the two dependency
closures: the governed manifest would grow by a dozen files, the two would have
to be deployed together forever, and a product-match defect would become a
scan-identify incident. The endpoint was built for service-to-service use and
already has an internal-secret gate. The hop's cost is measured
(`scanJourney.productMatch.durationMs`) rather than hidden.

### Additive only — the legacy path *is* the rollback path

`applyScanJourneyContract` runs **after** the legacy response is fully
assembled, takes it as input, and returns it. The legacy answer is never waited
on, weakened, or made conditional.

| situation | result |
|---|---|
| flags off | byte-identical legacy response, **no fetch attempted** |
| flag on, endpoint unreachable | legacy response stands, `skipReason: 'unreachable'` |
| flag on, endpoint 404s (dormant) | legacy response stands, `skipReason: 'rejected'` |
| flag on, malformed body | legacy response stands, `skipReason: 'malformed_response'` |
| contract-layer exception | legacy response returned unchanged |

There is no failure mode in which enabling this makes the scan worse than it is
today. `requestProductMatch` never throws, so an unhandled rejection cannot
violate that.

### Three flags, separate on purpose

```
SCAN_MULTI_ITEM_SELECTION_CONTRACT_ENABLED   selection state + no guess
SCAN_PRODUCT_MATCH_ENABLED                    the product-match hop
SCAN_SIMILAR_ITEM_FLAG_ENABLED                advisory closet comparison
```

Bundling them would mean a problem with the similarity engine forces the
selection fix off too — and the selection fix repairs a funnel that currently
loses every multi-item scan.

### The privacy boundary held

`projectIdentificationToQuery` names each forwarded field explicitly rather than
spreading the identification object. The scanner's identification carries visual
observations, confidence blocks and raw model output; a spread would forward all
of it to a service documented as accepting text attributes only. A test asserts
that a visual observation, a base64 blob and a token count in the source object
do **not** appear in the projection.

`sanitizeExistingItemCandidates` applies the same rule to closet candidates: a
strict allowlist, with `userId`, `authToken` and `imageBase64` dropped in test.

### Application states, without streaming

`MULTI_ITEM_SELECTION_REQUIRED · FASHION_IDENTIFIED · CANDIDATES_READY ·
ENRICHED · NO_CONFIDENT_MATCH · FAILED`, in
`supabase/functions/_shared/scanJourneyState.ts`.

**Progressive HTTP streaming is deferred and not implemented.** These are
ordinary response states; a client reaches a later one by making another
request or transitioning its own state. No SSE, no chunked transfer, no live
connection — and nothing here should be read as a commitment to add one.

Derivation is ordered: failure outranks selection, selection outranks
everything else. A multi-item image has no single correct identification, so any
state below selection would imply one.

---

## 4. Similar-item flagging — plumbing only, engine NOT validated

Checkpoint 3 wires the system in and proves the flow. **It does not validate
similarity quality**, and the flag is off in every environment.

What is wired: detection against Closet and Recent Scans, `potentialSimilarItem`
(never `isDuplicate`), the existing record and its source, both image
references, explainable reasons, independent records preserved, all six actions
always offered, and nothing merged, suppressed or deleted automatically.

**What the next pass must measure — and the seams that now exist to measure it.**
`scanJourney.similarity` is emitted on **every** scan, including when the flag
is off, because the candidate population has to be measured *before* the engine
is switched on rather than after:

| the next pass must answer | seam available now |
|---|---|
| what comparison inputs it uses | `similarity.comparisonInputs` — the query attributes that were non-empty |
| Closet, Recent Scans, or both | `similarity.sourcesChecked` |
| how thresholds are calibrated | `MIN_REASONS` and `REASON_WEIGHTS`, named and exported in `closetSimilarity.ts` |
| how often it flags / misses / annoys | `similarity.flagged` against `similarity.candidatesAvailable` |
| performance as a Closet grows | `similarity.candidatesAvailable` and the `similarity` stage timing |
| are the side-by-side images correct | `comparison.newScanImageUri` / `existingItemImageUri`, echoed from the caller |
| do actions match record state | all six are always offered today — **this is the open question**, and the next pass should decide whether eligibility ever depends on state |

**Unvalidated and stated as such:** the similarity threshold structure is
uncalibrated, the false-positive and false-negative rates are unmeasured, and no
real Closet has been tested against. `SCAN_SIMILAR_ITEM_FLAG_ENABLED` stays off
until that pass runs; turning it on is a decision about a known-unvalidated
engine, not a side effect of enabling product matching.

---

## 5. Governance — the repository is now ahead of production

Both governed manifests were regenerated:

- `config/edge-function-manifest.json` — scan-identify's bundle grew 31 → 36
  files
- `config/cross-path-parity-manifest.json` — the scanner hash it pins changed

**A passing parity gate no longer means "repo equals production."** Both gates
are repo-internal; neither contacts Supabase. `config/deployed-edge-baseline.json`
now records what production was actually running (scan-identify v141,
stylechat-generate v84, style-outfit-generate v3, all verified byte-identical at
`b2df581`), and `__tests__/deployedBaselineDivergence.test.js` enforces the rule
that makes divergence safe:

> The repository may be ahead of production, but only while every behavioural
> change it adds is behind a flag that defaults off.

The test reads each default from source rather than trusting the JSON, and
verifies the Checkpoint 3 modules are inside the governed bundle — otherwise the
parity gate would not notice them changing.

**iOS propagation is required.** The cross-path manifest must be committed
identically on both platform lines, and this branch is Android-line only. The
iOS `scan-identify` copy is stale and must never be edited directly — the
Android line is canonical. Propagating this change is a prerequisite for any
release shipping both lines.

---

## 6. Results

```
node scripts/run-backend-tests.js                     272 passed, 0 failed
node scripts/run-backend-tests.js product-match       119 passed, 0 failed
node scripts/check-edge-function-parity.js            PASS
node --test __tests__/edgeProviderReconciliation      9 passed, 0 failed
node --test __tests__/deployedBaselineDivergence      5 passed, 0 failed
node --test __tests__/phase2b4CrossPlatformParity     9 passed, 0 failed
node scripts/product-match-benchmark.js               5/5 directional, exit 0
node scripts/run-all-tests.js      4489/4502; the 13 failures are pre-existing
                                   at f5fb946, verified against a clean baseline
```

The integrated-flow suite (30 tests) covers: multi-item stops for selection and
never calls product-match; the selected item validates and flows through to
`ENRICHED`; a failed product-match leaves the legacy result standing; and — the
rollback proof — with every flag off, no fetch is attempted and the response is
unchanged, with the input object unmutated.

---

## 7. Still open

**Not blockers, sequenced autonomously as evidence arrives:** flag rollout
scope, production test-row cleanup, mobile presentation, provider cost policy,
staging rollout mechanics, similar-item UX polish.

**Genuinely open:**

1. **The similarity engine is unvalidated** (§4). Dedicated next pass.
2. **iOS propagation** of the cross-path manifest and the scan-identify change.
3. **No client consumes the new states yet.** The backend emits them; the
   scanner UI still reads the legacy shape. The multi-item funnel is repaired
   *in the contract* — closing it for users needs the client change.
4. **product-match is still not deployed**, so `SCAN_PRODUCT_MATCH_ENABLED` has
   nothing to call. Activation order: deploy product-match → set its secret →
   enable it → then enable the bridge.
5. **No production latency data.** The stage instrumentation and
   `scanJourney.productMatch.durationMs` exist to collect it; nothing has.
6. **No accuracy baseline.** Unchanged from Checkpoint 2.
7. **The 14 `KSCAN_TEST` rows** are still in production `product_catalog`.
