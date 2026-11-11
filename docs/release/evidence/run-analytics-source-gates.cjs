const fs=require('fs'),cp=require('child_process');
const root='C:/b35analyticsguard1029', prefix='C:/b35readback1030/analytics-gates';
const sha=cp.execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const gates=['check-edge-function-parity.js','verify-backend-authority.js','check-native-config-parity.js','check-migration-provenance.js','check-dependency-reachability.js','check-build35-release-profile.js'];
const rows=[];for(const gate of gates){const r=cp.spawnSync(process.execPath,['scripts/'+gate],{cwd:root,encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024});fs.writeFileSync(prefix+'-'+gate+'.log',(r.stdout||'')+(r.stderr||''));rows.push({sourceSha:sha,command:'node scripts/'+gate,exitCode:r.status,signal:r.signal,verdict:r.status===0?'PASS':'FAIL_OR_INCOMPLETE',error:r.error?.code??null});}
fs.writeFileSync(prefix+'.json',JSON.stringify(rows,null,2)+'\n');console.log(JSON.stringify(rows));if(rows.some(x=>x.verdict!=='PASS'))process.exitCode=1;
