/**
 * @fileoverview Public API surface for the work-items module.
 */

export type { WorkItem, WorkItemDependency, WorkItemStatus, WorkItemSource } from './types.js';
export { openDb, getDb, closeDb } from './db.js';
export {
  createWorkItem,
  getWorkItem,
  listWorkItems,
  updateWorkItem,
  deleteWorkItem,
  claimWorkItem,
  getReadyWorkItems,
  addDependency,
  removeDependency,
  listDependencies,
  decay,
} from './store.js';
