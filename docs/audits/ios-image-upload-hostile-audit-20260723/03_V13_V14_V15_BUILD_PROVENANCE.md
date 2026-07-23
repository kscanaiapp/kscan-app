# 03 — v13 / v14 / v15 Build-to-Source Provenance (Phase 1)

The iOS TestFlight builds are labeled by the `expo.ios.buildNumber` field in `app.json`.
**The label alone is NOT trusted** — it is corroborated against commit ancestry, dates, and
runtime-consistency logic.

## Build number → introducing commit (along `fix` branch first-parent ancestry)

| buildNumber | introduced at | date | shipped-tree tip (parent of next bump) |
|---|---|---|---|
| 13 | `13ef03d` | 2026-07-10 | pre-gate range |
| 14 | `d80b767` | 2026-07-17 08:40 | `54785a5` |
| 15 | `5146ad1` | 2026-07-18 | `32addd5` |
| 16 (prior repair, **not built by this task**) | `79f1106` | 2026-07-23 | `b1ac92c` |

## Provenance findings

### v13 — known-good runtime baseline
- **Physical source ≈ pre-gate tree at/near `13ef03d`** (buildNumber 13, 2026-07-10).
- **Proof of exclusion:** the buildNumber-13 label *also* sits on `5a825f7` (2026-07-17), but
  `5a825f7` already contains the fail-closed gate (commit `2c8feeb`). A build from `5a825f7`
  would fail closed on 100% of uploads. Since v13 upload **worked** on device, the physical
  v13 binary **cannot** be `5a825f7`; it must be the earlier pre-`2c8feeb` tree.
- At `13ef03d`: `sanitizeImageBeforeUpload` = `passthrough`/`return input`; **no** privacy
  proof gate. This directly explains why upload worked.
- **Confidence: STRONGLY SUPPORTED** (source + runtime-consistency logic). Not PROVEN —
  EAS build logs for v13 were not available to this audit to pin the exact SHA.

### v14 — built, expired before physical test
- Source tip `54785a5` (buildNumber 14). **Contains** the gate (`2c8feeb` is ancestor).
- Runtime upload status **UNKNOWN** (expired untested). At source it is regression-bad.
- **Confidence: STRONGLY SUPPORTED** (source).

### v15 — known-bad runtime baseline
- Source tip `32addd5` (buildNumber 15). **Contains** the gate.
- Physical device: image upload **failed**. Consistent with the source-level fail-closed lock.
- **Confidence: STRONGLY SUPPORTED** (source + physical runtime).

## Environment (constant across the window)
Expo SDK 54, app version 1.0.1, single origin remote, `production`/store EAS profile per
`eas.json`. `package.json`/`package-lock.json` changed within the window but not in a way that
affects the upload boundary (see 08 H6).

## Uncommitted-source risk
Worktree clean at audit; no evidence uncommitted source entered any build from this worktree.
Prior-agent build report claims its worktree was cut cleanly from the v15 commit.
