# 01 — Release Provenance

## Known releases (EAS production / store distribution)

| Label | Platform | Version | Build Number | Build ID | Commit SHA | Branch at build | Physical QA |
|---|---|---|---|---|---|---|---|
| **v13 (known good)** | iOS | 1.0.1 | 13 | `4c5a97af-a215-4389-930f-0873ac0aa5c5` | `d5e19eea984d863182694bee065848efaeab6a7e` | EAS-recorded commit | Upload worked |
| **v14 (untested)** | iOS | 1.0.1 | 14 | `ef0f19db-fd09-4170-8607-b53e4fd19977` | `9c87f48ab4c31e9e3b7a85fccc13e691f66ab72e` | EAS-recorded commit | Expired before physical test |
| **v15 (known bad)** | iOS | 1.0.1 | 15 | `5dd6b128-82dc-4deb-b769-7a5403b002da` | `32addd55187e4742c197e46e36d9d1cb0e0bf63c` | `integration/ios-v15-second-pass-test-ready` | Image upload broken |

## Ancestry

```
git merge-base v13 v14  => d5e19eea… (v13)
git merge-base v14 v15  => 9c87f48a… (v14)
git merge-base v13 v15  => d5e19eea… (v13)
```

v13 ⊆ v14 ⊆ v15 (linear ancestry on the iOS integration line).

## Regression window

- Source-level failure first appears in **v13 → v14** at commit `2c8feeb` (`fix(elise): fail closed and isolate scanner return`).
- v14 is therefore a **source-bad checkpoint**, even though physical QA never ran.
- v15 inherits the same broken gates; later commits in v14→v15 do not restore upload.

## Repair branch

- Branch: `fix/ios-v15-image-upload-regression`
- Base: `32addd5` (exact v15 EAS SHA)
- Target QA build number: **16**
