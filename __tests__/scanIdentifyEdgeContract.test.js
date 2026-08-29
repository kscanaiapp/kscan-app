const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EDGE_SOURCE = fs.readFileSync(path.join(ROOT, 'supabase/functions/scan-identify/index.ts'), 'utf8');

// ── 1. CORS and Auth Contract ──

test('edge source: CORS OPTIONS preflight is handled', () => {
  assert.ok(EDGE_SOURCE.includes("req.method === 'OPTIONS'"), 'Must handle OPTIONS preflight');
  assert.ok(EDGE_SOURCE.includes('Access-Control-Allow-Origin'), 'Must include CORS allow-origin');
  assert.ok(EDGE_SOURCE.includes('Access-Control-Allow-Methods'), 'Must include CORS allow-methods');
});

test('edge source: text mode remains authenticated', () => {
  assert.ok(EDGE_SOURCE.includes('isEligiblePaidAIActor'), 'Text mode must be gated by the paid-AI actor authority');
  assert.ok(EDGE_SOURCE.includes("auth.getUser()"), 'Must verify signed-in users with getUser');
  assert.ok(EDGE_SOURCE.includes("{ error: 'Not authenticated' }"), 'Must return auth error for protected paths');
});

// Build 32 P1-B regression guard (SEC-2026-001 / SEC-2026-002).
//
// A prior version of this suite required the OPPOSITE of what is asserted
// below: it named and defended a "project-key analysis-only" path that let
// any caller holding the public/publishable anon key reach paid Gemini image
// inference with no user JWT at all, and let a freely-mintable Supabase
// anonymous identity do the same. That path is a defect, not a feature — see
// the launch security audit, SEC-2026-001 and SEC-2026-002 — and has been
// removed. This test exists to make sure it cannot silently come back.
test('edge source: paid image inference requires a real, non-anonymous K Scan AI account', () => {
  // One authoritative rule, defined once, deciding actor eligibility for
  // BOTH text and image identification. Not a per-mode duplicate.
  const definitionCount = EDGE_SOURCE.split('const isEligiblePaidAIActor =').length - 1;
  assert.equal(definitionCount, 1, 'isEligiblePaidAIActor must be defined exactly once');
  assert.ok(
    EDGE_SOURCE.includes('const isEligiblePaidAIActor = auth.isAuthenticated && !auth.isAnonymous'),
    'Eligibility must require both a verified session AND a non-anonymous identity',
  );

  // The old defective rule must not exist in any form: a public/publishable
  // key (hasProjectAccess) may no longer stand in for actor authorization,
  // in this file or as a fallback alongside the new rule.
  assert.equal(
    EDGE_SOURCE.includes('isAnonymousImageAnalysis && !auth.hasProjectAccess'),
    false,
    'The old project-key-only authorization path must be removed, not kept as a fallback',
  );
  assert.equal(
    /if\s*\(\s*!?isEligiblePaidAIActor\s*(&&|\|\|)\s*[^)]*hasProjectAccess/.test(EDGE_SOURCE),
    false,
    'hasProjectAccess must not be combined into the paid-AI actor decision, even as a fallback',
  );

  // No "verification error → continue anyway" fallback. A JWT that fails
  // verification must be indistinguishable, for authorization purposes, from
  // no JWT at all — both already produce isAuthenticated: false.
  assert.equal(
    EDGE_SOURCE.includes('image_auth_fallback_to_analysis_only'),
    false,
    'A JWT verification error must not fall back to an analysis-only path',
  );

  // Anonymous identity is read off the already-verified getUser() response —
  // no second network call to determine eligibility.
  assert.ok(
    EDGE_SOURCE.includes('isAnonymous: boolean'),
    'AuthContext must carry an explicit isAnonymous signal',
  );
  assert.ok(
    EDGE_SOURCE.includes('is_anonymous'),
    'isAnonymous must be read from the verified Supabase user record',
  );

  // The gate must run before any Gemini call, for either mode.
  const gateIndex = EDGE_SOURCE.indexOf('const isEligiblePaidAIActor');
  const geminiIndex = EDGE_SOURCE.indexOf('fetch(buildGeminiUrl(');
  assert.ok(gateIndex !== -1 && geminiIndex !== -1 && gateIndex < geminiIndex,
    'Actor eligibility must be decided before any Gemini call');

  // MODE B (commerce-only, no bearer token by design) is a separate surface
  // that never reaches Gemini and is unaffected by this authority — it must
  // still be dispatched before this gate runs.
  const modeBIndex = EDGE_SOURCE.indexOf('MODE B: commerce-only request');
  assert.ok(modeBIndex !== -1 && modeBIndex < gateIndex,
    'MODE B must remain dispatched before the paid-AI actor gate, and must not be folded into it');
});

// ── 2. Text Mode Contract ──

test('edge source: text mode accepts request without imageBase64', () => {
  assert.ok(EDGE_SOURCE.includes("mode === 'text'"), 'Must branch on text mode');
  assert.ok(EDGE_SOURCE.includes('textQuery'), 'Must accept textQuery');
});

test('edge source: text mode rejects empty textQuery', () => {
  assert.ok(EDGE_SOURCE.includes("if (!textQuery)"), 'Must check empty textQuery');
});

test('edge source: text mode validates textQuery length', () => {
  assert.ok(EDGE_SOURCE.includes('MAX_TEXT_QUERY_LEN'), 'Must define max text query length');
});

test('edge source: text mode rejects invalid textQuery', () => {
  assert.ok(EDGE_SOURCE.includes('validateTextQuery'), 'Must have text query validation');
});

test('edge source: text mode handles long input safely', () => {
  assert.ok(EDGE_SOURCE.includes('MAX_TEXT_QUERY_LEN'), 'Must cap text query length');
});

// ── 3. Image Mode Backward Compatibility ──

test('edge source: image mode remains backward-compatible', () => {
  assert.ok(EDGE_SOURCE.includes('imageBase64'), 'Must accept imageBase64');
  assert.ok(EDGE_SOURCE.includes('MAX_IMAGE_BASE64_BYTES'), 'Must guard image size');
});

