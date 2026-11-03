# Batch 2 mutation controls (one guard at a time, file restored with `git checkout`, blob verified)

Source: `2c2c9da4`. Each target was restored after every run; `services/vto/vtoFeatureControl.ts` blob `ad7daced` and `vtoLiveGarmentRegistry.ts` blob `b0b5ec5e` were confirmed afterwards.

## live-batch2.test.cjs
| Mutation | Detected by |
| --- | --- |
| L1-L4 hook guards (single-flight, dispose, unmount, denial) | 2775 / 2776 |
| L5 registry URL validation line removed | 2767 / 2768 / 2769 |
| L6 Studio member gate loosened | 2791 composition |
| L7 stale mapped to member | 2791 composition |
| dispose@141, dispose@206 | 2775 / 2776 |

## live-remote-source-1102.test.cjs (retained tests, run against a mutated `vtoFeatureControl.ts`)
| Mutation | Result | Failing tests |
| --- | --- | --- |
| `schemaVersion` check disabled (line 69) | detected | wrongSchema (2787) |
| `if (error)` returns an ENABLED config | detected | 401, 429, 500 (2788, 2783, 2782) |
| `catch` returns an ENABLED config | detected | empty, malformedJSON, timeout (2786, 2785, 2784) |
| `withTimeout` bound set to 1e9 | detected | timeout (2784) |
| `if (error)` branch merely disabled (falls through to `data?.value`) | SURVIVED, equivalent mutant: a faulted read returns `data: null`, which normalises to DISABLED anyway | none |
| non-object payload guard removed (line 65) | SURVIVED, equivalent mutant: `undefined` then throws and the `catch` returns DISABLED | none |

The two survivors are defence-in-depth redundancies: a second guard fails closed, so neither is observable from outside. They are not gaps in the cells claimed.
