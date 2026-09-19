# K SCAN AI — BUILD 34

# PRODUCTION LEDGER RECONCILIATION

Read-only reconciliation of the production migration ledger
(`wyyuqfdxucjksghsmhry`) against the governed migration tree at
`rebuild/backend-authority-v2@13a784413a1687e5599912047c11998c3e5cb07e`.

**PRODUCTION_MUTATED=NO.** No migration was applied, no ledger row was written
or rewritten, no Edge Function was deployed, no `app_config` value was changed.
Every fact below comes from a read-only query.

This document explains the `ledgerReconciliation.environments.wyyuqfdxucjksghsmhry`
block in `config/migration-authority-manifest.json`. That block is the machine
-readable authority; this is its rationale.

---

## THE PROBLEM THIS CLOSES

```
LOCAL_MIGRATIONS              = 172
PRODUCTION_REMOTE_MIGRATIONS  = 95
COMMON_VERSIONS               = 72
LOCAL_ONLY (pending)          = 100
PRODUCTION_ONLY               = 23
```

Production is **intentionally** many Build 34 migrations behind staging. That is
not drift to be closed by parity — `CLIENT_COMPATIBILITY > STAGING_PARITY` — but
the governed tooling could not say so. Its vocabulary had exactly three ways to
describe a local-only version:

| existing classification | what it asserts |
|---|---|
| `EXACT_CONTENT_RENUMBER` | effect already present, under another version |
| `EQUIVALENT_RENUMBER` | effect already present, equivalent SQL |
| `CONSOLIDATED_IN_REMOTE` | effect already present, split across rows |
| `SUPERSEDED_BY_LATER_MIGRATION` | effect unnecessary, later state covers it |

All four assert **"no execution is needed."** None of them can represent

> KNOWN FUTURE MIGRATION — DELIBERATELY UNAPPLIED

where execution **is** still needed, just not yet and never automatically. With
no way to say that, the only way to make the gate pass would have been to claim
a false reconciliation — asserting an effect is present when it is provably
absent. That is precisely the failure mode this work exists to prevent.

The applier additionally required `pending.length === 1`, so it could not apply
one approved migration while other legitimate Build 34 migrations remained
pending.

---

## METHOD

Classification is by **physical effect**, never by filename or timestamp.

1. `supabase_migrations.schema_migrations` read read-only from production (95
   rows: version, name, statement count, statement length, and a
   whitespace-normalised md5 of the statements).
2. The full production object inventory read read-only: `pg_class` (tables and
   indexes), `pg_proc` with `pg_get_function_identity_arguments` **and**
   `pg_get_functiondef`, `information_schema.columns`, `storage.buckets`, and
   `has_function_privilege` / `aclexplode` for grants.
3. Each of the 172 governed migrations was parsed for the objects it declares
   (tables, functions, indexes, policies, triggers, added columns), and those
   objects were checked against the live inventory.
4. Renumber claims were corroborated three ways where possible: the production
   ledger row's own logical name and statement length, the migration file's
   in-repo provenance header, and — for `20260723050000` — an exact normalised
   md5 match against the production ledger statements.

### Why signature-level checking mattered

A name-only check reported `get_item_reaction_counts` as "present" and would
have classified `20260916203000` and `20260916233708` as reconciled. The
identity-argument read shows production carries

```
public.get_item_reaction_counts(p_item_ids uuid[])
```

— the **one-argument** form. The Build 34 token-bound contract
`get_item_reaction_counts(p_item_ids uuid[], p_share_token text)` does **not**
exist on production. Both migrations are therefore recorded as genuinely pending
and **HOLD**, not reconciled. Recording them as reconciled would have asserted a
client-facing RPC contract production does not have.

---

## RESULT

```
RECONCILED_LOCAL_COUNT   = 22
RECONCILED_REMOTE_COUNT  = 18
REMOTE_ONLY_ALLOWED      = 5
KNOWN_PENDING_COUNT      = 78
UNEXPLAINED_REMOTE_COUNT = 0
UNEXPLAINED_LOCAL_COUNT  = 0
```

`22 reconciled + 78 known pending = 100 local-only`, and
`18 reconciled-remote + 5 production-only = 23 production-only`. Every divergent
version on both sides is accounted for, with evidence.

### Known pending, by disposition

| disposition | count | meaning | approvable |
|---|---|---|---|
| `KNOWN_FUTURE_UNAPPLIED` | 47 | effect proven absent; legitimate Build 34 work | yes, one at a time, by explicit approval |
| `HOLD` | 11 | known and classified, not cleared for execution at this SHA | **no** |
| `EXCLUDE` | 20 | must never execute against production | **no** |

