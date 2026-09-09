/**
 * `cloudflare:workers` is a runtime module workerd supplies and node does not,
 * so importing the Worker entry under vitest fails without a stand-in.
 *
 * `@cloudflare/workers-oauth-provider` uses `WorkerEntrypoint` for one thing:
 * telling a handler class apart from a handler object, with `instanceof` on the
 * prototype chain. An empty class answers that question the same way, because
 * every handler in this app is an object.
 */
export class WorkerEntrypoint {}
