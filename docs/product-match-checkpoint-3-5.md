# Checkpoint 3.5 — cross-platform client consumption

Status: **both client contracts consume the scan journey.** No deployment, no
EAS build, no database mutation, no similarity calibration, no production flag
activation.

Branches:

| line | branch | base |
|---|---|---|
| Android | `product-match/foundation-v1` | `validation/android-build25-prebuild-readiness` |
| iOS | `product-match/foundation-v1-ios` | `validation/ios-build25-prebuild-readiness` |

Checkpoint 3 left the contract real in the backend and absent in the app. This
closes that.

---

## 1. What the client now does

```
scan
→ MULTI_ITEM_SELECTION_REQUIRED when several garments are detected
→ selectionCandidates rendered, user chooses
→ that candidate's selectionToken echoed back verbatim
→ backend validates lineage; a mismatch is REJECTED, not repaired
→ selected garment reaches product matching
→ ENRICHED / CANDIDATES_READY / NO_CONFIDENT_MATCH
→ potential-similar-item notice, if any
→ user acts
```

### Consumption layer — `services/scanJourney.ts`

One place the client interprets `applicationState`, `selectionRequired`,
`selectionCandidates` and `potentialSimilarItems`, so every screen agrees on
what a response means.

**Legacy fallback is the default, not the exception.** `applicationState` is
emitted on the completed path only — the handler has 26 return sites and the
early terminal ones return before the contract layer — and the whole contract
sits behind a flag that is off. So an absent state means "legacy shape" and
never an error, and every state is derivable from the legacy fields.

**Legacy derivation never invents `MULTI_ITEM_SELECTION_REQUIRED`.** That state
promises two things a legacy response has not kept: that the backend suppressed
its guess, and that dispatchable tokens exist. Inferring it from
`detectedGarments.length > 1` would drop the user into a selection screen with
nothing to send — worse than the legacy behaviour it replaced. Selection is
honoured only when the backend **both** declared it **and** supplied usable
tokens.

### Token dispatch

The backend's token is echoed back **verbatim**, through
`scannerScanRequest` → `scanIdentification` → request body. It is never
reconstructed from parts: the value of a server-issued bundle is precisely that
the client did not assemble it, so a client-side rebuild would validate against
itself rather than against the detection. Responses that predate the contract
still correlate through the legacy `scanSessionId` / `imageDigestPrefix` pair,
so this is additive on every path.

`findSelectionCandidate` returns `null` rather than falling back to the first
candidate. Substituting a neighbour is the client-side version of the guess the
backend refuses to make — it would send one garment's token for another
garment's selection.

### Lifecycle — `services/scanSelectionSession.ts`

- **Resume.** A selection survives background/resume. Without this, switching
  apps mid-choice loses the photograph — the exact point production telemetry
  already shows leaking.
- **Expiry.** 30 minutes, then dropped. A selection is only meaningful against
  the image that produced it, and the backend validates the image digest — so a
  stale session would fail server-side anyway. Expiring locally turns a
  confusing rejection into a clean restart.
- **No double dispatch.** A claim ledger makes a candidate dispatchable at most
  once per session. `markDispatched` is idempotent, so a re-render cannot
  double-count. Two identical `selected_item` requests would cost two paid
  provider runs and deliver two results for one user action.
- **Rejection is never retried and never substituted.** A rejected token stays
  rejected; the candidate stays visible so the user can choose again
  deliberately. Removing it would look like the app decided for them, and
  auto-advancing to the next candidate would reintroduce the guess on the client
  side of the wire.
- **No image bytes are persisted.** Tokens, descriptions and local URIs only.
  Refresh tokens already sit in plaintext AsyncStorage on this platform; adding
  scan imagery to the same store would widen an exposure that is already open.

---

## 2. State-aware action eligibility

The design issue from Checkpoint 3, resolved.

**The contract keeps all six actions, always.** The backend cannot know whether
the new scan is already saved or whether the existing item still exists, and a
backend filtering on stale information would be worse than one that does not
filter. **The client knows, so the client decides** —
`services/similarItemActions.ts`.

| action | eligible when | why |
|---|---|---|
| `delete_existing_item` | the existing item exists | offering it for a record already gone produces an error the user cannot act on |
| `add_to_closet` | the new item is not saved | a second "add" is either a no-op or a duplicate, and the user cannot tell which |
| `keep_in_recent_scans` | it is not already there | presenting it implies a change that would not happen |
| `shop_identified_product` | usable commerce candidates exist | otherwise the button leads to an empty screen |
| `keep_both` | the existing item exists | two records are needed to keep two |
| `reject_new_scan` | **always** | see below |

`evaluateSimilarItemActions` returns every action with `eligible` and a
`reason`, rather than a filtered array, so "impossible right now" is
distinguishable from "someone forgot to include it".

