/**
 * Ownership/persistence side-effect proof (spec §13). VTO must create only
 * the quota/reservation state necessary for an attempt — never an
 * unrelated Closet, Dressing Room, or Saved Scan write. Actor-scoped only;
 * never a global table scan.
 */
'use strict';

function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export async function snapshotActorPersistence(runSql, userId) {
  const rows = await runSql(
    `select `
    + `(select count(*) from public.user_closet_items where user_id = ${sqlQuote(userId)}) as closet, `
    + `(select count(*) from public.dressing_room_participants where user_id = ${sqlQuote(userId)}) as dressing_room, `
    + `(select count(*) from public.saved_scans where user_id = ${sqlQuote(userId)}) as saved_scan;`,
  );
  const row = Array.isArray(rows) ? rows[0] : rows;
  return {
    closet: Number(row?.closet ?? 0),
    dressingRoom: Number(row?.dressing_room ?? 0),
    savedScan: Number(row?.saved_scan ?? 0),
  };
}

export function diffPersistence(before, after) {
  return {
    autoClosetWrite: after.closet > before.closet ? 'YES' : 'NO',
    autoDressingRoomWrite: after.dressingRoom > before.dressingRoom ? 'YES' : 'NO',
    autoSavedScanWrite: after.savedScan > before.savedScan ? 'YES' : 'NO',
  };
}
