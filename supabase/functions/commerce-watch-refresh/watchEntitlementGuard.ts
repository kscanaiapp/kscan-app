// A claim authorizes queued work at claim time. Re-read canonical K+ at the
// provider boundary so a lapse during queueing cannot dispatch new paid work.
export async function runEntitledWatchObservation<T>(
  userId: string,
  readEntitlement: (userId: string) => Promise<boolean>,
  observe: () => Promise<T>,
): Promise<T | null> {
  let active = false;
  try { active = await readEntitlement(userId); } catch { active = false; }
  if (active !== true) return null;
  return observe();
}
