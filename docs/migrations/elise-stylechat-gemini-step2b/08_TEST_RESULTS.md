# 08 — Test results

```bash
node --test __tests__/eliseModelRouting.test.js __tests__/edgeStyleDnaContext.test.js
```

**19/19 passed**

Coverage: model defaults, empty env, GEMINI_MODEL ignored, retired rejected, client override ignored, fallback wiring, Signature Style bounds/truncation, StyleDNA separation, thinking deferred, quota migration SQL present, StyleDNA delimiter update.

Deferred: full SQL concurrency matrix against live DB (requires authenticated RPC harness); pre-existing `services`/`_shared` `abuseControls.ts` byte-sync drift unrelated to Step 2B.
