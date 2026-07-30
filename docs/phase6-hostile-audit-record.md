# Phase 6 hostile audit — defect record

Governing audit branches (all clean, pushed, 0/0 with upstream):

| Lane    | Branch                               | HEAD      |
|---------|--------------------------------------|-----------|
| Backend | `audit/phase6-elise-contract-v1`     | `ce356ce` |
| iOS     | `audit/phase6-ios-saved-looks-v1`    | `999720b` |
| Android | `audit/phase6-android-saved-looks-v1`| `4ce85d3` |

Composed from the frozen Phase 5 candidates (`d00cba1` / `fb10ea8` / `f8a7da4`)
plus the auth-401 hotfix (`ada2dfe`, `f89ba25`), so the audited tree is what
would actually ship.

## Defect IDs

Two defects were both labelled `DEFECT-P6-003` while in flight — the actor-scope
failure and the persistence race. The commit subjects are accurate but their
bodies carry the collided label. **This table is authoritative.**

| ID | Severity | Title | Repair commit (Android) |
|----|----------|-------|--------------------------|
| DEFECT-P6-001 | HIGH | Auth preflight ran ahead of the injectable transport, breaking 17 certified Phase 5 tests and coupling the DEV QA provider to a real login | `8b0cbca` |
| DEFECT-P6-002 | MEDIUM | Two harness gates broken by the hotfix: `aiStylistUiContract` loader had no stub for the new import; QA-provider boundary gate counts raw factory-call occurrences | `2f31a7e` |
| DEFECT-P6-003 | CRITICAL | **Actor-scope attestation failed open** — `belongsToActor` admitted any Closet item lacking `actorId`, and the projection has no such field, so in production the filter was a no-op | `02c91b0` |
| DEFECT-P6-004 | CRITICAL | **Saved Look read/write race caused ghost read and data loss** — an unserialized read stole the writer's temp manifest | `1bee26b` |
| DEFECT-P6-005 | MEDIUM | Stale return context could highlight a slot on a later unrelated visit; no TTL, no slot-membership check | `4ce85d3` |

The commit body of `1bee26b` calls the race `DEFECT-P6-003`; read it as
**P6-004**. History is not rewritten because the branches are pushed
checkpoints.

## DEFECT-P6-003 — actor-scope attestation failed open

`belongsToActor` returned true when `item.actorId` was `undefined` or `null`.
`ClosetItemProjection` carries no `actorId`, so every production item took that
branch: isolation rested entirely on `loadClosetTyped` being scoped upstream,
with no defence in depth.

Inverting the condition would have been a worse defect. Absent evidence is
unsafe in both directions — admitting an unattributed item can report another
actor's garment as owned; excluding it resolves a genuinely owned piece to
`not_owned`, which un-suppresses commerce and offers to sell the user something
they already have.

The resolver therefore no longer picks a default. It takes a required
`OwnershipClosetScope` naming the actor the Closet was read for; a null, blank
or mismatched attestation fails closed, and TypeScript rejects silent call sites.

## DEFECT-P6-004 — read/write race, ghost read and data loss

`loadPrivateSavedLooks` used `await mutationQueue` rather than enqueueing, so a
read starting first overlapped a mutation enqueued after it. `persist()` leaves
the primary absent between its two moves, and `recoverMissingPrimary()` treats an
absent primary as a crash to recover from. Captured pre-repair trace:

```text
MOVE MANIFEST -> MANIFEST.bak     persist opens its swap window
GATE released, exists=false       the read observes the primary absent
MOVE MANIFEST.tmp -> MANIFEST     the READ steals the writer's temp
MOVE FAIL ENOENT MANIFEST.tmp     the write fails on the stolen file
MOVE MANIFEST.bak -> MANIFEST     the write rolls back
READ  ok=true n=2                 a record that was never committed
WRITE ok=false saved_look_persist_failed
ON DISK records=1                 the new Look is gone
```

Reads now share the mutation queue. Only the read-first ordering was ever
unserialized; a read starting during an in-flight write always blocked. Reads
must never be issued from inside an enqueued mutation — none are.

## Evidence gap carried into the build decision

```text
AUTHENTICATED LEGACY 2XX:  BLOCKED — no authorized QA session
AUTHENTICATED PRIVATE 2XX: BLOCKED — no authorized QA session
UNAUTHENTICATED REJECTION: PASS  (no header / bad bearer / anon-key-as-bearer -> 401)
DEPLOYED LOG PRIVACY:      PASS for available 401 traffic
```

The 401 results prove the gateway rejects, and that v3's own code executes and
refuses a non-user JWT. They prove neither the legacy nor the private success
contract. This matters because the `production` EAS profile sets
`EXPO_PUBLIC_AI_STYLIST_BACKEND_ENABLED = "true"` — see
[style-outfit-generate-live-traffic.md](style-outfit-generate-live-traffic.md).
The backend must not be recorded as fully certified until an authorized QA
session closes both.

## Audit-environment integrity findings

**Not application defects.** Both caused the audit to observe code other than the
candidate, and evidence captured under them is invalid and excluded.

**ENV-P6-A — a stale Metro served a foreign worktree.** The app fetches its bundle
from `http://10.0.2.2:8081`, the host loopback alias, which bypasses `adb reverse`
entirely (reverse only affects `localhost` ON the device). A Metro left running on
host port 8081 from a previous session therefore kept serving its own worktree while
appearing to work — plausible screenshots, wrong flags, wrong code. Three screenshots
taken before this was found, including a Dressing Room that appeared to have a live
session, came from that foreign bundle and are **excluded from the audit record**.
Control: your Metro must own host 8081, and Metro must log `Android Bundled …
(N modules)` before any runtime observation is trusted. No bundling line means the
evidence is not yours.

**ENV-P6-B — a junctioned `node_modules` broke Metro resolution.** The audit worktrees
were given `node_modules` junctions (valid for the jest/`tsc` gates, which is how every
suite was run). Metro cannot resolve through one: the junction target's absolute path
leaks into resolution and the bundle 404s with `Unable to resolve module
./Users/jsmit/<donor>/node_modules/expo-router/entry`. Fixed by removing the link
(`cmd /c rmdir`, which removes the link and not the target) and running a real
`npm ci` in the worktree. This extends the known export-time constraint to Metro.

Consequence for the record: **no Phase 5 or Phase 6 runtime evidence existed before
these were corrected.** Everything reported as Android runtime evidence was captured
after Metro confirmed it bundled from `C:\src\PHASE6-ANDROID-20260730`.

## Deferred, not defects

* `purgeSavedLooksForActor` has no production caller — expected in Phase 5, and
  confirmed: it is referenced only by the store module and its tests. The
  automated-deletion integration remains a separate phase.
* External commerce remains deferred; the handoff adapter is local-only and its
  outbound query carries taxonomy only.
