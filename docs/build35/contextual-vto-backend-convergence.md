# Build 35 contextual VTO backend convergence

This repair carries the exact reviewed VTO and StyleChat deploy units from mobile PR #521 (`fbe96bb8935914dd1dfe540e778e2f7c89cb1733`) onto canonical backend authority `a2d8d6bbef605a7692eb08e91acf1ae1c26c3693`. The mobile source remains non-authoritative; its deployment marker is not changed. No migration, Production write, provider call, or feature activation is part of this PR.

Root cause: the contextual VTO source was converged onto mobile integration but had not reached the declared backend deployment branch. Matching deployed function names did not establish source parity. A fresh read found Staging VTO v19 and StyleChat v133 already byte-equivalent after LF normalization to #521's complete reachable local import closures (18 and 52 files respectively). These functions do not need redeployment to acquire that source identity. Production remains on older versions and is frozen.

Complete bundle identities are unchanged by this recovery:

- `vto-generate`: `cfac5d6fd1359b4ad83b3a516ee9d6d983be9d9970e59395da17df2d980e64e4`
- `stylechat-generate`: `ca1b4c860b49bc8d8b94aa260eaf908830aee8b35328679121209bacd2c9285c`

Local validation: 83 focused Deno tests passed; both entrypoints typechecked using `deno check --no-config --no-lock`. The no-config option prevents mobile package auto-discovery during this backend-only validation; it does not alter source, test assertions, or CI. Exact-head Linux CI remains required before merge.

The first canonical-branch CI run exposed pre-existing unpatched dependency resolutions (`compression`, `proxy-addr`, `shell-quote`, `source-map-js`) and missing exact VTO scope inventory rows. This repair recovers the same four pinned remediation versions already used on integration by #512, updates only their lockfile resolutions, and records the six exact existing authorized backend/test paths. No exception or failure baseline was widened. The initial Project checks Linux run passed before these configuration repairs; the final head must re-run all gates.

Staging zero-spend evidence on #521: [run 37807287304](https://github.com/kscanaiapp/kscan-app/actions/runs/37807287304), 22 controls PASS, zero reservations/provider submissions/paid requests, clean synthetic actor cleanup. This does not certify paid generation, candidate UI, native devices, store purchases, or Production activation. Paid tests remain held pending the remaining allowance.
