# Controlled real-entrypoint probes

Run `deno test --allow-env --allow-read security/probes/edge-entrypoint-hostile.test.ts`.
No network permission is granted. The harness captures actual `Deno.serve`
handlers, replaces fetch with a rejecting synthetic authority, and restores
environment/fetch/server descriptors after every endpoint.

PASS means only a controlled response without provider dispatch or privileged
write for the specified invalid/anonymous payload. It does not establish
authenticated IDOR protection, deployed gateway behavior, or provider success.

The campaign records a known failing `scan-identify` JSON-null case: an uncaught
TypeError, with no provider call or privileged write. Keep the assertion failing
until an approved source repair resolves it. This harness is separate from the
governed backend unit suite; its result must be reported separately, never
silently folded into that suite's passing count.
