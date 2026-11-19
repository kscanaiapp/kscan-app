#!/usr/bin/env node
// Re-run the Commons candidate collection that produced manifest/candidates.v1.json.
// Metadata only (no image bytes). Writes ./candidates.json in the current directory.
import { api } from './commons-client.mjs';
import fs from 'node:fs';
// stratum -> [category, maxCandidates]
const PLAN = {
  exact_known: [['Chuck Taylor All-Stars',6],['Adidas Superstar',5],['Adidas Stan Smith',5],['Ray-Ban Wayfarer',5],['Crocs',6],['Air Jordan 1',6],['Casio F-91W',5],['Adidas Samba',4],['Adidas Gazelle',3],['Ray-Ban Aviator',4],['Fjällräven Kånken',5],['Rolex Submariner',4],['Moon Boot',4],['Burberry check',4],['Nike Air Max',5]],
  unknown_generic: [['Cardigans',3],['Hoodies',3],['Denim jackets',3],['Leather jackets',3],['Skirts',3],['Scarves',3],['Handbags',3],['Boots',3],['Sandals',3],['Baseball caps',3],['Sunglasses',3],['Backpacks',3],['Neckties',3],['Sweaters',3],['Blazers',3],['Jeans',3],['Raincoats',3],['Down jackets',3],['Duffle coats',3]],
  logo_visible: [['Nike clothing',6],['Adidas clothing',6],['Champion (sportswear)',4],['Supreme (brand)',4],['Fred Perry',4],['Lacoste',4],['Vans shoes',4],['Oakley sunglasses',3]],
  texture_pattern: [['Tartan clothing',4],['Houndstooth',4],['Leopard print',4],['Polka dot dresses',4],['Sequins',4],['Argyle',4],['Camouflage clothing',4],['Striped shirts',4]],
  multi_item: [['Mannequins',8],['Clothing shop windows',8],['Clothing racks',6]],
  non_fashion: [['Coffee mugs',5],['Chairs',5]],
};
const OK_LIC = /^(cc0|public domain|pd|cc by(-sa)? (2\.0|2\.5|3\.0|4\.0)( [a-z]+)?)$/i;
const strip = (s) => (s ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
const out = [];
for (const [stratum, cats] of Object.entries(PLAN)) {
  for (const [cat, max] of cats) {
    const cacheFile = `cache/${Buffer.from(cat).toString('hex')}.json`;
    fs.mkdirSync('cache', { recursive: true });
    const j = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : await api({ action: 'query', generator: 'categorymembers', gcmtitle: `Category:${cat}`, gcmtype: 'file', gcmlimit: '40', gcmsort: 'timestamp', gcmdir: 'asc',
      prop: 'imageinfo', iiprop: 'url|size|mime|sha1|extmetadata|timestamp', iiurlwidth: '960', iiextmetadatafilter: 'LicenseShortName|License|Artist|ImageDescription|ObjectName|AttributionRequired|Copyrighted|Restrictions' });
    if (!fs.existsSync(cacheFile)) fs.writeFileSync(cacheFile, JSON.stringify(j));
    const pages = j.query?.pages ?? [];
    let kept = 0;
    for (const p of pages) {
      if (kept >= max) break;
      const ii = p.imageinfo?.[0]; if (!ii) continue;
      if (!/^image\/(jpeg|png)$/.test(ii.mime)) continue;
      if ((ii.width ?? 0) < 400 || (ii.height ?? 0) < 300) continue;
      const em = ii.extmetadata ?? {};
      const lic = strip(em.LicenseShortName?.value);
      if (!OK_LIC.test(lic) || /nc|nd/i.test(lic.replace(/^cc /i,'').replace(/by-sa|by/i,''))) continue;
      if (strip(em.Restrictions?.value)) continue; // trademark/personality restrictions -> skip
      out.push({ stratum, category: cat, title: p.title, pageid: p.pageid, descriptionUrl: ii.descriptionurl, originalUrl: ii.url, thumbUrl: ii.thumburl, width: ii.width, height: ii.height, mime: ii.mime, sha1: ii.sha1, uploaded: ii.timestamp,
        license: lic, licenseUrl: strip(em.License?.value), artist: strip(em.Artist?.value), objectName: strip(em.ObjectName?.value), description: strip(em.ImageDescription?.value) });
      kept++;
    }
    console.log(`${stratum}\t${cat}\tpages=${pages.length}\tkept=${kept}`);
  }
}
fs.writeFileSync('candidates.json', JSON.stringify(out, null, 1));
console.log('total', out.length);
