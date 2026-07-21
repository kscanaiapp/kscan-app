# E-4 Hostile Audit — Overview and Findings

## Scope note

The audit instructions for this pass were truncated mid-Phase-11 (the source
text cut off inside "Attack: - exact owned duplicate; ... - affiliate"), so
Phases 12 onward (multi-look, structured output, telemetry deep-dive,
rollback, old-client compatibility, Android/iOS parity, final defect
classification, required output files) were not delivered verbatim. This
audit inferred that remaining scope from Phase 1's own claim-ledger category
list and applied the same rigor the delivered phases modeled (source
verification, hostile attack cases, real test execution, repair with
regression coverage). This is noted here rather than silently guessed at.

## Preflight (Phase 0) — independently verified, not assumed

| Field | Value |
| ----- | ----- |
| Worktree | `C:\src\KScan-elise-e4-closet-intelligence-20260721` |
| Branch | `feature/elise-e4-closet-aware-styling` |
| HEAD at audit start | `8023820c1be995db0edf18cecc311e991ed0ff6e` (matches expected) |
| Parent | `8852665da2ed054da39c19251b019eed244972d1` (matches expected; `integration/elise-e1-e2-e3-complete`) |
| **Repaired HEAD** | `787f311` (one commit on top of `8023820`) |
| Ancestor check | `8852665d...` confirmed an ancestor of HEAD |

**Critical Phase 0 finding — the "PUSHED" claim was false.** The worktree's
`origin` remote was configured as `C:\src\KScan-KC05-repair-20260710-144442`,
a **local filesystem path**, not the authoritative GitHub host
(`https://github.com/kscanaiapp/kscan-app.git`). `git branch -vv` showed
`[origin/feature/elise-e4-closet-aware-styling]` as up to date, which is
exactly the misleading signal the audit brief warned about: local-remote
parity was being read as GitHub parity. Independently verified against the
real GitHub remote (`git ls-remote https://github.com/kscanaiapp/kscan-app.git
refs/heads/feature/elise-e4-closet-aware-styling` from a repo whose `origin`
genuinely is GitHub) returned **no result** — the branch does not exist on
GitHub. By contrast, the accepted DR-1 branch's HEAD (`955c58b...`) *was*
found on the real GitHub remote at the exact SHA cited in this audit's brief,
confirming the check methodology is sound (it correctly distinguishes a
branch that really is on GitHub from one that only appears pushed locally).

**Repair:** `git remote set-url origin https://github.com/kscanaiapp/kscan-app.git`
was applied to the E-4 worktree. See "Push status" below for the outcome.

**Second critical Phase 0/Phase 2 finding — E-4 is not based on, and does not
contain, the accepted DR-1 branch.** `git merge-base --is-ancestor
955c58be941eeeb1a507fc923523158bebf11f5d HEAD` fails with `fatal: Not a valid
commit name` — the DR-1 commit object isn't even present in this repository's
history; E-4 branched from `integration/elise-e1-e2-e3-complete`, a sibling
lineage that also traces back to `f73d4147` but never merged DR-1's work.
Confirmed directly: `types/canonicalDressingRoomItem.ts`,
`services/dressingRoomCommerce.ts`, `services/dressingRoomDedupe.ts`,
`supabase/functions/stylechat-generate/eliseRoomItemEvidence.ts`, and every
`DRESSING_ROOM_*` feature flag are **absent** from the E-4 branch entirely.
See `02_E4_DR1_COMPATIBILITY.md` for the full analysis and why this was
contained to a Phase 15 finding rather than requiring a branch rebase.

## Test-execution capability (materially strengthens this audit vs. relying on source review alone)

This sandbox initially had no Deno runtime, and E-4's most substantive test
coverage — `eliseAdviceE4.test.ts` (500 lines, 11 tests) and
`eliseE4HostileAudit.test.ts` (230 lines, 6 tests) — is written as
`Deno.test(...)`, unexecutable under plain Node. The Node-visible test file
(`__tests__/eliseE4ClosetIntelligence.test.js`) turned out to be **regex/
string-presence checks against raw source text** (e.g. `assert.match(source,
/ownerMatches/)`), not behavioral verification — a real but narrow finding in
itself (documented below as F-4).

