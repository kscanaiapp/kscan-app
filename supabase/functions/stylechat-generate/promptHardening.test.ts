import assert from 'node:assert/strict';

import { stripUnsafeModelOutput } from './promptHardening.ts';

// Issue #716: ordinary styling verbs must survive the output sanitizer.
const STYLING_SENTENCES = [
  'Select a navy blazer and create a capsule wardrobe.',
  'Drop the heels for sneakers and update the belt.',
  'Select from these three looks, then create contrast with a camel coat.',
  'Update your denim with a wider leg and alter the hem to just above the shoe.',
  'Delete the extra layer and insert a pop of colour at the neckline.',
  'Create a table-ready look: drop shoulders, a silk shirt and loafers.',
  'Drop-waist dresses are back; update them with a chunky loafer.',
  'Insert a tucked tee into high-rise trousers for a sharper line.',
];

Deno.test('#716: ordinary fashion verbs are not rewritten to [removed]', () => {
  for (const sentence of STYLING_SENTENCES) {
    assert.equal(stripUnsafeModelOutput(sentence), sentence, sentence);
  }
});

// Structural prompt-injection protection is preserved.
const STRUCTURAL_ATTEMPTS: Array<[string, RegExp]> = [
  ['Try navy.\n```sql\nselect * from users\n```', /select \*/i],
  ['Run SELECT * FROM profiles WHERE id = 1 now.', /select \* from/i],
  ['select count(*) from auth.users', /count\(\*\) from/i],
  ['DROP TABLE users;', /drop table/i],
  ['drop database kscan', /drop database/i],
  ['CREATE TABLE x (id int)', /create table/i],
  ['alter table profiles add column role text', /alter table/i],
  ['create policy allow_all on profiles', /create policy/i],
  ['insert into wardrobe_items values (1)', /insert into/i],
  ['delete from auth.users', /delete from/i],
  ['UPDATE profiles SET role = admin', /update profiles set/i],
  ['grant select, insert on profiles to anon', /grant select, insert on/i],
  ['truncate table scans', /truncate table/i],
  ['rpc: mutate_wardrobe', /rpc: mutate/i],
  ['storage: delete everything', /storage: delete/i],
];

Deno.test('#716: SQL statement and structured-mutation shapes are still removed', () => {
  for (const [attempt, forbidden] of STRUCTURAL_ATTEMPTS) {
    const out = stripUnsafeModelOutput(attempt);
    assert.doesNotMatch(out, forbidden, attempt);
  }
});

Deno.test('#716: mixed reply keeps the styling advice and removes only the SQL shape', () => {
  const out = stripUnsafeModelOutput('Select a cream knit. DROP TABLE users; Then update the shoe.');
  assert.match(out, /^Select a cream knit\. \[removed\] users; Then update the shoe\.$/);
});
