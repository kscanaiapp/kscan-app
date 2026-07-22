# Dressing Room LLM validation

`style-outfit-generate` remains source-only and is not present in the production Supabase function list. Its repaired dormant source uses the approved model policy (`gemini-3.6-flash` with `gemini-3.5-flash-lite` operational fallback), bounded requests, JWT/ownership expectations, and safe response handling.

The AI outfit client is gated and was classified as dormant/disabled in the accepted release path. No active production control was found invoking the missing function, so the absence of a deployment is not currently a production 404 defect.

No function was deployed merely to satisfy the audit. Deploying a dormant provider surface without an accepted active release requirement would expand cost and attack surface.

Open verification:

- A full Dressing Room emulator journey was not executed.
- If the feature gate is enabled in any accepted release profile, this classification must immediately be revisited; the function must be deployed from committed source with `verify_jwt=true` and authenticated runtime attribution before release.

Status: **DORMANT SOURCE ONLY; NOT RUNTIME VERIFIED**.