test('edge source: image mode works without explicit mode field', () => {
  assert.ok(EDGE_SOURCE.includes("typeof body.mode === 'string'") && EDGE_SOURCE.includes("'image'"), 'Must default to image mode');
});

test('edge source: image failures return safe app-compatible shape', () => {
  assert.ok(EDGE_SOURCE.includes('NO_IMAGE_PROVIDED_MESSAGE'), 'Must return explicit no-image message');
  assert.ok(EDGE_SOURCE.includes('INVALID_IMAGE_MESSAGE'), 'Must return explicit invalid-image message');
  assert.ok(EDGE_SOURCE.includes('identification:'), 'Must always include identification object');
  assert.ok(EDGE_SOURCE.includes('attributes:'), 'Must always include attributes object');
  assert.ok(EDGE_SOURCE.includes('products:'), 'Must always include products array');
  assert.ok(EDGE_SOURCE.includes('purchaseOptions:'), 'Must always include purchaseOptions array');
  assert.ok(EDGE_SOURCE.includes('similarityMatches:'), 'Must always include similarityMatches array');
  assert.ok(EDGE_SOURCE.includes('shoppingMeta:'), 'Must always include shoppingMeta object');
});

test('edge source: invalid image payload is rejected before Gemini', () => {
  const validationIndex = EDGE_SOURCE.indexOf('validateImageBase64(imageBase64)');
  const geminiIndex = EDGE_SOURCE.indexOf('fetch(buildGeminiUrl(');
  assert.ok(validationIndex !== -1, 'Must validate image base64');
  assert.ok(geminiIndex !== -1, 'Must call Gemini after validation');
  assert.ok(validationIndex < geminiIndex, 'Image validation must run before Gemini');
});

test('edge source: anonymous image scans are rate-limited before Gemini', () => {
  const rateLimitIndex = EDGE_SOURCE.indexOf('checkAnonymousImageRateLimit');
  const geminiIndex = EDGE_SOURCE.indexOf('fetch(buildGeminiUrl(');
  assert.ok(EDGE_SOURCE.includes('ANON_SCAN_RATE_LIMIT_WINDOW_MS'), 'Must define anonymous limiter window');
  assert.ok(EDGE_SOURCE.includes('ANON_SCAN_RATE_LIMIT_MAX'), 'Must define anonymous limiter maximum');
  assert.ok(rateLimitIndex !== -1, 'Must check anonymous rate limit');
  assert.ok(geminiIndex !== -1, 'Must call Gemini after rate limit');
  assert.ok(rateLimitIndex < geminiIndex, 'Anonymous rate limit must run before Gemini');
  assert.ok(EDGE_SOURCE.includes('retryAfterSeconds'), 'Limited response must include retryAfterSeconds');
});

test('edge source: Render fallback is not reintroduced', () => {
  assert.equal(EDGE_SOURCE.includes('render.com'), false, 'Must not reference Render');
  assert.equal(EDGE_SOURCE.includes('/api/analyze'), false, 'Must not call legacy analyze fallback');
});

// ── 4. Kill Switch and Env Vars ──

test('edge source: kill switch disables AI', () => {
  assert.ok(EDGE_SOURCE.includes('SCAN_IDENTIFY_AI_ENABLED'), 'Must reference kill switch env var');
  assert.ok(EDGE_SOURCE.includes("'false'"), 'Must check false value');
});

test('edge source: missing Gemini key returns safe error', () => {
  assert.ok(EDGE_SOURCE.includes("Deno.env.get('GEMINI_API_KEY')"), 'Must read GEMINI_API_KEY');
  assert.ok(EDGE_SOURCE.includes("error: 'AI provider not configured'"), 'Must return safe error for missing key');
  assert.ok(EDGE_SOURCE.includes("normalized('failed'"), 'Missing-key response must use normalized safe shape');
});

test('edge source: env var audit lists expected variables', () => {
  assert.ok(EDGE_SOURCE.includes("Deno.env.get('GEMINI_API_KEY')"), 'Must reference GEMINI_API_KEY');
  assert.ok(EDGE_SOURCE.includes('SCAN_GEMINI_MODEL'), 'Must reference SCAN_GEMINI_MODEL');
  assert.ok(EDGE_SOURCE.includes('GEMINI_MODEL'), 'Must reference GEMINI_MODEL fallback');
  assert.ok(EDGE_SOURCE.includes('SCAN_IDENTIFY_AI_ENABLED'), 'Must reference SCAN_IDENTIFY_AI_ENABLED');
  assert.ok(EDGE_SOURCE.includes("Deno.env.get('SUPABASE_URL')"), 'Must reference SUPABASE_URL');
  assert.ok(EDGE_SOURCE.includes("Deno.env.get('SUPABASE_ANON_KEY')"), 'Must reference SUPABASE_ANON_KEY');
});

// ── 5. Gemini Response Handling ──

test('edge source: malformed Gemini JSON is handled safely', () => {
  assert.ok(EDGE_SOURCE.includes('parseModelJson'), 'Must have parseModelJson helper');
  assert.ok(EDGE_SOURCE.includes('model_json_unparseable'), 'Must log parse failure');
});

test('edge source: markdown-fenced JSON is parsed correctly', () => {
  assert.ok(EDGE_SOURCE.includes('parseModelJson'), 'Must have parseModelJson helper');
  assert.ok(EDGE_SOURCE.includes('```'), 'Must handle markdown fences');
});

test('edge source: Gemini timeout returns user-safe failure', () => {
  assert.ok(EDGE_SOURCE.includes('AbortController'), 'Must use AbortController for timeout');
  assert.ok(EDGE_SOURCE.includes('AbortError'), 'Must catch AbortError');
  assert.ok(EDGE_SOURCE.includes('SAFE_FAILED_MESSAGE'), 'Must return safe message on timeout');
});

