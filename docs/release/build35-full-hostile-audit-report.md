# Build 35 full hostile campaign — PARTIAL EVIDENCE PACKAGE

Verdict: **FAIL — BLOCKING ISSUES REMAIN**. The full campaign is not complete. No source-convergence, complete hostile-audit or platform-readiness certification.

## Scope actually executed

Fetched all three authorities, inspected release governance, verified eight specified PR merges, created three isolated worktrees, inventoried source paths, captured authenticated staging/production function inventories, ran baseline suites, traced mounted discovery source and investigated Gemini consent. Full lanes F/B/C/G remain incomplete; D/E/H not audited. No lane receives a default PASS.

## Confirmed repairs

- B35-G-001 P2: malformed secondary display fields accepted into primary render host. Regression fails before; targeted repair 22/22 passing. Draft #644, bd2827e7bb524cf149ac01ae5443f2901bbb29f6; unmerged and undeployed.
- B35-C-001 P1: unnamed image-only consent and legacy v1 completion omit Gemini chat disclosure/upgrade. Two failing before assertions; focused 39/39 after. Draft #645, 8c86a9fd; unmerged and undeployed. Not universal consent certification.
- No confirmed P0 or P3 entered yet; no claim that none exist. Unconfirmed investigations and untriaged test failures remain explicit.

## Validation actually completed

| Source / command | Result | Limits |
|---|---|---|
| Integration 65a1e7cd full Node, direct node --test --test-concurrency=4 over 625 discovered files | 11179 pass / 0 fail / 98 skipped, 11277 total | Before consent repair; individual skips not yet classified |
| Same integration baseline governed Deno runner | 1422 pass / 0 fail | Deterministic tests, not live provider proof |
| Backend authority discovery directory, Deno | 28 pass / 0 fail | No live catalog/provider certification |
| Pre-freeze with #644 repair, direct Node over 517 discovered files | 9332 pass / 68 fail / 67 skipped, 9467 total | FAIL; no baseline suppression. Failures require triage; path-separator mismatch and local tooling are among observed causes |
| #644 focused discovery client/host | 22 pass / 0 fail / 0 skip | Latest local repair source |
| #645 focused consent/onboarding/legal | 39 pass / 0 fail / 0 skip | Latest local repair source |
| TypeScript --noEmit on both baseline trees | exit 0 | Completed before final consent edits |
| Clean npm ci --ignore-scripts --no-audit | Successful in both mobile worktrees | No package version changes; native scripts intentionally not run |
| TestSprite CLI/auth/project/test discovery | Available | Native patch undeployed, no reachable target containing changes, no TestSprite MCP; UNVERIFIED-BECAUSE-UNDEPLOYED. Old backend runs do not verify these patches |

Initial missing-module runs started before install completion and are INVALID, excluded from product findings. Local raw logs remain in evidence. Passing CI captured for #644 includes skipped paid/device lanes; skipped jobs are not runtime certification. #645 CI pending.

## Runtime and governance

Production discovery absent; staging ACTIVE v5 JWT=true with recorded digest. Production Scanner v179 JWT=false retained intentionally; in-function auth source reviewed in part, exhaustive hostile checks pending. No runtime flags, store prices, full bundle/source parity or signed-binary live status certified. Migration query blocked by IPv6; no alternate unauthorized database operation.

RP-108 conflicts with promoting Build 35 onto pre-freeze. Pending owner target selection; no silent authority change or conflict resolution. No production writes, deployments, migrations, secret mutations, commercial activation, builds or submissions made.

## Remaining work

Use checkpoint, integration matrix and mandatory individual probe inventory. Finish F then B/C/G/D/E/H/A; classify 68 failures; attribute all required attack probes; inspect exact runtime bundles and flags; resolve authority; verify CI/review and integrate repairs; rerun full converged validation. Neither draft PR is a release-ready merge claim.

Artifacts: repair ledger, backlog, integration matrix, processor inventory, convergence record, platform handoff, claim verification and checkpoint in this directory.

Additional Lane F executed probe: all 18 Production endpoints marked verify_jwt=true returned HTTP 401 to an anonymous POST with an empty object. Evidence: evidence/anonymous-endpoint-probes.json. This verifies gateway rejection only, not authenticated IDOR, handler authorization, storage isolation or tampered-token rejection. Corresponding mandatory-probe cells updated individually. No authenticated/customer/provider operation requested.
