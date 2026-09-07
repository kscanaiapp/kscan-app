import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { classifyHardTractability, type HardTractability } from './hardTractability';
import { repoRoot } from './realFixtureCatalog';
import { classifyShot } from './shotClassifier';
import { computeSourcePreflight, type SourcePreflight } from './sourcePreflight';
import { loadSourceImage } from './sourceLoad';
import type { ShotClass } from './types';

/**
 * Phase 4.2 §2/§7/§8 — LARGE-CORPUS CATALOG CHARACTERIZATION.
 *
 * §2 requires the addressability math BEFORE any segmentation tuning, and
 * §8 requires that characterization be separated from full asset
 * generation: this runner deliberately does NOT run the asset pipeline. It
 * decodes each authoritative image candidate and measures it — shot class,
 * source preflight, HARD tractability — which is everything §2's questions
 * need at a fraction of the cost of extraction + anchors + geometry + QA.
 *
 * The central question (§1/§11) is that shot class is an IMAGE property
 * while addressability is a PRODUCT property, so a product whose hero image
 * is model-worn may still carry an addressable alternate. Answering it
 * requires inspecting EVERY image candidate in the authoritative Commerce
 * record — which Phase 4.1's cohort runner never did (it passed
 * `product_photos[0]` alone).
 *
 * Boundaries carried forward unchanged: the already-deployed, already-
 * authorized `product-search-deals` staging path only (§10 — no scraping,
 * no invented alternate URLs, no retailer integration, no PDP browsing, no
 * crossing product boundaries); transient bytes (§57 — nothing decoded is
 * written to disk); and no product title, store name, or raw image URL is
 * ever committed to evidence.
 */

const STAGING_FUNCTION_URL = 'https://yzqjvdfgefveprobvvyw.supabase.co/functions/v1/product-search-deals';

/** Provider hard cap (MAX_LIMIT in supabase/functions/product-search-deals/index.ts). Not a value to tune. */
const PROVIDER_MAX_LIMIT = 20;
/** Courtesy pacing between provider requests. Deliberately conservative — §7 forbids evading limits. */
const QUERY_PACING_MS = 180;
/** How long to wait after a 429 before retrying, doubling each attempt. */
const RATE_LIMIT_BACKOFF_MS = Number(process.env.CATALOG_RATE_LIMIT_BACKOFF_MS ?? 30_000);
/** Bounded retries per request. After this the stratum is abandoned — never retried harder. */
const RATE_LIMIT_MAX_RETRIES = Number(process.env.CATALOG_RATE_LIMIT_MAX_RETRIES ?? 2);

interface QueryStratum {
  visual: string;
  query: string;
}

/**
 * Top-category only (garmentContract.ts maps only 'top' to a Live template
 * family), stratified across the visual characteristics the corpus request
 * asked for. Identical stratum LIST to the Phase 4.1 Gate E run; scale comes
 * from offset paging (§7), not from changing what is asked for.
 *
 * AUDIT CORRECTION (P42-A-004, hostile-audit A7): an identical stratum list
 * does NOT make the two corpora comparable, and this comment previously
 * claimed it did. In the 2026-09-05 run the provider rate limit closed after
 * 28 successful requests, ALL of them `plain` queries; the other 17 strata
 * returned only HTTP 429 and contributed ZERO products, while Phase 4.1's
 * 220-run realized all 7 visual classes. Any run that does not reach the
 * non-`plain` strata yields a single-stratum draw and must be reported as
 * one — see docs/vto-phase4-2-addressability.md §5.1.
 */
const QUERY_STRATA: QueryStratum[] = [
  { visual: 'plain', query: 'mens plain crew neck t-shirt' },
  { visual: 'plain', query: 'womens plain cotton t-shirt' },
  { visual: 'plain', query: 'mens plain v-neck t-shirt' },
  { visual: 'plain', query: 'womens plain fitted tee' },
  { visual: 'logo', query: 'mens graphic logo t-shirt' },
  { visual: 'logo', query: 'womens graphic print tee' },
  { visual: 'logo', query: 'mens brand logo t-shirt' },
  { visual: 'patterned', query: 'mens striped t-shirt' },
  { visual: 'patterned', query: 'womens floral print top' },
  { visual: 'patterned', query: 'mens plaid flannel shirt' },
  { visual: 'dark', query: 'black cotton t-shirt mens' },
  { visual: 'dark', query: 'navy t-shirt womens' },
  { visual: 'light', query: 'white cotton t-shirt womens' },
  { visual: 'light', query: 'cream colored t-shirt mens' },
  { visual: 'softknit', query: 'merino wool crew neck sweater mens' },
  { visual: 'softknit', query: 'cashmere sweater womens' },
  { visual: 'softknit', query: 'knit pullover sweater mens' },
  { visual: 'structured', query: 'oxford button down shirt mens' },
  { visual: 'structured', query: 'poplin blouse womens' },
  { visual: 'structured', query: 'polo shirt mens cotton' },
  { visual: 'structured', query: 'henley shirt mens' },
];

