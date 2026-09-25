import { parseRoute } from './router.js';

export type Route = { name: string; id: string | null; landing: boolean };

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

let snapshot: Route = { ...parseRoute(location.hash), landing: onLandingHash() };
const listeners = new Set<() => void>();

function read() {
  const next = parseRoute(location.hash);
  snapshot = { name: next.name, id: next.id, landing: onLandingHash() };
  for (const listener of listeners) listener();
}

window.addEventListener('hashchange', read);

/**
 * Every caller asks for a hash other than the one it is on, so this is a plain
 * assignment. It used to carry a nonce for the reload-me case, where a screen
 * asks to go where it already is and no `hashchange` fires, but nothing ever
 * asked: the tabs are anchors, and each `go()` in the app names a different
 * screen from the one it runs on.
 */
export function go(hash: string) {
  location.hash = hash;
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
