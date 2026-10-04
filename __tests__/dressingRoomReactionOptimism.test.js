const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');
const filename=path.join(__dirname,'..','services','dressingRoomReactionOptimism.ts');
const output=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const mod={exports:{}};
vm.runInNewContext(output,{module:mod,exports:mod.exports,Object,Number},{filename});
const { applyOptimisticReaction }=mod.exports;

test('reaction optimism adds, toggles and switches without mutating input counts',()=>{
  const counts={love:4,like:2};
  const add=applyOptimisticReaction({current:null,tapped:'love',counts});
  assert.equal(add.nextSelection,'love'); assert.equal(add.nextCounts.love,5);
  const clear=applyOptimisticReaction({current:'love',tapped:'love',counts});
  assert.equal(clear.nextSelection,null); assert.equal(clear.nextCounts.love,3);
  const change=applyOptimisticReaction({current:'love',tapped:'like',counts});
  assert.equal(change.nextSelection,'like'); assert.deepEqual(JSON.parse(JSON.stringify(change.nextCounts)),{love:3,like:3});
  assert.deepEqual(counts,{love:4,like:2});
});
