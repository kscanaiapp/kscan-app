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

## Continuation classification and closure readiness

Read-only GitHub inspection on 2026-10-12 confirmed PR #549 remains OPEN at the
reviewed head above. Its six changed files contain no Scanner runtime changes.
The intended shipping configuration was integrated by `f208559d`; `32b9c427`
reconciled the remaining shipped-profile regression assertions. Those results
do not substitute for final deployment evidence or a freeze at the final SHA.

| Relevant change | Classification | Final disposition |
| --- | --- | --- |
| Approved Voice/push native selectors and Closet, Packing, VTO, Concierge and Scanner feature matrix | SHIP | Already integrated; preserve the approved source configuration. |
| Today parent/children ON and relaxed Today assertions | REMOVE | Rejected; preserve all three flags OFF in every profile and NC-PV-01. |
| Speech ON and corresponding release-profile assertion | RETEST | Shipping target; activate the intended profiles after governed security/cost controls are deployed and verified. |
| Earlier dark-profile assertions and obsolete selector constraints | SUPERSEDED | Replaced by the owner-approved shipping contract and regression assertions. |
| Scanner residual repairs from PR #550 | SHIP | Preserve canonical backend source; PR #549 contains no replacement Scanner runtime hunk. |
| Production recovery/capture repairs from PR #551/#552 | SHIP | Execute from canonical backend authority; the mobile integration branch retains its non-authoritative role. |
| Migration negative-control isolation from PR #553 | SUPERSEDED in mobile integration | Equivalent, stronger fixture isolation already exists on the integrated line; preserve it instead of downgrading the controls. |

Merged backend authority `4b71ce543d5aad6acd2de8d2f1340487a4b21400`
contains PR #552 and #553. Its Scanner runtime source is unchanged from
`3c63471301643958ae31d3b14cf2f36f93210e40`, already converged in the mobile
candidate. Backend deployment authority and mobile source freeze remain
separately identified.

Close PR #549 as superseded only after the final integration configuration,
including the verified Speech activation contract, is recorded on the
replacement integration PR. The closure record must link that replacement,
identify its exact SHA and this hunk disposition, and state that Today remains
OFF. Do not merge PR #549 wholesale: its reviewed patch turns Today ON. No PR
closure or external write was performed by this reconciliation review.