interface RawCommerceProduct {
  product_id?: string;
  product_photos?: string[];
}

interface AssembledProduct {
  productRef: string;
  visual: string;
  /** Every authoritative image candidate, in provider order. Index 0 is the HERO. */
  imageUrls: string[];
}

interface QueryLogEntry {
  stratum: string;
  offset: number;
  httpStatus: number;
  returned: number;
  durationMs: number;
}

async function fetchPage(
  anonKey: string,
  stratum: QueryStratum,
  offset: number,
  log: QueryLogEntry[],
  attempt = 0,
): Promise<RawCommerceProduct[]> {
  const startedAt = Date.now();
  try {
    const res = await fetch(STAGING_FUNCTION_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + anonKey, apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: stratum.query, limit: PROVIDER_MAX_LIMIT, offset }),
    });
    const durationMs = Date.now() - startedAt;
    if (!res.ok) {
      log.push({ stratum: stratum.visual, offset, httpStatus: res.status, returned: 0, durationMs });
      // 429 is the provider telling us to slow down. Honour it: back off for a
      // real interval and retry a BOUNDED number of times, then give up on this
      // stratum. Backing off is respecting the limit; retrying immediately, or
      // rotating keys/hosts, would be evading it (§7 forbids evasion).
      if (res.status === 429 && attempt < RATE_LIMIT_MAX_RETRIES) {
        const waitMs = RATE_LIMIT_BACKOFF_MS * Math.pow(2, attempt);
        console.log('[catalog] 429 from provider — backing off ' + (waitMs / 1000) + 's (retry ' + (attempt + 1) + '/' + RATE_LIMIT_MAX_RETRIES + ')');
        await new Promise((r) => setTimeout(r, waitMs));
        return fetchPage(anonKey, stratum, offset, log, attempt + 1);
      }
      return [];
    }
    const json = (await res.json()) as { data?: { products?: RawCommerceProduct[] } };
    const products = json.data?.products ?? [];
    log.push({ stratum: stratum.visual, offset, httpStatus: res.status, returned: products.length, durationMs });
    return products;
  } catch (err) {
    log.push({ stratum: stratum.visual, offset, httpStatus: 0, returned: 0, durationMs: Date.now() - startedAt });
    console.error('[catalog] query error ' + stratum.visual + '@' + offset + ': ' + (err as Error).message);
    return [];
  }
}

/**
 * Phase 4.2 closeout §5/§6 — PAGE-GRANULAR, RESUMABLE CORPUS ASSEMBLY.
 *
 * The original implementation accumulated every page in memory and wrote the
 * cache only after the whole assembly finished. When the provider rate limit
 * hit mid-run, the pages already paid for were lost with it — which is
 * exactly what happened on the first 490-product run, and why the closeout
 * measurement could not be re-run without spending quota again.
 *
 * The cache is now keyed PER PAGE. Every successful page is persisted the
 * moment it arrives, so a 429 can never discard work already funded. A
 * re-run skips pages already cached and fetches only what is missing.
 *
 * This is tooling resilience, not quota evasion: it strictly REDUCES the
 * number of provider requests made, honours the same bounded backoff, and
 * never retries a limit harder.
 */

interface PageCacheEntry {
  visual: string;
  query: string;
  offset: number;
  fetchedAt: string;
  /** Raw provider records, reduced to the two fields this lane uses. */
  products: { product_id: string; product_photos: string[] }[];
}

interface CorpusCacheFile {
  schema: 'vto-phase4-2-corpus-cache/2';
  updatedAt: string;
  /** Keyed by stratum + offset so a page is fetched at most once, ever. */
  pages: Record<string, PageCacheEntry>;
  queryLog: QueryLogEntry[];
  /** Derived, written alongside the pages so addressableSliceCli can consume the cache directly. */
  products: AssembledProduct[];
  rawSeen: number;
  skippedNoPhotos: number;
}

