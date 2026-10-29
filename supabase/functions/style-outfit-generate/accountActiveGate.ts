import { assertAccountActive } from '../_shared/deletion/common.ts';

/** A failed lifecycle lookup never authorizes provider or persistence work. */
export async function isOutfitAccountActive(
  userId: string,
  check: (id: string) => Promise<void> = assertAccountActive,
): Promise<boolean> {
  try {
    await check(userId);
    return true;
  } catch {
    return false;
  }
}
