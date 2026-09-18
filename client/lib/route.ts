import { parseRoute } from './router.js';

export type Route = { name: string; id: string | null; nonce: number };

let snapshot: Route = { ...parseRoute(location.hash), nonce: 0 };
const listeners = new Set<() => void>();

function read(bump: boolean) {
  const next = parseRoute(location.hash);
  snapshot = { name: next.name, id: next.id, nonce: bump ? snapshot.nonce + 1 : snapshot.nonce };
  for (const listener of listeners) listener();
}

window.addEventListener('hashchange', () => read(false));

/**
 * The hash the app is already on fires no `hashchange`, and a screen asking to
 * go where it already is means reload me. The nonce is what the screen is keyed
 * on, so bumping it remounts.
 */
export function go(hash: string) {
  if (location.hash === hash) read(true);
  else location.hash = hash;
}

export function subscribeRoute(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function routeSnapshot(): Route {
  return snapshot;
}
