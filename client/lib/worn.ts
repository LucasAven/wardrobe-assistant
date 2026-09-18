/**
 * Which outfits were logged as worn this session. Whether the Worker flips the
 * outfit's own flag is its business, so the tap is remembered here as well and
 * the same day is never offered twice. It is not server state, so it is a plain
 * set rather than a query.
 */
const wornThisSession = new Set<string>();

export function isWorn(id: string) {
  return wornThisSession.has(id);
}

export function markWorn(id: string) {
  wornThisSession.add(id);
}
