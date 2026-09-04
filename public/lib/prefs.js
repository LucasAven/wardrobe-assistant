/**
 * The two or three answers the Today screen should not ask for twice.
 *
 * Private browsing throws on the first read of `localStorage`, and the app is
 * still usable with no memory at all, so every path here falls back to the
 * default instead of failing.
 */
const NAMESPACE = 'wardrobe.';

function store() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readPref(key, fallback = null) {
  try {
    const value = store()?.getItem(NAMESPACE + key);
    return value === null || value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

export function writePref(key, value) {
  try {
    store()?.setItem(NAMESPACE + key, String(value));
  } catch {
    // A preference that cannot be kept is not worth an error the user can act on.
  }
}

export function forgetPref(key) {
  try {
    store()?.removeItem(NAMESPACE + key);
  } catch {
    // Same.
  }
}

/** A stored value only counts when it is still one of the choices on screen. */
export function readChoice(key, allowed, fallback) {
  const value = readPref(key, null);
  return allowed.includes(value) ? value : fallback;
}

export function readNumberChoice(key, allowed, fallback) {
  // `Number(null)` and `Number('')` are both 0, which is a real choice here, so
  // nothing stored has to be answered before the conversion.
  const stored = readPref(key, null);
  if (stored === null || stored.trim() === '') return fallback;
  const value = Number(stored);
  return allowed.includes(value) ? value : fallback;
}