test('edge source: error response does not leak secrets', () => {
  // Verify no raw error text is returned to client
  assert.ok(EDGE_SOURCE.includes('SAFE_FAILED_MESSAGE'), 'Must use safe failure message');
  assert.ok(EDGE_SOURCE.includes('SAFE_TEXT_FAILED_MESSAGE'), 'Must use safe text failure message');
  assert.ok(EDGE_SOURCE.includes('SAFE_NON_FASHION_MESSAGE'), 'Must use safe non-fashion message');
  assert.ok(EDGE_SOURCE.includes('SAFE_TEXT_NON_FASHION_MESSAGE'), 'Must use safe text non-fashion message');
  // Verify stack traces are not returned
  assert.equal(EDGE_SOURCE.includes('err.stack'), false, 'Must not reference stack traces in responses');
  assert.equal(EDGE_SOURCE.includes('"stack"'), false, 'Must not include stack in JSON responses');
});

// ── 6. Source Field Preservation ──

test('edge source: source field is preserved in request parsing', () => {
  assert.ok(EDGE_SOURCE.includes('source?:'), 'Must accept source in request type');
  assert.ok(EDGE_SOURCE.includes('source'), 'Must reference source in body parsing');
});

test('edge source: source field is preserved in logs', () => {
  assert.ok(EDGE_SOURCE.includes('source'), 'Must log source field');
});

// ── 7. Structured Output ──

test('edge source: structured output uses responseMimeType application/json', () => {
  assert.ok(EDGE_SOURCE.includes("responseMimeType: 'application/json'"), 'Must use JSON response mime type');
});

// ── 8. Non-Fashion Response ──

test('edge source: non-fashion response is handled correctly', () => {
  assert.ok(EDGE_SOURCE.includes('non_fashion'), 'Must handle non_fashion status');
  assert.ok(EDGE_SOURCE.includes('SAFE_NON_FASHION_MESSAGE'), 'Must use safe non-fashion message');
  assert.ok(EDGE_SOURCE.includes('SAFE_TEXT_NON_FASHION_MESSAGE'), 'Must use safe text non-fashion message');
});

test('edge source: non-fashion scans never surface catalog products', () => {
  // A non-fashion scan can still carry a plausible item_type from the model;
  // the branch must force an empty shelf rather than fetch catalog rows.
  assert.ok(
    EDGE_SOURCE.includes('Non-fashion scans never surface catalog products'),
    'Must document forced-empty shelf for non-fashion',
  );
  assert.equal(
    EDGE_SOURCE.includes('nonFashionCatalogCandidates'),
    false,
    'Must not fetch catalog candidates in the non-fashion branch',
  );
});

// ── 9. Request Validation Parity ──

test('edge source: text validation matches client-side rules', () => {
  assert.ok(EDGE_SOURCE.includes('validateTextQuery'), 'Must have validateTextQuery function');
  // Check that the same validation rules exist server-side
  assert.ok(EDGE_SOURCE.includes('length < 3'), 'Must reject too-short queries');
  assert.ok(EDGE_SOURCE.includes('length > MAX_TEXT_QUERY_LEN'), 'Must reject too-long queries');
  assert.ok(EDGE_SOURCE.includes('A-Za-z0-9+/') && EDGE_SOURCE.includes('{40,}'), 'Must reject base64 payloads');
  assert.ok(EDGE_SOURCE.includes("'```'"), 'Must reject code blocks');
  assert.ok(EDGE_SOURCE.includes('ignore previous instructions'), 'Must reject prompt injection');
  assert.ok(EDGE_SOURCE.includes('[\\w.+-]+@[\\w.-]+\\.\\w+'), 'Must reject email addresses');
  assert.ok(EDGE_SOURCE.includes('(\\+?\\d[\\d\\s-]{7,}\\d)'), 'Must reject phone numbers');
  assert.ok(EDGE_SOURCE.includes('\\b\\d{3}[\\s-]\\d{2}[\\s-]\\d{4}\\b'), 'Must reject SSN-like patterns');
  assert.ok(EDGE_SOURCE.includes('0.30'), 'Must reject excessive non-alphanumeric chars');
});

// ── 10. Deployment Readiness ──

test('edge source: no Node.js-only APIs are used', () => {
  assert.equal(EDGE_SOURCE.includes('process.env'), false, 'Must not use process.env');
  assert.equal(EDGE_SOURCE.includes('require('), false, 'Must not use require()');
  assert.equal(EDGE_SOURCE.includes('module.exports'), false, 'Must not use module.exports');
  assert.equal(EDGE_SOURCE.includes('Buffer'), false, 'Must not use Buffer');
  assert.equal(EDGE_SOURCE.includes('fs.'), false, 'Must not use fs module');
  assert.equal(EDGE_SOURCE.includes('path.'), false, 'Must not use path module');
});

test('edge source: Deno.serve is present', () => {
  assert.ok(EDGE_SOURCE.includes('Deno.serve'), 'Must use Deno.serve');
});

test('edge source: routing is allowlist-bound with no retired model', () => {
  // Android v26: Scanner runs gemini-3.6-flash with one gemini-3.5-flash-lite
  // fallback; TextScan is pinned to gemini-3.5-flash-lite with one same-model
  // retry. No retired identifier may remain, and the generic GEMINI_MODEL
  // variable must not influence routing.
  assert.equal(/gemini-1\.5|gemini-2\.0|gemini-2\.5/.test(EDGE_SOURCE), false, 'No retired model');
  assert.equal(EDGE_SOURCE.includes("readTrimmedEnv('GEMINI_MODEL')"), false, 'No generic override');
  assert.ok(
    EDGE_SOURCE.includes("resolveRoutePlan(mode === 'text' ? 'textscan' : 'scanner'"),
    'Surface routing is resolved through the shared allowlist',
  );
  assert.ok(EDGE_SOURCE.includes('nextAttemptModel(routePlan, attempt)'), 'Attempts are plan-bound');
});

test('edge source: text mode and image mode share auth, timeout, and error handling', () => {
  assert.ok(EDGE_SOURCE.includes('auth.getUser'), 'Auth is shared');
  assert.ok(EDGE_SOURCE.includes('AbortController'), 'Timeout is shared');
  assert.ok(EDGE_SOURCE.includes('SAFE_FAILED_MESSAGE'), 'Error handling is shared');
});

