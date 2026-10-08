const test = require('node:test');
const assert = require('node:assert/strict');
const { createRenderer, runModule, findAll, textContent } = require('./helpers/componentRenderer');

function mount(mutate) {
  const renderer = createRenderer();
  const actor = runModule('services/actorContext.js', {}, { jsx: false });
  actor.advanceActorEpoch('actor-a');
  function ScannerSession() {
    const [result, setResult] = renderer.react.useState('empty');
    return renderer.jsx('View', { children: [renderer.jsx('Text', { children: result }),
      renderer.jsx('Button', { testID: 'complete', onPress: () => setResult('actor-a private result') })] });
  }
  const { default: ScannerRoute } = runModule('app/scan/index.tsx', {
    ...renderer.runtimeModules, '../../app': { __esModule: true, default: ScannerSession },
    '../../contexts/AuthSessionContext': { useAuthSession: () => ({ user: { id: actor.getActorContext().actorId } }) },
    '../../services/actorContext': actor,
  }, { mutate });
  const root = renderer.jsx(ScannerRoute, {});
  let tree = renderer.render(root);
  return { actor, render: () => { tree = renderer.render(root); return textContent(tree); },
    complete: () => { findAll(tree, (node) => node.props?.testID === 'complete')[0].props.onPress(); tree = renderer.render(root); } };
}

test('a retained Scanner route resets completed private result on authenticated A to B', () => {
  const m = mount();
  m.complete();
  assert.match(m.render(), /private result/);
  m.actor.advanceActorEpoch('actor-b');
  assert.equal(m.render(), 'empty');
});

test('same-account sign-out/sign-in cycle resets while ordinary token refresh preserves session', () => {
  const m = mount();
  m.complete();
  assert.match(m.render(), /private result/, 'ordinary render/token refresh retains the actor epoch');
  m.actor.advanceActorEpoch(null);
  m.actor.advanceActorEpoch('actor-a');
  assert.equal(m.render(), 'empty', 'even a batched A to signed-out to A transition changes the key');
});

test('NEGATIVE CONTROL: removing the actor key leaks the completed result across accounts', () => {
  const m = mount((text) => text.replace('key={`${actor.actorId ?? \'device-local\'}:${actor.epoch}`}', ''));
  m.complete();
  m.actor.advanceActorEpoch('actor-b');
  assert.match(m.render(), /private result/);
  assert.throws(() => assert.equal(m.render(), 'empty'));
});
