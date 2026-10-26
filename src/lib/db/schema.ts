/**
 * The database schema, split into per-domain modules under `./schema`.
 *
 * This file stays the single import path (`@/lib/db/schema`) so none of the
 * modules that consume it had to change, but it now holds three lines of
 * re-exports instead of 1,128 lines of table definitions: a change to the
 * memory tables touches `./schema/memory.ts` and nothing else, which is what
 * makes the diff reviewable and the merge conflicts rare.
 *
 * Load order matters. Each module may only import from the ones listed above
 * it, because a table's foreign keys point backwards: core (users) ← agents ←
 * goals ← tasks ← runs ← memory ← councils ← governance ← ops. Keep that
 * property when adding a module — the FK graph is acyclic, and it should stay
 * that way.
 */
export * from "./schema/types";
export * from "./schema/core";
export * from "./schema/agents";
export * from "./schema/goals";
export * from "./schema/tasks";
export * from "./schema/runs";
export * from "./schema/learning";
export * from "./schema/memory";
export * from "./schema/councils";
export * from "./schema/governance";
export * from "./schema/ops";
