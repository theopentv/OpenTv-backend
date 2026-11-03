/**
 * `cloudflare:workers` under Node, for the suites that load the OAuth library
 * (it imports `WorkerEntrypoint` at the top and never uses it on the paths the
 * tests drive). Mapped in vitest.config.ts. Nothing in `src/` imports this.
 */
export class WorkerEntrypoint {
  constructor(
    readonly ctx: unknown,
    readonly env: unknown,
  ) {}
}
export class DurableObject extends WorkerEntrypoint {}
export const env = {};