test('edge source: CORS headers are valid for browser/web clients', () => {
  assert.ok(EDGE_SOURCE.includes('Access-Control-Allow-Origin'), 'Must have allow-origin');
  assert.ok(EDGE_SOURCE.includes('Access-Control-Allow-Headers'), 'Must have allow-headers');
  assert.ok(EDGE_SOURCE.includes('authorization'), 'Must allow authorization header');
  assert.ok(EDGE_SOURCE.includes('content-type'), 'Must allow content-type header');
});

// ── 11. Image Base64 Not Required for Text Mode ──

test('edge source: imageBase64 is not required for text mode', () => {
  assert.ok(EDGE_SOURCE.includes('imageBase64?:'), 'Must make imageBase64 optional');
  assert.ok(EDGE_SOURCE.includes('textQuery?:'), 'Must make textQuery optional');
});

// ── 12. Future Source Compatibility ──

test('edge source: accepts unknown source values without crashing', () => {
  assert.ok(EDGE_SOURCE.includes('source?:'), 'Must accept optional source');
  // The source should be used for logging, not for routing or auth bypass
  assert.ok(EDGE_SOURCE.includes('source'), 'Must reference source in logs');
});

// ── 13. Mode-Specific Provider Routing ──

test('edge source: text mode calls live shopping APIs', () => {
  assert.ok(
    EDGE_SOURCE.includes('getShoppingResults('),
    'Must retain getShoppingResults for flag-off TextScan commerce',
  );
  assert.ok(
    EDGE_SOURCE.includes('getScanCommerceResults('),
    'Must support getScanCommerceResults for TextScan parity ON',
  );

  // Locate the product-recommendations text branch.
  const firstTextBranch = EDGE_SOURCE.indexOf("if (mode === 'text')");
  assert.ok(firstTextBranch !== -1, "Must have 'if (mode === \\'text\\')' branch");

  const secondTextBranch = EDGE_SOURCE.indexOf("if (mode === 'text')", firstTextBranch + 1);
  const productRecBranchStart = secondTextBranch !== -1 ? secondTextBranch : firstTextBranch;

  // Commerce calls may live in nested if/else (parity ON vs repaired-v122 OFF).
  const shoppingCallIndex = EDGE_SOURCE.indexOf('getShoppingResults(', productRecBranchStart);
  const routerCallIndex = EDGE_SOURCE.indexOf('getScanCommerceResults(', productRecBranchStart);
  assert.ok(
    shoppingCallIndex > productRecBranchStart || routerCallIndex > productRecBranchStart,
    'Text mode product branch must call getShoppingResults and/or getScanCommerceResults',
  );
  assert.ok(
    EDGE_SOURCE.includes('allowTextMode: true'),
    'Parity ON TextScan must pass allowTextMode to the commerce router',
  );
});

test('edge source: image mode uses catalog retrieval plus the commerce router fallback', () => {
  const imageBranchStart = EDGE_SOURCE.indexOf('} else {');
  assert.ok(imageBranchStart !== -1, 'Must have an else branch for image mode');

  const imageBranch = EDGE_SOURCE.slice(imageBranchStart);
  assert.ok(
    imageBranch.includes('fetchCatalogCandidates('),
    'Image mode must use fetchCatalogCandidates for catalog retrieval',
  );
  assert.ok(
    imageBranch.includes('getScanCommerceResults('),
    'Image mode must call the camera commerce router fallback',
  );
  assert.ok(
    imageBranch.includes('findSimilarityMatches('),
    'Image mode must score catalog candidates with the similarity matcher',
  );
  assert.ok(
    imageBranch.includes('similarityMatches'),
    'Image mode must return a similarityMatches array',
  );
  assert.ok(
    imageBranch.includes('commerce:'),
    'Image mode must include commerce diagnostics',
  );
});

test('edge source: image mode generates a fresh scanId for metadata capture', () => {
  assert.ok(
    EDGE_SOURCE.includes("mode === 'image' ? crypto.randomUUID() : requestScanId"),
    'Image mode must generate a fresh scanId',
  );
  assert.ok(
    EDGE_SOURCE.includes('scanId'),
    'Image responses should preserve scanId as an optional field',
  );
});

test('edge source: image mode captures scan intelligence with timeout protection', () => {
  assert.ok(
    EDGE_SOURCE.includes('captureScanIntelligence'),
    'Must invoke scan intelligence capture from the edge function',
  );
  assert.ok(
    EDGE_SOURCE.includes('Promise.race(['),
    'Must bound capture latency with Promise.race',
  );
  assert.ok(
    EDGE_SOURCE.includes('SCAN_INTELLIGENCE_TIMEOUT_MS = 500'),
    'Capture timeout must be capped at 500ms',
  );
  assert.ok(
    EDGE_SOURCE.includes('appPlatform') && EDGE_SOURCE.includes('appVersion'),
    'Must pass through optional app metadata when present',
  );
});

test('edge source: image mode commerce lookup has a 3000ms Promise.race timeout guard', () => {
  assert.ok(
    EDGE_SOURCE.includes('IMAGE_MODE_COMMERCE_TIMEOUT_MS = 3000'),
    'Image mode commerce timeout constant must be 3000ms',
  );

  const imageBranchStart = EDGE_SOURCE.indexOf('} else {');
  assert.ok(imageBranchStart !== -1, 'Must have an else branch for image mode');

  const imageBranch = EDGE_SOURCE.slice(imageBranchStart);
  assert.ok(
    imageBranch.includes('Promise.race(['),
    'Image mode commerce must be wrapped in Promise.race',
  );
  assert.ok(
    imageBranch.includes('getScanCommerceResults('),
    'Promise.race must include the live commerce call',
  );
  assert.ok(
    imageBranch.includes('.catch('),
    'Live commerce call must include a .catch() error fallback',
  );
  assert.ok(
    imageBranch.includes('setTimeout(') && imageBranch.includes('commerce_timeout'),
    'Promise.race must include a commerce_timeout timeout fallback',
  );
  assert.ok(
    imageBranch.includes('IMAGE_MODE_COMMERCE_TIMEOUT_MS'),
    'Image branch must reference the commerce timeout constant',
  );
});

