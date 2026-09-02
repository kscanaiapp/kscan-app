const H=require('./fixtures/avatarEngineHarness.js');
const E=H.loadEngine(),P=H.loadPackages();
const CAPS={elise:P.resolveAvatarPackage('stylist_portrait_01').validation.assetCapabilities,
            henry:P.resolveAvatarPackage('stylist_portrait_02').validation.assetCapabilities};
const CORPUS={
 NEUTRAL:'That jacket would work well with the trousers already in your Closet.',
 QUESTION:'Would you like me to find a more casual option?',
 ENTHUSIASTIC:'Yes, that combination works beautifully.',
 LIST:'Pack the blazer, black trousers, two lightweight tops, and the loafers.',
 BRANDS:'The Loewe bag works nicely with the Maison Margiela trousers.',
 LONG:'For a dinner like that I would start with the charcoal blazer you already own. Pair it with the black trousers rather than denim, because the drape reads more polished. Keep the accessories simple so the silhouette stays clean. If the room runs warm, the lightweight knit underneath works better than a shirt. Finish with the loafers, and you are done.',
};
function synth(t,cps=15){const b=1/cps;const c=[],s=[],e=[];let x=0;
 for(const ch of t){let d=b;if(/[aeiouAEIOU]/.test(ch))d=b*1.35;else if(/\s/.test(ch))d=b*.85;
 else if(/[,;:]/.test(ch))d=b*3.2;else if(/[.!?]/.test(ch))d=b*6;c.push(ch);s.push(x);e.push(x+d);x+=d;}
 return{characters:c,characterStartTimesSeconds:s,characterEndTimesSeconds:e};}
function m(caps,text,hold){
  const tl=E.compileSpeechTimeline(synth(text),caps,{minVisibleHoldMs:hold});
  const cur=new E.TimelineCursor(); const T=tl.totalDurationSeconds; const s=[];
  for(let ms=0;ms<=T*1000;ms+=80) s.push(cur.resolve(tl,ms/1000));
  let ch=0; for(let i=1;i<s.length;i++) if(s[i]!==s[i-1]) ch++;
  const open=s.filter(x=>x==='open').length;
  return {rate:ch/T, open:100*open/s.length, T};
}
for(const who of ['elise','henry']){
  console.log(`\n=== ${who.toUpperCase()} — visible change rate at the 80ms render tick ===`);
  console.log('SAMPLE          before(hold=0)      after(hold=90)     open% before→after');
  let rb=[],ra=[],ob=[],oa=[];
  for(const [k,t] of Object.entries(CORPUS)){
    const b=m(CAPS[who],t,0), a=m(CAPS[who],t,90);
    rb.push(b.rate);ra.push(a.rate);ob.push(b.open);oa.push(a.open);
    console.log(`${k.padEnd(14)}  ${b.rate.toFixed(2)}/s             ${a.rate.toFixed(2)}/s            ${b.open.toFixed(0)}% → ${a.open.toFixed(0)}%`);
  }
  const av=x=>x.reduce((p,c)=>p+c,0)/x.length;
  console.log(`${'AVERAGE'.padEnd(14)}  ${av(rb).toFixed(2)}/s             ${av(ra).toFixed(2)}/s            ${av(ob).toFixed(0)}% → ${av(oa).toFixed(0)}%`);
  console.log(`${'MAXIMUM'.padEnd(14)}  ${Math.max(...rb).toFixed(2)}/s             ${Math.max(...ra).toFixed(2)}/s            max open ${Math.max(...oa).toFixed(0)}%`);
}
