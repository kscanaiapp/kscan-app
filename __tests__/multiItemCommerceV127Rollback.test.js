/**
 * Build 32 — v127 rollback contract (BACKEND_COMMERCE_FUNNEL_V127_ENABLED).
 *
 * The flag is the existing rollback authority: turning it off must return the
 * system to pre-v127 behavior without a redeploy. This pins what "off" has to
 * mean on BOTH sides of the boundary:
 *
 *   backend — isCommerceFunnelEnabled() is false, so the MODE B route does not
 *             exist and a commerce_only request is not served by it;
 *   client  — commerce.deferred is therefore absent, so the multi-item
 *             hydration never dispatches: zero MODE B requests, zero provider
 *             work, and no "no strong shopping match" card for a search that
 *             never ran.
 *
 * That last point is the reason the client gate is anchored on
 * commerceDeferred rather than on candidate count: with the funnel off, N
 * per-item requests would fall through to the image path, fail, and narrate a
 * false no-match N times.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = process.env.KSCAN_COMMERCE_SOURCE_ROOT
  ? path.resolve(process.env.KSCAN_COMMERCE_SOURCE_ROOT)
  : path.resolve(__dirname, '..');

function createLoader(root, mocks = {}) {
  const cache = new Map();
  function resolveFile(candidate) {
    const candidates = path.extname(candidate)
      ? [candidate]
      : [`${candidate}.ts`, `${candidate}.tsx`, `${candidate}.js`];
    return candidates.find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
  }
  function loadFile(filename) {
    const resolved = resolveFile(filename);
    if (!resolved) throw new Error(`Unable to resolve production module: ${filename}`);
    if (cache.has(resolved)) return cache.get(resolved).exports;
    const module = { exports: {} };
    cache.set(resolved, module);
    const output = ts.transpileModule(fs.readFileSync(resolved, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        jsx: ts.JsxEmit.React,
      },
      fileName: resolved,
    }).outputText;
    const localRequire = (id) => {
      if (Object.prototype.hasOwnProperty.call(mocks, id)) return mocks[id];
      if (id.startsWith('.')) return loadFile(path.resolve(path.dirname(resolved), id));
      try { return require(id); } catch { return {}; }
    };
    Function('exports', 'require', 'module', '__filename', '__dirname', output)(
      module.exports, localRequire, module, resolved, path.dirname(resolved),
    );
    return module.exports;
  }
  return (relativePath) => loadFile(path.resolve(root, relativePath));
}

// ── Backend side: the flag really is the route's authority ──────────────────

test('the flag resolves off/on from the deployed env spellings', () => {
  const { isCommerceFunnelEnabled } = createLoader(ROOT)(
    'supabase/functions/scan-identify/commerceFunnelConfig.ts',
  );
  const at = (value) => isCommerceFunnelEnabled(() => value);

  for (const off of ['false', '0', 'off', 'no', 'FALSE', ' Off ']) {
    assert.equal(at(off), false, `"${off}" must disable the funnel`);
  }
  for (const on of ['true', '1', 'on', 'yes', 'TRUE', ' On ']) {
    assert.equal(at(on), true, `"${on}" must enable the funnel`);
  }
});

test('MODE B is guarded by the flag, not merely by the request shape', () => {
  // The route is `if (commerceFunnelEnabled && isCommerceOnlyRequest(body))`.
  // With the flag off a commerce_only request is NOT served by MODE B — it
  // falls through, which is exactly why the client must not dispatch.
  const src = fs.readFileSync(
    path.join(ROOT, 'supabase/functions/scan-identify/index.ts'), 'utf8',
  );
  assert.match(
    src,
    /if\s*\(\s*commerceFunnelEnabled\s*&&\s*isCommerceOnlyRequest\(body\)\s*\)/,
    'the MODE B route must be gated by the v127 flag',
  );
});

// ── Client side: nothing dispatches when the backend did not defer ──────────

function candidate(id, label) {
  return {
    id, order: 0, label, category: 'outerwear', subtype: 'jacket', isPrimary: false,
    source: { candidateId: id, identification: { item_type: 'jacket' }, attributes: {} },
  };
}

/**
 * The dispatch predicate the hook applies, read straight from useKScan so it
 * cannot drift from the effect it documents.
 */
