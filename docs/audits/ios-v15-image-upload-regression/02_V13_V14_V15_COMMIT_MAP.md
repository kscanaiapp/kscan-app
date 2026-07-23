# 02 — v13 / v14 / v15 Commit Map

## Anchor SHAs

- v13: `d5e19eea984d863182694bee065848efaeab6a7e`
- v14: `9c87f48ab4c31e9e3b7a85fccc13e691f66ab72e`
- v15: `32addd55187e4742c197e46e36d9d1cb0e0bf63c`

## Upload-critical commits inside v13 → v14

| SHA | Summary | Upload impact |
|---|---|---|
| `2c8feeb` | fail closed and isolate scanner return | **FIRST BAD** — sanitizer throw, proof gate, upload disabled |
| `4b9a092` | surface privacy fail-closed reason | Reinforces sanitizer userMessage |
| `038e96c` | disable gallery intake without pixel masking | Greys Upload UI via `isPrivateImageUploadAvailable()` |
| `0f52958`…`9c87f48` | Elise multi-image, multi-item handoff, dressing-room fixes | Features preserved; not the break |

## v14 → v15 (narrow window)

| SHA | Summary | Upload impact |
|---|---|---|
| `5146ad1` | prepare build 15 | Version bump only |
| `54785a5` | audio asset runtime dependency | Unrelated |
| `5617c4f` | recoverable photo-library settings flow | Improves permission UX; not the break |
| `32addd5` | shared-room inspiration previews | Unrelated to Scanner sanitize/invoke |

## Graph (simplified)

```
v13 (d5e19ee) ──► … Elise/auth/rooms … ──► 2c8feeb [FIRST BAD]
                                         ──► 038e96c [UI disable]
                                         ──► 9c87f48 = v14
                                         ──► 5146ad1 prepare build 15
                                         ──► 32addd5 = v15
```

## Decision

Regression entered **v13 → v14**. Do not treat v14 as good merely because it was untested.
