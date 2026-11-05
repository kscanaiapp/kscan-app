/** Generate reviewable SQL for the ordinary source registry. Never executes SQL or reads credentials.
 * Input: JSON array of source records. Research imports must remain enabled:false/review_status:review
 * until an operator records lightweight public-source qualification. No ownership/feed fields exist.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const categories = new Set(['outerwear','blazer','dress','pants','top','footwear','bag','accessory']);
const columns = ['id','brand_name','official_website','canonical_domain','alternate_domains','social_references','categories','keywords','us_eligible','enabled','review_status','reviewed_at','source_notes','provenance_references','rotation_weight'];
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
const sqlValue = value => value === null ? 'null' : typeof value === 'boolean' ? String(value) : typeof value === 'number' ? String(value) : Array.isArray(value) ? `array[${value.map(quote).join(',')}]::text[]` : quote(value);

export function sourcePlan(records) {
  if (!Array.isArray(records) || !records.length || records.length > 1000) throw new Error('Expected 1–1000 source records');
  const ids = new Set(), domains = new Set(), names = new Set();
  const statements = records.map(r => {
    if (!r || Object.keys(r).some(k => !columns.includes(k))) throw new Error('Unknown source field (product, ownership and merchant fields are not accepted)');
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(r.id ?? '') || typeof r.brand_name !== 'string' || !r.brand_name.trim() || r.brand_name.length > 60) throw new Error('Invalid source identity');
    if (typeof r.canonical_domain !== 'string' || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(r.canonical_domain) || /(?:^|\.)(?:local|internal|localhost|test|invalid|onion)(?:\.|$)/.test(r.canonical_domain)) throw new Error('Invalid public domain');
    if (r.official_website !== `https://${r.canonical_domain}/`) throw new Error('Use the canonical HTTPS root website');
    if (!Array.isArray(r.categories) || r.categories.some(c => !categories.has(c))) throw new Error('Unsupported categories');
    if (typeof r.enabled !== 'boolean' || typeof r.us_eligible !== 'boolean' || !['review','qualified','excluded'].includes(r.review_status)) throw new Error('Explicit source status required');
    if (r.enabled && (!r.us_eligible || r.review_status !== 'qualified' || !r.categories.length || !Array.isArray(r.provenance_references) || !r.provenance_references.length || !Number.isFinite(Date.parse(r.reviewed_at)) || Date.parse(r.reviewed_at) > Date.now() || Date.now() - Date.parse(r.reviewed_at) > 180 * 86400000)) throw new Error('Enabled source needs current public-source qualification');
    if (ids.has(r.id) || domains.has(r.canonical_domain) || names.has(r.brand_name.trim().toLowerCase())) throw new Error('Duplicate source, domain or brand');
    ids.add(r.id); domains.add(r.canonical_domain); names.add(r.brand_name.trim().toLowerCase());
    const row = { alternate_domains: [], social_references: [], keywords: [], reviewed_at: null, source_notes: '', provenance_references: [], rotation_weight: 1, ...r };
    for (const key of ['alternate_domains','social_references','keywords','provenance_references']) {
      if (!Array.isArray(row[key]) || row[key].length > 20 || row[key].some(v => typeof v !== 'string' || v.length > 2000)) throw new Error('Invalid source references');
    }
    if (typeof row.source_notes !== 'string' || row.source_notes.length > 4000) throw new Error('Invalid source notes');
    if (row.alternate_domains.some(d => !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(d) || /(?:^|\.)(?:local|internal|localhost|test|invalid|onion)(?:\.|$)/.test(d))) throw new Error('Invalid alternate domain');
    if (!Number.isInteger(row.rotation_weight) || row.rotation_weight < 1 || row.rotation_weight > 10) throw new Error('Invalid rotation weight');
    return `insert into public.black_owned_brand_search_sources (${columns.join(',')}) values (${columns.map(k => sqlValue(row[k])).join(',')})\non conflict (id) do update set ${columns.filter(k => k !== 'id').map(k => `${k}=excluded.${k}`).join(',')};`;
  });
  return `-- Ordinary commerce source maintenance. Execute only through governed service administration.\nbegin;\n${statements.join('\n')}\ncommit;\n`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(sourcePlan(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')))); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
