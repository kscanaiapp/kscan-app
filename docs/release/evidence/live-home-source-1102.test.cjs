const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const root=process.env.B35_AUDIT_SOURCE_ROOT||'C:/b35live1102';
const {world}=require(path.join(root,'__tests__/vtoLiveMountedSource.test.js'));
const {findAll,settle}=require(path.join(root,'__tests__/helpers/componentRenderer'));
for(const platform of ['ios','android'])test(`audit: ${platform} real Home entry navigates to actual Studio; anonymous Studio is hidden`,async()=>{
 const w=world(platform);try{
  const entry=w.load('components/home/TryOnStudioEntry.tsx').TryOnStudioEntry;
  const render=()=>w.r.render(w.r.jsx(entry,{}));render();await settle();const tree=render();
  const button=findAll(tree,n=>typeof n.type==='string'&&n.props?.accessibilityRole==='button')[0];
  assert.ok(button);button.props.onPress();assert.deepEqual(w.calls,[['route','/try-on-studio']]);
  w.env.actor=null;await w.refresh();assert.ok(w.host('try-on-studio-hidden'));assert.equal(w.host('vto-live-pilot-try-on'),undefined);assert.equal(w.calls.filter(x=>x[0]==='start').length,0);
 }finally{w.cleanup();}
});