function pageKey(stratum: QueryStratum, offset: number): string {
  return stratum.visual + '|' + stratum.query + '|' + offset;
}

function emptyCache(): CorpusCacheFile {
  return {
    schema: 'vto-phase4-2-corpus-cache/2',
    updatedAt: new Date().toISOString(),
    pages: {},
    queryLog: [],
    products: [],
    rawSeen: 0,
    skippedNoPhotos: 0,
  };
}

function loadCache(cachePath: string): CorpusCacheFile {
  if (!cachePath || !existsSync(cachePath)) return emptyCache();
  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf-8')) as Partial<CorpusCacheFile>;
    if (parsed.schema !== 'vto-phase4-2-corpus-cache/2' || !parsed.pages) {
      console.warn('[catalog] cache at ' + cachePath + ' is not schema v2 — starting a fresh page cache (the old file is left untouched).');
      return emptyCache();
    }
    return Object.assign(emptyCache(), parsed) as CorpusCacheFile;
  } catch (err) {
    console.warn('[catalog] cache unreadable (' + (err as Error).message + ') — starting fresh.');
    return emptyCache();
  }
}

function writeCache(cachePath: string, cache: CorpusCacheFile): void {
  if (!cachePath) return;
  cache.updatedAt = new Date().toISOString();
  mkdirSync(dirname(cachePath), { recursive: true });
  // Write-then-rename so a crash mid-write cannot corrupt a cache that
  // represents provider quota already spent.
  const tmp = cachePath + '.tmp';
  writeFileSync(tmp, JSON.stringify(cache, null, 2));
  // Audit P42-A-006 (§23). MEASURED on win32/node 24: renameSync over an
  // existing destination is atomic, BUT throws EPERM whenever any other
  // handle holds the destination open — a concurrent reader, an editor, or
  // (routinely) an antivirus scanner touching the file just written. Under
  // two concurrent writers, 51 of 800 renames failed this way.
  //
  // This runner calls writeCache after every funded page, so an unguarded
  // throw would abort a run and forfeit provider quota already spent —
  // the exact outcome the write-then-rename was introduced to prevent.
  // Bounded retry, then surface the error; never silently drop the write.
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      renameSync(tmp, cachePath);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw err;
      const until = Date.now() + 20 * (attempt + 1);
      while (Date.now() < until) { /* brief synchronous backoff — this path is rare and must not reorder writes */ }
    }
  }
  throw lastErr;
}

/**
 * Derives the product list from the cached pages. Deduplicates by
 * `product_id` (stable provider identity), preserves stratum accounting, and
 * interleaves strata ROUND-ROBIN so any trim to `targetCount` falls evenly
 * rather than favouring whichever strata were queried first.
 */
function deriveProducts(cache: CorpusCacheFile, targetCount: number): { products: AssembledProduct[]; skippedNoPhotos: number } {
  const byStratum = new Map<string, { visual: string; products: { product_id: string; product_photos: string[] }[] }>();
  const seen = new Set<string>();
  let skippedNoPhotos = 0;

  // Deterministic order: stratum declaration order, then ascending offset.
  const entries = Object.values(cache.pages).sort((a, b) => {
    const ai = QUERY_STRATA.findIndex((s) => s.visual === a.visual && s.query === a.query);
    const bi = QUERY_STRATA.findIndex((s) => s.visual === b.visual && s.query === b.query);
    if (ai !== bi) return ai - bi;
    return a.offset - b.offset;
  });

  for (const page of entries) {
    const key = page.visual + '|' + page.query;
    const bucket = byStratum.get(key) ?? { visual: page.visual, products: [] };
    for (const p of page.products) {
      if (!p.product_id || seen.has(p.product_id)) continue;
      if (!p.product_photos || p.product_photos.length === 0) {
        skippedNoPhotos++;
        continue;
      }
      seen.add(p.product_id);
      bucket.products.push(p);
    }
    byStratum.set(key, bucket);
  }

  const buckets = Array.from(byStratum.values());
  const products: AssembledProduct[] = [];
  let sequence = 0;
  let round = 0;
  outer: while (products.length < targetCount) {
    let anyTaken = false;
    for (const bucket of buckets) {
      if (round >= bucket.products.length) continue;
      anyTaken = true;
      sequence++;
      products.push({
        productRef: 'cat-' + String(sequence).padStart(5, '0'),
        visual: bucket.visual,
        imageUrls: bucket.products[round].product_photos,
      });
      if (products.length >= targetCount) break outer;
    }
    if (!anyTaken) break;
    round++;
  }

  return { products, skippedNoPhotos };
}