test('edge source: image mode commerce error fallback returns safe empty products', () => {
  const imageBranchStart = EDGE_SOURCE.indexOf('} else {');
  assert.ok(imageBranchStart !== -1, 'Must have an else branch for image mode');

  const imageBranch = EDGE_SOURCE.slice(imageBranchStart);
  const catchIndex = imageBranch.indexOf('.catch(');
  assert.ok(catchIndex !== -1, 'Image branch must call .catch() on the commerce promise');

  const fallbackText = imageBranch.slice(catchIndex);
  assert.ok(
    fallbackText.includes("provider: 'error'") || fallbackText.includes('provider: "error"'),
    'Error fallback provider must be "error"',
  );
  assert.ok(
    fallbackText.includes('products: []'),
    'Error fallback products must be an empty array',
  );
  assert.ok(
    fallbackText.includes('providersTried: []'),
    'Error fallback providersTried must be an empty array',
  );
});

test('edge source: image mode still runs similarity matcher after commerce timeout or error', () => {
  const imageBranchStart = EDGE_SOURCE.indexOf('} else {');
  assert.ok(imageBranchStart !== -1, 'Must have an else branch for image mode');

  const imageBranch = EDGE_SOURCE.slice(imageBranchStart);
  const commerceTimeoutIndex = imageBranch.indexOf('commerce_timeout');
  const catchIndex = imageBranch.indexOf('.catch(');
  const similarityIndex = imageBranch.indexOf('buildImageSimilarityMatches');
  assert.ok(commerceTimeoutIndex !== -1, 'Image branch must handle commerce_timeout');
  assert.ok(catchIndex !== -1, 'Image branch must handle commerce errors with .catch()');
  assert.ok(similarityIndex !== -1, 'Image branch must call buildImageSimilarityMatches');
  assert.ok(
    similarityIndex > commerceTimeoutIndex && similarityIndex > catchIndex,
    'Similarity matcher must run after both the commerce timeout and error branches',
  );
});

// ── 14. Gemini Timeout and Resilience ──

test('edge source: default Gemini timeout is 14000ms when env override is absent', () => {
  assert.ok(
    EDGE_SOURCE.includes('DEFAULT_GEMINI_TIMEOUT_MS = 14_000'),
    'Default Gemini timeout must be 14000ms',
  );
});

test('edge source: SCAN_GEMINI_TIMEOUT_MS override clamps within 2000ms to 20000ms', () => {
  assert.ok(EDGE_SOURCE.includes('SCAN_GEMINI_TIMEOUT_MS'), 'Must reference SCAN_GEMINI_TIMEOUT_MS');
  assert.ok(EDGE_SOURCE.includes('parsed >= 2_000'), 'Must enforce minimum 2000ms');
  assert.ok(EDGE_SOURCE.includes('parsed <= 20_000'), 'Must enforce maximum 20000ms');
});

test('edge source: Gemini timeout logs elapsedMs and timeoutMs and returns safe failed shape', () => {
  assert.ok(EDGE_SOURCE.includes('gemini_timeout'), 'Must log gemini_timeout');
  assert.ok(EDGE_SOURCE.includes('timeoutMs=%d'), 'Must include timeoutMs in timeout log');
  assert.ok(
    EDGE_SOURCE.includes("normalized('failed', safeFailed)"),
    'Must return safe failed shape on timeout',
  );
  assert.ok(EDGE_SOURCE.includes('AbortError'), 'Must recognize AbortError');
});

test('edge source: Gemini empty or no-identification returns safe failure shape', () => {
  assert.ok(EDGE_SOURCE.includes('gemini_empty'), 'Must log gemini_empty');
  assert.ok(EDGE_SOURCE.includes('completed_without_attributes'), 'Must handle completed without attributes');
  assert.ok(
    EDGE_SOURCE.includes("normalized('failed', safeFailed)"),
    'Must return safe failed shape on empty/no-identification',
  );
});

test('edge source: Gemini success returns completed response even with empty products', () => {
  assert.ok(EDGE_SOURCE.includes('gemini_success'), 'Must log gemini_success');
  assert.ok(EDGE_SOURCE.includes('parse_success'), 'Must log parse_success');
  assert.ok(EDGE_SOURCE.includes("normalized('completed'"), 'Must return completed response');
  assert.ok(EDGE_SOURCE.includes('final_status status=completed'), 'Must log final completed status');
});

test('edge source: image commerce failure or timeout does not fail a completed scan', () => {
  assert.ok(EDGE_SOURCE.includes('commerce_timeout'), 'Must log commerce_timeout');
  assert.ok(EDGE_SOURCE.includes("provider: 'error'"), 'Must catch commerce errors');
  assert.ok(
    EDGE_SOURCE.includes('buildImageSimilarityMatches'),
    'Similarity matcher must still run after commerce issues',
  );
  assert.ok(EDGE_SOURCE.includes('final_status status=completed'), 'Must still complete after commerce issues');
});

test('edge source: text-mode shopping failure does not fail a completed Gemini interpretation', () => {
  assert.ok(EDGE_SOURCE.includes('TEXT_MODE_COMMERCE_TIMEOUT_MS'), 'Must define text commerce timeout');
  assert.ok(EDGE_SOURCE.includes('text_commerce_timeout'), 'Must handle text commerce timeout');
  assert.ok(EDGE_SOURCE.includes('.catch((err)'), 'Must catch text commerce errors');
  assert.ok(
    EDGE_SOURCE.includes('finalRecommendedProducts = []'),
    'Must fall back to empty products on text commerce failure',
  );
  assert.ok(EDGE_SOURCE.includes('final_status status=completed'), 'Must still complete after text commerce failure');
});

