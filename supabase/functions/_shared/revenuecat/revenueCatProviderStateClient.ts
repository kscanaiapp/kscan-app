/** Bounded RevenueCat v2 customer-state client for K+ pull reconciliation. */

export const REVENUECAT_RECONCILE_SECRET_API_KEY_ENV = 'REVENUECAT_RECONCILE_SECRET_API_KEY' as const;
export const REVENUECAT_PROJECT_ID_ENV = 'REVENUECAT_PROJECT_ID' as const;
export const KPLUS_REVENUECAT_RECONCILE_ENVIRONMENT_ENV =
  'KPLUS_REVENUECAT_RECONCILE_ENVIRONMENT' as const;
export const KPLUS_REVENUECAT_RECONCILE_TIMEOUT_MS_ENV =
  'KPLUS_REVENUECAT_RECONCILE_TIMEOUT_MS' as const;
export const KPLUS_REVENUECAT_RECONCILE_MAX_PAGES_ENV =
  'KPLUS_REVENUECAT_RECONCILE_MAX_PAGES' as const;

export type RevenueCatEnvironment = 'production' | 'sandbox';

export interface RevenueCatSubscriptionResource {
  id: string;
  customerId: string;
  originalCustomerId: string;
  productResourceId: string;
  startsAt: string;
  currentPeriodStartsAt: string;
  currentPeriodEndsAt: string | null;
  endsAt: string | null;
  givesAccess: boolean;
  pendingPayment: boolean;
  status: string;
  autoRenewalStatus: string | null;
  store: string;
  storeSubscriptionIdentifier: string;
  environment: RevenueCatEnvironment;
  embeddedProduct: RevenueCatProductResource | null;
}

export interface RevenueCatPurchaseResource {
  id: string;
  customerId: string;
  originalCustomerId: string;
  productResourceId: string;
  purchasedAt: string;
  status: string;
  store: string;
  storePurchaseIdentifier: string;
  environment: RevenueCatEnvironment;
  embeddedProduct: RevenueCatProductResource | null;
}

export interface RevenueCatEventResource {
  id: string;
  type: string;
  appUserId: string;
  originalAppUserId: string;
  productId: string | null;
  transactionId: string | null;
  originalTransactionId: string | null;
  occurredAt: string;
  environment: RevenueCatEnvironment;
  store: string | null;
}

export interface RevenueCatProductResource {
  resourceId: string;
  storeIdentifier: string;
  type: string;
}

export type ProviderClientResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'throttled'; retryAfterSeconds: number }
  | { ok: false; kind: 'unavailable' | 'malformed'; retryAfterSeconds?: number };

export interface ProviderClientDeps {
  fetch: typeof fetch;
  now: () => number;
  getProductCache: (projectDigest: string, productDigest: string) => Promise<RevenueCatProductResource | null>;
  putProductCache: (
    projectDigest: string,
    productDigest: string,
    product: RevenueCatProductResource,
  ) => Promise<void>;
}

export interface ProviderClientConfig {
  secretApiKey: string;
  projectId: string;
  environment: RevenueCatEnvironment;
  timeoutMs: number;
  maxPages: number;
}

const API_ORIGIN = 'https://api.revenuecat.com';
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$/;

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function string(value: unknown, max = 512): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return new Date(value).toISOString();
  }
  const candidate = string(value, 64);
  return candidate && Number.isFinite(Date.parse(candidate)) ? new Date(candidate).toISOString() : null;
}

