/** Offline executable comparison with the selected canonical shopping implementation.
 * deno run --no-config --allow-run=git --allow-read --allow-env qa/bobse/brandSearchCanonicalParity.ts
 * Extracts the fixed Git object; never edits the checkout or accesses the network.
 */
import assert from 'node:assert/strict';
import { getShoppingResults, _resetShoppingCache } from '../../supabase/functions/scan-identify/shoppingProvider.ts';
import { resolveBrandExpansion } from '../../supabase/functions/_shared/brandSearchExpansion.ts';
import { getFastCommerceResults, getScanCommerceResults } from '../../supabase/functions/scan-identify/scanCommerceRouter.ts';
import { commerceCacheClear } from '../../supabase/functions/scan-identify/commerceResultCache.ts';
const canonical = '4a832287f291086f600cf7411343ae5554cbf344';
const output = await new Deno.Command('git', { args: ['show', `${canonical}:supabase/functions/scan-identify/shoppingProvider.ts`], stdout:'piped', stderr:'piped' }).output();
if (!output.success) throw new Error('Canonical Git source unavailable');
const base = new URL('../../supabase/functions/scan-identify/shoppingProvider.ts', import.meta.url);
const code = new TextDecoder().decode(output.stdout).replace(/from (['"])(\.[^'"]+)\1/g, (_m, q, path) => `from ${q}${new URL(path,base).href}${q}`);
const legacy = await import(`data:application/typescript,${encodeURIComponent(code)}`);
const originalFetch = globalThis.fetch;
const keys=['SHOPPING_ENABLED','SHOPPING_SERPER_API_KEY','SHOPPING_BRAVE_API_KEY','POSHMARK_ENABLED'];
const previous = keys.map(k=>Deno.env.get(k));
const realNow=Date.now;
const item={title:'Black leather moto jacket',link:'https://retailer-fashion.com/p/jacket',imageUrl:'https://retailer-fashion.com/i/jacket.jpg',price:'$90',currency:'USD'};
let comparisons=0;
try {
  for(const scenario of ['primary','fallback','empty','unsafe','disabled']) {
    Deno.env.set('SHOPPING_SERPER_API_KEY','offline-test'); Deno.env.set('SHOPPING_BRAVE_API_KEY','offline-test'); Deno.env.set('SHOPPING_ENABLED',scenario==='disabled'?'false':'true');
    const run = async (shopping: typeof getShoppingResults, reset: ()=>void, userOff: boolean) => {
      reset(); const calls: unknown[]=[];
      globalThis.fetch=async (url,init)=>{
        calls.push({url:String(url),method:init?.method ?? 'GET',body:init?.body ?? null});
        if(String(url).includes('serper')) return scenario==='fallback'||scenario==='empty' ? Response.json({shopping:[]}) : Response.json({shopping:[scenario==='unsafe'?{...item,link:'http://127.0.0.1/private'}:item]});
        return Response.json({web:{results:scenario==='fallback'?[{title:item.title,url:item.link}]:[]}});
      };
      const expansion = userOff ? await resolveBrandExpansion('11111111-1111-4111-8111-111111111111',{item_type:'outerwear'},undefined,()=> 'true',async path=>{
        assert.ok(path.startsWith('user_stylist_preferences?'),'user OFF must not read registry');
        return Response.json([{include_black_owned_brand_search:false}]);
      }) : undefined;
      const results=[];
      for(let n=0;n<2;n++)results.push(await shopping({query:'black leather moto jacket',limit:8,...(userOff?{expansion}: {})}));
      return {calls,results};
    };
    const baseline=await run(legacy.getShoppingResults,legacy._resetShoppingCache,false);
    for(const userOff of [false,true]) {
      assert.deepEqual(await run(getShoppingResults,_resetShoppingCache,userOff),baseline,`${scenario}: ${userOff?'flag ON/user OFF':'flag OFF'}`);
      comparisons++;
    }
  }
  const routerOutput=await new Deno.Command('git',{args:['show',`${canonical}:supabase/functions/scan-identify/scanCommerceRouter.ts`],stdout:'piped',stderr:'piped'}).output();
  if(!routerOutput.success)throw new Error('Canonical router unavailable');
  const routerBase=new URL('../../supabase/functions/scan-identify/scanCommerceRouter.ts',import.meta.url);
  const routerCode=new TextDecoder().decode(routerOutput.stdout).replace(/from (['"])(\.[^'"]+)\1/g,(_m,q,path)=>`from ${q}${new URL(path,routerBase).href}${q}`);
  const legacyRouter=await import(`data:application/typescript,${encodeURIComponent(routerCode)}`);
  Date.now=()=>1793793600000;
  Deno.env.set('SHOPPING_ENABLED','true'); Deno.env.set('POSHMARK_ENABLED','false');
  for(const [label,reference,current] of [
    ['image fast path',legacyRouter.getFastCommerceResults,getFastCommerceResults],
    ['image inline',legacyRouter.getScanCommerceResults,getScanCommerceResults],
    ['text parity',legacyRouter.getScanCommerceResults,getScanCommerceResults],
  ] as const) {
    const run=async(fn:typeof getFastCommerceResults,userOff:boolean)=>{
      _resetShoppingCache(); commerceCacheClear(); const calls:unknown[]=[];
      globalThis.fetch=async(url,init)=>{calls.push({url:String(url),body:init?.body??null});return Response.json({shopping:[item]});};
      const identification={item_type:'outerwear',subtype:'moto jacket',primary_color:'black',material_estimate:'leather'};
      const expansion=userOff?await resolveBrandExpansion('11111111-1111-4111-8111-111111111111',identification,undefined,()=> 'true',async()=>Response.json([{include_black_owned_brand_search:false}])):undefined;
      const results=[];
      for(let n=0;n<2;n++)results.push(await fn({mode:label==='text parity'?'text':'image',allowTextMode:true,identification,searchQueries:['black leather moto jacket'],limit:8,...(userOff?{expansion}:{})}));
      return {calls,results};
    };
    const expected=await run(reference,false);
    for(const off of [false,true]){assert.deepEqual(await run(current as typeof getFastCommerceResults,off),expected,`${label}: ${off?'user OFF':'flag OFF'}`);comparisons++;}
  }
  console.log(JSON.stringify({canonical,comparisons,requestsPerComparison:2,status:'PASS',compared:['complete outputs','ordering','provider URLs','methods','query bodies','cache invocation patterns','image fast path','image inline','TextScan parity']}));
} finally {
  Date.now=realNow; commerceCacheClear();
  globalThis.fetch=originalFetch; _resetShoppingCache();
  keys.forEach((k,i)=>previous[i]===undefined?Deno.env.delete(k):Deno.env.set(k,previous[i]!));
}