function persist(cachePath: string, cache: CorpusCacheFile, targetCount: number): void {
  const derived = deriveProducts(cache, targetCount);
  cache.products = derived.products;
  cache.skippedNoPhotos = derived.skippedNoPhotos;
  writeCache(cachePath, cache);
}

async function assembleLargeCorpus(
  anonKey: string,
  targetCount: number,
  pagesPerStratum: number,
  cachePath: string,
): Promise<{
  products: AssembledProduct[];
  queryLog: QueryLogEntry[];
  rawSeen: number;
  skippedNoPhotos: number;
  newRequests: number;
  cachedPagesReused: number;
  rateLimited: boolean;
}> {
  const cache = loadCache(cachePath);
  const cachedPagesAtStart = Object.keys(cache.pages).length;
  if (cachedPagesAtStart > 0) {
    console.log('[catalog] resuming from ' + cachedPagesAtStart + ' cached page(s) — those cost 0 provider requests.');
  }

  let newRequests = 0;
  let rateLimited = false;

  for (const stratum of QUERY_STRATA) {
    for (let page = 0; page < pagesPerStratum; page++) {
      const offset = page * PROVIDER_MAX_LIMIT;
      const key = pageKey(stratum, offset);

      const cached = cache.pages[key];
      if (cached) {
        // Already funded. A page that legitimately returned zero products marks
        // the end of this stratum, and is cached as such, so stop here too.
        if (cached.products.length === 0) break;
        continue;
      }
      // Once the provider starts refusing, stop issuing requests rather than
      // walking every remaining stratum into a 429.
      if (rateLimited) break;

      const logBefore = cache.queryLog.length;
      const raw = await fetchPage(anonKey, stratum, offset, cache.queryLog);
      newRequests += cache.queryLog.length - logBefore;

      const lastEntry = cache.queryLog[cache.queryLog.length - 1];
      if (lastEntry && lastEntry.httpStatus === 429) {
        rateLimited = true;
        console.log('[catalog] provider rate limit reached — stopping. ' + Object.keys(cache.pages).length + ' page(s) remain cached and will not be re-fetched.');
        persist(cachePath, cache, targetCount);
        break;
      }

      cache.rawSeen += raw.length;
      cache.pages[key] = {
        visual: stratum.visual,
        query: stratum.query,
        offset,
        fetchedAt: new Date().toISOString(),
        products: raw
          .filter((p) => typeof p.product_id === 'string')
          .map((p) => ({ product_id: p.product_id as string, product_photos: p.product_photos ?? [] })),
      };
      // Persist IMMEDIATELY: this page is paid for, and a later 429 must not
      // be able to discard it.
      persist(cachePath, cache, targetCount);

      if (raw.length === 0) break; // stratum exhausted
      await new Promise((r) => setTimeout(r, QUERY_PACING_MS));
    }
    if (rateLimited) break;
  }

  const derived = deriveProducts(cache, targetCount);
  cache.products = derived.products;
  cache.skippedNoPhotos = derived.skippedNoPhotos;
  writeCache(cachePath, cache);

  return {
    products: derived.products,
    queryLog: cache.queryLog,
    rawSeen: cache.rawSeen,
    skippedNoPhotos: derived.skippedNoPhotos,
    newRequests,
    cachedPagesReused: cachedPagesAtStart,
    rateLimited,
  };
}

// ── Image-level characterization ─────────────────────────────────────────

interface CharacterizedImage {
  /** Position in the authoritative record. 0 = hero. */
  index: number;
  /** Host only — never the full URL (§57 / privacy carry-forward). */
  host: string;
  sha256: string | null;
  ok: boolean;
  failureCode: string | null;
  width: number | null;
  height: number | null;
  format: string | null;
  shotClass: ShotClass | null;
  shotConfidence: number | null;
  addressable: boolean;
  hardTractability: HardTractability | null;
  preflight: SourcePreflight | null;
}

interface CharacterizedProduct {
  productRef: string;
  visual: string;
  imageCandidateCount: number;
  images: CharacterizedImage[];
  heroShotClass: ShotClass | null;
  heroAddressable: boolean;
  bestShotClass: ShotClass | null;
  bestAddressable: boolean;
  bestImageIndex: number | null;
  /** True when the hero is not addressable but some alternate image is — the §13 rescue case. */
  rescuedByAlternate: boolean;
  hardOnly: boolean;
}

