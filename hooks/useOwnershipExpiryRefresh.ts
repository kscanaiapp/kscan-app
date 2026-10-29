import { useEffect, useState } from 'react';
import { hasVerifiedOwnership, type OwnershipIdentity } from '../services/blackOwnedDiscovery';

/** Refresh mounted badges at known expiry; never refetch or alter ranking. */
export function useOwnershipExpiryRefresh(identities: readonly (OwnershipIdentity | undefined)[]): void {
  const [revision, setRevision] = useState(0);
  const now = Date.now();
  const deadlines = identities.filter((identity) => hasVerifiedOwnership(identity, now))
    .map((identity) => Date.parse(identity!.verifiedUntil));
  const deadline = deadlines.length ? Math.min(...deadlines) : null;
  useEffect(() => {
    if (deadline === null) return;
    const delay = Math.max(1, Math.min(deadline - Date.now() + 1, 2147483647));
    const timer = setTimeout(() => setRevision((value) => value + 1), delay);
    return () => clearTimeout(timer);
  }, [deadline, revision]);
}
