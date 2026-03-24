/**
 * @fileoverview Re-exports the shared DB handle from work-items/db.ts.
 *
 * The messages table lives in the same work-items.db file.
 * This module simply re-exports the DB access functions so that
 * messages/store.ts does not need to import directly from work-items/.
 */

export { getDb, openDb, closeDb } from '../work-items/db.js';
