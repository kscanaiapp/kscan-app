# Replay (L2) — READY_NO_CORPUS

**STATUS: READY_NO_CORPUS.** No replay corpus exists in this repository, and §29
explicitly forbids spending substantial time building elaborate replay
infrastructure. This directory therefore holds the **interface only**.

## What was searched

| Location | Contents | Usable as a replay corpus? |
|---|---|---|
| `qa/backend-quality-tune-fixtures/` | v119–v122 commerce quality baselines and comparison JSON | **No.** These record commerce *quality* outcomes, not timing. Reading them for latency would be inventing a measurement. |
| `assets/qa_fixtures/` | 8 JPEGs (7 fashion + 1 non-fashion control) | **Partially.** Used already — real byte counts and real SOF dimensions feed the payload model. They carry no timing. |
| `evidence/vto-phase4-*` | VTO catalog characterisation and Gate E economics | **No.** Different subsystem, different providers. Out of lane. |
| `__tests__/fixtures/scanAccuracyCases.js` | 37 category cases | **No.** A text proxy for `normalizeCategory`; no vision, no timing. |
| `docs/BUILD34_SCANNER_SCAN_RESULTS_DEEP_AUDIT.md` | **8 live scans with server and client timings** | **Yes, as OBSERVED evidence — and it is used.** But it is a prose report of 8 scans, not a replayable corpus. |

The only genuine timing evidence in the repository is the Build 34 scanner audit,
and it has been consumed directly as OBSERVED input to the assumptions register
rather than wrapped in replay machinery it does not fit.

## The interface a future corpus must satisfy

A replay record is one observed scan trace. Field names match the performance
event model so an observation can flow into the same graph the model uses.

```jsonc
{
  "trace_id": "synthetic-0001",          // synthetic only — never a real request id
  "scenario_id": "scan-funnel-on",
  "platform_profile": "ios",
  "source_sha": "…",                     // the SHA the trace was captured against
  "source_binding_hash": "…",            // to detect a trace replayed against drifted source
  "captured_at": "2026-09-06",
  "stages": [
    {
      "stage_id": "server.a.gemini",
      "parent_ids": ["server.a.quota"],
      "start": 1234,                     // ms relative to t=0, never a wall clock
      "duration": 6100,
      "result_available_at": 7334,
      "blocks_first_result": true,
      "evidence_class": "OBSERVED",      // a replayed trace is OBSERVED, never PROVEN
      "source_binding": "supabase/functions/scan-identify/index.ts",
      "provider": null,
      "retry_count": 0,
      "timeout": 14000,
      "outcome": "ok"
    }
  ]
}
```

## Hard rules for whoever builds the corpus

1. **`lib/privacy.js` must pass over every record.** No user id, email, token,
   signed URL, image payload or coordinate. Unsafe input fails; it is not redacted.
2. **Synthetic ids only.** A real request id is a correlation handle to a real
   customer.
3. **A replayed trace is OBSERVED, never PROVEN.** Structure is proven from source;
   timing is observed from a run.
4. **Record `source_binding_hash` at capture time.** Replaying a trace against
   drifted source produces a confident wrong answer, which is the failure mode this
   whole lab is built to avoid.
5. **Percentiles require a real distribution.** Do not compute P50/P95 from a
   handful of traces, and never label simulator output as a production percentile.
