import { parseRoute } from './router.js';

export type Route = { name: string; id: string | null; landing: boolean; nonce: number };

/**
 * The hash the app is opened on, before anything has decided where to send the
 * owner. `parseRoute` clamps it to the wardrobe like any other name it does not
 * know, so the shell has to be able to tell the two apart: rendering the
 * wardrobe for the one task it takes the boot `hashchange` to arrive mounted
 * that screen and fired its gaps request on every launch.
 */
function onLandingHash() {
  return location.hash === '' || location.hash === '#' || location.hash === '#/';
}

let snapshot: Route = { ...parseRoute(location.hash), landing: onLandingHash(), nonce: 0 };
const listeners = new Set<() => void>();

function read(bump: boolean) {
  const next = parseRoute(location.hash);
  snapshot = {
    name: next.name,
    id: next.id,
    landing: onLandingHash(),
    nonce: bump ? snapshot.nonce + 1 : snapshot.nonce,
  };
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
