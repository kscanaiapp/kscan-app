/* Actual hook/client/host code, deterministic synthetic scheduling; no network. */
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const cp = require('child_process');
const root = path.resolve(process.argv[2]);
const { runModule } = require(path.join(root, '__tests__/helpers/componentRenderer'));
const client = runModule('services/blackOwnedDiscovery.ts', {}, { jsx: false });
const host = runModule('services/blackOwnedDiscoveryHost.ts', { './blackOwnedDiscovery': client }, { jsx: false });
const rows = [];
const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
function fixture() {
  let slots = [], index = 0, effects = [], unmounted = false, staleWrites = 0;
  const react = {
    useState(initial) {
      const i = index++;
      if (!(i in slots)) slots[i] = { value: initial };
      const slot = slots[i];
      return [slot.value, next => { if (unmounted) staleWrites++; slot.value = next; }];
    },
    useEffect(fn, deps) {
      const i = index++, previous = slots[i];
      if (!previous || deps.some((d, k) => !Object.is(d, previous.deps[k]))) effects.push(() => {
        previous?.cleanup?.(); slots[i] = { deps, cleanup: fn() };
      });
    },
  };
  const { useBlackOwnedDiscovery } = runModule('hooks/useBlackOwnedDiscovery.ts', {
    react, '../services/blackOwnedDiscovery': client,
    '../services/supabaseClient': { supabase: { functions: { invoke() { throw Error('No implicit provider'); } } } },
  }, { jsx: false });
  const pending = [];
  const invoke = (_name, { signal }) => new Promise(resolve => pending.push({ signal, resolve }));
  const render = (id, enabled = true) => {
    index = 0; effects = [];
    const input = { garment: { item_type: 'outerwear' }, market: 'US', primaryProducts: [{ id }] };
    const result = useBlackOwnedDiscovery(input, host.discoveryRequestKey(input), { enabled, primarySettled: true, invoke });
    effects.forEach(fn => fn()); return result;
  };
  return { render, pending, unmount() { unmounted = true; for (const s of slots) s.cleanup?.(); }, get staleWrites() { return staleWrites; } };
}
const result = tag => ({ data: { version: 'black-owned-discovery-v1', status: 'empty', products: [], primaryOwnership: {}, generatedAt: tag }, error: null });
async function probe(id, name, fn) {
  try { await fn(); rows.push({ probeId: id, probe: name, expected: 'Actual hook isolates canceled/superseded/failed secondary state', actual: 'All assertions completed', verdict: 'PASS' }); }
  catch (e) { rows.push({ probeId: id, probe: name, expected: 'Actual hook isolates canceled/superseded/failed secondary state', actual: String(e), verdict: 'FAIL' }); process.exitCode = 1; }
}
async function main() {
  await probe('B35-DISC-HOOK-001', 'B settles before delayed A; A cannot overwrite B', async () => {
    const f = fixture(); f.render('A'); f.render('B');
    assert.equal(f.pending.length, 2); assert.equal(f.pending[0].signal.aborted, true);
    f.pending[1].resolve(result('B')); await settle(); assert.equal(f.render('B').generatedAt, 'B');
    f.pending[0].resolve(result('A')); await settle(); assert.equal(f.render('B').generatedAt, 'B'); f.unmount();
  });
  await probe('B35-DISC-HOOK-002', 'cancel, reissue same scan, late canceled response ignored', async () => {
    const f = fixture(); f.render('A'); f.render('A', false); f.render('A');
    assert.equal(f.pending.length, 2); assert.equal(f.pending[0].signal.aborted, true);
    f.pending[1].resolve(result('reissued')); await settle(); f.pending[0].resolve(result('canceled')); await settle();
    assert.equal(f.render('A').generatedAt, 'reissued'); f.unmount();
  });
  await probe('B35-DISC-HOOK-003', 'unmount suppresses provider completion state writes', async () => {
    const f = fixture(); f.render('A'); f.unmount(); assert.equal(f.pending[0].signal.aborted, true);
    f.pending[0].resolve(result('late')); await settle(); assert.equal(f.staleWrites, 0);
  });
  await probe('B35-DISC-HOOK-004', 'secondary auth401 response cannot become successful state', async () => {
    const f = fixture(); f.render('A'); f.pending[0].resolve({ data: result('wrong').data, error: { status: 401 } });
    await settle(); assert.equal(f.render('A'), undefined); f.unmount();
  });
  const sha = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  for (const row of rows) Object.assign(row, { feature: 'Black-owned discovery client hook', boundary: 'useBlackOwnedDiscovery + actual client + request-key host', sourceSha: sha, environment: 'offline real source, React effect fixture and injected transport', sourceLocation: 'hooks/useBlackOwnedDiscovery.ts', executionMethod: 'node docs/release/evidence/discovery-hook-hostile.cjs SOURCE_ROOT', evidence: 'discovery-hook-hostile-results.json', limitation: 'Hook output/state only; no signed binary, mounted full UI, live auth or provider latency claim', linkedDefectId: null, repairReference: null, reverificationStatus: 'Current unchanged authoritative source' });
  fs.writeFileSync(path.join(__dirname, 'discovery-hook-hostile-results.json'), JSON.stringify(rows, null, 2) + '\n');
  console.log(JSON.stringify({ total: rows.length, pass: rows.filter(x => x.verdict === 'PASS').length, fail: rows.filter(x => x.verdict === 'FAIL').length }));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
