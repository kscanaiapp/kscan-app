const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname,'..');
const baseline = require('../config/black-owned-discovery-primary-baseline.json');
test('secondary infrastructure preserves exact primary routing, budgets, rankers, schemas and model/provider calls',()=>{
  for(const [file,expected] of Object.entries(baseline.files)){
    const source=fs.readFileSync(path.join(root,file),'utf8').replace(/\r\n/g,'\n');
    assert.equal(crypto.createHash('sha256').update(source).digest('hex'),expected,file);
    assert.equal(source.includes('black-owned-discovery'),false,file);
  }
});
test('secondary source has no model or scan-image integration and sponsorship has no organic callers',()=>{
  const dir=path.join(root,'supabase/functions/black-owned-discovery');
  for(const file of fs.readdirSync(dir).filter(f=>f.endsWith('.ts')&&!f.endsWith('.test.ts'))){
    const source=fs.readFileSync(path.join(dir,file),'utf8');
    assert.doesNotMatch(source,/from\s+['"][^'"]*(?:gemini|genai|paidProvider|safeRemoteMedia)/i,file);
    if(file==='engine.ts')assert.equal(source.includes("from './sponsorshipPolicy"),false,file);
  }
});


test('consent repair changes only the actor prerequisite, preserving original primary source bytes',()=>{
  const source=fs.readFileSync(path.join(root,'supabase/functions/scan-identify/index.ts'),'utf8').replace(/\r\n/g,'\n');
  const original=source.replace("import { requireGeminiConsent } from '../_shared/geminiConsent.ts';\n",'').replace('  const consentGate = await requireGeminiConsent(userId);\n  if (consentGate) return consentGate;\n\n','');
  assert.notEqual(original,source,'the explicit guard additions must be present');
  assert.equal(crypto.createHash('sha256').update(original).digest('hex'),baseline.consentAuthorityPromotion.priorScanEntrypointDigest);
  assert.notEqual(crypto.createHash('sha256').update(original+'\n// unauthorized primary drift').digest('hex'),baseline.consentAuthorityPromotion.priorScanEntrypointDigest);
});
