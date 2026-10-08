# Build 35 Watchlist backend convergence

This repair carries the exact `commerce-watch-refresh` source and regression tests from mobile PR #520 (`abc655b652cc8eb039a4b4c94ee33f36ef2df27f`) onto canonical backend authority `a2d8d6bbef605a7692eb08e91acf1ae1c26c3693`. It remains separate from the contextual VTO lane. No migration, Production write, worker activation, or provider call is included.

Root cause: both deployed Watchlist implementations lack #520's final canonical entitlement check immediately before provider observation. Earlier entitlement checks leave a lapse race between claiming a watch and dispatching its observation. The restored guard skips the observation when authority is inactive or unavailable and preserves reactivation behavior.

The complete reachable bundle matches #520 exactly: `abcb61d6fcf919d81a9f046ed7d9e9fe7ec9a1e15ac6a17e3fb3cdcb911c79fd` (16 files). Fresh read-only inspection found Staging v16 and Production v10 on the earlier 15-file closure. Production is frozen. Staging deployment is permitted only after this exact head earns all required CI evidence.

Local validation: both focused Deno entitlement tests passed, including lapse before dispatch and unavailable/nonboolean fail-closed authority. The entrypoint passed `deno check --no-config --no-lock`. Exact-head Linux CI remains required.

Initial canonical-branch dependency CI exposed four unpatched resolutions inherited from this backend base. The repair recovers integration #512's pinned `compression`, `proxy-addr`, `shell-quote`, and `source-map-js` versions and the corresponding lockfile entries. No reachability exception, test baseline, or unrelated package was changed. Final-head CI is still required.

Existing evidence records 1 of 2 authorized forced Watchlist refreshes used. Empty scheduled calls do not establish provider spend. The remaining paid allowance must be reconciled before invoking a provider. Runtime lapse denial/zero dispatch, refreshed observation, and native-device behavior remain unverified for this backend source.

Production inspection found `watchlist_worker_enabled=true`; this conflicts with the Build 35 autonomous-worker hold and requires separate owner authorization to correct. This PR does not change that setting or scheduler.
