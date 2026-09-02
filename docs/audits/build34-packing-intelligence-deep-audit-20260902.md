# Build 34 — Packing Intelligence deep audit & repair

**Date:** 2026-09-02
**Branch:** `audit/build34-packing-intelligence-deep-20260902`
**Base:** `integration/backend-kplus-complimentary-staging-v1` @ `6e7e005`
**Verdict:** CONDITIONAL — 1 P1 and 1 P2 found and repaired; source-side green.
Not merged, not deployed, no EAS, no store submission.

## A. Authority

| | |
|---|---|
| Base branch | `integration/backend-kplus-complimentary-staging-v1` |
| Base SHA | `6e7e005` (2026-09-02, merge of PR #275) |
| Packing authority | Same line. PR #232 (feature) merged at `d021c45`; hostile repairs #234 and actor-epoch #252 all present. |
| `master` | STALE (2026-08-14). Deliberately not used as a base. |
| Worktree | `C:/src/AUDIT-B34-PACKING-20260902`, clean |
| Staging `stylechat-generate` | v121 — advanced past the v115 a prior audit proved stale. Repairs here are **source-only and undeployed**. |

## B. Actual architecture

Packing is **a versioned branch of `stylechat-generate`**, selected by the exact
top-level `schemaVersion: "packing-plan-v1"` — not a new Edge Function. The real
order, which is the security model:

```
auth -> account lifecycle -> schema discriminator -> burst quota
  -> K+ precheck (before any Closet read)
  -> Closet retrieval (user_closet_items ONLY)
  -> K+ confirmation (fresh, uncached, before the retrieval is interpreted)
  -> deterministic narrowing (coverage-first, 200-row census -> 14-item shortlist)
  -> weather enrichment (Open-Meteo, keyless)
  -> Signature Style (advisory)
  -> prompt -> daily quota reservation -> provider
  -> post-model ownership gate -> deterministic gap derivation -> plan
```

Client: `usePackingPlan` -> `packingPlanStore` (actor-bound) -> `PackingPlanView`.

## C. Findings

| ID | Sev | Status | Location | Summary |
|---|---|---|---|---|
| PK-001 | P1 | REPAIRED | `packingValidation.ts`, `packingPrompt.ts` | Model prose could assert the traveller does not own something the census contradicts, or that nothing can ground. |
| PK-002 | P2 | REPAIRED | `packingWeather.ts` + plan contract + UI | Forecast was attributed to the typed destination while resolved from a silently-chosen geocode match. |
| PK-003 | P4 | RECORDED | `packingWeather.ts` | A trip longer than the 16-day horizon spends a geocode + forecast call that can only 400. |
| PK-004 | P4 | RECORDED | `packingWeather.ts` | Fahrenheit only; no Celsius presentation. Not a unit *mismatch* — prompt and label agree. |
| PK-005 | P4 | RECORDED | `packingContract.ts` | Past-dated trips are accepted (weather correctly resolves UNAVAILABLE). |
| PK-006 | P4 | RECORDED | `packingWeather.ts` | Task-local weather cache never evicts; bounded in practice by burst/daily quota and ephemeral instances. |
| PK-007 | P3 | RECORDED (cross-feature) | `scripts/edge-function-manifest-lib.js` | Governed-manifest specifier extractor reads `from` + a quoted string inside a **line** comment as a real import. |

### PK-001 — false Closet-absence claims in model prose (P1, repaired)

**Reproduction.** At the real validation seam, with a shortlist of 3 owned items
and a census of `{outer:1, bottom:4, shoe:2}`, all of the following reached the
traveller verbatim:

- assumption: "You don't own a rain jacket, so I planned around showers."
  (the census says `outer:1`)
- assumption: "Your Closet has no outerwear for this trip."
  (also survived with `censusComplete: false`, where nothing is provable)
- item reason: "Since you don't own any boots, these carry the trip."

The same screen renders **"Your only outer layer"** on the rain jacket the
assumption denies — both halves of one plan, disagreeing about the traveller's
own property.

**Root cause.** The structured plan was grounded — gaps derive from the census
before the model output is read, and `scarcitySignal` is a counted fact — but
three free-text channels were not: `assumptions[]`, `packedItems[].reason` and
`outfits[].reason`. The prompt made this likely rather than theoretical: it
showed a 14-item shortlist drawn from a 200-item census, called it *"the only
garments that exist for this task"*, and then asked the model to write
assumptions.

**Repair.** The prompt was reframed (the shortlist is a selection; a new rule 11
forbids stating or implying the traveller lacks anything) **and** every model
string now passes through the project's one absence authority,
`enforceClosetAbsenceProseSafety`, via a new Packing-owned adapter that maps the
layering-role census onto that guard's subject vocabulary. The guard is
**consumed, not modified**.

**The ownership half is deliberately not applied.** It builds its vocabulary from
the candidates handed to it; for Packing that would be 14 of up to 200 owned
items, so true sentences about the other 186 would be deleted — the mirror of the
bug being fixed, and the shared module's own doctrine says deleting a true claim
is worse than the failure it prevents.

Drops rather than substitutes; new `absenceClaimsDropped` telemetry makes an
over-firing guard visible. Two of the six regression tests prove it does **not**
over-fire: a census-provable absence still gets said, and ordinary prose is
untouched.

### PK-002 — the forecast did not name the place it was for (P2, repaired)

Geocoding uses `count=1`: one candidate returns and is used silently, and the
resolved place was then discarded. Probed against the live public endpoint
(read-only, no user data):

```
"Springfield" -> Springfield, Missouri, US
"Portland"    -> Portland, Oregon, US
"Georgia"     -> Georgia, GE          <- the COUNTRY, not the US state
```

Qualified input is handled correctly ("Paris, Texas" and "Portland, Maine"
resolve as written), so this is specifically about bare, ambiguous names. The
plan showed the typed string above a confident forecast line, so a wrong city was
undetectable while it drove real garment choices.

**Repair.** The resolved label is built from the provider's own `name`,
`admin1` and `country_code` — never from the typed string, so it can actually
disagree with what the traveller wrote — and carried through the resolver, the
prompt, the plan contract and the wire to the screen: *"Forecast for Springfield,
Missouri, US: ..."*. A geocode that names no place carries `null` rather than
echoing the destination back, because a false confirmation is worse than none.

**Verified NOT a defect:** the 16-day horizon. A 30-night trip starting tomorrow
is inside `maxTripNights` but past the provider window; Open-Meteo answers HTTP
400 rather than clamping, so it resolves to UNAVAILABLE. No partial window is
ever labelled a whole-trip forecast.

### PK-007 — manifest extractor reads line-comment prose as imports (P3, cross-feature)

```
extractSpecifiers("// reasoning from 'not in this list' to ...")    -> ["not in this list"]
extractSpecifiers("/* prose from 'not in this list' */")            -> []   (handled)
extractSpecifiers("// the helper imported from './packingGaps.ts'") -> ["./packingGaps.ts"]
```

Block comments are stripped; line comments deliberately are not, because a naive
`//` strip would truncate a legitimate `https://esm.sh/...` specifier at the
scheme's own double slash. The consequence is real: prose naming a **local** path
silently adds a file to the deployable bundle graph that is never imported, or
hard-fails manifest generation if the path does not resolve.

**Not repaired here.** A correct fix needs a string-aware scanner inside a gate
that every Edge function's parity depends on, with six audits live — outside
Packing's ownership. Avoided at the one site that hit it, with the trap noted
inline. **Suggested owner:** Build 34 CI/governance.

## D. What was verified and found genuinely sound

Covered by existing negative-controlled tests, re-confirmed here:

- **Ownership by construction.** Retrieval reads `user_closet_items` only —
  deliberately not `retrieveAuthorizedWardrobeCandidates`. Saved scans,
  inspiration, Watchlist, VTO results, Dressing Room and shared items therefore
  cannot enter the owned census at all.
- **RLS verified live on staging:** `user_id = auth.uid() AND has_active_k_plus()`
  on SELECT — an unentitled or foreign actor gets zero rows even if every gate
  above it were bypassed.
- **K+ checked twice, uncached** — before the Closet read, and again before the
  retrieval result is interpreted; both fail closed. Daily quota reserved last,
  so no refused caller is ever charged.
- **Deleted items:** tombstoned rows filtered in the query and re-checked in
  retrieval.
- **Post-model gate drops, never patches:** hallucinated, foreign, excluded and
  non-shortlisted ids all resolve to nothing.
- **Absence discipline in the structured layer:** an incomplete census asserts no
  gap and no "your only X".
- **Actor isolation:** the store is actor-bound, not merely actor-labelled; late
  completions are rejected on actor *epoch* rather than id, so an A -> B -> A
  cycle is caught.
- **Injection stays data** through destination, trip notes and Closet metadata.
- **No commerce anywhere in Packing** — the wire parser drops any gap carrying a
  price, url or productId.

**Persistence truth:** V1 was in-memory only. This audit adds a device-local
cache (UX-4) and corrected the store header, which stated flatly that nothing is
ever persisted.

## E. UX/UI maturity enhancements

| Item | Status |
|---|---|
| UX-1 multi-stage progress | Implemented |
| UX-2 interactive checklist | Implemented |
| UX-3 provenance badges | Implemented (owned side) |
| UX-3 "Find Similar" commerce CTA | **Not shipped — owner decision required** |
| UX-4 offline cached plan | Implemented |

**UX-1 — how the stages map to backend latency.** The order follows
`packingHandler.ts`: Closet read (1.8s) -> forecast (2.6s, matching the 1.5s
geocode + 2s forecast budget) -> reasoning (6s) -> ownership gate (holds). The
Closet precedes weather because that is the real sequence; leading with a weather
step would be a tidier story and a false one. Every label is an **attempt**, never
an outcome — the client cannot observe weather resolution mid-flight, because the
server resolves it internally and reports provenance only in the finished plan.
The only honest pivot is therefore at completion, where an UNAVAILABLE provenance
renders "Weather unavailable — planned from your trip and occasions". The final
stage has no timer and holds until the response lands; nothing claims success
before a validated `ready`. No percentage, no progress bar. Announced with a
`progressbar` role and a polite live region.

**UX-2 — local state vs server state.** Ticking is purely local: it calls
nothing, and cannot add, remove or alter a `user_closet_items` row — ownership is
not something a checkbox may change. Only an item the *current* plan packs can be
ticked, and a regenerated plan starts empty, so ticks cannot accumulate across
plans. Ticks are mirrored into the device cache so they survive a restart, and
are cleared at every actor boundary. Rows are `React.memo`'d with an explicit
comparator (24 items — one tick would otherwise re-render all of them) and are
56pt targets. Not a `FlatList`: the contract bounds a plan at 24 items, so a
plain map avoids nesting a virtualized list inside the screen's own scroller. The
AI output is a **validated structured contract**, so the prose-fallback branch the
brief anticipated is unreachable by construction.

**UX-3 — badges are evidence, not decoration.** "IN YOUR CLOSET" is backed by the
server's resolution against the actor's own Closet row. Gaps keep their
deliberately unowned treatment — no badge, no checkbox, no photograph, nothing to
tap — asserted by test.

**UX-4 — offline plan.** One plan per actor, 128KB, 30 days. **The actor boundary
is enforced by the key, not the delete:** clearing is async and an app can be
killed mid-clear, so every entry is stored under an actor-scoped key and every
read supplies the actor it is reading for — a record left behind by another
account is *unaddressable*, not merely deleted-eventually. The stored actor is
re-checked on read anyway. Restore fills an empty screen only, refusing to
overwrite a live or in-flight plan, so a slow disk read can never replace a newer
result. A restored plan says when it was built and is never dressed up as fresh.

### Deferred / not shipped, with reasons

- **"Find Similar" on a gap (P4, owner decision).** This would be a new commerce
  integration binding a generic requirement label ("An outer layer") to a product
  search with no product identity — exactly the gap/product mis-binding the gap
  engine is shaped to avoid — and would reverse the explicit V1 decision that
  Packing helps someone pack and does not sell. A test asserts Packing still
  routes no commerce.
- **UX-4 is a new device-local personal-data class** where V1 deliberately had
  none. It inherits the project's *unbuilt* terminal-deletion local purge
  (`services/accountDeletion.js` records that the purge "is not built yet")
  exactly as Recent Scans and Style DNA preferences already do. It **is** cleared
  on sign-out, which is the boundary that actually occurs. Server-side trip
  history remains a future change needing owner sign-off.

## F. Negative controls

| Control | Invariant | Original | Mutated | Restored |
|---|---|---|---|---|
| PK-NC-007 | Absence prose requires census authority | PASS | **FAIL** (3 targeted) | PASS |
| PK-NC-015 | Cached plan is actor-scoped | PASS | **FAIL** (3 targeted) | PASS |
| PK-NC-016 | Checklist binds to the current plan | PASS | **FAIL** (2 targeted) | PASS |

Controls PK-NC-001/002/003/004/005/008/009/010/012/013 are already satisfied by
the shipped suite's existing negative-controlled tests (ownership source,
foreign/deleted/saved rejection, K+ before Closet, weather never fabricated,
prompt privacy). PK-NC-011 is vacuous by construction: Packing routes no commerce.