The four account-deletion migrations the campaign targets are all
`KNOWN_FUTURE_UNAPPLIED`: `20260831140000`, `20260908230000`, `20260916130553`,
`20260917163000`.

### Why anything is EXCLUDE rather than merely pending

`EXCLUDE` is used where replay is harmful or meaningless, not merely unnecessary:

- `20260723021145` would **abort**: it issues `CREATE OR REPLACE` on
  `schedule_deletion_retry_or_fail` with a changed return type (text → boolean),
  which Postgres rejects once the lifecycle migration has run.
- `20260723021515`, `20260805120000`, `20260805121000` and `20260805130000` were
  authored **from** production — their headers record reading
  `wyyuqfdxucjksghsmhry` read-only — and exist to bring *staging* up to
  production's shape. Production is the origin, not the target.
- `20260813224918` targets `status='pending'`, and production holds **0** pending
  deletion rows. It is excluded rather than run so no ledger row asserts work
  that did not happen.
- `20260808121216` and `20260823175314` are recovered ledger-version twins of
  `20260808103028` and `20260823120000`. Only one local version may claim a
  remote row; the twin is excluded so the authority cannot double-claim.

### Why anything is HOLD

`HOLD` is the honest answer where the probe was inconclusive or where applying
would outrun the client:

- `20260916203000` / `20260916233708` — effect proven absent, but held behind
  frontend blocker **B34-FE-DR-001**. `20260916233708` *drops* the one-argument
  overload the currently shipped production client calls, so applying it before
  the Build 34 client artifact would break the live public room preview.
- `20260914120000` — `build_owned_item_snapshot` exists on production, but its
  live definition was not compared against the governed body, so it cannot be
  proven to be the hardened, cross-actor-closing one. Claiming it reconciled
  would assert a security property that was not verified.
- `20260814230933`, `20260814140000`, `20260915133739`, `20260803214253`,
  `20260812031312` — partially satisfied or grant-level deltas not enumerated in
  this pass.
- `20260618132214`, `20260722201910` — the legacy waitlist surface; whether it
  belongs on this project is an owner decision.
- `20260915232402` — a locked release decision rather than a probe result; see
  **Locked owner scope decisions** below.

(`20260819125700` and `20260819144630` were `HOLD` in the first pass and are now
`EXCLUDE` under `WEARABLE_SCOPE=EXCLUDE_FROM_BUILD34_PRODUCTION`.)

**HOLD is a classification, not a deferral of the honesty requirement.** A HOLD
entry still carries evidence, still counts as explained (so it does not read as
drift), and is still refused for execution.

---

## THE CAMPAIGN LIFECYCLE

A production campaign applies one approved migration at a time, over days. If a
`KNOWN_FUTURE_UNAPPLIED` entry became "stale authority" the moment its version
landed in the ledger, **every successful migration would invalidate the manifest**
and require a governed-source edit before the next one could run. Editing
authority between every production write is worse than the problem it solves.

So `KNOWN_FUTURE_UNAPPLIED` has two legitimate states:

| state | ledger | meaning |
|---|---|---|
| **A** | version absent | `KNOWN_PENDING` — approvable |
| **B** | that exact version present | `FULFILLED` — no longer pending, never selected again, still reported |

A fulfilled entry does not fail the gate and does not block the next migration.
The whole four-step account-deletion campaign runs on **one unchanged manifest**.

**The tolerance is deliberately asymmetric.** `HOLD` and `EXCLUDE` say the
migration must not run here. If one of them turns up in the ledger anyway,
something applied it outside this gate — which is precisely the unexplained
production mutation the authority exists to catch. That fails closed, loudly:

```
known-pending entry <v>: declared EXCLUDE, which must never be applied here,
but the remote ledger contains it — unexplained production mutation
```

---

## LOCKED OWNER SCOPE DECISIONS

Build 34's goal is **production must support the application contract safely** —
not production/staging parity, and not clearing every historical difference. The
following are release decisions, not drift findings.

| decision | versions | disposition |
|---|---|---|
| `SIGNATURE_STYLE_FREE_CLOSET_EVIDENCE_MIGRATION=HOLD_AS_CURRENTLY_WRITTEN` | `20260915232402` | `HOLD` |
| `WEARABLE_SCOPE=EXCLUDE_FROM_BUILD34_PRODUCTION` | `20260819125404`, `20260819125700`, `20260819144630`, `20260819151224`, `20260823170850` | `EXCLUDE` |
| `INVESTOR_SCOPE=EXCLUDE_FROM_BUILD34_PRODUCTION` | `20260824175813` | `EXCLUDE` |
| Non-canonical duplicate identity | `20260818000001` | `EXCLUDE` |

