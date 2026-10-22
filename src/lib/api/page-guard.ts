/**
 * A user row exists as soon as someone signs up, but their cabinet does not:
 * `setupWorkspace` is what creates the seven agents. Page loaders therefore
 * treat "authenticated but no agents" as "not set up yet" and navigate to
 * `/setup` instead of rendering an empty shell.
 */
export function needsSetup(agents: ReadonlyArray<unknown>): boolean {
  return agents.length === 0;
}