## G. Tests

| Suite | Result |
|---|---|
| `npx tsc --noEmit` | 0 errors (tsc 5.9.3 verified real, not the decoy package) |
| `run-backend-tests.js` | **785 passed / 0 failed** (baseline 775; +10 new) |
| `run-all-tests.js` | observed 19 / known 19 / **unexpected 0** |
| Edge function parity | **PASS** (manifest regenerated) |
| New tests | 10 backend (PK-001 x6, PK-002 x4), 19 client UX (behavioural) |

The UX tests load the cache and store as **real modules** through the repo's
transpile harness with a stubbed AsyncStorage, rather than asserting source
strings. One trap worth recording: without `__esModule: true` on the stub,
TypeScript's `__importDefault` re-wraps it, every write is swallowed by the
cache's own try/catch, and the tests pass **vacuously** against a cache that never
stored anything.

## H. Parallel-audit collisions

| File | Packing need | Held by | Disposition |
|---|---|---|---|
| `eliseOwnershipProseSafety.ts` | Consume the absence guard | Concierge (built it) | **Consumed read-only, zero edits** — no collision |
| `eliseClosetCensus.ts`, `eliseAdviceTypes.ts`, `stylechat-generate/index.ts` | Inspection only | Concierge (uncommitted edits) | Inspected, not edited |
| `hooks/useStyleChat.ts` | None | Elise audit | Untouched |
| `scripts/edge-function-manifest-lib.js` | PK-007 | Nobody | Recorded, not repaired (scope) |

## I. Production safety

```
PRODUCTION DEPLOY:    NO
PRODUCTION MIGRATION: NO
EAS RUN:              NO
STORE SUBMISSION:     NO
STAGING MUTATED:      NO (two read-only reads: pg_policies, list_edge_functions)
```
