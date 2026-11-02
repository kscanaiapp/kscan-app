// Source composition, not physical camera or rendering certification.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = process.env.B35_AUDIT_SOURCE_ROOT || 'C:/b35live1102';
const {createRenderer, runModule, findAll, deepStub, settle, textContent} = require(path.join(ROOT, '__tests__/helpers/componentRenderer'));
const ts = require(path.join(ROOT, 'node_modules/typescript'));
const deferred = () => { let resolve; const promise = new Promise(r => resolve=r); return {promise,resolve}; };
function world(platform='android', opts={}) {
  const r=createRenderer(); const calls=[]; const listeners=new Set(); const appListeners=new Set();
  const env={actor:'A', kplus:'active', remote:true, native:true, permission:'undetermined', ...opts};
  const emit=(type,payload={}) => {for(const f of listeners)f({type,timestamp:Date.now(),payload});};
  const native={getCapability:()=>({capable:true,runtimeReady:true}),
    addListener:(_,f)=>{listeners.add(f);return{remove:()=>listeners.delete(f)};},
    loadGarment:d=>{calls.push(['load',d.productRef]);emit('garmentLoaded',{productRef:d.productRef});},
    start:()=>{calls.push(['start']);if(env.startThrows)throw Error('synthetic native failure');emit('ready');emit('trackingAcquired');},
    pause:()=>calls.push(['pause']), resume:()=>calls.push(['resume']), stop:()=>calls.push(['stop']),
    dispose:()=>calls.push(['dispose']),
    capturePreview:async()=>{calls.push(['preview']); if(env.previewWait) return env.previewWait.promise;return {kind:'PREVIEW',captureId:'preview',localUri:'file:///preview.png',width:720,height:960};},
    capturePersonFrame:async()=>{calls.push(['person']);if(env.personWait)return env.personWait.promise;return {kind:'PERSON_FRAME',captureId:'person',localUri:'file:///person.png',width:720,height:960};}
  };
  const appState={currentState:'active',addEventListener:(name,fn)=>{assert.equal(name,'change');appListeners.add(fn);return {remove:()=>appListeners.delete(fn)};}};
  const rn={AppState:appState,Platform:{OS:platform}, StyleSheet:{create:x=>x,absoluteFill:{}},
    ...Object.fromEntries(['View','Text','Image','Pressable','Modal','ScrollView','ActivityIndicator'].map(x=>[x,x])),
    Linking:{openURL:url=>calls.push(['shop',url])}, Alert:{alert:()=>{}}, AccessibilityInfo:{announceForAccessibility:()=>{}},
    Animated:{Value:class{setValue(){}},View:'AnimatedView'},PanResponder:{create:()=>({panHandlers:{}})}};
  const auth={useAuthSession:()=>({user:env.actor?{id:env.actor}:null,isAuthenticated:!!env.actor})};
  const awareness={useVtoActorKPlusState:()=>env.kplus,useVtoAwarenessBlocker:()=>{}};
  const history={subscribeVtoAwareness:()=>()=>{},loadVtoAwareness:async()=>{},readVtoAwareness:()=>({initiated:false}),
    emitVtoAwarenessTap:()=>{},emitVtoAwarenessImpression:()=>{},markVtoInitiated:()=>{},markVtoCompleted:()=>{}};
  const photo={status:'idle',person:null,result:null,failure:null,adoptPerson:p=>{calls.push(['adopt',p.sanitizedUri]);photo.person=p;},dismiss:()=>{},clearPerson:()=>{}, generate:()=>{throw Error('unexpected paid generation');}};
  const byPath=new Map();
  function stub(rel,value){byPath.set(rel,value);}
  stub('constants/theme.ts',{LUXURY:deepStub(),RADIUS:deepStub(),SPACING:deepStub(),SHADOWS:deepStub()});
  stub('constants/featureFlags.ts',{VTO_UI_ENABLED:true,LIVE_VTO_ENABLED:true,LIVE_VTO_NATIVE_MODULE_NAME:'KScanLiveVto'});
  stub('contexts/AuthSessionContext.tsx',auth);
  stub('hooks/useVtoAwareness.ts',awareness);
  stub('hooks/useVtoAvailability.ts',{useVtoAvailability:()=>({available:env.kplus==='active',upgradeOpportunity:env.kplus==='free',loading:false,liveRemoteEnabled:env.remote,liveSupportedCategories:['top']})});
  stub('hooks/useVtoSessionStatus.ts',{useVtoSessionStatus:()=>({status:'idle'}),useVtoActorBoundaryEpoch:()=>env.actor});
  stub('hooks/useVirtualTryOn.ts',{useVirtualTryOn:()=>photo});
  stub('hooks/useReducedMotion.ts',{useReducedMotion:()=>true});
  stub('services/actorScope.ts',{currentActorScopeKey:()=>env.actor});
  stub('services/vto/vtoAwareness.ts',history);
  stub('services/vto/vtoFeatureControl.ts',{getVtoRemoteConfig:async()=>({enabled:true,liveEnabled:env.remote})});
  stub('services/vto/vtoLiveHarness.ts',{getLiveVtoHarnessState:()=>null,isLiveVtoHarnessActive:()=>false});
  stub('services/vto/vtoLiveCameraPermission.ts',{readLiveCameraPermission:async()=>env.permission,ensureLiveCameraPermission:async()=>{calls.push(['permission']);return env.permissionWait?env.permissionWait.promise:{state:env.permission==='denied'?'denied':'granted'};}});
  stub('services/privacyImageUpload.ts',{prepareImageForPrivacyUpload:async()=>({sanitizedUri:'file:///sanitized.jpg',width:720,height:960,policy:{metadataStripped:env.metadataStripped!==false,sanitizerVersion:1}}),cleanupSanitizedImage:async()=>{}});
  stub('services/vto/vtoPersonInput.ts',{VTO_PERSON_JPEG_QUALITY:0.8,VTO_PERSON_MAX_DIMENSION:1600});
  stub('services/haptics.ts',{selectionTick:()=>{},successPulse:()=>{},warningPulse:()=>{}});
  stub('services/navigationExit.ts',{goBackOrHome:()=>{}});
  stub('services/responsiveLayout.ts',{MODAL_MAX_WIDTH:600});
  stub('services/openExternalUrl.ts',{openExternalUrl:async()=>true});
  stub('services/vto/vtoTelemetry.ts',{emitVtoEvent:()=>{}});
  stub('services/kplus/kplusTelemetry.ts',{emitKPlusEvent:()=>{}});
  stub('services/vto/vtoConsent.ts',{hasVtoConsent:()=>false,loadVtoConsent:async()=>{},grantVtoConsent:async()=>{},VTO_CONSENT_COPY:{}});
  stub('services/commerceDestination.ts',{selectCommerceDestination:urls=>urls.find(Boolean)||null});
  stub('services/dressingRoomCommerce.ts',{normalizePersistedCommerceUrl:url=>url,openPersistedCommerceUrl:(url,open)=>open(url)});
  stub('components/luxury/index.ts',Object.fromEntries(['PrimaryButton','SecondaryButton','TertiaryButton','InlineNotice','LuxuryScreen','KScanHeader'].map(x=>[x,x])));
  for(const [rel,name] of [['components/icons/kscan/index.ts','KScanIcon'],['components/kplus/KPlusMarkerBadge.tsx','KPlusMarkerBadge'],['components/vto/VtoFirstUseCue.tsx','VtoFirstUseCue'],['components/vto/VtoMinimizedPill.tsx','VtoMinimizedPill'],['components/vto/VtoSaveToDressingRoom.tsx','VtoSaveToDressingRoom'],['components/vto/VtoSilhouetteGuide.tsx','VtoSilhouetteGuide'],['components/vto/VtoConsentStep.tsx','VtoConsentStep']])stub(rel,{[name]:name});
  stub('components/kplus/KPlusGate.tsx',{KPlusGate:({children})=>children({openUpgrade:()=>calls.push(['upgrade'])})});
  stub('components/vto/VtoLiveErrorBoundary.tsx',{VtoLiveErrorBoundary:({children})=>children}); // no render-exception claim
  const external={...r.runtimeModules,'react-native':rn,'expo-router':{router:{push:p=>calls.push(['route',p])}},'react-native-safe-area-context':{useSafeAreaInsets:()=>({bottom:0})},'expo-modules-core':{requireOptionalNativeModule:()=>env.native?native:null,requireNativeViewManager:()=>env.native?'NativeLiveView':null}};
  const core=new Set(['app/try-on-studio.tsx','components/home/TryOnStudioEntry.tsx','components/vto/LiveVtoPilotProduct.tsx','components/vto/TryItOnEntry.tsx','components/vto/VtoLaunchHost.tsx','components/vto/VirtualTryOnSheet.tsx','components/vto/VtoModeSelector.tsx','components/vto/VtoLivePanel.tsx','components/vto/VtoLiveNativeView.tsx','hooks/useVtoStudio.ts','hooks/useVtoLiveCapability.ts','hooks/useVtoLiveSession.ts','services/cameraOwnership.ts','types/vtoLive.ts','services/vto/vtoStudio.ts','services/vto/vtoDiscovery.ts','services/vto/vtoLiveSession.ts','services/vto/liveVtoNativeModule.ts','services/vto/vtoLiveCapability.ts','services/vto/vtoLiveGarment.ts','services/vto/vtoEligibility.ts','services/vto/vtoLiveGarmentRegistry.ts','services/vto/vtoLivePilotCatalog.ts','services/vto/vtoCommerceGarment.ts','services/vto/vtoPhotorealHandoff.ts','services/vto/vtoDecisionLoop.ts','services/vto/vtoProgressStages.ts']);
  function resolve(from,s){const p=path.posix.normalize(path.posix.join(path.posix.dirname(from),s));return [p,p+'.ts',p+'.tsx',p+'/index.ts'].find(p=>byPath.has(p)||(fs.existsSync(path.join(ROOT,p)) && fs.statSync(path.join(ROOT,p)).isFile()));}
  function load(rel){if(byPath.has(rel))return byPath.get(rel);assert.ok(core.has(rel),`unconfigured dependency: ${rel}`);const source=fs.readFileSync(path.join(ROOT,rel),'utf8');const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;const map={...external};for(const [,s]of compiled.matchAll(/require\(["']([^"']+)["']\)/g)){if(s.startsWith('.'))map[s]=load(resolve(rel,s));else assert.ok(s in map,`unconfigured external ${s}`);}const value=runModule(rel,map);byPath.set(rel,value);return value;}
  let tree; const root=load('app/try-on-studio.tsx').default;
  const api={env,calls,load,photo,r,emit,listeners,render(){tree=r.render(r.jsx(root,{}));return tree;},get tree(){return tree;},host(id){return findAll(tree,n=>typeof n.type==='string'&&n.props?.testID===id)[0];},async refresh(){api.render();await settle();return api.render();},async press(id){const n=api.host(id);assert.ok(n,`missing control ${id}`);assert.notEqual(n.props.disabled,true,`disabled ${id}`);await n.props.onPress();await settle();return api.refresh();},async open(){await api.refresh();await api.press('vto-live-pilot-try-on');api.host('vto-live-native-view').props.onLayout({});return api.refresh();},async start(){await api.open();return api.press('vto-live-enter');},cleanup(){r.unmount();}};
  api.background=()=>{appState.currentState='background';for(const f of appListeners)f('background');};
  return api;
}
test('background during pending camera permission must prevent a late native start',async()=>{
 const w=world('ios',{permissionWait:deferred()});try{await w.open();await w.press('vto-live-enter');w.background();await w.refresh();w.env.permissionWait.resolve({state:'granted'});await w.refresh();assert.equal(w.calls.filter(x=>x[0]==='start').length,0);assert.equal(w.load('services/cameraOwnership.ts').currentCameraOwner(),null);}finally{w.cleanup();}
});
test('background releases an active Live camera, listener and pending person handoff',async()=>{
 const w=world('android',{personWait:deferred()});try{await w.start();await w.press('vto-live-photoreal');w.background();await w.refresh();assert.equal(w.load('services/cameraOwnership.ts').currentCameraOwner(),null);assert.equal(w.listeners.size,0);w.env.personWait.resolve({kind:'PERSON_FRAME',captureId:'late',localUri:'file:///late.png',width:720,height:960});await w.refresh();assert.equal(w.calls.filter(x=>x[0]==='adopt').length,0);}finally{w.cleanup();}
});
for(const platform of ['ios','android'])test(`${platform}: mounted Studio -> actual shared entry -> sheet -> native controller -> customer controls`,async()=>{
 const w=world(platform);try{await w.start();assert.equal(w.calls.filter(x=>x[0]==='start').length,1);assert.match(textContent(w.tree),/Live/);await w.press('vto-live-pause-resume');await w.press('vto-live-pause-resume');await w.press('vto-live-capture-preview');assert.ok(w.calls.some(x=>x[0]==='preview'));await w.press('vto-mode-ai-photo');assert.ok(w.calls.some(x=>x[0]==='dispose'));assert.equal(w.load('services/cameraOwnership.ts').currentCameraOwner(),null);assert.equal(w.listeners.size,0);}finally{w.cleanup();}
});
module.exports={world,deferred};
for(const platform of ['ios','android']) {
test(`${platform}: Start waits for native layout and explicit customer permission`,async()=>{
 const w=world(platform);try{await w.refresh();assert.equal(w.calls.length,0);await w.press('vto-live-pilot-try-on');assert.equal(w.host('vto-live-enter').props.disabled,true);assert.equal(w.calls.length,0);w.host('vto-live-native-view').props.onLayout({});await w.refresh();await w.press('vto-live-enter');assert.deepEqual(w.calls.filter(x=>x[0]==='permission'),[['permission']]);}finally{w.cleanup();}
});
test(`${platform}: permission denial is bounded; AI Photo remains reachable`,async()=>{
 const w=world(platform);try{await w.open();w.env.permission='denied';await w.press('vto-live-enter');assert.ok(w.host('vto-live-error'));assert.equal(w.calls.filter(x=>x[0]==='start').length,0);await w.press('vto-live-switch-ai-photo');assert.ok(w.host('vto-mode-ai-photo'));assert.equal(w.load('services/cameraOwnership.ts').currentCameraOwner(),null);}finally{w.cleanup();}
});
test(`${platform}: switching modes during permission await fences late camera start`,async()=>{
 const w=world(platform,{permissionWait:deferred()});try{await w.open();await w.press('vto-live-enter');await w.press('vto-mode-ai-photo');w.env.permissionWait.resolve({state:'granted'});await w.refresh();assert.equal(w.calls.filter(x=>x[0]==='start').length,0);assert.equal(w.listeners.size,0);}finally{w.cleanup();}
});
test(`${platform}: Scanner camera lease refuses Live without disturbing Scanner`,async()=>{
 const w=world(platform);try{const camera=w.load('services/cameraOwnership.ts');const lease=camera.acquireCameraLease('scanner');await w.start();assert.equal(camera.currentCameraOwner(),'scanner');assert.ok(w.host('vto-live-error'));assert.equal(w.calls.filter(x=>x[0]==='start').length,0);lease.release();}finally{w.cleanup();}
});
test(`${platform}: Scanner preemption disposes active Live and removes listener`,async()=>{
 const w=world(platform);try{await w.start();const camera=w.load('services/cameraOwnership.ts');const lease=camera.acquireCameraLease('scanner');await w.refresh();assert.equal(camera.currentCameraOwner(),'scanner');assert.equal(w.listeners.size,0);assert.ok(w.calls.some(x=>x[0]==='dispose'));lease.release();}finally{w.cleanup();}
});
test(`${platform}: clean Live capture enters Photo review without automatic provider submission`,async()=>{
 const w=world(platform);try{await w.start();await w.press('vto-live-photoreal');assert.deepEqual(w.calls.filter(x=>x[0]==='adopt'),[['adopt','file:///sanitized.jpg']]);assert.equal(w.photo.person.source,'live_capture');assert.equal(w.host('vto-live-panel'),undefined);assert.equal(w.load('services/cameraOwnership.ts').currentCameraOwner(),null);}finally{w.cleanup();}
});
test(`${platform}: sanitizer refusal preserves Live and never adopts a person`,async()=>{
 const w=world(platform,{metadataStripped:false});try{await w.start();await w.press('vto-live-photoreal');assert.ok(w.host('vto-live-photoreal-error'));assert.equal(w.calls.filter(x=>x[0]==='adopt').length,0);assert.equal(w.load('services/cameraOwnership.ts').currentCameraOwner(),'live_vto');}finally{w.cleanup();}
});
test(`${platform}: late capture after Photo-mode switch is discarded`,async()=>{
 const w=world(platform,{personWait:deferred()});try{await w.start();await w.press('vto-live-photoreal');await w.press('vto-mode-ai-photo');w.env.personWait.resolve({kind:'PERSON_FRAME',captureId:'late',localUri:'file:///late.png',width:720,height:960});await w.refresh();assert.equal(w.calls.filter(x=>x[0]==='adopt').length,0);assert.equal(w.listeners.size,0);}finally{w.cleanup();}
});
test(`${platform}: native start failure can restart through the visible control`,async()=>{
 const w=world(platform,{startThrows:true});try{await w.start();assert.ok(w.host('vto-live-error'));w.env.startThrows=false;await w.press('vto-live-restart');assert.equal(w.calls.filter(x=>x[0]==='start').length,2);assert.equal(w.host('vto-live-error'),undefined);}finally{w.cleanup();}
});
test(`${platform}: free and unavailable-native states never offer a fabricated Live session`,async()=>{
 for(const over of [{kplus:'free'},{native:false},{remote:false}]){const w=world(platform,over);try{await w.refresh();assert.equal(w.host('vto-live-pilot-try-on'),undefined);assert.equal(w.calls.length,0);}finally{w.cleanup();}}
});
test(`${platform}: unmount releases camera and ignores captured frames still pending`,async()=>{
 const w=world(platform,{previewWait:deferred()});await w.start();await w.press('vto-live-capture-preview');w.cleanup();w.env.previewWait.resolve({kind:'PREVIEW',captureId:'late',localUri:'file:///late.png',width:720,height:960});await settle();assert.equal(w.load('services/cameraOwnership.ts').currentCameraOwner(),null);assert.equal(w.listeners.size,0);
});
}
