import { useSyncExternalStore } from 'react';

/**
 * Which outfits were logged as worn this session. Whether the Worker flips the
 * outfit's own flag is its business, so the tap is remembered here as well and
 * the same day is never offered twice. It is not server state, so it is a set
 * rather than a query.
 *
 * The card and the history row above it both read it, and only the card is
 * re-rendered by the tap itself, so the set is replaced rather than added to
 * and both readers subscribe. A set that was mutated in place would leave the
 * row reading the answer it drew with.
 */
let worn: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

export function wornSnapshot(): ReadonlySet<string> {
  return worn;
}

export function subscribeWorn(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function markWorn(id: string) {
  if (worn.has(id)) return;
  worn = new Set(worn).add(id);
  for (const listener of listeners) listener();
}

/** The set as it stands, plus a re-render when a wear is logged anywhere. */
export function useWorn(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeWorn, wornSnapshot);
}
