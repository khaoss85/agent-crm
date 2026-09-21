// @ts-check

import { claimTransactionMinter } from './transaction-witness.js';

/**
 * The one process-wide right to open an owned transaction scope.
 *
 * Claimed here so SQLite (`database.js`) and PostgreSQL
 * (`postgresql-storage.js`) share the minter instead of the second adapter
 * throwing "already claimed" at import. The exhaustion rule is unchanged: a
 * later `claimTransactionMinter()` from any other module is refused.
 */
export const openTransactionScope = claimTransactionMinter();
