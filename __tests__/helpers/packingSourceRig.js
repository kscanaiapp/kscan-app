const assert = require('node:assert/strict');
const root = require('node:path').resolve(__dirname, '../..');
const h = require(root + '/__tests__/helpers/componentRenderer');
const types = h.runModule('types/packing.ts', {}, { jsx: false });
const trip = {
    destination: 'Paris', startDate: '2026-12-10', endDate: '2026-12-13', tripType: 'leisure', activities: ['dinner'], note: ''
};
function wirePlan(id = 'plan-1', destination = 'Paris') { return {
    contractVersion: 'packing_plan_v1', planId: id, trip: {
        ...trip, destination, nights: 3
    }, weather: {
        provenance: 'UNAVAILABLE', summary: null
    }, packedItems: [{
            itemId: 'item-1', clientId: 'local-1', title: 'My shirt', layeringRole: 'base'
        }, {
            itemId: 'item-2', clientId: 'local-2', title: 'My boots', layeringRole: 'shoe'
        }], outfits: [{
            outfitId: 'look-1', label: 'Dinner look', itemIds: ['item-1', 'item-2']
        }], gaps: [], constraints: {
        excludedItemIds: [], notes: [], packLight: false
    }, counts: {
        items: 2, outfits: 1, shoes: 1, gaps: 0
    }, assumptions: []
}; }
function rig(os = 'ios', seed = {}) {
    const renderer = h.createRenderer(), disk = new Map(Object.entries(seed)), calls = [], events = [];
    renderer.react.memo = component => component;
    let actor = 'actor-a', authenticated = true, entitlement = 'active', diskWriteError = false, diskRead = null, uuid = 0;
    const storage = {
        getItem: async (k) => diskRead ? await diskRead(k) : disk.get(k) || null, setItem: async (k, v) => {
            if (diskWriteError)
                throw Error('storage unavailable');
            disk.set(k, v);
        }, removeItem: async (k) => disk.delete(k), getAllKeys: async () => [...disk.keys()], multiRemove: async (ks) => ks.forEach(k => disk.delete(k))
    };
    const response = h.runModule('services/packing/packingResponse.ts', { '../../types/packing': types });
    const cache = h.runModule('services/packing/packingPlanCache.ts', {
        '@react-native-async-storage/async-storage': {
            __esModule: true, default: storage
        }, './packingResponse': response
    });
    const store = h.runModule('services/packing/packingPlanStore.ts', { './packingPlanCache': cache });
    const authority = h.runModule('services/actorContext.js', {});
    authority.advanceActorEpoch(actor);
    const scope = h.runModule('services/actorScope.ts', { './actorContext': authority });
    const transport = { functions: { invoke: async (name, args) => { const d = h.deferred(); calls.push({
                name, args, ...d
            }); return d.promise; } } };
    const client = h.runModule('services/packing/packingClient.ts', {
        '../supabaseClient': { supabase: transport }, '../../types/packing': types, './packingResponse': response
    });
    const sequence = h.runModule('services/packing/packingRefinementSequence.ts', {});
    const refinement = h.runModule('services/packing/packingRefinement.ts', {});
    const changes = h.runModule('services/packing/packingPlanChanges.ts', {});
    renderer.react.useSyncExternalStore = (subscribe, getSnapshot) => { const [, refresh] = renderer.react.useState(0); renderer.react.useEffect(() => subscribe(() => refresh(n => n + 1)), [subscribe]); return getSnapshot(); };
    const hook = h.runModule('hooks/usePackingPlan.ts', {
        ...renderer.runtimeModules, 'expo-crypto': { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` }, '../contexts/AuthSessionContext': { useAuthSession: () => ({
                user: actor ? { id: actor } : null, isAuthenticated: authenticated
            }) }, '../services/actorScope': scope, './useKPlusEntitlement': { useKPlusEntitlement: () => ({
                state: entitlement, isActive: entitlement === 'active'
            }) }, '../services/kplus/kplusEntitlementStore': { getKPlusEntitlementSnapshot: () => ({ state: entitlement }) }, '../services/kplus/kplusTelemetry': { emitKPlusEvent: (...a) => events.push(a) }, '../constants/featureFlags': { PACKING_INTELLIGENCE_V1: true }, '../services/packing/packingClient': client, '../services/packing/packingPlanStore': store, '../services/packing/packingPlanCache': cache, '../services/packing/packingRefinement': refinement, '../services/packing/packingRefinementSequence': sequence, '../services/packing/packingPlanChanges': changes
    });
    let api;
    function Probe() { api = hook.usePackingPlan(); return null; }
    let element = renderer.jsx(Probe, {});
    const rn = {
        ...h.createReactNativeStub({ platformOS: os }), findNodeHandle: () => null
    };
    const dates = h.runModule('components/packing/packingDates.ts', {}), calendar = h.runModule('components/packing/packingCalendar.ts', { './packingDates': dates });
    const picker = h.runModule('components/packing/PackingDateRangePicker.tsx', {
        ...renderer.runtimeModules, 'react-native': rn, 'react-native-safe-area-context': { useSafeAreaInsets: () => ({
                top: 0, bottom: 0
            }) }, '../../constants/theme': h.deepStub(), './packingDates': dates, './packingCalendar': calendar
    });
    const form = h.runModule('components/packing/PackingTripForm.tsx', {
        ...renderer.runtimeModules, 'react-native': rn, '../../constants/theme': h.deepStub(), '../luxury': { PrimaryButton: 'PrimaryButton' }, './packingDates': dates, './PackingDateRangePicker': picker, '../../types/packing': types
    });
    const views = h.runModule('components/packing/PackingPlanView.tsx', {
        ...renderer.runtimeModules, 'react-native': rn, '../../constants/theme': h.deepStub(), '../../services/haptics': { selectionTick() { } }, '../luxury': { SectionHeader: 'SectionHeader' }, '../../types/packing': types
    });
    const chips = h.runModule('services/refinementChips.ts', {});
    const screen = h.runModule('app/packing/index.tsx', {
        ...renderer.runtimeModules, 'react-native': rn, 'expo-router': { router: { back() { } } }, '../../components/luxury': {
            LuxuryScreen: 'LuxuryScreen', KScanHeader: 'KScanHeader', PrimaryButton: 'PrimaryButton', SecondaryButton: 'SecondaryButton'
        }, '../../components/kplus/KPlusGate': { KPlusGate: p => p.children({
                resolving: entitlement === 'loading', isActive: entitlement === 'active', openUpgrade: () => events.push(['upgrade'])
            }) }, '../../components/packing/PackingTripForm': form, '../../components/packing/PackingPlanView': views, '../../hooks/usePackingPlan': { usePackingPlan: () => { api = hook.usePackingPlan(); return api; } }, '../../hooks/useCloset': { useCloset: () => ({ items: [{
                        id: 'local-1', imageUri: 'file:///synthetic-shirt.jpg'
                    }] }) }, '../../constants/theme': h.deepStub(), '../../constants/featureFlags': { PACKING_INTELLIGENCE_V1: true }, '../../services/refinementChips': chips, '../../services/actorScope': scope
    });
    const render = () => renderer.render(element);
    const node = id => { const a = h.byTestId(render(), id); assert.ok(a.length, 'missing ' + id); return a[a.length - 1]; };
    return {
        renderer, render, node, screen() { renderer.unmount(); element = renderer.jsx(screen.default, {}); return render(); }, get api() { render(); return api; }, store, cache, client, calls, events, disk,
        switchActor(id) { actor = id; authenticated = !!id; authority.advanceActorEpoch(id); store.resetPackingPlanState(); render(); }, setEntitlement(s) { entitlement = s; render(); }, setDiskFailure(v) { diskWriteError = v; }, setRead(v) { diskRead = v; },
        succeed(i = 0, plan = wirePlan()) { calls[i].resolve({
            data: {
                status: 'success', message: 'Your plan', plan
            }, error: null
        }); }, fail(i = 0, error = { status: 401 }) { calls[i].resolve({
            data: null, error
        }); },
        unmount() { renderer.unmount(); }, scope
    };
}
module.exports = {
    rig, trip, wirePlan, ...h
};
