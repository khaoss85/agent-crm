// @ts-check

// Shared by bootstrap and native restore without pulling the PostgreSQL client
// implementation into the provider-neutral core backup contract.
export const DATA_ADVISORY_LOCK = Object.freeze({ classId: 1094927186, objectId: 1145197617 });

// A restore child holds this transaction lock while it executes rendered SQL.
// Startup and a later restore acquire DATA_ADVISORY_LOCK first, then this lock,
// so a child that outlives its coordinator still fences every authority path.
export const DATA_RESTORE_CHILD_LOCK = Object.freeze({ classId: 1094927186, objectId: 1145197618 });