test('edge source: anonymous image scan skips commerce, similarity, and authenticated user writes', () => {
  assert.ok(
    EDGE_SOURCE.includes('commerce_skipped reason=anonymous_image_analysis'),
    'Must log commerce_skipped for anonymous scans',
  );
  assert.ok(
    EDGE_SOURCE.includes('similarity_skipped reason=anonymous_image_analysis'),
    'Must log similarity_skipped for anonymous scans',
  );
  assert.ok(
    EDGE_SOURCE.includes("mode === 'image' && auth.isAuthenticated"),
    'Must only capture scan intelligence for authenticated users',
  );
});

test('edge source: production stage logs are present and do not leak sensitive data', () => {
  const logLabels = [
    'request_start',
    'quota_allowed',
    'quota_rate_limited',
    'quota_check_error',
    'gemini_start',
    'gemini_success',
    'gemini_timeout',
    'gemini_http_error',
    'gemini_empty',
    'model_json_unparseable',
    'parse_success',
    'commerce_skipped',
    'commerce_started',
    'commerce_timeout',
    'similarity_skipped',
    'similarity_started',
    'similarity_timeout',
    'final_status',
  ];
  for (const label of logLabels) {
    assert.ok(
      EDGE_SOURCE.includes(`[scan-identify] ${label}`),
      `Must include production stage log: ${label}`,
    );
  }
  // Variable names like bearerToken/geminiKey are used for request handling but
  // are never logged directly; the existing 'error response does not leak secrets'
  // test covers the response contract.
});

// ── 15. Authenticated daily quota enforcement ──

test('edge source: authenticated image scan checks DB quota before Gemini', () => {
  const quotaIndex = EDGE_SOURCE.indexOf('checkAuthenticatedScanQuota');
  const geminiIndex = EDGE_SOURCE.indexOf('fetch(buildGeminiUrl(');
  assert.ok(EDGE_SOURCE.includes('checkAuthenticatedScanQuota'), 'Must call authenticated quota check');
  assert.ok(
    EDGE_SOURCE.includes('check_and_increment_scan_identify_daily_usage'),
    'Must call scan_identify daily quota RPC',
  );
  assert.ok(quotaIndex !== -1, 'Must check authenticated quota');
  assert.ok(geminiIndex !== -1, 'Must call Gemini after quota');
  assert.ok(quotaIndex < geminiIndex, 'Authenticated quota must run before Gemini');
});

test('edge source: authenticated TextScan checks DB quota before Gemini', () => {
  assert.ok(EDGE_SOURCE.includes("mode === 'text'"), 'Must branch on text mode');
  assert.ok(EDGE_SOURCE.includes('checkAuthenticatedScanQuota'), 'Must call authenticated quota check for text');
  const quotaIndex = EDGE_SOURCE.indexOf('checkAuthenticatedScanQuota');
  const geminiIndex = EDGE_SOURCE.indexOf('fetch(buildGeminiUrl(');
  assert.ok(quotaIndex < geminiIndex, 'Text scan quota must run before Gemini');
});

test('edge source: quota exceeded returns HTTP 200 rate_limited app-safe shape', () => {
  assert.ok(EDGE_SOURCE.includes("status: 'rate_limited'"), 'Must return rate_limited status');
  assert.ok(EDGE_SOURCE.includes('buildRateLimitedResponse'), 'Must use rate-limited response builder');
  assert.ok(
    EDGE_SOURCE.includes('Daily scan limit reached. Try again tomorrow.'),
    'Must include user-facing rate-limit message',
  );
  assert.ok(EDGE_SOURCE.includes("provider: 'rate_limited'"), 'Must mark shoppingMeta provider as rate_limited');
  assert.ok(EDGE_SOURCE.includes("reason: 'daily_limit'"), 'Must mark reason as daily_limit');
  assert.ok(EDGE_SOURCE.includes('recommendedProducts: []'), 'Rate-limited response must include empty recommendedProducts');
  assert.ok(EDGE_SOURCE.includes('products: []'), 'Rate-limited response must include empty products');
  assert.ok(EDGE_SOURCE.includes('purchaseOptions: []'), 'Rate-limited response must include empty purchaseOptions');
  assert.ok(EDGE_SOURCE.includes('similarityMatches: []'), 'Rate-limited response must include empty similarityMatches');
});

test('edge source: quota exceeded does not call Gemini, commerce, or similarity', () => {
  const rateLimitReturn = EDGE_SOURCE.indexOf('return json(buildRateLimitedResponse(), 200)');
  const geminiIndex = EDGE_SOURCE.indexOf('fetch(buildGeminiUrl(');
  const commerceIndex = EDGE_SOURCE.indexOf('getShoppingResults(');
  const similarityIndex = EDGE_SOURCE.indexOf('buildImageSimilarityMatches');
  assert.ok(rateLimitReturn !== -1, 'Must return early on quota exceeded');
  assert.ok(rateLimitReturn < geminiIndex, 'Rate-limited response must return before Gemini');
  assert.ok(rateLimitReturn < commerceIndex, 'Rate-limited response must return before commerce');
  assert.ok(rateLimitReturn < similarityIndex, 'Rate-limited response must return before similarity');
});

test('edge source: quota DB/RPC failure fails open and proceeds to Gemini', () => {
  assert.ok(EDGE_SOURCE.includes('quota_check_error'), 'Must log quota check errors');
  assert.ok(
    EDGE_SOURCE.includes('{ allowed: true, count: 0, limit: 0 }'),
    'Must allow scan when quota check fails',
  );
});

test('edge source: missing service role key fails open for authenticated quota', () => {
  assert.ok(
    EDGE_SOURCE.includes('reason=missing_service_role_client'),
    'Must detect missing service role client',
  );
  assert.ok(
    EDGE_SOURCE.includes('{ allowed: true, count: 0, limit: 0 }'),
    'Must allow scan when service role client missing',
  );
});

test('edge source: anonymous image scan uses anonymous guard, not DB user quota', () => {
  const anonGuardIndex = EDGE_SOURCE.indexOf('checkAnonymousImageRateLimit');
  const quotaIndex = EDGE_SOURCE.indexOf('checkAuthenticatedScanQuota');
  assert.ok(anonGuardIndex !== -1, 'Must keep anonymous image guard');
  assert.ok(quotaIndex !== -1, 'Must have authenticated quota check');
  assert.ok(
    EDGE_SOURCE.includes('if (auth.isAuthenticated && userId)'),
    'Quota check must be gated to authenticated users',
  );
  assert.ok(EDGE_SOURCE.includes('isAnonymousImageAnalysis'), 'Must preserve anonymous image analysis path');
});