**`reject_new_scan` is unconditional and never touches the existing record.**
It is the user's escape hatch from a comparison they consider wrong, so it must
not depend on the state of the other record — and by definition it does not
affect it. An `ACTION_SCOPE` table declares which records each action may
touch, and a test asserts that **only** `delete_existing_item` may modify the
user's existing record.

---

## 3. The notice — `PotentialSimilarItemNotice.tsx`

Side-by-side: both images, the source of the existing record ("In your Closet" /
"In Recent Scans"), named reasons as chips, and the actions.

**The language is part of the contract.** A correct advisory payload rendered as
"Duplicate found" is still a duplicate claim. The headline is *"This looks
similar to something you have"* — an observation, not a verdict — and a test
fails the build if the word *duplicate*, *already own*, *same item* or *you own*
appears in any user-facing string.

The component **holds no state and resolves nothing**. Every action is an
explicit press handed straight back to the caller; there is no dismissal that
silently resolves anything, no pre-selected action, and no merge, suppression or
deletion path. A missing image is stated ("No image") rather than hidden —
silently collapsing one side leaves a "side-by-side" with one side, which reads
as a system error.

---

## 4. Cross-platform

`services/scanJourney.ts`, `similarItemActions.ts`, `scanSelectionSession.ts`,
`scanJourneyTypes.ts` and the notice component are **byte-identical** on both
lines, verified by `cmp`. The hook wiring is applied per line because
`hooks/useKScan.js` and `services/scanIdentification.ts` genuinely diverge
between platforms — the iOS scanner uses a single `selectedCandidateId` where
Android uses a selection queue.

The Checkpoint 3.5 client commit was therefore **hand-applied to iOS rather than
cherry-picked**: the auto-merge produced a 165-line conflict hunk across the
divergent dispatch path, and accepting a merge that large in the scanner hook is
not a review anyone can do honestly. Checkpoints 1–3 and the validation commit
cherry-picked cleanly.

**Both governed manifests are byte-identical across the two lines**, which is
the property the cross-path gate exists to guarantee — two trees that each pass
are provably running the same bytes.

### The client mirror

`services/scanJourneyTypes.ts` duplicates the backend state union rather than
importing it: the Edge module is Deno TypeScript with `.ts` specifiers and Deno
globals, and pulling it into Metro would drag a server runtime into the app.
Duplication is fine; *silent divergence* is not — a client that does not
recognise a state the backend now sends falls back to legacy handling and
quietly stops rendering the new flow. `scanJourneyContractParity.test.js` fails
the moment the state lists, action vocabularies or reason vocabularies disagree.

---

## 5. A test-harness trap worth recording

The `useKScan` harnesses mock `useState` with an **index-keyed slot array**.
Inserting a state hook anywhere above the end renumbers every hook after it, and
every existing assertion reads the wrong slot. Adding one `useState` in the
natural place cost **34 failures** across two suites.

The new state is therefore declared **last**, on both lines, with a comment
saying why. Both harnesses now receive the **real** contract reader rather than
a stub, via `__tests__/helpers/loadScanJourneyModule.js` — a stub of a pure
contract reader would silently diverge from the module the app ships.

---

## 6. Results

**Android**

```
scanJourneyClient            25 passed, 0 failed
scanJourneyContractParity     6 passed, 0 failed
scanJourneyWiring             8 passed, 0 failed
useKScan harnesses           67 passed, 0 failed
run-backend-tests.js        276 passed, 0 failed
check-edge-function-parity  PASS
tsc                          83 errors — identical to the base worktree
run-all-tests.js            4528/4541; the 13 failures are pre-existing
```

**iOS**

```
scanJourneyClient + parity   31 passed, 0 failed
run-backend-tests.js        276 passed, 0 failed
check-edge-function-parity  PASS
run-all-tests.js            4474/4487; the 12 failures are byte-identical to
                            the iOS clean baseline (failing test names diffed)
```

Each line's failures were compared against **its own** clean baseline worktree
by diffing failing test names. Both diffs are empty.

---

## 7. Still open

**Not blockers for Checkpoint 4:**

1. **No screen renders the new surfaces yet.** The hooks expose
   `scanJourneyState`, `selectionCandidates` and `potentialSimilarItems`, and
   the notice component exists — wiring them into the scanner result screens is
   presentation work, deliberately left for after the engine is calibrated so
   the layout is designed against real flag rates rather than guesses.
2. **`product-match` is still not deployed**, so the bridge has nothing to call
   and `potentialSimilarItems` is always empty in practice. The client path is
   proven against fixtures.
3. Release gates unchanged: propagate to iOS on merge, deploy `/product-match`,
   resolve the 14 production test-catalog rows, gather production latency,
   grow the directional case set, apply migrations only after approval.

**The next checkpoint:** the similarity engine is wired and observable but
**not validated or calibrated**. It is not known whether it flags the right
items, misses genuine similarities, or produces excessive false alerts.
`SCAN_SIMILAR_ITEM_FLAG_ENABLED` stays off until Checkpoint 4 answers that.
