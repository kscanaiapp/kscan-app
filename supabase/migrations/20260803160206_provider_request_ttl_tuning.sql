-- Provider-request TTL tuning: closes the reservation-TTL / worst-case-retry-
-- envelope gap identified during the Pass 4 provider-edge-hardening
-- compatibility validation (docs/security/provider-edge-compatibility-validation.md,
-- Pass E). Data-only change — no table, column, RPC, or policy is added,
-- dropped, or altered.
--
-- reserve_provider_request()'s concurrency and duplicate-replay checks both
-- filter on `expires_at > now()` (supabase/migrations/20260803020000_provider_request_security.sql,
-- lines 261-288), but the partial unique index that blocks a true in-flight
-- duplicate has no such filter. When a function's reservation TTL is shorter
-- than its own worst-case retry envelope, a request still legitimately running
-- past its TTL (a) silently drops out of the concurrency count for the
-- remainder of its run, and (b) if the client retries the same logical
-- request in that window, causes reserve_provider_request to fail open
-- (product-search-deals/index.ts:216-229 logs `reservation_unavailable` and
-- proceeds without a tracked reservation) rather than replaying the existing
-- one — a narrow cost/concurrency-accounting gap, never a client-visible leak.
--
-- product-search-deals: UPSTREAM_TIMEOUT=20_000ms, maxAttempts=2, backoff cap
-- on the one retry ~200ms -> worst-case envelope ~40,200ms (index.ts:41,248-251).
-- Previous TTL (20s) expired at almost exactly the start of the retry attempt.
-- New TTL (45s) exceeds the envelope with margin.
--
-- nike-shoe-details: UPSTREAM_TIMEOUT=8_000ms, maxAttempts=2 -> worst-case
-- envelope ~16,200ms (index.ts:44,201-203). Previous TTL (15s) left only a
-- ~1.2s margin. New TTL (20s) restores a safer margin. This function has no
-- live caller and is not deployed (held per security/scripts/staging-deployment-allowlist.js)
-- — the prior gap was dormant, not live, but the seeded config is tuned now so
-- a future deploy decision doesn't have to remember to revisit it.
--
-- See __tests__/security/ttlEnvelopeInvariant.test.js for the regression guard
-- that keeps these two values checked against their functions' own retry
-- constants going forward.

update public.provider_request_limits
set reservation_ttl_seconds = 45
where function_name = 'product-search-deals';

update public.provider_request_limits
set reservation_ttl_seconds = 20
where function_name = 'nike-shoe-details';