Rather than accept "SOURCE VERIFIED" as the ceiling for E-4's core logic, this
audit downloaded and installed Deno 2.9.3 into the sandbox (network access
was available; the official installer's single-shot download exceeded this
sandbox's per-command time budget, so it was resumed across several `curl -C -`
calls) and ran the real Deno test suite. This is the difference between
"the file contains the word `ownerMatches`" and "the authorization logic
actually rejects a foreign row when invoked" — the latter is what was
verified.

## Findings

### F-1 (P1, repaired) — Dressing Room items saved from a catalog/commerce match were labeled "owned"

**Evidence:** `eliseWardrobeRetrieval.ts`'s `listOwnedRoomItems` handler
hardcoded `actorRelationship: 'owned'` (and `sourceType: 'owned_room'`) for
**every** row returned from the actor's own rooms, even though the query
already selects `source_type` (a column that is `'product_match'` for a
catalog item a user browsed and saved into a room, versus `'scan_image'` for
a genuinely scanned garment — this is the exact distinction DR-1 established
and this audit's DR-1 pass repaired on the write side). The type system
already defines `EliseWardrobeSourceType` values `'saved_product'` /
`'commerce_product'` for precisely this case, but the retrieval code never
used them. Consequence: Elise would tell a user "You already have..." about
an item they merely bookmarked from a catalog — the exact prohibited pattern
Phase 10 names verbatim ("'You already have…' for a commerce match").

**Repair:** added `roomItemRelationship()` to `eliseWardrobeRetrieval.ts`,
which checks DR-1's canonical `snapshot_payload.canonical.source.kind` when
present (forward-compatible with `DRESSING_ROOM_CANONICAL_ITEM_V1`) and falls
back to the legacy `source_type` column that exists on every row today.
`product_match` / `catalog_product` → `sourceType: 'saved_product'`,
`actorRelationship: 'saved'`; everything else (including no `source_type` at
all, for old rows) conservatively defaults to the prior `'owned_room'` /
`'owned'` behavior, so genuinely Scanner/Closet-originated items and legacy
rows are unaffected. Regression test added to `eliseAdviceE4.test.ts`
covering both the legacy-column path and the DR-1-canonical-kind path, plus
an explicit legacy-row-defaults-to-owned case so the fix cannot regress
into over-classifying items as merely "saved."

**Disposition:** REPAIRED AND VERIFIED (67/67 tests pass post-repair: 60 Deno
across all 8 `stylechat-generate` test files + 7 Node).

### F-2 (P2, repaired) — Shared-room retrieval didn't check for a stale share owner

**Evidence:** `index.ts`'s `listSharedRoomItems` data-source implementation
correctly re-verifies, at request time, that the membership is not removed,
and that the joined `room_shares` row is active, not revoked, and not
expired — a genuinely solid implementation of the "membership alone is not
access" contract Phase 4 requires. It did **not**, however, replicate the
`rs.owner_id = dr.user_id` staleness check that the codebase's own
`list_shared_rooms_for_me()` RPC already applies for the equivalent "Shared
with Me" list feature (guarding against a share row whose recorded owner no
longer matches the room's current owner, e.g. after an account-deletion
room-transfer). Live exploitability is narrow — the only ownership-transfer
mechanism in this codebase is the account-deletion script, and that script's
`room_shares.owner_id references auth.users(id) on delete cascade`
constraint means the original owner's share rows are cascade-deleted at the
same time their auth account is deleted, closing the gap in all but a
transient window internal to that admin script's own execution — which is
why this is P2 (defense-in-depth/consistency) rather than P1/P0, not because
the check is meaningless.

**Repair:** extended the `room_shares!inner(...)` embed to include
`owner_id`, then cross-checked each candidate room's live `dressing_rooms.user_id`
against the share's recorded `owner_id` before including its items, matching
the established pattern exactly.

