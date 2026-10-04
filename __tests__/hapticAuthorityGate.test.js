const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const AUTHORITY = path.join(ROOT, 'services', 'haptics.js');
const DIRECT = /from\s+['"]expo-haptics['"]|require\(\s*['"]expo-haptics['"]\s*\)/;
function walk(dir, out=[]) {
  for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
    if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name.startsWith('.')) continue;
    const full=path.join(dir,entry.name);
    if(entry.isDirectory()) walk(full,out);
    else if(/\.(js|jsx|ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}
test('services/haptics.js is the only direct expo-haptics authority', () => {
  const files=['app','components','hooks','services'].flatMap((dir)=>walk(path.join(ROOT,dir)));
  const offenders=files.filter((file)=>file!==AUTHORITY&&DIRECT.test(fs.readFileSync(file,'utf8')));
  assert.deepEqual(offenders.map((file)=>path.relative(ROOT,file)),[]);
});
test('shared haptic authority exports only the restrained semantic vocabulary', () => {
  const src=fs.readFileSync(AUTHORITY,'utf8');
  const exported=[...src.matchAll(/^export function (\w+)/gm)].map((m)=>m[1]).sort();
  assert.deepEqual(exported,['errorPulse','selectionTick','softImpact','successPulse','warningPulse'].sort());
  assert.match(src,/function fire\(effect\)/);
  assert.match(src,/\.catch\(/);
});