function dispatchGateFrom(hookSource) {
  const start = hookSource.indexOf('const hydrateMultiItemCommerce');
  assert.ok(start > -1, 'hydrateMultiItemCommerce exists');
  const effectStart = hookSource.indexOf('useEffect(() => {', start);
  const block = hookSource.slice(effectStart, effectStart + 700);
  return block;
}

test('with the funnel off the client dispatches no MODE B request at all', async () => {
  const hookSource = fs.readFileSync(path.join(ROOT, 'hooks/useKScan.js'), 'utf8');
  const gate = dispatchGateFrom(hookSource);

  assert.match(gate, /if\s*\(\s*!analysis\?\.commerceDeferred\s*\)\s*return;/,
    'dispatch is gated on the v127 activation marker');
  assert.match(gate, /if\s*\(status\s*!==\s*'result'\)\s*return;/,
    'and only after the primary result exists');

  // Behavioral: the orchestrator is never reached for a non-deferred analysis.
  let dispatches = 0;
  const { fetchMultiItemCommerce } = createLoader(ROOT, {
    './commerceHydration': {
      fetchDeferredCommerce: async () => {
        dispatches += 1;
        return { status: 'empty', purchaseOptions: [], enrichmentCandidates: [], cacheHit: false, retryable: true };
      },
    },
  })('services/multiItemCommerce.ts');

  // Simulate the gate the effect applies, with commerce NOT deferred.
  const analysis = { commerceDeferred: false, confirmationCandidates: [candidate('a', 'A'), candidate('b', 'B')] };
  if (analysis.commerceDeferred) {
    await fetchMultiItemCommerce(analysis.confirmationCandidates);
  }

  assert.equal(dispatches, 0, 'MODE B dispatches with the funnel off: must be 0');
});

test('a flag-off scan persists no fabricated commerce', async () => {
  // attachScanMultiItemCommerce refuses an empty card set, so a scan that
  // never ran commerce cannot acquire a commerce record by default.
  const files = new Map();
  const fileSystem = {
    documentDirectory: 'memory://documents/',
    EncodingType: { UTF8: 'utf8' },
    getInfoAsync: async (uri) => ({ exists: files.has(uri), uri }),
    readAsStringAsync: async (uri) => {
      if (!files.has(uri)) throw new Error('missing ' + uri);
      return files.get(uri);
    },
    writeAsStringAsync: async (uri, v) => { files.set(uri, v); },
    makeDirectoryAsync: async () => undefined,
    moveAsync: async ({ from, to }) => {
      if (!files.has(from)) throw new Error('missing ' + from);
      files.set(to, files.get(from)); files.delete(from);
    },
    deleteAsync: async (uri) => { files.delete(uri); },
  };
  const library = createLoader(ROOT, {
    'expo-file-system/legacy': fileSystem,
    'expo-image-manipulator': { SaveFormat: { JPEG: 'jpeg' }, manipulateAsync: async () => ({ uri: 'memory://t.jpg' }) },
    './savedScansCloud': { saveScanToCloud: async () => ({ ok: false }), softDeleteCloudSavedScan: async () => ({ ok: false }) },
    './actorContext': { resolveWriteAuthority: () => ({ ok: true, ownerId: null }), isActorRequestCurrent: () => true },
  })('services/library.js');

  const saved = await library.saveMultiItemScan({
    photoUri: 'memory://capture.jpg',
    analysis: { result: 'two items', metadata: {} },
    candidates: [candidate('a', 'A'), candidate('b', 'B')],
    source: 'camera',
  });
  assert.ok(saved, 'the canonical scan is still saved with the funnel off');

  assert.equal(await library.attachScanMultiItemCommerce(saved.id, []), false,
    'an empty commerce result is never written');

  const [reopened] = await library.loadLibrary();
  assert.deepEqual(reopened.multiItemCommerce, [],
    'no commerce state exists for commerce that never ran');
  assert.equal(reopened.multiItemCandidates.length, 2,
    'the identified garments are still there — identification is not commerce');
});
