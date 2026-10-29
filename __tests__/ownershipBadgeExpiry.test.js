const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRenderer, runModule, deepStub, textContent } = require('./helpers/componentRenderer');
const { loadPortable } = require('./helpers/commerceMatchContract');
function fixture(identity) {
  const r = createRenderer();
  const client = loadPortable('services/blackOwnedDiscovery.ts');
  const hookPath = 'hooks/useOwnershipExpiryRefresh.ts';
  const hook = fs.existsSync(path.join(__dirname, '..', hookPath)) ? runModule(hookPath, { ...r.runtimeModules, '../services/blackOwnedDiscovery': client }) : {};
  const { ProductCard } = runModule('components/luxury/ProductCard.tsx', {
    ...r.runtimeModules,
    'react-native': { View:'View', Text:'Text', Image:'Image', Pressable:'Pressable', StyleSheet:{create:x=>x} },
    '../../constants/theme': { LUXURY:deepStub(), SPACING:deepStub(), RADIUS:deepStub() },
    '../../services/blackOwnedDiscovery':client,
    '../../hooks/useOwnershipExpiryRefresh':hook,
  });
  return () => r.render(r.jsx(ProductCard,{ title:'Synthetic product', ownershipIdentity:identity }));
}
function withClock(run) {
  const original = { now:Date.now, setTimeout:global.setTimeout, clearTimeout:global.clearTimeout };
  let now = Date.parse('2030-01-01T00:00:00Z');
  const tasks = new Map(); let id = 0;
  Date.now = () => now;
  global.setTimeout = (callback,delay) => {const key=++id;tasks.set(key,{callback,delay});return key;};
  global.clearTimeout = key => tasks.delete(key);
  try { run({tasks,advance(ms){now+=ms;for(const [key,task] of [...tasks])if(task.delay<=ms){tasks.delete(key);task.callback();}}}); }
  finally {Date.now=original.now;global.setTimeout=original.setTimeout;global.clearTimeout=original.clearTimeout;}
}
test('a visible verified badge schedules its own expiry without another user action', () => withClock(({tasks,advance}) => {
  const render=fixture({brandId:'synthetic',brandName:'Synthetic',ownershipVerificationStatus:'verified',publicOwnershipLabelAllowed:true,verifiedUntil:new Date(Date.now()+1000).toISOString()});
  assert.match(textContent(render()),/Black-owned brand/);
  assert.equal(tasks.size,1,'expiry must cause a React update even while the card is idle');
  advance(1001);
  assert.doesNotMatch(textContent(render()),/Black-owned brand/);
}));
test('ordinary unrelated cards retain content and schedule no expiry work', () => withClock(({tasks}) => {
  const render=fixture(undefined);assert.match(textContent(render()),/Synthetic product/);assert.equal(tasks.size,0);
}));
