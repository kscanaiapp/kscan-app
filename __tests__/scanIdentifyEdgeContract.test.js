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

test('edge source: anonymous requests are rejected', () => {
  assert.ok(EDGE_SOURCE.includes("authHeader?.startsWith('Bearer ')"), 'Must check Bearer auth header');
  assert.ok(EDGE_SOURCE.includes("auth.getUser()"), 'Must verify auth with getUser');
  assert.ok(EDGE_SOURCE.includes("{ error: 'Not authenticated' }"), 'Must return auth error');
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

// ── 4. Kill Switch and Env Vars ──

test('edge source: kill switch disables AI', () => {
  assert.ok(EDGE_SOURCE.includes('SCAN_IDENTIFY_AI_ENABLED'), 'Must reference kill switch env var');
  assert.ok(EDGE_SOURCE.includes("'false'"), 'Must check false value');
});

test('edge source: missing Gemini key returns safe error', () => {
  assert.ok(EDGE_SOURCE.includes("Deno.env.get('GEMINI_API_KEY')"), 'Must read GEMINI_API_KEY');
  assert.ok(EDGE_SOURCE.includes("{ error: 'AI provider not configured' }"), 'Must return safe error for missing key');
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

test('edge source: default model is gemini-1.5-flash', () => {
  assert.ok(EDGE_SOURCE.includes("gemini-1.5-flash"), 'Default model must be gemini-1.5-flash');
  assert.equal(EDGE_SOURCE.includes('gemini-2.0'), false, 'Must not use gemini-2.0 in TextScan path');
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
    EDGE_SOURCE.includes('await getShoppingResults('),
    'Must call getShoppingResults for text mode commerce',
  );

  // Locate the text mode branch that handles product recommendations.
  // There are two "if (mode === 'text')" blocks; the second one is the
  // product-recommendations branch that calls getShoppingResults.
  const firstTextBranch = EDGE_SOURCE.indexOf("if (mode === 'text')");
  assert.ok(firstTextBranch !== -1, "Must have 'if (mode === \\'text\\')' branch");

  const secondTextBranch = EDGE_SOURCE.indexOf("if (mode === 'text')", firstTextBranch + 1);
  const productRecBranchStart = secondTextBranch !== -1 ? secondTextBranch : firstTextBranch;

  const elseBranchStart = EDGE_SOURCE.indexOf('} else {', productRecBranchStart);
  assert.ok(elseBranchStart !== -1, 'Must have an else branch for image mode');

  // The getShoppingResults call must live inside the text branch.
  const shoppingCallIndex = EDGE_SOURCE.indexOf('await getShoppingResults(');
  assert.ok(
    shoppingCallIndex > productRecBranchStart && shoppingCallIndex < elseBranchStart,
    'getShoppingResults must be called inside the text mode branch',
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