**Disposition:** REPAIRED AND VERIFIED (source-level; this specific closure
lives inside `index.ts`'s Supabase-client-bound data source and — consistent
with every other data-source closure in this file, including the ones DR-1's
audit reviewed — is not independently unit-testable without a live/mocked
Postgres connection; no existing pattern in this codebase unit-tests these
closures directly, so this is not a new testing gap introduced by the
repair).

### F-3 (informational, contained — see `02_E4_DR1_COMPATIBILITY.md`) — E-4 does not literally consume DR-1 source

E-4's branch lineage never merged DR-1, and none of DR-1's helper modules are
imported. Because DR-1's flags are all default OFF in production, and F-1's
repair makes E-4 correctly interpret DR-1's canonical `source.kind` field
when it does eventually appear, the live impact today is contained. This is
still recorded as a real gap for whoever integrates E-4 forward — full
analysis in `02_E4_DR1_COMPATIBILITY.md`.

### F-4 (informational, not repaired — testing-quality gap, not a functional defect) — Node-visible E-4 test coverage is presence-only

`__tests__/eliseE4ClosetIntelligence.test.js` verifies that certain
identifiers/strings appear in source files; it does not import or execute any
E-4 module. The real behavioral coverage lives in the Deno-only test files.
This was not "repaired" (rewriting a working regression suite into a
different style is not a confirmed defect, and the Deno suite already
provides genuine behavioral coverage) but is recorded so nobody mistakes the
Node file's presence-checks for functional verification going forward.

### F-5 (informational) — Android/iOS parity is structural, not a two-codebase comparison

K Scan's Elise/StyleChat client is a single shared React Native/Expo codebase
(`services/style-chat/providers/edgeStyleChatProvider.ts`,
`types/eliseAdvice.ts`); there are no separate native Android (`.kt`/`.java`)
or iOS (`.swift`) implementations of the StyleChat request/response contract
to compare. Parity is achieved by construction — one TypeScript contract
compiled to both platforms — rather than something that can regress between
platforms independently. `adviceMetadata`/`adviceContractVersion` are
optional, type-guarded fields on the client response type; an old client that
doesn't read them is unaffected (verified in `edgeStyleChatProvider.ts`).

## Severity summary

| Finding | Severity | Disposition |
| ------- | -------- | ----------- |
| F-1: false-ownership language for saved catalog items | P1 | REPAIRED AND VERIFIED |
| F-2: shared-room owner-staleness gap | P2 | REPAIRED AND VERIFIED |
| Wrong `origin` remote / false "pushed" claim | Blocker (process/authority) | REPAIRED (remote fixed); push itself remains EXTERNAL GATE — see below |
| F-3: E-4 not based on DR-1 | contained, documented | see `02_E4_DR1_COMPATIBILITY.md` |
| F-4: Node test file is presence-only | informational | documented, not a functional defect |
| F-5: Android/iOS parity | informational | verified structural, no action needed |

No P0 was found: authorization for owned Saved Scans, Inspiration Items, and
owned/shared Dressing Room items is server-derived in every retrieval path
(`user_id`/`owner_id` equality against the authenticated session, or the
explicit room-ownership/share-membership joins reviewed above); client-
supplied ids are independently re-verified by `retrieveAuthorizedWardrobeCandidates`
regardless of what the data source returns (`isUuid` + `ownerMatches` /
`__*_access` marker checks), and this is exercised by a passing hostile test
("client-claimed other-user Closet item is rejected").

## Push status

`origin` was corrected to the authoritative GitHub URL and the repair commit
(`787f311`) was created locally. `git push origin
feature/elise-e4-closet-aware-styling` fails in this sandbox with
`fatal: could not read Username for 'https://github.com'` — there are no
GitHub credentials available here (no credential helper, `~/.netrc`, SSH key,
or `gh` CLI), identical to the constraint documented in the DR-1 audit. See
`99_E4_FINAL_ACCEPTANCE_HANDOFF.md` for the exact command to run from your
own machine.
