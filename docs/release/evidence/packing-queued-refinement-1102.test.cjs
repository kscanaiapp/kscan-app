const test=require('node:test'),assert=require('node:assert/strict');const {rig,trip,wirePlan}=require('C:/b35packing1102/__tests__/helpers/packingSourceRig'),h=require('C:/b35packing1102/__tests__/helpers/componentRenderer');
test('queued refinement from a departed actor epoch cannot change the returned actor new trip',async()=>{const r=rig();let first,queued;try{
 let initial=r.api.generate(trip);r.succeed();await initial;
 first=r.api.refineWith('Old trip first note');queued=r.api.refineWith('Old trip queued note');await h.settle();assert.equal(r.calls.length,2,'only the first serialized refinement is dispatched');
 r.switchActor('actor-b');r.switchActor('actor-a');const fresh=r.api.generate({...trip,destination:'Rome'});r.succeed(2,wirePlan('new-trip','Rome'));await fresh;
 r.succeed(1,wirePlan('departed-trip','Paris'));await first;await h.settle();
 console.log(JSON.stringify({sourceSha:'8ffd1ccaa552d74358071d77d499b0a4615be7c1',expectedCalls:3,actualCalls:r.calls.length,unexpectedTrip:r.calls[3]?.args.body.trip.destination,unexpectedNotes:r.calls[3]?.args.body.constraints.notes,newTripStatus:r.api.status}));
 assert.equal(r.calls.length,3,'departed-epoch queued note must not dispatch under the new session');assert.deepEqual(r.api.constraintNotes,[]);assert.equal(r.api.plan.planId,'new-trip');
 }finally{for(const call of r.calls)call.resolve({data:null,error:{status:499}});await Promise.allSettled([first,queued]);r.unmount()}
});
