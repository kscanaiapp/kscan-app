// One-guard-at-a-time mutation runner for audit/a2/outfit-batch4.test.ts. Restores each file with git checkout.
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const D = 'supabase/functions/style-outfit-generate/';
const muts = [
  ['O1 spoofable actor (x-user-id wins)', D + 'index.ts', "const userId = user.id;", "const userId = req.headers.get('x-user-id') ?? user.id;"],
  ['O2 closet ownership filter removed', D + 'index.ts', "      .select('id,user_id,title,category,clothing_type,subtype,brand,primary_color,material,deleted_at')\n      .eq('user_id', userId)\n", "      .select('id,user_id,title,category,clothing_type,subtype,brand,primary_color,material,deleted_at')\n"],
  ['O3 foreign-anchor rejection removed', D + 'validation.ts', "    anchor = pool.get(candidateKey(request.anchorItem)) ?? null;\n    if (!anchor) {", "    anchor = pool.get(candidateKey(request.anchorItem)) ?? null;\n    if (false) {"],
  ['O4 lifecycle gate removed', D + 'index.ts', "if (!await isOutfitAccountActive(userId)) {", "if (false) {"],
  ['O5 lifecycle lookup failure fails open', D + 'accountActiveGate.ts', "  } catch {\n    return false;\n  }", "  } catch {\n    return true;\n  }"],
  ['O6 burst denial ignored', D + 'index.ts', "if (!burstRow.allowed) {", "if (false) {"],
  ['O7 burst RPC error fails open', D + 'index.ts', "  if (burstError) {", "  if (false) {"],
  ['O8 daily limit ignored', D + 'index.ts', "if (dailyRow.limit_reached) {", "if (false) {"],
  ['O9 provider failure disguised as no-result', D + 'index.ts', "if (providerOutput === null) {", "if (false) {"],
  ['O10 invented ids accepted into outfits', D + 'validation.ts', "      const candidate = pool.get(key);\n      if (!candidate) {", "      const candidate = pool.get(key) ?? ({ sourceType: ref.sourceType, sourceId: ref.sourceId, role: 'top' } as never);\n      if (!candidate) {"],
  ['O11 anchor presence not enforced', D + 'validation.ts', "    if (anchor && !seenKeys.has(candidateKey(anchor))) continue;", ""],
  ['O12 note length cap removed', D + 'validation.ts', "const note = cleanString(eventRaw.note, NOTE_MAX_CHARS);", "const note = cleanString(eventRaw.note, 1e9);"],
  ['O13 UUID allow-list removed', D + 'validation.ts', "  if (!isValidUuid(record.sourceId)) return null;", ""],
  ['O14 unknown-schema rejection removed', D + 'index.ts', "if (dispatch === 'unknown_schema') {", "if (false) {"],
  ['O15 private strict field allow-list removed', D + 'privateDressingRoomEliseContract.ts', "    if (!PRIVATE_ELISE_REQUEST_FIELDS.includes(key)) {", "    if (false) {"],
  ['O16 outfit structure check removed', D + 'validation.ts', "    if (!satisfiesOutfitStructure(itemRefs.map((item) => item.role))) continue;", ""],
  ['O17 excludeItems cap removed', D + 'validation.ts', "parseItemRefList(record.excludeItems, MAX_OUTFIT_ITEMS * 2)", "parseItemRefList(record.excludeItems, 100000)"],
  ['O18 keepItems cap removed', D + 'validation.ts', "parseItemRefList(record.keepItems, MAX_OUTFIT_ITEMS)", "parseItemRefList(record.keepItems, 100000)"],
  ['O19 consent gate removed', D + 'index.ts', "if (consentGate) return consentGate;", ""],
  ['O20 maximumOutfits clamp removed', D + 'validation.ts', "const maximumOutfits = Math.max(1, Math.min(Math.floor(rawMax) || MAX_OUTFIT_SUGGESTIONS, MAX_OUTFIT_SUGGESTIONS));", "const maximumOutfits = Math.floor(rawMax) || MAX_OUTFIT_SUGGESTIONS;"],
  ['O21 inspiration owner-prefix check removed', D + 'validation.ts', "  if (!path.startsWith(prefix)) return false;", ""],
  ['O22 inspiration bucket check removed', D + 'validation.ts', "  if (!userId || bucket !== STYLE_LIBRARY_IMAGES_BUCKET) return false;", "  if (!userId) return false;"],
  ['O23 bearer regex check bypassed', D + 'index.ts', "if (!authHeader || !/^Bearer\\s+/i.test(authHeader)) {", "if (!authHeader || false) {"],
  ['O24 private early-return parse guard removed', D + 'index.ts', "if (!parsedElise.ok || eliseAiDisabled) {", "if (eliseAiDisabled) {"],
];
const out = [];
for (const [name, file, find, rep] of muts) {
  if (process.env.ONLY && !new RegExp(process.env.ONLY).test(name)) continue;
  const s = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const n = s.split(find).length - 1;
  if (n !== 1) { out.push({ name, applied: false, matches: n }); continue; }
  fs.writeFileSync(file, s.replace(find, rep));
  const r = spawnSync('deno', ['test', '--no-check', '--allow-read', '--allow-env', '--allow-write=audit/a2/out', 'audit/a2/outfit-batch4.test.ts'], { encoding: 'utf8', timeout: 120000 });
  const text = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, '');
  const failed = [...new Set([...text.matchAll(/^(.*) \.\.\. FAILED/gm)].map((m) => m[1].replace(/ \(.*/, '')))];
  execSync('git checkout -- ' + file);
  out.push({ name, applied: true, detected: failed.length > 0, timedOut: r.error ? String(r.error.code || r.error.message) : undefined, failing: failed });
}
const dirty = execSync('git status --short').toString().split('\n').filter((l) => l && !l.startsWith('??'));
console.log(JSON.stringify({ muts: out, dirtyTrackedFiles: dirty }, null, 1));
fs.writeFileSync('audit/a2/out/outfit-batch4-mutations' + (process.env.ONLY ? '-partial' : '') + '.json', JSON.stringify({ muts: out }, null, 1));
