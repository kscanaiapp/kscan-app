# Phase 0E — Amendment: what "1 model call" meant

The Phase 0E-R1 report said the certified path executed with **"1 model call on
`gemini-3.6-flash`"**. That phrasing was ambiguous. "Model call" could be read as
a live provider request, which would imply provider spend. It was not one.

This amendment states the counts separately and proves the zero-network claim at
the runtime level rather than by assertion.

---

## 1. Disambiguated counts

Per scenario, in `detect_items` mode against certified v140:

| Metric | Value |
|---|---|
| `modelRouteInvocationCount` | **1** (2 for the fallback scenarios) |
| `mockProviderInvocationCount` | **1** (2 for the fallback scenarios) |
| `externalGeminiHttpRequestCount` | **0** |
| `unexpectedNetworkAttemptCount` | **0** |
| `paidProviderCallCount` | **0** |
| `actualProviderCost` | **$0.00** |

**A model-route invocation is not a live provider call.** What happened is:

1. The certified router selected `gemini-3.6-flash` and built the request URL —
   this is the certified routing logic executing, which is the thing worth
   proving.
2. It called `globalThis.fetch`, which had been **replaced before the certified
   module was imported**, so control never left the process.
3. The interceptor returned a synthetic `Response` in Gemini's real
   `candidates[].content.parts[].text` envelope.

No socket was opened, no credential was transmitted, and no provider was billed.

## 2. Proof, not assertion

The zero-network claim is not resting on the interceptor being correct. The same
run was repeated under Deno's permission system with **all** network access
denied:

```bash
deno run --deny-net --allow-read --allow-env --allow-write --no-lock \
  --node-modules-dir=none certifiedHarness.ts \
  --cert-root <path> --scenario completed --mode detect_items
```

Result: `httpStatus 200`, `modelRouteInvocations 1`,
`modelsUsed ["gemini-3.6-flash"]`, `unexpectedNetworkAttempts 0`,
`payload.status "completed"`.

Under `--deny-net` a real socket would have been refused by the runtime and the
run would have failed. It completed. Therefore **no external request occurred** —
this is a runtime-enforced fact, not a property of my own stub.

The `GEMINI_API_KEY` present in the harness environment is the literal string
`harness-synthetic-key-not-a-credential`. No production credential was used or
read.

## 3. A second, separate correction

The Phase 0E-R1 report said the path executed with `status: completed`. True, but
incomplete in a way that matters:

The certified quality-tune telemetry for those runs reported
`provider_outcome: "none"` and **`candidate_count: 0`**, and the projected V2
`item.category` and `item.subtype` were **null**.

The reason: `detect_items` is the multi-item **detection** path and expects a
detection envelope containing candidate entries. The mock envelope supplied was
a single-item `identification` object, so the certified parser ran and correctly
found **zero candidates**.

So the honest characterisation is:

- **Proven executing:** request validation, project-access gating, V2 activation,
  intent and evidence validation, prompt construction, model routing (primary and
  fallback), provider-response parsing, quality processing, telemetry
  construction, response projection, and bounded error mapping.
- **NOT yet proven:** that a populated V2 `item` is produced end to end. That
  needs either a detection-shaped mock envelope for `detect_items`, or the
  `identify_selected_item` path — which is itself gated behind a prior detection
  session (`selected_item_image_mismatch`), consistent with the known Phase 2B.2
  behaviour that the backend emits no `detectionDigest`.

## 4. Effect on the Lane E2 verdict

Lane E2 remains **COMPLETE** for what it claimed: the certified identification
pipeline executes offline, through certified modules, with fallback routing
proven live and zero network egress.

It is **not** a claim that a populated identification result was produced, and
the Phase 0E-R1 report should be read with §3 above attached. No paid call
occurred at any point, and the allowed pre-authorization spend of $0.00 was not
exceeded.