function environment(value: unknown): RevenueCatEnvironment | null {
  if (value === 'production' || value === 'PRODUCTION') return 'production';
  if (value === 'sandbox' || value === 'SANDBOX') return 'sandbox';
  return null;
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

function embeddedProduct(row: Record<string, unknown>, productResourceId: string): RevenueCatProductResource | null {
  const direct = object(row.product);
  const candidates: unknown[] = direct ? [direct] : [];
  const entitlements = object(row.entitlements);
  const entitlementItems = Array.isArray(entitlements?.items) ? entitlements.items : [];
  for (const entitlement of entitlementItems) {
    const products = object(object(entitlement)?.products);
    if (Array.isArray(products?.items)) candidates.push(...products.items);
  }
  for (const candidate of candidates) {
    const product = object(candidate);
    if (!product || string(product.id, 200) !== productResourceId) continue;
    const storeIdentifier = string(product.store_identifier, 200);
    const type = string(product.type, 64);
    if (storeIdentifier && type) return { resourceId: productResourceId, storeIdentifier, type };
  }
  return null;
}

function parseSubscription(value: unknown): RevenueCatSubscriptionResource | null {
  const row = object(value);
  if (!row) return null;
  const id = string(row.id, 200);
  const customerId = string(row.customer_id, 128);
  const originalCustomerId = string(row.original_customer_id, 128) ?? customerId;
  const productResourceId = string(row.product_id, 200);
  const startsAt = timestamp(row.starts_at);
  const currentPeriodStartsAt = timestamp(row.current_period_starts_at);
  const currentPeriodEndsAt = row.current_period_ends_at == null ? null : timestamp(row.current_period_ends_at);
  const endsAt = row.ends_at == null ? null : timestamp(row.ends_at);
  const status = string(row.status, 64);
  const store = string(row.store, 64);
  const storeSubscriptionIdentifier = string(row.store_subscription_identifier, 512);
  const env = environment(row.environment);
  if (!id || !customerId || !originalCustomerId || !productResourceId || !startsAt ||
      !currentPeriodStartsAt || (row.current_period_ends_at != null && !currentPeriodEndsAt) ||
      (row.ends_at != null && !endsAt) || typeof row.gives_access !== 'boolean' || typeof row.pending_payment !== 'boolean' ||
      !status || !store || !storeSubscriptionIdentifier || !env) return null;
  return {
    id, customerId, originalCustomerId, productResourceId, startsAt,
    currentPeriodStartsAt, currentPeriodEndsAt, endsAt, givesAccess: row.gives_access,
    pendingPayment: row.pending_payment,
    status, autoRenewalStatus: string(row.auto_renewal_status, 64), store,
    storeSubscriptionIdentifier, environment: env,
    embeddedProduct: embeddedProduct(row, productResourceId),
  };
}

function parsePurchase(value: unknown): RevenueCatPurchaseResource | null {
  const row = object(value);
  if (!row) return null;
  const id = string(row.id, 200);
  const customerId = string(row.customer_id, 128);
  const originalCustomerId = string(row.original_customer_id, 128) ?? customerId;
  const productResourceId = string(row.product_id, 200);
  const purchasedAt = timestamp(row.purchased_at);
  const status = string(row.status, 64);
  const store = string(row.store, 64);
  const storePurchaseIdentifier = string(row.store_purchase_identifier, 512);
  const env = environment(row.environment);
  if (!id || !customerId || !originalCustomerId || !productResourceId || !purchasedAt ||
      !status || !store || !storePurchaseIdentifier || !env) return null;
  return {
    id, customerId, originalCustomerId, productResourceId, purchasedAt, status,
    store, storePurchaseIdentifier, environment: env,
    embeddedProduct: embeddedProduct(row, productResourceId),
  };
}

function eventTimestamp(row: Record<string, unknown>): string | null {
  const direct = timestamp(row.occurred_at) ?? timestamp(row.event_timestamp);
  if (direct) return direct;
  const millis = row.event_timestamp_ms;
  return typeof millis === 'number' && Number.isFinite(millis)
    ? new Date(millis).toISOString()
    : null;
}

function parseEvent(value: unknown): RevenueCatEventResource | null {
  const row = object(value);
  if (!row) return null;
  const body = object(row.body) ?? row;
  const id = string(row.id, 200);
  const rawType = string(row.type, 64);
  const type = rawType?.replace(/^(?:PURCHASES|SUBSCRIPTIONS)_/, '') ?? null;
  const appUserId = string(body.app_user_id ?? body.customer_id, 128);
  const originalAppUserId = string(body.original_app_user_id ?? body.original_customer_id, 128) ?? appUserId;
  const occurredAt = eventTimestamp(row) ?? eventTimestamp(body);
  const env = environment(body.environment);
  if (!id || !type || !appUserId || !originalAppUserId || !occurredAt || !env) return null;
  return {
    id, type, appUserId, originalAppUserId,
    productId: string(body.product_id, 200),
    transactionId: string(body.transaction_id, 512),
    originalTransactionId: string(body.original_transaction_id, 512),
    occurredAt, environment: env, store: string(body.store, 64),
  };
}

function retryAfter(response: Response, nowMs: number): number {
  const raw = response.headers.get('retry-after');
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(300, Math.ceil(seconds));
  if (raw) {
    const dateSeconds = Math.ceil((Date.parse(raw) - nowMs) / 1000);
    if (Number.isFinite(dateSeconds) && dateSeconds >= 0) return Math.min(300, dateSeconds);
  }
  return 30;
}

async function requestJson(
  deps: ProviderClientDeps,
  config: ProviderClientConfig,
  url: URL,
): Promise<ProviderClientResult<Record<string, unknown>>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await deps.fetch(url, {
      headers: { Authorization: `Bearer ${config.secretApiKey}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (response.status === 429) return { ok: false, kind: 'throttled', retryAfterSeconds: retryAfter(response, deps.now()) };
    if (response.status >= 500) return { ok: false, kind: 'unavailable' };
    if (!response.ok) return { ok: false, kind: 'malformed' };
    const body = object(await response.json().catch(() => null));
    return body ? { ok: true, value: body } : { ok: false, kind: 'malformed' };
  } catch {
    return { ok: false, kind: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

function firstNext(body: Record<string, unknown>): string | null {
  const next = string(body.next_page, 2048) ?? string(object(body.links)?.next, 2048);
  return next;
}

async function list<T>(
  deps: ProviderClientDeps,
  config: ProviderClientConfig,
  actorId: string,
  resource: 'subscriptions' | 'purchases' | 'events',
  parse: (value: unknown) => T | null,
): Promise<ProviderClientResult<T[]>> {
  let url = new URL(`/v2/projects/${encodeURIComponent(config.projectId)}/customers/${encodeURIComponent(actorId)}/${resource}`, API_ORIGIN);
  url.searchParams.set('environment', config.environment);
  url.searchParams.set('limit', '100');
  const items: T[] = [];
  const expectedPath = url.pathname;
  for (let page = 0; page < config.maxPages; page += 1) {
    const result = await requestJson(deps, config, url);
    if (!result.ok) return result;
    const rows = result.value.items;
    if (!Array.isArray(rows) || rows.length > 100) return { ok: false, kind: 'malformed' };
    for (const row of rows) {
      const parsed = parse(row);
      if (!parsed) return { ok: false, kind: 'malformed' };
      items.push(parsed);
    }
    const next = firstNext(result.value);
    if (!next) return { ok: true, value: items };
    const nextUrl = new URL(next, API_ORIGIN);
    if (nextUrl.origin !== API_ORIGIN || nextUrl.pathname !== expectedPath) return { ok: false, kind: 'malformed' };
    nextUrl.searchParams.set('environment', config.environment);
    url = nextUrl;
  }
  return { ok: false, kind: 'malformed' };
}

export async function fetchRevenueCatCurrentState(
  deps: ProviderClientDeps,
  config: ProviderClientConfig,
  actorId: string,
): Promise<ProviderClientResult<{ subscriptions: RevenueCatSubscriptionResource[]; purchases: RevenueCatPurchaseResource[] }>> {
  const [subscriptions, purchases] = await Promise.all([
    list(deps, config, actorId, 'subscriptions', parseSubscription),
    list(deps, config, actorId, 'purchases', parsePurchase),
  ]);
  if (!subscriptions.ok) return subscriptions;
  if (!purchases.ok) return purchases;
  if (subscriptions.value.length + purchases.value.length > 50) return { ok: false, kind: 'malformed' };
  return { ok: true, value: { subscriptions: subscriptions.value, purchases: purchases.value } };
}

export function fetchRevenueCatEvents(
  deps: ProviderClientDeps,
  config: ProviderClientConfig,
  actorId: string,
): Promise<ProviderClientResult<RevenueCatEventResource[]>> {
  return list(deps, config, actorId, 'events', parseEvent);
}

export async function resolveRevenueCatProduct(
  deps: ProviderClientDeps,
  config: ProviderClientConfig,
  productResourceId: string,
  embedded: RevenueCatProductResource | null,
): Promise<ProviderClientResult<{ product: RevenueCatProductResource; source: 'embedded' | 'cache' | 'lookup' }>> {
  if (!ID.test(productResourceId)) return { ok: false, kind: 'malformed' };
  if (embedded?.resourceId === productResourceId) return { ok: true, value: { product: embedded, source: 'embedded' } };
  const [projectDigest, productDigest] = await Promise.all([digest(config.projectId), digest(productResourceId)]);
  try {
    const cached = await deps.getProductCache(projectDigest, productDigest);
    if (cached) {
      return { ok: true, value: { product: { ...cached, resourceId: productResourceId }, source: 'cache' } };
    }
  } catch {
    // An unavailable cache is a miss. Unknown product still fails closed if the
    // authoritative lookup below cannot establish the store identifier.
  }
  const url = new URL(`/v2/projects/${encodeURIComponent(config.projectId)}/products/${encodeURIComponent(productResourceId)}`, API_ORIGIN);
  const result = await requestJson(deps, config, url);
  if (!result.ok) return result;
  const id = string(result.value.id, 200);
  const storeIdentifier = string(result.value.store_identifier, 200);
  const type = string(result.value.type, 64);
  if (id !== productResourceId || !storeIdentifier || !type) return { ok: false, kind: 'malformed' };
  const product = { resourceId: id, storeIdentifier, type };
  try {
    await deps.putProductCache(projectDigest, productDigest, product);
  } catch {
    // The current authoritative answer is usable; a later request may look it
    // up again. No inferred or stale value is substituted.
  }
  return { ok: true, value: { product, source: 'lookup' } };
}
