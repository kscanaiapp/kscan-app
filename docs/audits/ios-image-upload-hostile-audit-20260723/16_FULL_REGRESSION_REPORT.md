# 16 — Full Regression Report (Phase 12)

## Command
```
node --test __tests__/*.test.js      # 99 test files
npx tsc --noEmit                      # TypeScript project check
```

## Mobile / JS suite
| Metric | Value |
|---|---|
| test files | 99 |
| tests | **1616** |
| suites | 2 |
| pass | **1616** |
| fail | **0** |
| cancelled | 0 |
| skipped | 0 |
| duration | ~9.7 s |

> Note: pass the explicit file glob (`__tests__/*.test.js`); passing the bare directory
> (`__tests__/`) makes `node --test` try to load the directory as a module and errors — a runner
> artifact, not a suite failure.

## TypeScript
`tsc --noEmit` → **exit 0**, no diagnostics. (`tsconfig` extends `expo/tsconfig.base`, excludes
`supabase/functions/**`.)

## Coverage of required validation areas
Scanner, TextScan, multi-image, multi-item, Recent Scans, Save All, Dressing Rooms, Shared
Rooms, Elise, image attachments, provenance, digest continuity, authentication, account
switching, quota handling, Android source parity, request-contract tests, edge-function
contract tests — all represented in the 99-file suite and green.

## Lint / format
No lint/format script is configured in `package.json`; TypeScript strictness via
`expo/tsconfig.base` is the enforced static gate and passes.

## Verdict: **PASS**