test('edge source: TextScan remains authenticated-only', () => {
  assert.ok(EDGE_SOURCE.includes('isEligiblePaidAIActor'), 'Text mode must be gated by the paid-AI actor authority');
  assert.ok(EDGE_SOURCE.includes("{ error: 'Not authenticated' }"), 'Must return auth error for text mode');
});

test('edge source: quota logs do not expose full user id, tokens, image, or text', () => {
  const quotaLogLines = EDGE_SOURCE.split('\n').filter(
    (line) =>
      line.includes('quota_allowed') ||
      line.includes('quota_rate_limited') ||
      line.includes('quota_check_error'),
  );
  assert.ok(quotaLogLines.length >= 3, 'Must have quota allowed, rate-limited, and error log lines');
  for (const line of quotaLogLines) {
    assert.ok(line.includes('user=%s'), 'Quota log must truncate user id with format specifier');
    assert.equal(line.includes('imageBase64'), false, 'Quota log must not reference image payload');
    assert.equal(line.includes('textQuery'), false, 'Quota log must not reference text query');
    assert.equal(line.includes('bearerToken'), false, 'Quota log must not reference bearer token');
    assert.equal(line.includes('geminiKey'), false, 'Quota log must not reference gemini key');
  }
});

// ── Quality Tune v120 contract non-regression ──

test('edge source: quality tune modules are wired without changing response field names', () => {
  assert.ok(EDGE_SOURCE.includes('qualityTuneConfig'), 'Must import quality tune config');
  assert.ok(EDGE_SOURCE.includes('applyQualityTaxonomyTune'), 'Must apply taxonomy tune');
  assert.ok(EDGE_SOURCE.includes('isQualityTuneEnabled'), 'Must support rollback flag');
  assert.ok(EDGE_SOURCE.includes('purchaseOptions'), 'Must preserve purchaseOptions');
  assert.ok(EDGE_SOURCE.includes('detectedGarments'), 'Must preserve detectedGarments');
  assert.ok(EDGE_SOURCE.includes('scanSessionId'), 'Must preserve scanSessionId validation path');
  assert.ok(EDGE_SOURCE.includes('imageDigestPrefix'), 'Must preserve imageDigestPrefix validation path');
  assert.equal(EDGE_SOURCE.includes('requiredQualityField'), false, 'Must not add invented required fields');
});

test('edge source: scanner intelligence modules are wired without contract changes', () => {
  assert.ok(EDGE_SOURCE.includes('scannerIntelligenceConfig'), 'Must import intelligence config');
  assert.ok(EDGE_SOURCE.includes('resolveScannerCategoryRoute'), 'Must route by category');
  assert.ok(EDGE_SOURCE.includes('applyScannerQualityGate'), 'Must apply quality gate');
  assert.ok(EDGE_SOURCE.includes('isScannerIntelligenceEnabled'), 'Must support intelligence rollback flag');
  assert.ok(EDGE_SOURCE.includes('BACKEND_SCANNER_INTELLIGENCE_ENABLED') || EDGE_SOURCE.includes('isScannerIntelligenceEnabled'), 'Must gate intelligence');
  assert.equal(EDGE_SOURCE.includes('requiredQualityScore'), false, 'Must not require quality score on client');
  assert.equal(EDGE_SOURCE.includes('quality_score_value'), false, 'Must not expose quality_score_value in response builder');
  assert.ok(EDGE_SOURCE.includes('purchaseOptions'), 'Must preserve purchaseOptions');
  assert.ok(EDGE_SOURCE.includes('detectedGarments'), 'Must preserve detectedGarments');
});

test('edge source: commerce relevance modules are wired without contract changes', () => {
  assert.ok(EDGE_SOURCE.includes('commerceRelevanceConfig'), 'Must import commerce relevance config');
  assert.ok(EDGE_SOURCE.includes('isCommerceRelevanceEnabled'), 'Must support relevance rollback flag');
  assert.ok(EDGE_SOURCE.includes('COMMERCE_RELEVANCE_VERSION'), 'Must version the relevance layer');
  assert.ok(EDGE_SOURCE.includes('mapToFailureReason'), 'Must map privacy-safe failure reasons');
  assert.ok(EDGE_SOURCE.includes('relevanceRoute') || EDGE_SOURCE.includes('relevanceEnabled'), 'Must gate relevance query path');
  assert.ok(EDGE_SOURCE.includes('purchaseOptions'), 'Must preserve purchaseOptions');
  assert.equal(EDGE_SOURCE.includes('requiredAgreementScore'), false, 'Must not require agreement score on client');
});

test('edge source: quality tune does not rename products or purchaseOptions arrays', () => {
  assert.ok(EDGE_SOURCE.includes('recommendedProducts'), 'Must keep recommendedProducts');
  assert.ok(EDGE_SOURCE.includes('purchaseOptions:'), 'Must keep purchaseOptions mapping');
  assert.ok(EDGE_SOURCE.includes('similarityMatches'), 'Must keep similarityMatches');
});


// ── v122 hostile-audit regressions ──

test('edge source: commerce route is recomputed from final identification, not the pre-model prompt route', () => {
  assert.ok(
    EDGE_SOURCE.includes('const commerceCategoryRoute'),
    'Must compute a distinct post-identification commerce route (legacy_single_item and TextScan commerce must not stay stuck on the pre-model general route)'
  );
  assert.equal(
    EDGE_SOURCE.includes('relevanceRoute: categoryRoute,'),
    false,
    'Commerce relevance route must not reuse the raw pre-model categoryRoute variable'
  );
  assert.ok(
    EDGE_SOURCE.includes('relevanceRoute: commerceCategoryRoute'),
    'Image-mode commerce must pass the post-identification commerceCategoryRoute'
  );
  assert.ok(
    EDGE_SOURCE.includes('categoryRoute: commerceCategoryRoute'),
    'Text-mode filterAndDedupeProducts relevance option must use the post-identification commerceCategoryRoute'
  );
});

