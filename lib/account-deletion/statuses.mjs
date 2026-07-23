// Deletion-request status constants shared by the CLI wrapper, the
// hard-delete pipeline, and the (future) automatic scheduler/worker.
//
// Legacy model: requests start 'pending' and move to 'processing' while a
// human operator runs the CLI script.
// New lifecycle model: requests move to 'deactivated' immediately (grace
// period, restorable), then 'purging' while the hard-delete pipeline runs,
// then terminal 'purged'. 'deletion_requests' rows in 'purged' state survive
// the Auth user deletion (see userDataResources survive_auth_delete action).

export const OPEN_LEGACY_STATUSES = ['pending', 'processing'];
export const ACTIVE_DELETION_STATUSES = ['deactivated', 'purging'];

// Legacy + new: any status where the CLI/worker should still be able to find
// and act on the request (list-pending, get-open-request, allow processing).
export const OPEN_STATUSES = [...OPEN_LEGACY_STATUSES, ...ACTIVE_DELETION_STATUSES];

// Status a request must be in for a user-initiated restoration to be allowed.
export const CLAIMABLE_STATUS = 'deactivated';

// Terminal status once the hard-delete pipeline has completed successfully.
export const TERMINAL_STATUS = 'purged';

export const RESTORABLE_STATUSES = [CLAIMABLE_STATUS];
