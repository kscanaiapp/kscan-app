const fs=require('fs');
const p=__dirname+'/';
const read=n=>JSON.parse(fs.readFileSync(p+n,'utf8').replace(/^\uFEFF/,''));
const write=(n,v)=>fs.writeFileSync(p+n,JSON.stringify(v,null,2)+'\n');
const m=read('mandatory-hostile-probes.json'), results=read('discovery-hook-hostile-results.json');
const mappings=[['A then B delayed A supersession','B35-DISC-HOOK-001'],['cancel then reissue','B35-DISC-HOOK-002'],['Supabase 401 mid-request','B35-DISC-HOOK-004']];
const links=[];
for(const [name,id]of mappings){
 const r=results.find(x=>x.probeId===id), cell=m.find(x=>x.endpoint==='workflow:Black-owned discovery'&&x.probe===name);
 if(!r||r.verdict!=='PASS'||!cell)throw Error('Missing exact passing boundary');
 if(cell.verdict!=='NOT TESTED'&&cell.evidence!=='discovery-hook-hostile-results.json')throw Error('Unexpected prior disposition');
 Object.assign(cell,{verdict:'PASS',expected:r.expected,actual:r.actual,environment:r.environment,sourceSha:r.sourceSha,sourceLocation:r.sourceLocation,evidence:r.evidence,executionMethod:r.executionMethod,reverificationStatus:r.reverificationStatus,limitation:r.limitation,matchedExecutedProbe:id,reason:'Executed actual current hook/client/state assertion; no live/full UI certification'});
 cell.coverageDisposition={category:1,label:'Already executed with matching evidence',reason:'Exact hook/client probe now executed',reviewSourceSha:r.sourceSha,scope:r.limitation};
 links.push({mandatoryProbeId:cell.probeId,executedProbeId:id,boundary:cell.endpoint,limitation:r.limitation});
}
const counts=(rows,fn)=>rows.reduce((a,r)=>(a[fn(r)]=(a[fn(r)]??0)+1,a),{});
write('mandatory-hostile-probes.json',m);
const d=read('continuation-probe-dispositions.json');
d.currentVerdicts=counts(m,r=>r.verdict); d.allCellsByDisposition=counts(m,r=>r.coverageDisposition.category);
d.currentPendingByDisposition=counts(m.filter(r=>r.verdict==='NOT TESTED'),r=>r.coverageDisposition.category);
d.originalNotTestedByDisposition={...d.allCellsByDisposition,1:d.allCellsByDisposition[1]-55};
d.originalPendingResolved=d.originalNotTestedByDisposition[1];write('continuation-probe-dispositions.json',d);
const summary=read('mandatory-hostile-coverage-summary.json');summary.counts=d.currentVerdicts;summary.additionalAnalyticsFailure='B35-G-008 actual-source reset failure, separate from original matrix; no live vendor leak';write('mandatory-hostile-coverage-summary.json',summary);
write('continuation-discovery-hook-reconciliation.json',{sourceSha:results[0].sourceSha,links,notClosed:['Whole mounted-primary hang latency','Account switch auth scope','Navigation return','Live endpoint provider failure'],counts:d.currentVerdicts});
console.log(JSON.stringify({counts:d.currentVerdicts,pending:d.currentPendingByDisposition,links}));