test('edge source: commerceRelevance telemetry reports real filter/fallback stats, not hardcoded placeholders', () => {
  assert.ok(
    EDGE_SOURCE.includes('let commerceRelevanceStats'),
    'Must capture real commerce filter stats for telemetry'
  );
  assert.equal(
    /productsBeforeFilter:\s*finalRecommendedProducts\.length,\s*\n\s*productsAfterFilter:\s*finalRecommendedProducts\.length,/.test(EDGE_SOURCE),
    false,
    'productsBeforeFilter and productsAfterFilter must not both collapse to the same final-array length'
  );
  assert.ok(
    EDGE_SOURCE.includes('commerceRelevanceStats?.fallbackUsed ?? false'),
    'commerceRelevance.fallbackUsed must reflect whether a fallback query actually ran, not a hardcoded false'
  );
});

// ── v123 TextScan parity + outcome intelligence ──

test('edge source: TextScan parity routes through getScanCommerceResults when enabled', () => {
  assert.ok(EDGE_SOURCE.includes('textScanCommerceParityConfig'), 'Must import TextScan parity config');
  assert.ok(EDGE_SOURCE.includes('isTextScanCommerceParityEnabled'), 'Must gate TextScan parity');
  assert.ok(EDGE_SOURCE.includes('TEXTSCAN_COMMERCE_PARITY_VERSION'), 'Must version TextScan parity');
  assert.ok(EDGE_SOURCE.includes('textScanParityEnabled'), 'Must compute textScanParityEnabled');
  assert.ok(
    EDGE_SOURCE.includes("allowTextMode: true"),
    'TextScan parity path must pass allowTextMode to commerce router',
  );
  assert.ok(
    EDGE_SOURCE.includes('getShoppingResults({ query: shoppingQuery, limit: 8 })'),
    'Flag-off TextScan must retain repaired-v122 getShoppingResults path',
  );
});

test('edge source: selected_item uses image commerce path after identification (not detection commerce)', () => {
  assert.ok(
    EDGE_SOURCE.includes("requestMode === 'selected_item'"),
    'Must distinguish selected_item request mode',
  );
  assert.ok(
    EDGE_SOURCE.includes('useSelectedItemProvider'),
    'Must gate selected-item provider path',
  );
  // Detection must skip product commerce; selected_item falls through to image commerce after ID.
  const detectionSkip = EDGE_SOURCE.includes('commerceSkipped') ||
    EDGE_SOURCE.includes('multi_item_detection');
  assert.ok(detectionSkip, 'Must preserve multi-item detection vs selected-item split');
  assert.ok(
    EDGE_SOURCE.includes("requestModeLabel") && EDGE_SOURCE.includes("'selected_item'"),
    'Outcome/telemetry must label selected_item distinctly',
  );
});

test('edge source: commerce outcome capture is wired fail-open', () => {
  assert.ok(EDGE_SOURCE.includes('commerceOutcomeCapture'), 'Must import outcome capture');
  assert.ok(EDGE_SOURCE.includes('captureCommerceOutcome'), 'Must call captureCommerceOutcome');
  assert.ok(EDGE_SOURCE.includes('void captureCommerceOutcome'), 'Capture must be fire-and-forget');
  assert.ok(EDGE_SOURCE.includes('requestStartedAt'), 'Early exits must use requestStartedAt, not Gemini clock');
});

test('edge source: non_fashion outcomes are captured, not silently dropped from telemetry (v120-v123 full-tree audit regression)', () => {
  // Prior to this repair, the non_fashion branch returned `finalResponse`
  // without ever calling captureCommerceOutcome, even though the outcome
  // schema explicitly supports a 'non_fashion' status and a dedicated
  // FAILURE_REASON_NON_FASHION reason. A whole legitimate outcome class was
  // structurally invisible to scan_commerce_events.
  const nonFashionBlockStart = EDGE_SOURCE.indexOf("status=non_fashion elapsedMs");
  assert.ok(nonFashionBlockStart > -1, 'non_fashion final_status log must exist');
  const nonFashionBlockEnd = EDGE_SOURCE.indexOf('if (!attributes) {', nonFashionBlockStart);
  assert.ok(nonFashionBlockEnd > nonFashionBlockStart, 'must be able to bound the non_fashion branch');
  const nonFashionBlock = EDGE_SOURCE.slice(nonFashionBlockStart, nonFashionBlockEnd);
  assert.ok(
    nonFashionBlock.includes('void captureCommerceOutcome'),
    'non_fashion branch must call captureCommerceOutcome before returning',
  );
  assert.ok(
    nonFashionBlock.includes("status: 'non_fashion'"),
    'non_fashion outcome row must use the non_fashion status, not a generic failure',
  );
  assert.ok(
    nonFashionBlock.includes('mapToFailureReason({ isNonFashion: true })'),
    'non_fashion outcome row must use the dedicated non_fashion failure reason',
  );
});

test('edge source: multi-item detection with zero valid garments is captured, not silently dropped from telemetry (v120-v123 full-tree audit regression)', () => {
  const blockStart = EDGE_SOURCE.indexOf('multi_item_no_valid_garments mode=%s');
  assert.ok(blockStart > -1, 'multi_item_no_valid_garments branch must exist');
  const blockEnd = EDGE_SOURCE.indexOf('return json(normalized(\'failed\', safeFailed), 200);', blockStart);
  assert.ok(blockEnd > blockStart, 'must be able to bound the multi_item_no_valid_garments branch');
  const block = EDGE_SOURCE.slice(blockStart, blockEnd);
  assert.ok(
    block.includes('void captureCommerceOutcome'),
    'multi_item_no_valid_garments branch must call captureCommerceOutcome before returning',
  );
  assert.ok(
    block.includes("requestMode: 'multi_item_detection'"),
    'must label the outcome row as multi_item_detection',
  );
});
