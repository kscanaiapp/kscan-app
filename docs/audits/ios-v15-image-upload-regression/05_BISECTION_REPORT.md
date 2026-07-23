# 05 — Bisection Report

## Method

1. Anchor known-good v13 and known-bad v15 EAS SHAs.
2. Use v14 as midpoint checkpoint.
3. Inspect upload-critical modules at each anchor.
4. Identify first commit that flips sanitizer / upload / identify gates.

## Results

| Checkpoint | Sanitizer | Upload available | Proof gate | Verdict |
|---|---|---|---|---|
| v13 `d5e19ee` | passthrough | N/A (module absent) | absent | GOOD |
| Pre-`2c8feeb` | passthrough | metadata re-encode works | absent | GOOD |
| `2c8feeb` | throws | `false` | present | **BAD** |
| v14 `9c87f48` | throws | `false` | present | BAD |
| v15 `32addd5` | throws | `false` | present | BAD |

## First bad commit

`2c8feeb` — `fix(elise): fail closed and isolate scanner return`

## Bisect criteria against harness

| Criterion | v13 | v15 | Post-repair |
|---|---|---|---|
| Picker succeeds | Yes | UI disabled / prep throws | Yes |
| Readable file | Yes | N/A | Yes |
| Prepared image | Yes | Fail | Yes |
| Valid MIME / filename | Yes | N/A | Yes |
| Request created | Yes | No | Yes |
| Authorization attached | Yes | N/A | Yes |
| scan-identify invoked | Yes | No | Yes (unit-stubbed) |
| Response handled | Yes | Error privacy copy | Yes |

## Classification update

Provisional Phase 0A class **D/E (request never created / never sent)** confirmed. Visible gallery label also makes class present as **UI-disabled intake** before networking.
