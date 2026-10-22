/**
 * Compatibility barrel.
 *
 * Business logic lives in `queries/` and `commands/`. This file only re-exports
 * them so existing imports from `@/lib/engine` and `@/server/services/engine`
 * keep working while callers migrate to direct imports.
 */
export * from "./queries/workspace";
export * from "./queries/metrics";
export * from "./queries/today";
export * from "./queries/cabinet";
export * from "./queries/agent";
export * from "./queries/task";
export * from "./queries/review";
export * from "./queries/memory";
export * from "./queries/council";

export * from "./commands/agents";
export * from "./commands/goals";
export * from "./commands/checkins";
export * from "./commands/brief";
export * from "./commands/memory/facts";
export * from "./commands/memory/insights";
export * from "./commands/tasks/execution";
export * from "./commands/tasks/approvals";
export * from "./commands/tasks/run";
export * from "./commands/tasks/audit";
export * from "./commands/tasks/create";
export * from "./commands/council/context";
export * from "./commands/council/positions";
export * from "./commands/council/create";
export * from "./commands/council/decide";
export * from "./commands/council/dissent";
export * from "./commands/apprentice";
export * from "./commands/reflection";

export { currentWeek } from "./shared/time";
