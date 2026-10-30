const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {createRequire}=require('node:module');
const root=path.resolve(__dirname,'..');
const localRequire=createRequire(path.join(root,'package.json'));
const {runModule}=localRequire('./__tests__/helpers/componentRenderer');
const sdkPath=path.join(root,'node_modules/posthog-react-native/dist/posthog-rn.js');
const sdkRequire=createRequire(sdkPath);
const source=fs.readFileSync(sdkPath,'utf8');
const marker='key:"captureAppLifecycleEvents",value:';
const start=source.indexOf(marker)+marker.length,end=source.indexOf('},{key:"persistAppVersion"',start);
if(start<marker.length||end<start)throw Error('Installed SDK method changed; inspect rather than substitute logic');
const expression=source.slice(start,end);
const pkg=JSON.parse(fs.readFileSync(path.join(root,'node_modules/posthog-react-native/package.json'),'utf8'));
const settle=async()=>{for(let n=0;n<10;n++)await Promise.resolve();};

for (const [scenario, url] of [
  ['OAuth query and token fragment','kscan://auth/callback?code=SYNTHETIC_AUTH_CODE#access_token=SYNTHETIC_ACCESS_TOKEN&refresh_token=SYNTHETIC_REFRESH_TOKEN'],
  ['recovery hash','kscan://auth/callback?token_hash=SYNTHETIC_RECOVERY_HASH&type=recovery'],
  ['private share capability','kscan://rooms/private/SYNTHETIC_ROOM_TOKEN'],
]) test('actual installed SDK delayed launch URL is excluded: '+scenario,async()=>{
  const keys=['EXPO_PUBLIC_POSTHOG_API_KEY','EXPO_PUBLIC_POSTHOG_HOST'];
  const prior=keys.map(k=>process.env[k]);
  process.env[keys[0]]='synthetic-fixture';process.env[keys[1]]='https://analytics-fixture.invalid';
  let sdk,releaseURL;
  const launchURL=new Promise(resolve=>{releaseURL=resolve;});
  class SDK {
    constructor(_key,options){this.options=options;this.actor='restored-fixture';this.sent=[];sdk=this;}
    ready(){return Promise.resolve();}
    reset(){this.actor='anonymous-fixture';}
    identify(id){this.actor=id;this.capture('$identify');}
    getDistinctId(){return this.actor;}
    capture(event,properties={}){const result=this.options.before_send({event,properties:{...properties,distinct_id:this.actor}});if(result)this.sent.push(result);}
  }
  try{
    const identity=runModule('services/analytics/posthogIdentitySync.ts',{}, {jsx:false});
    const modules={'posthog-react-native':{__esModule:true,default:SDK,PostHogProvider(){}},'./posthogIdentitySync':identity};
    for(const[file,setter]of [['../closetTelemetry','setClosetTelemetrySink'],['../kplus/kplusTelemetry','setKPlusAnalyticsSink'],['../todayWithElise/analytics','setTodayWithEliseAnalyticsSink'],['../voice/voiceTelemetry','setVoiceAnalyticsSink'],['../vto/vtoTelemetry','setVtoAnalyticsSink'],['../purchaseImport/purchaseImportTelemetry','setPurchaseImportTelemetrySink'],['../blackOwnedDiscoveryTelemetry','setBlackOwnedDiscoveryAnalyticsSink']])modules[file]={[setter]:()=>{}};
    const app=runModule('services/analytics/posthogClient.core.ts',modules,{jsx:false});
    assert.equal(sdk.options.captureAppLifecycleEvents,true,'Exercise the actual enabled SDK lifecycle path');
    const captureLifecycle=vm.runInNewContext('('+expression+')',{
      _asyncToGenerator2:{default:sdkRequire('@babel/runtime/helpers/asyncToGenerator')},
      _regenerator:{default:sdkRequire('@babel/runtime/regenerator')},
      _core:sdkRequire('@posthog/core'),
      _objectSpread:(...objects)=>Object.assign({},...objects),
      _reactNative:{Linking:{getInitialURL:()=>launchURL},AppState:{addEventListener:()=>({remove(){}})}}
    });
    const pending=captureLifecycle.call({_appProperties:{$app_build:'1',$app_version:'1'},_persistence:'memory',_logger:{warn(){}},capture:(event,properties)=>sdk.capture(event,properties)});
    app.syncPostHogIdentity('11111111-1111-4111-8111-111111111111');await settle();
    releaseURL(url);
    await pending;
    const event=sdk.sent.find(x=>x.event==='Application Opened');
    assert.ok(event,'The authorized lifecycle event should remain usable');
    console.log('LIFECYCLE_EGRESS_OBSERVATION '+JSON.stringify({sdkVersion:pkg.version,sdkMethodSha256:crypto.createHash('sha256').update(expression).digest('hex'),actual:event,networkCalls:0,method:'Installed SDK lifecycle method; injected RN Linking; real app source filter; identity sync completes before delayed initial URL'}));
    assert.equal(JSON.stringify(event).includes('SYNTHETIC_AUTH_CODE'),false,'Auth authorization code reached accepted analytics event');
    assert.equal(JSON.stringify(event).includes('SYNTHETIC_ACCESS_TOKEN'),false,'Auth token reached accepted analytics event');
    assert.equal(Object.hasOwn(event.properties,'url'),false,'Raw launch URL must be omitted rather than partially redacted');
    assert.equal(JSON.stringify(event).includes('SYNTHETIC_'),false,'No secret query, fragment or path may survive');
    assert.equal(event.properties.distinct_id,'11111111-1111-4111-8111-111111111111');
    const original={event:'Application Opened',properties:{distinct_id:sdk.actor,url,approved_fixture_count:3}};
    const sanitized=sdk.options.before_send(original);
    assert.equal(original.properties.url,url,'Do not mutate the SDK-owned event');
    assert.equal(sanitized.properties.approved_fixture_count,3,'Unrelated bounded metadata remains intact');
    assert.equal(Object.hasOwn(sanitized.properties,'url'),false);
    assert.equal(sdk.options.before_send({event:'Application Opened',properties:{distinct_id:'foreign-actor',url}}),null,'Identity fence remains authoritative');
    app.forwardTelemetryToPostHog('closet_candidate_created',{sourceType:'camera'});
    app.forwardTelemetryToPostHog('kplus_feature_exposed',{source:'closet'});
    assert.equal(sdk.sent.find(x=>x.event==='closet_candidate_created').properties.sourceType,'camera');
    assert.equal(sdk.sent.find(x=>x.event==='kplus_feature_exposed').properties.source,'closet');
  }finally{keys.forEach((k,i)=>prior[i]===undefined?delete process.env[k]:process.env[k]=prior[i]);}
});
