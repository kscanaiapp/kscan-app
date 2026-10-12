# Build 35 deployment verification

Backend authority: `69432b51a88d71a6bf8ea431fbc340db9c46434c`, containing reviewed, green PRs [554](https://github.com/kscanaiapp/kscan-app/pull/554) and [555](https://github.com/kscanaiapp/kscan-app/pull/555). Mobile integration engineering validation: `a28113b14a101ca2463ef620c74bfeafe53ea0bc`. This ledger is not a final freeze declaration.

## Speech database

`SPEECH_PRODUCTION_MIGRATION=PASS`.

- Exact migration `20261011222213_build35_speech_operational_cost_controls`, applied alone in [Production run38262097541](https://github.com/kscanaiapp/kscan-app/actions/runs/38262097541), conclusion SUCCESS. No function replacement or destructive migration.
- Live Production and Staging match: 14 columns, 12 constraints, five indexes, both RPC definitions. Functions owned by postgres, SECURITY DEFINER, empty search path; EXECUTE granted to service_role, denied to anon/authenticated. All three tables have RLS and deny client SELECT.
- Provider singleton disabled, daily character budget zero; reservation and cost row counts zero. Transaction-local disabled reservation contract returned `allowed=false, reason=disabled`; rolled back, no actor created or provider request.
- Security advisors show only expected Speech INFO notices for RLS tables without client policies. These controls intentionally expose no client row policy.

## Speech function

[Staging run38259807418](https://github.com/kscanaiapp/kscan-app/actions/runs/38259807418) succeeded from reviewed source `b692b87c81dfeb3bae4ae684d5159a0d41892122`. Live ACTIVE version75, verify_jwt=true, eszip digest `333ff2808b4ae6d94b07943b56f27c5e18ed5485b5cd7001e4051ab07642e62f`; all11 runtime files equal the reviewed source after LF normalization. Backend manifest bundle digest `2b60297e4523fbffba22f1b3cdddee05a8a2279b22fb3de3cc8d3aa7c867ed3f` is a different digest representation.

Provider-free [TestSprite execution](https://www.testsprite.com/dashboard-v3/o/42d96632-b284-52d4-9df9-6c0d70ebeb51/projects/135d7e41-d894-4a28-848a-7d4f75e6dc90/execution/7c05f8b8-29b6-4c39-855b-fd4769485d10) passed OPTIONS, missing-auth and invalid-JWT checks. Actual SQL fixture21/21; network-withheld backend1253/1253 at authority source.

Production before promotion: ACTIVEv51/JWTtrue, digest `e77653eea970c0ca7565ca180ba30eefa31f8a19053a2cfedf3b0599210c76de`. Its old handler does not use the new reservation RPC. Consequently, the new database control is verified but its runtime enforcement must not be inferred for the old function. [Function-only run38266249040](https://github.com/kscanaiapp/kscan-app/actions/runs/38266249040) is prepared behind Scanner; no repeat migration. Provider enablement and a positive allocation remain separately unauthorized.

## Scanner

[Corrected function-only run38265655585](https://github.com/kscanaiapp/kscan-app/actions/runs/38265655585) targets scan-identify, verify_jwt=false, no migration, authority SHA above. Preflight and source validation passed; protected human approval and successful deployment/live verification remain required.

Previous run38256999066 refused capture before replacement. Actual cause: current CLI creates `.temp/linked-project.json`; source-layout guard rejected it. PR555 validates the exact project reference/schema while refusing unknown files. Read-only Production capture verified all42 files; Production before replacement ACTIVEv172/JWTfalse, eszip digest `e5b6e5d4a539567fd2f4b76a55738ba410023e0848f6988d242a0fa9e5c22b23`. Private recovery and post-deployment contracts must pass before recording deployment PASS.

## Watchlist and engineering evidence

Staging Watchlistv17 matches all16 current runtime files; Productionv10 has a stale entrypoint and lacks the per-observation entitlement guard. Prepare separate governed commerce-watch-refresh promotion, preserving JWTfalse and workerdisabled. Worker activation permits paid commerce work and requires an explicit allocation; physical push receipt is post-build verification.

[Integration CI38259495290](https://github.com/kscanaiapp/kscan-app/actions/runs/38259495290) passed10802Node tests with97skips and zero failures, plus1371backend Deno tests with zero failures. Native declarative parity17checks and both store-profile configuration guards pass. Independent RevenueCat/K+ source review found no P0/P1/P2 source defect at the integration SHA; core Elise/Speech remain Free and Watchlist uses canonical K+ authority.

Outstanding store-readiness evidence is recorded in `OWNER_DEPENDENCIES.md`: live build identities, Apple metadata, Play product/base-plan state and RTDN/delivery. The owner explicitly deferred console inspection to certification/submission. These gaps do not stop unrelated engineering. No store, payment, provider allocation, EAS artifact or signing generation is authorized by this ledger.
