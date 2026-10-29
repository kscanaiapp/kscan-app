# Source convergence record — PARTIAL

| Authority | Fetched SHA |
|---|---|
| origin/release/kscan-pre-freeze-v1 | 840ba88ee41e97de8d9d63ad5f3d3dd03fd457a2 |
| origin/integration/build35-v1-convergence | 65a1e7cd6c2bea790e87c009a41de999d6cf2fa8 |
| origin/rebuild/backend-authority-v2 | 3efcb6cbf29eb10c1bc1510f05e9a3365755bd74 |

Original directory C:/Users/jsmit/KScan is bare. Isolated worktrees: C:/b35full1029, C:/b35int1029, C:/b35be1029. Other engineers' trees were not modified. Local pre-freeze ref was 82b9b7cfea4d59e6706db19588969e4efd07b489; local integration was 5a0e2c3dae04e27e2528f05967388e3c19b2a346. Backend local branch absent. Fetched remote heads govern inspection.

Mobile/integration merge base e97de30eab67691b91f9d68ffbb5ef2635aa0741; ahead counts 5 mobile-only / 512 integration-only. Merge preview conflicts: PurchaseOptionsPanel.tsx, ScanResultV2.tsx, package.json, posthogClient.core.ts. No merge performed. RP-108 expressly excludes Build 35 ancestry on pre-freeze; target resolution is pending owner answer. No new authority declared.

PRs #635/#637 merged into integration; #636/#638/#640/#641 merged into backend; #642/#643 merged into pre-freeze. Exact merges, file lists and then-current checks: evidence/pr-*.json. Open PR inventory included #625/#627/#582/#566 against integration and unrelated work. These are not incorporated or certified by this campaign.

Repair #644: bd2827e7bb524cf149ac01ae5443f2901bbb29f6 on audit/build35-full-hostile-20261029. Repair #645: 8c86a9fdabcd1bff905e86423d4033a3c8ed7e62 on audit/build35-integration-hostile-20261029. Both draft/unmerged. Conditional order: #644 then #645, then owner-selected convergence. No conflicting-file repairs run concurrently.

Mobile branch protection API returned 404 (not protected); rulesets and branch rules captured separately. This does not waive governed CI/review. Final candidate SHA: NOT SELECTED. Final clean-tree proof and final CI: NOT AVAILABLE. Working report artifacts are intentionally uncommitted until this checkpoint is saved.