/** §14: addressability reuses the EXISTING Easy/Medium eligibility contract. No new class is invented that could quietly widen it. */
function isAddressableClass(shotClass: ShotClass | null): boolean {
  return shotClass === 'EASY' || shotClass === 'MEDIUM';
}

const SHOT_RANK: Record<ShotClass, number> = { EASY: 3, MEDIUM: 2, HARD: 1, UNSUPPORTED: 0 };

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unparseable';
  }
}

async function characterizeProduct(product: AssembledProduct): Promise<CharacterizedProduct> {
  const images: CharacterizedImage[] = [];

  for (let index = 0; index < product.imageUrls.length; index++) {
    const url = product.imageUrls[index];
    const host = hostOf(url);
    const loaded = await loadSourceImage({ ref: url, origin: 'https-fetch' });

    if (!loaded.ok) {
      images.push({
        index,
        host,
        sha256: null,
        ok: false,
        failureCode: loaded.kind === 'systemError' ? loaded.systemError.code : loaded.rejection.code,
        width: null,
        height: null,
        format: null,
        shotClass: null,
        shotConfidence: null,
        addressable: false,
        hardTractability: null,
        preflight: null,
      });
      continue;
    }

    const img = loaded.decoded.image;
    const preflight = computeSourcePreflight(img);
    const shot = classifyShot(img);
    const hardTractability = shot.shotClass === 'HARD' ? classifyHardTractability(preflight).tractability : null;

    images.push({
      index,
      host,
      sha256: loaded.decoded.sha256,
      ok: true,
      failureCode: null,
      width: img.width,
      height: img.height,
      format: loaded.decoded.format,
      shotClass: shot.shotClass,
      shotConfidence: Math.round(shot.confidence * 1000) / 1000,
      addressable: isAddressableClass(shot.shotClass),
      hardTractability,
      preflight,
    });
  }

  const hero = images[0] ?? null;
  const decodedImages = images.filter((i) => i.ok);
  let best: CharacterizedImage | null = null;
  for (const img of decodedImages) {
    if (!img.shotClass) continue;
    if (best === null || SHOT_RANK[img.shotClass] > SHOT_RANK[best.shotClass as ShotClass]) best = img;
  }

  const heroAddressable = hero !== null && hero.addressable;
  const bestAddressable = best !== null && best.addressable;

  return {
    productRef: product.productRef,
    visual: product.visual,
    imageCandidateCount: product.imageUrls.length,
    images,
    heroShotClass: hero !== null ? hero.shotClass : null,
    heroAddressable,
    bestShotClass: best !== null ? best.shotClass : null,
    bestAddressable,
    bestImageIndex: best !== null ? best.index : null,
    rescuedByAlternate: !heroAddressable && bestAddressable,
    hardOnly: decodedImages.length > 0 && decodedImages.every((i) => i.shotClass === 'HARD'),
  };
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function countBy(items: (string | number)[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[String(item)] = (out[String(item)] ?? 0) + 1;
  return out;
}

function pct(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 1000) / 10;
}

function distributionOf(values: number[]) {
  if (values.length === 0) return { count: 0, min: 0, median: 0, p75: 0, p95: 0, max: 0, mean: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
  return {
    count: sorted.length,
    min: sorted[0],
    median: at(50),
    p75: at(75),
    p95: at(95),
    max: sorted[sorted.length - 1],
    mean: Math.round((sorted.reduce((a, b) => a + b, 0) / sorted.length) * 1000) / 1000,
  };
}

async function main() {
  const anonKey = process.env.GATE_E_STAGING_ANON_KEY;
  if (!anonKey) {
    console.error('[catalog] GATE_E_STAGING_ANON_KEY is not set. Refusing to run — no real-product fetch may proceed without an explicit credential in the environment (never hardcoded in source).');
    process.exit(1);
  }
  const targetCount = Number(process.env.CATALOG_TARGET ?? 1200);
  const pagesPerStratum = Number(process.env.CATALOG_PAGES_PER_STRATUM ?? 12);
  const concurrency = Number(process.env.CATALOG_CONCURRENCY ?? 6);
  /** Transient corpus cache. Holds image URLs — deliberately defaulted outside the repo tree. */
  const cachePath = process.env.CATALOG_CORPUS_CACHE ?? '';

  const startedAt = new Date().toISOString();
  const assembleStart = Date.now();

  // ── Corpus cache ──────────────────────────────────────────────────────
  // The provider enforces a hard rate limit (measured: HTTP 429 after ~28
  // requests — see catalog-characterization-query-log.json), so an assembled
  // corpus is genuinely scarce. `assembleLargeCorpus` now owns the cache
  // entirely and works at PAGE granularity: it skips pages already cached,
  // persists each new page the moment it arrives, and stops issuing requests
  // once the provider starts refusing. Re-running is therefore cheap and
  // strictly reduces provider load.
  //
  // The cache holds image URLs, so it is written OUTSIDE the repository and
  // must never be committed (§57); committed evidence carries only hashes,
  // dimensions, formats and classifications.
  const assembled = await assembleLargeCorpus(anonKey, targetCount, pagesPerStratum, cachePath);
  const products = assembled.products;
  const queryLog = assembled.queryLog;
  const rawSeen = assembled.rawSeen;
  const skippedNoPhotos = assembled.skippedNoPhotos;
  const corpusSource: 'provider' | 'cache' | 'cache+provider' =
    assembled.newRequests === 0 ? 'cache' : assembled.cachedPagesReused > 0 ? 'cache+provider' : 'provider';

  if (products.length === 0) {
    console.error('[catalog] no products available: the cache is empty and the provider returned nothing usable.');
    if (assembled.rateLimited) {
      console.error('[catalog] the provider rate-limited this run (HTTP 429). No page was obtained, so there is nothing to characterize.');
      console.error('[catalog] Re-run when the quota window reopens; any pages already cached will not be re-fetched.');
    }
    process.exit(2);
  }
  const assembleMs = Date.now() - assembleStart;
  console.log(
    '[catalog] corpus ready: ' + products.length + ' unique products in ' + (assembleMs / 1000).toFixed(1) + 's — ' +
      assembled.newRequests + ' new provider request(s), ' + assembled.cachedPagesReused + ' cached page(s) reused' +
      (assembled.rateLimited ? ' (stopped early: provider rate limit)' : ''),
  );

  const characterizeStart = Date.now();
  console.log('[catalog] characterizing every authoritative image candidate (concurrency ' + concurrency + ')...');
  let done = 0;
  const characterized = await mapWithConcurrency(products, concurrency, async (p) => {
    const result = await characterizeProduct(p);
    done++;
    if (done % 100 === 0) console.log('[catalog]   ' + done + '/' + products.length);
    return result;
  });
  const characterizeMs = Date.now() - characterizeStart;

  // ── §2 ADDRESSABILITY MATH ──
  const totalProducts = characterized.length;
  const allImages = characterized.flatMap((p) => p.images);
  const decodedImages = allImages.filter((i) => i.ok);
  const totalImages = allImages.length;

  const imagesPerProduct = characterized.map((p) => p.imageCandidateCount);
  const multiImageProducts = characterized.filter((p) => p.imageCandidateCount > 1);

  const productsWithEasy = characterized.filter((p) => p.images.some((i) => i.shotClass === 'EASY'));
  const productsWithMedium = characterized.filter((p) => p.images.some((i) => i.shotClass === 'MEDIUM'));
  const productsAddressable = characterized.filter((p) => p.bestAddressable);
  const heroAddressableProducts = characterized.filter((p) => p.heroAddressable);
  const rescued = characterized.filter((p) => p.rescuedByAlternate);
  const hardOnlyProducts = characterized.filter((p) => p.hardOnly);

  // ── §19 HARD SUBDIVISION ──
  const hardImages = decodedImages.filter((i) => i.shotClass === 'HARD');
  const hardSubdivision = countBy(hardImages.map((i) => i.hardTractability ?? 'HARD_UNKNOWN'));

  // ── Preflight distributions (§25) ──
  const pf = decodedImages.map((i) => i.preflight).filter((p): p is SourcePreflight => p !== null);
  const preflightDistributions = {
    shortSidePx: distributionOf(pf.map((p) => p.shortSidePx)),
    backgroundUniformity: distributionOf(pf.map((p) => p.backgroundUniformity)),
    foregroundCoverage: distributionOf(pf.map((p) => p.foregroundCoverage)),
    totalComponentCount: distributionOf(pf.map((p) => p.totalComponentCount)),
    significantComponentCount: distributionOf(pf.map((p) => p.significantComponentCount)),
    largestComponentRatio: distributionOf(pf.map((p) => p.largestComponentRatio)),
    garmentOccupancy: distributionOf(pf.map((p) => p.garmentOccupancy)),
    borderContactEdges: distributionOf(pf.map((p) => p.borderContactEdges)),
    paddingTotalFraction: distributionOf(pf.map((p) => p.padding.totalFraction)),
    paddingAsymmetry: distributionOf(pf.map((p) => p.padding.asymmetry)),
    contrast: distributionOf(pf.map((p) => p.contrast)),
    sharpnessProxy: distributionOf(pf.map((p) => p.sharpnessProxy)),
    skinRatioProxy: distributionOf(pf.map((p) => p.skinRatioProxy)),
  };

  const summary = {
    schema: 'vto-phase4-2-catalog-characterization/1',
    generatedAt: new Date().toISOString(),
    startedAt,
    boundaries: {
      commercePath: 'product-search-deals (staging, already-deployed, already-authorized)',
      scraping: false,
      retailerIntegrationsAdded: 0,
      alternateUrlsInvented: 0,
      pdpBrowsing: false,
      productionMutation: false,
      stagingMutation: false,
      externalCvCalls: 0,
      generativeCalls: 0,
      sourceBytesRetained: 0,
    },
    corpus: {
      uniqueProductsCharacterized: totalProducts,
      targetRequested: targetCount,
      providerRequests: queryLog.length,
      providerRawRecordsSeen: rawSeen,
      skippedRecordsWithNoPhotos: skippedNoPhotos,
      strataQueried: QUERY_STRATA.length,
      pagesPerStratumRequested: pagesPerStratum,
      providerMaxLimitPerRequest: PROVIDER_MAX_LIMIT,
      corpusSource,
      newProviderRequests: assembled.newRequests,
      cachedPagesReused: assembled.cachedPagesReused,
      rateLimitedThisRun: assembled.rateLimited,
      visualDistribution: countBy(characterized.map((p) => p.visual)),
      assembleDurationMs: assembleMs,
      characterizeDurationMs: characterizeMs,
      httpStatusDistribution: countBy(queryLog.map((q) => q.httpStatus)),
      rateLimitResponses: queryLog.filter((q) => q.httpStatus === 429).length,
    },
    imagesPerProduct: {
      totalAuthoritativeImages: totalImages,
      distribution: countBy(imagesPerProduct),
      stats: distributionOf(imagesPerProduct),
      productsWithMoreThanOneImage: multiImageProducts.length,
      productsWithMoreThanOneImagePct: pct(multiImageProducts.length, totalProducts),
      imageHostDistribution: countBy(allImages.map((i) => i.host)),
    },
    decode: {
      imagesAttempted: totalImages,
      imagesDecoded: decodedImages.length,
      imagesFailed: totalImages - decodedImages.length,
      decodePassRatePct: pct(decodedImages.length, totalImages),
      formatDistribution: countBy(decodedImages.map((i) => i.format ?? 'unknown')),
      failureCodeDistribution: countBy(allImages.filter((i) => !i.ok).map((i) => i.failureCode ?? 'unknown')),
    },
    heroShotDistribution: countBy(characterized.map((p) => p.heroShotClass ?? 'UNDECODED')),
    allImageShotDistribution: countBy(decodedImages.map((i) => i.shotClass ?? 'UNDECODED')),
    productLevelAddressability: {
      totalProducts,
      productsWithAtLeastOneEasyImage: productsWithEasy.length,
      productsWithAtLeastOneMediumImage: productsWithMedium.length,
      productsWithAtLeastOneAddressableImage: productsAddressable.length,
      productLevelAddressablePct: pct(productsAddressable.length, totalProducts),
      heroOnlyAddressable: heroAddressableProducts.length,
      heroOnlyAddressablePct: pct(heroAddressableProducts.length, totalProducts),
      addressabilityGainPoints:
        Math.round((pct(productsAddressable.length, totalProducts) - pct(heroAddressableProducts.length, totalProducts)) * 10) / 10,
      productsWithOnlyHardImagery: hardOnlyProducts.length,
      productsWithOnlyHardImageryPct: pct(hardOnlyProducts.length, totalProducts),
    },
    multiImageRescue: {
      productsWithMoreThanOneImage: multiImageProducts.length,
      heroHardButAlternateAddressable: rescued.length,
      heroHardButAlternateAddressablePct: pct(rescued.length, totalProducts),
      productsRescuedByAlternateImage: rescued.length,
      rescuedProductRefs: rescued.map((p) => p.productRef),
      catalogCoverageBeforeRescuePct: pct(heroAddressableProducts.length, totalProducts),
      catalogCoverageAfterRescuePct: pct(productsAddressable.length, totalProducts),
      note:
        multiImageProducts.length === 0
          ? 'ZERO products in this corpus carry more than one authoritative image, so multi-image rescue has no material to act on. This is a property of the SOURCE, not of the selection code: the rescue path is implemented and unit-tested, and would fire the moment a product carries an addressable alternate.'
          : 'Rescue measured over products carrying more than one authoritative image.',
    },
    hardSubdivision: {
      totalHardImages: hardImages.length,
      HARD_TRACTABLE: hardSubdivision.HARD_TRACTABLE ?? 0,
      HARD_INTRACTABLE: hardSubdivision.HARD_INTRACTABLE ?? 0,
      HARD_UNKNOWN: hardSubdivision.HARD_UNKNOWN ?? 0,
      tractablePct: pct(hardSubdivision.HARD_TRACTABLE ?? 0, hardImages.length),
      intractablePct: pct(hardSubdivision.HARD_INTRACTABLE ?? 0, hardImages.length),
      unknownPct: pct(hardSubdivision.HARD_UNKNOWN ?? 0, hardImages.length),
      note: 'PLANNING DIAGNOSTIC ONLY. No HARD image is LIVE2D_ELIGIBLE in Phase 4.2; HARD_TRACTABLE means "worth researching later", never "accept now".',
    },
    preflightDistributions,
  };

  const evidenceRoot = join(repoRoot(), 'evidence', 'vto-phase4-2');
  mkdirSync(evidenceRoot, { recursive: true });

  const lines = characterized.map((p) =>
    JSON.stringify({
      productRef: p.productRef,
      visual: p.visual,
      imageCandidateCount: p.imageCandidateCount,
      heroShotClass: p.heroShotClass,
      heroAddressable: p.heroAddressable,
      bestShotClass: p.bestShotClass,
      bestAddressable: p.bestAddressable,
      bestImageIndex: p.bestImageIndex,
      rescuedByAlternate: p.rescuedByAlternate,
      hardOnly: p.hardOnly,
      images: p.images,
    }),
  );
  writeFileSync(join(evidenceRoot, 'catalog-characterization.jsonl'), lines.join('\n') + '\n');
  writeFileSync(join(evidenceRoot, 'catalog-characterization-summary.json'), JSON.stringify(summary, null, 2));
  writeFileSync(
    join(evidenceRoot, 'catalog-characterization-query-log.json'),
    JSON.stringify({ schema: 'vto-phase4-2-query-log/1', requests: queryLog }, null, 2),
  );

  const a = summary.productLevelAddressability;
  console.log('');
  console.log('[catalog] ── ADDRESSABILITY MATH (§2) ──');
  console.log('  TOTAL PRODUCTS CHARACTERIZED : ' + a.totalProducts);
  console.log('  TOTAL AUTHORITATIVE IMAGES   : ' + summary.imagesPerProduct.totalAuthoritativeImages);
  console.log('  IMAGES/PRODUCT DISTRIBUTION  : ' + JSON.stringify(summary.imagesPerProduct.distribution));
  console.log('  PRODUCTS WITH >1 IMAGE       : ' + summary.imagesPerProduct.productsWithMoreThanOneImage + ' (' + summary.imagesPerProduct.productsWithMoreThanOneImagePct + '%)');
  console.log('  HERO-ONLY ADDRESSABLE        : ' + a.heroOnlyAddressable + ' (' + a.heroOnlyAddressablePct + '%)');
  console.log('  PRODUCT-LEVEL ADDRESSABLE    : ' + a.productsWithAtLeastOneAddressableImage + ' (' + a.productLevelAddressablePct + '%)');
  console.log('  GAIN FROM MULTI-IMAGE RESCUE : +' + a.addressabilityGainPoints + ' points');
  console.log('  PRODUCTS WITH ONLY HARD      : ' + a.productsWithOnlyHardImagery + ' (' + a.productsWithOnlyHardImageryPct + '%)');
  console.log('  HARD SUBDIVISION             : ' + JSON.stringify(summary.hardSubdivision));
  console.log('  evidence -> ' + evidenceRoot);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