Notes that matter:

- **Signature Style.** `20260915232402` conflates legacy Recent Scan / utility
  evidence with owned Closet evidence. Its sibling `20260915214857`
  (`signature_style_free_entitlement`) is **not** covered by that decision and
  remains legitimate Build 34 work. The two are not equivalent and are not
  treated as such.
- **Wearables.** A content scan confirms `20260819125404`, `20260819151224` and
  `20260823170850` touch only `public.wearable_*` relations. `20260819125700`
  and `20260819144630` touch the shared `saved_scans.source` contract but exist
  to admit the wearable lane, so they are excluded by the scope decision rather
  than by object ownership. A scan of all 78 known-pending entries found **no
  other** wearable-only migration.
- **Investor.** A content scan confirms `20260824175813` touches only
  `public.investor_inquiries`. No other known-pending entry is exclusively
  investor infrastructure.
- **Not excluded speculatively.** `20260618132214` and `20260722201910` (the
  legacy waitlist surface) remain `HOLD`. They are website-adjacent, but no
  locked Build 34 scope decision covers them, so they are reported rather than
  excluded.
- **Display-name duplicate.** The registry declares `20260818141056` the
  canonical `ledgerVersion` and records `20260818000001` only as its
  `sourceOriginalFilename` (retained because `__tests__/stylistIdentity.test.js`
  reads it directly). Both carry byte-identical executable SQL, so only one may
  ever become a production ledger row. The non-canonical original is
  non-executable; the canonical copy carries the production identity.

---

## SECURITY INVARIANTS, VERIFIED LIVE

```
PUBLIC_EXECUTE                        = 0
UNPINNED_SECURITY_DEFINER_SEARCH_PATH = 0
UNPINNED_TRIGGER_SEARCH_PATH          = 0
ANON_EXECUTABLE_ROUTINES              = 3
  get_item_reaction_counts, get_public_room_preview, get_public_room_decision_preview
dressing_room_items_source_identity_key = ABSENT (as required)
```

No entry in this reconciliation widens a grant, adds a policy, or changes a
`verify_jwt` posture. Nothing here authorises a mutation.

---

## BUILD 34 CLIENT CONTRACT

This PR changes **no** schema, RPC, Edge Function, RLS policy, grant or
configuration on any environment, so it proposes no client-facing contract
change:

```
CLIENT_SURFACE                = none (governed tooling and manifest only)
CLIENT_CALLSITE               = none
CURRENT_PRODUCTION_CONTRACT   = unchanged
POST_MIGRATION_CONTRACT       = unchanged
BUILD34_CLIENT_EXPECTATION    = unchanged
BACKWARD_COMPATIBLE           = YES
CLIENT_CHANGE_REQUIRED        = NO
SAFE_BEFORE_BUILD34_ARTIFACT  = YES
```

The one place where the governed backend and the shipped client **do** disagree
is recorded, not resolved, here: production exposes the one-argument
`get_item_reaction_counts`, the Build 34 backend contract requires the
token-bound two-argument form, and the public Dressing Room route does not yet
pass `p_share_token` (**B34-FE-DR-001**). This reconciliation holds both
migrations rather than reconciling them, so the tooling cannot be used to apply
that contract ahead of the client. They are **not** loosened to approvable merely
because their backend effect is absent: they stay `HOLD` until the authoritative
Build 34 client callsites have been separately verified and the migration
sequence is explicitly authorized.

```
CLIENT_CONTRACT_REVIEW_REQUIRED = B34-FE-DR-001 (pre-existing; recorded, not introduced)
```

---

## WHAT THIS DOES NOT AUTHORISE

The manifest block is documentation of reality. It is not permission.

- A `KNOWN_FUTURE_UNAPPLIED` entry remains **non-executable** unless that exact
  version is separately supplied as `APPROVED_MIGRATION_VERSION` for one
  controlled invocation.
- Passing a version through an environment variable is **never sufficient**. The
  applier also requires the exact production target, the governed branch tip, a
  clean worktree, the migration to exist canonically and be legitimately
  pending, a clean prohibited-SQL scan, the production GitHub Environment
  approval, and the manual `DEPLOY TO PRODUCTION` confirmation.
- Unknown drift — an undeclared remote-only row, an undeclared local divergence
  — still **fails closed**, in both the preflight and the applier.
