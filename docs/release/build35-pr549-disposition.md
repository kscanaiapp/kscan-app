# Build 35 PR #549 hunk disposition

Reviewed head: `5bb3fa1af9284aae7da2b8b2bcf1fc8b5465df63`.
Compared base: `eb842d55557bd904b7b6dbe9fcacec7994f73cdf`.
Authority: owner ship-first directive, with Today explicitly OFF in every profile.
These are source configuration results, not built-artifact or device certification.

| File / old hunk start | Disposition | Result and reason |
| --- | --- | --- |
| `__tests__/build35ReleaseProfile.test.js`: 20 | ADOPT | Canonical store-profile naming. |
| Same: 38 | ADOPT | Explicit approved feature-ON requirements. |
| Same: 83 | REJECT | Preserve inherited Today FALSE. |
| Same: 92 | MODIFY | Exercise effective Voice OFF override; Speech is temporarily OFF pending environment controls. |
| Same: 117 | MODIFY | Preserve owner Today assertions. |
| Same: 136 | MODIFY | Require all three Today flags OFF in every profile and reject each ON override. |
| `__tests__/nativeConfigParityGate.test.js`: 237 | ADOPT | Authorize production and build35-release native selectors. |
| Same: 364 | ADOPT | Voice UI and native capability must agree; unauthorized Staging selector rejected. |
| Same: 410 | ADOPT | Reject removing production's native selector. |
| `android/app/build.gradle`: 226 | ADOPT | Add build35-release to approved native Voice profiles. |
| `config/native-config-authority.json`: 10 | ADOPT | Explain approved Build 35 store selectors. |
| Same: 34 | ADOPT | Voice selector profile authority. |
| Same: 50 | ADOPT | Remote-push selector profile authority. |
| Same: 71 | ADOPT | Retain artifact verification requirement. |
| Same: 82 | ADOPT | Combined capability selector profiles. |
| Same: 95 | ADOPT | Retain artifact verification requirement. |
| `eas.json`: 244 | MODIFY | Enable approved production features and native Voice; all Today flags FALSE; Speech FALSE pending deployed security/cost controls. |
| Same: 265 | MODIFY | Apply the same Build 35 store matrix. |
| `scripts/check-build35-release-profile.js`: 8 | MODIFY | Explicit Today OFF and temporary Speech environment gate. |
| Same: 23 | MODIFY | Require approved features/native Voice ON; exclude Today and pending Speech. |
| Same: 51 | ADOPT | Derive approved ON set from explicit required matrix. |
| Same: 98 | MODIFY | Remove obsolete dormant-child allowance; retain exhaustive Today hold. |
| Same: 144 | MODIFY | Approved feature allowlist excludes Today. |
| Same: 165 | REJECT | Preserve the owner hold guard, extended to every profile. |
| Same: 226 | ADOPT | Report the actual feature matrix guard. |

Speech remains a SHIP_TARGET. Its disclosure is owner approved, and client
consent plus server kill switch/budget controls are implemented. Store-profile
activation remains an unresolved pre-build requirement until the governed
environment deployment and verification are complete; it is not a product hold.
Watchlist push is a SHIP_TARGET; source native activation is integrated, while
worker scheduling, Production configuration and device delivery require their
own evidence. Physical audio and notification receipt are POSTBUILD_REQUIRED.

Validation of these configuration changes: 105 release/native assertions pass;
release-profile guard and native source-parity guard pass. Full regression and
independent final-candidate review remain required. Old dark-feature assertions
must be reconciled explicitly, without expanding the failure baseline.
