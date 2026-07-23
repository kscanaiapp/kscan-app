# 14 — Unit Test Report (Phase 10)

## Runner
Node built-in `node:test` (Node v24.14.0). TS transpiled in-process (`typescript@5.9.2`) and run
in a VM sandbox; only native modules (`expo-image-manipulator`, `expo-file-system`) are stubbed
at their boundary — the modules under test are the **real** source.

## Command
```
node --test __tests__/imageUploadRegression.test.js __tests__/scanIdentification.test.js
```

## Result
| Metric | Value |
|---|---|
| tests | **59** |
| pass | **59** |
| fail | **0** |
| skipped | 0 |

## Coverage of required unit areas
URI normalization (`file://` accept, `ph://`/`assets-library://`/remote reject); metadata-strip
re-encode; MIME/filename derivation; sanitizer passthrough (v13 invariant); identify request
construction + `localPrivacyFiltered`; authorization/sign-in guard (401-class); oversized payload
(413-class client guard); abort/already-aborted ownership; temp cleanup best-effort;
HEIC/JPEG/PNG/screenshot fixtures present and non-zero.

## Verdict: **PASS**
