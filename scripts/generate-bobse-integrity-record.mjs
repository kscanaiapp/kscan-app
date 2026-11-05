/** Review artifact generator, not a baseline reset or deployment authorization. */
import fs from 'node:fs';
import crypto from 'node:crypto';
const baseline=JSON.parse(fs.readFileSync('config/black-owned-discovery-primary-baseline.json','utf8'));
const vri=JSON.parse(fs.readFileSync('config/vri03-primary-integrity-approval.json','utf8'));
const read=p=>fs.readFileSync(p,'utf8').replace(/\r\n/g,'\n');
const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
const reasons={
  'supabase/functions/scan-identify/index.ts':'Owner-directed BOBSE integration: server-resolved account preference at existing commerce entry points; identification and consent authority unchanged.',
  'supabase/functions/scan-identify/scanCommerceRouter.ts':'Owner-directed BOBSE integration: optional server lane passed to existing shopping call, enabled-shelf cache isolation; existing ranker and provider routing retained.',
  'supabase/functions/scan-identify/shoppingProvider.ts':'Owner-directed BOBSE integration: reuses unused second request slot after primary success, bounded cancellation, revision cache and primary-result salvage; OFF parity compared with canonical Git source.',
};
const source=read('supabase/functions/scan-identify/index.ts');
const consentStripped=source.replace("import { requireGeminiConsent } from '../_shared/geminiConsent.ts';\n",'').replace('  const consentGate = await requireGeminiConsent(userId);\n  if (consentGate) return consentGate;\n\n','');
if(source===consentStripped)throw new Error('Consent guard absent');
fs.writeFileSync('config/bobse-primary-integrity-approval.json',JSON.stringify({
  schemaVersion:'bobse-primary-integrity-approval-v1',baseCommit:'4a832287f291086f600cf7411343ae5554cbf344',
  authority:'Owner Build 35 BOBSE directive: ordinary search expansion integrated into Scanner and Elise; independent default-OFF flag and account preference.',
  note:'Exact feature source record only. Immutable historical Black-owned and VRI-03 snapshots are preserved. No Staging/Production deployment, activation or platform parity certification is implied.',
  approvedFiles:Object.fromEntries(Object.entries(reasons).map(([file,reason])=>[file,{priorSha256:vri.approvedFiles[file]?.vri03Sha256??baseline.files[file],bobseSha256:digest(read(file)),reason}])),
  consentPromotion:{priorConsentStrippedSha256:vri.consentPromotion.vri03ConsentStrippedSha256,bobseConsentStrippedSha256:digest(consentStripped)},
  evidence:['scripts/brand-search-canonical-parity.ts','supabase/functions/_shared/brandSearchExpansion.test.ts','docs/BUILD35_BRAND_SEARCH_EXPANSION_READINESS.md'],
  restrictions:['Research sources not loaded or qualified','Feature remains OFF pending governed Staging and real-path acceptance','No Production activation approval','Synchronize platform/backend source lineages before release promotion'],
},null,2)+'\n');
