import { createDiscoveryAuthenticator } from "../../../black-owned-discovery/accountAuthorization.ts";
import type { Adapters, Batch } from "./adapters.ts";
import { matchesRefinement, relevant } from "./adapters.ts";
import {
  amount,
  asRecommended,
  identity,
  normalizeProduct,
  type Product,
  RECORD_TTL_MS,
} from "./products.ts";
import {
  type Capability,
  type Failure,
  parseToolRequest,
  TOOL_VERSION,
  ToolError,
} from "./request.ts";
import type { ReferenceStore, StoredReference } from "./sessionStore.ts";

export const LIMITS = Object.freeze({
  requestsPerTurn: 2,
  concurrency: 1,
  /** Retrieval deadline (provider/catalog work), unchanged at 2,500 ms. */
  deadlineMs: 2500,
  /** Separate bound for per-turn re-authorization, which precedes any provider call. */
  authorizationMs: 1000,
  candidates: 8,
  sessionRecords: 32,
  recordTtlMs: RECORD_TTL_MS,
});
export type Metadata = {
  version: typeof TOOL_VERSION;
  tool: Capability | "invalid";
  permitted: boolean;
  durationMs: number;
  serviceCalls: number;
  providerCallCeiling: number;
  candidateCount: number;
  resultCount: number;
  cacheHit: boolean | null;
  failure: Failure | null;
  costUsd: null;
};
export type Result = {
  version: typeof TOOL_VERSION;
  status: "ready" | "empty" | "denied" | "error";
  reason: Failure | null;
  products: Product[];
};
type Actor = { id: string; isAnonymous: boolean };
export type Dependencies = {
  enabled: () => boolean;
  authenticate: (request: Request) => Promise<Actor>;
  assertActive: (actorId: string) => Promise<void>;
  /** Must verify current consent and server quota/entitlement policy; never use model claims. */
  permitTurn: (actorId: string) => Promise<boolean>;
  allowedMarkets: readonly string[];
  adapters: Adapters;
  emit?: (metadata: Metadata) => void;
  /**
   * Optional server-side reference store (OC-01 integration). Without it the
   * session keeps its records in memory only, exactly as before. With it, a
   * session opened for a verified actor + owned conversation also sees that
   * conversation's unexpired references from earlier HTTP requests, and
   * persists the products it returns. Never constructed from client/model data.
   */
  store?: ReferenceStore;
};
const response = (
  status: Result["status"],
  reason: Failure | null,
  products: Product[] = [],
): Result => ({ version: TOOL_VERSION, status, reason, products });
/** One broker per isolate; one session per verified actor/conversation. No client body is accepted as trusted context. */
export function createReadOnlyBroker(deps: Dependencies) {
  const authenticate = createDiscoveryAuthenticator(
    deps.authenticate,
    deps.assertActive,
  );
  let occupied = false;
  return {
    async openSession(
      request: Request,
      options: { conversationId?: string } = {},
    ) {
      if (deps.enabled() !== true) throw new ToolError("disabled");
      const actor = await authenticate(request);
      if (!actor.id || actor.isAnonymous) throw new ToolError("unauthorized");
      const records = new Map<string, Product>();
      const conversationId = options.conversationId;
      const store = deps.store && conversationId ? deps.store : undefined;
      let loaded: Promise<StoredReference[]> | null = null;
      /** Stored references of THIS actor's conversation, loaded once per session. Failure reads as none (fail closed). */
      const references = (): Promise<StoredReference[]> => {
        if (!store) return Promise.resolve([]);
        loaded ??= store.load(
          actor.id,
          conversationId!,
          AbortSignal.any([request.signal, AbortSignal.timeout(1_000)]),
        ).catch(() => []);
        return loaded;
      };
      // This object, and all result refs, stay on the server. It must never be deserialized from a request.
      return {
        /** Server-held, validated references available to this turn (for numbering follow-ups). */
        references,
        /** Server-only presentation order for the optional combined two-result shelf.
         * Accepts only live refs issued by THIS broker session, never model products.
         */
        async rememberPresentation(refs: readonly string[]): Promise<void> {
          if (!store || deps.enabled() !== true || request.signal.aborted || refs.length > LIMITS.candidates) throw new ToolError('foreign_or_stale_reference');
          const selected = refs.map(ref => records.get(ref));
          if (selected.some(p => !p || p.provenance.expiresAt <= Date.now()) || new Set(refs).size !== refs.length) throw new ToolError('foreign_or_stale_reference');
          const signal = AbortSignal.any([request.signal, AbortSignal.timeout(200)]);
          await Promise.race([
            store.save(actor.id, conversationId!, selected as Product[], signal),
            new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new ToolError('deadline')), { once: true })),
          ]);
        },
        async executeTurn(inputs: readonly unknown[]): Promise<Result[]> {
          const controller = new AbortController();
          // Re-authorization (identity, account state, consent/permit) runs
          // first under its OWN bound; the 2,500 ms retrieval deadline starts
          // only once it has passed, so it bounds provider work alone (live
          // Staging evidence: ~0.9 s of re-authorization left the primary
          // shopping provider less than its normal successful latency).
          let authTimer: ReturnType<typeof setTimeout> | undefined;
          const authTimeout = new Promise<never>((_, reject) => {
            authTimer = setTimeout(() => {
              controller.abort();
              reject(new ToolError("deadline"));
            }, LIMITS.authorizationMs);
          });
          authTimeout.catch(() => {});
          const authBounded = <T>(p: Promise<T>) => Promise.race([p, authTimeout]);
          let deadline = Infinity;
          let timer: ReturnType<typeof setTimeout> | undefined;
          let timeout: Promise<never> = new Promise<never>(() => {});
          const startRetrievalClock = () => {
            clearTimeout(authTimer);
            deadline = performance.now() + LIMITS.deadlineMs;
            timeout = new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                controller.abort();
                reject(new ToolError("deadline"));
              }, LIMITS.deadlineMs);
            });
            timeout.catch(() => {});
          };
          const bounded = <T>(p: Promise<T>) => Promise.race([p, timeout]);
          const abort = () => controller.abort();
          request.signal.addEventListener("abort", abort, { once: true });
          if (request.signal.aborted) controller.abort();
          const persisted = await references();
          const existing = new Map(
            [
              ...persisted.map((r) => [r.product.ref, r.product] as const),
              ...records,
            ].filter(([, p]) => p.provenance.expiresAt > Date.now()),
          );
          records.clear();
          existing.forEach((p, k) => records.set(k, p));
          const outputs: Result[] = [];
          // A turn snapshots existing refs: requests in the same turn cannot chain.
          try {
            if (
              !Array.isArray(inputs) || inputs.length === 0 ||
              inputs.length > LIMITS.requestsPerTurn
            ) {
              try {
                deps.emit?.({
                  version: TOOL_VERSION,
                  tool: "invalid",
                  permitted: false,
                  durationMs: 0,
                  serviceCalls: 0,
                  providerCallCeiling: 0,
                  candidateCount: 0,
                  resultCount: 0,
                  cacheHit: false,
                  failure: "limit",
                  costUsd: null,
                });
              } catch { /* telemetry only */ }
              return [response("denied", "limit")];
            }
            let authorized = false;
            try {
              if (deps.enabled() !== true || controller.signal.aborted) {
                throw new ToolError("disabled");
              }
              const current = await authBounded(authenticate(request));
              authorized = current.id === actor.id && !current.isAnonymous &&
                await authBounded(deps.permitTurn(actor.id));
            } catch {
              authorized = false;
            }
            startRetrievalClock();
            for (const input of inputs) {
              const t = performance.now();
              const meta: Metadata = {
                version: TOOL_VERSION,
                tool: "invalid",
                permitted: false,
                durationMs: 0,
                serviceCalls: 0,
                providerCallCeiling: 0,
                candidateCount: 0,
                resultCount: 0,
                cacheHit: false,
                failure: null,
                costUsd: null,
              };
              try {
                if (deps.enabled() !== true) throw new ToolError("disabled");
                if (
                  controller.signal.aborted || performance.now() >= deadline
                ) throw new ToolError("deadline");
                if (!authorized) throw new ToolError("unauthorized");
                const parsed = parseToolRequest(input, deps.allowedMarkets);
                meta.tool = parsed.capability;
                const a = parsed.arguments;
                const referenceKeys = "productRefs" in a
                  ? a.productRefs
                  : "previousRefs" in a
                  ? a.previousRefs
                  : [];
                const previous = referenceKeys.map((ref) => {
                  const p = existing.get(ref);
                  if (!p || p.provenance.expiresAt <= Date.now()) {
                    throw new ToolError("foreign_or_stale_reference");
                  }
                  return p;
                });
                meta.permitted = true;
                let products: Product[];
                if (parsed.capability === "compare_products") {
                  // Comparison is a closed table of supported records; no generated conclusions or unavailable attributes.
                  products = previous;
                  meta.cacheHit = true;
                } else {
                  if (occupied) throw new ToolError("busy");
                  occupied = true;
                  // Keep the slot until the service settles, even when the response deadline has fired.
                  meta.serviceCalls = 1;
                  meta.providerCallCeiling =
                    parsed.capability === "discover_black_owned" ? 0 : 2;
                  meta.cacheHit = null; // Existing service caches do not expose hit/call counters.
                  const work = Promise.resolve().then(() =>
                    parsed.capability === "discover_black_owned"
                      ? deps.adapters.blackOwned(
                        parsed.arguments,
                        controller.signal,
                      )
                      : deps.adapters.shopping(
                        parsed.arguments,
                        Math.max(1, deadline - performance.now()),
                        controller.signal,
                      )
                  );
                  void work.finally(() => {
                    occupied = false;
                  }).catch(() => {});
                  const batch: Batch = await bounded(work);
                  if (
                    controller.signal.aborted || performance.now() >= deadline
                  ) throw new ToolError("deadline");
                  if (
                    !batch || !Array.isArray(batch.products) ||
                    batch.products.length > LIMITS.candidates ||
                    !(parsed.capability === "discover_black_owned"
                      ? batch.provider === "eligible_catalog"
                      : ["serper", "brave", "none"].includes(batch.provider)) ||
                    (batch.provider === "none" && batch.products.length > 0)
                  ) throw new ToolError("malformed_provider");
                  meta.candidateCount = batch.products.length;
                  meta.cacheHit = batch.cacheHit === true
                    ? true
                    : batch.cacheHit === false
                    ? false
                    : null;
                  const seen = new Set<string>();
                  products = [];
                  for (const raw of batch.products) {
                    if (batch.provider === "none") {
                      throw new ToolError("malformed_provider");
                    }
                    const p = normalizeProduct(raw, batch.provider, Date.now());
                    if (!p) throw new ToolError("malformed_provider");
                    const sourceKey =
                      `${p.provenance.provider}:${p.provenance.sourceId}`;
                    if (seen.has(identity(p)) || seen.has(sourceKey)) continue;
                    seen.add(identity(p));
                    seen.add(sourceKey);
                    if (
                      parsed.capability !== "discover_black_owned" &&
                      !relevant(asRecommended(p), parsed.arguments)
                    ) continue;
                    if (
                      parsed.capability === "refine_products" &&
                      !matchesRefinement(p.title, parsed.arguments)
                    ) continue;
                    if (
                      parsed.arguments.currency &&
                      p.currency !== parsed.arguments.currency
                    ) continue;
                    if (
                      parsed.arguments.maxPrice !== undefined &&
                      (amount(p) === null ||
                        amount(p)! > parsed.arguments.maxPrice)
                    ) continue;
                    if (
                      "excludePreviousMerchants" in parsed.arguments &&
                      parsed.arguments.excludePreviousMerchants &&
                      previous.some((old) => old.merchant === p.merchant)
                    ) continue;
                    products.push(p);
                  }
                  for (const p of products) {
                    if (records.size >= LIMITS.sessionRecords) {
                      records.delete(records.keys().next().value!);
                    }
                    records.set(p.ref, structuredClone(p));
                  }
                  if (store && products.length > 0) {
                    // Persistence failure never fails the result; it only means a
                    // later follow-up sees no reference (fail closed).
                    // Own 1 s budget: a slow search must not leave the save no time (P3-3).
                    await store.save(
                      actor.id,
                      conversationId!,
                      products,
                      AbortSignal.any([request.signal, AbortSignal.timeout(1_000)]),
                    ).catch(() => {});
                  }
                }
                meta.resultCount = products.length;
                outputs.push(
                  response(
                    products.length ? "ready" : "empty",
                    null,
                    structuredClone(products),
                  ),
                );
              } catch (error) {
                const code = error instanceof ToolError
                  ? error.code
                  : "provider_failure";
                meta.failure = code;
                outputs.push(
                  response(
                    ["provider_failure", "malformed_provider", "deadline"]
                        .includes(code)
                      ? "error"
                      : "denied",
                    code,
                  ),
                );
              } finally {
                meta.durationMs = Math.max(
                  0,
                  Math.round(performance.now() - t),
                );
                try {
                  deps.emit?.(meta);
                } catch { /* telemetry cannot affect results */ }
              }
            }
            return outputs;
          } finally {
            clearTimeout(authTimer);
            clearTimeout(timer);
            controller.abort();
            request.signal.removeEventListener("abort", abort);
          }
        },
      };
    },
  };
}
