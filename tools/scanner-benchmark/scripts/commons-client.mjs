// Minimal, polite Commons API client: batched, serialized, with backoff.
export const UA = 'KScanScannerBenchmarkBuilder/1.0 (internal evaluation; generic client)';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export async function api(params) {
  const u = new URL('https://commons.wikimedia.org/w/api.php');
  u.search = new URLSearchParams({ format: 'json', formatversion: '2', maxlag: '5', ...params });
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(1200);
    let r, t;
    try { r = await fetch(u, { headers: { 'User-Agent': UA, 'Api-User-Agent': UA } }); t = await r.text(); }
    catch { await sleep(5000 * (attempt + 1)); continue; }
    if (r.status === 429 || /too many requests/i.test(t) || r.status >= 500) { await sleep(5000 * (attempt + 1)); continue; }
    try { const j = JSON.parse(t); if (j.error?.code === 'maxlag') { await sleep(5000); continue; } return j; } catch { await sleep(5000 * (attempt + 1)); }
  }
  throw new Error('commons api failed: ' + params.titles?.slice(0, 80));
}
export async function catSizes(cats) {
  const out = {};
  for (let i = 0; i < cats.length; i += 40) {
    const chunk = cats.slice(i, i + 40);
    const j = await api({ action: 'query', prop: 'categoryinfo', titles: chunk.map(c => `Category:${c}`).join('|') });
    for (const p of j.query.pages) out[p.title.replace(/^Category:/, '')] = p.missing ? null : { files: p.categoryinfo?.files ?? 0, subcats: p.categoryinfo?.subcats ?? 0 };
  }
  return out;
}
