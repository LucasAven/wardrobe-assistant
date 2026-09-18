/**
 * The one place the app asks the browser where it is.
 *
 * A denial is remembered, so a screen that asks on its own does not open on the
 * same prompt every morning. A button the owner just tapped passes
 * `remembered: false` and asks anyway: the tap is a newer answer than a
 * preference saved days ago.
 *
 * A failure comes back as a cause and never as a sentence, because what a
 * missing position costs is different on every screen that asks for one.
 */

import { readChoice, writePref } from './prefs.js';

const GEO_TIMEOUT_MS = 8000;
/** A position from earlier this morning is good enough, and it saves the second wait. */
const GEO_MAX_AGE_MS = 10 * 60 * 1000;

/** A remembered denial and a fresh one are the same answer, so they share a cause. */
function causeOf(error) {
  if (error?.code === 1) return 'denied';
  if (error?.code === 3) return 'timeout';
  return 'unknown';
}

/** Resolves to `{ found: true, lat, lon }`, or to a cause. It never rejects. */
export function askPosition({ remembered = true } = {}) {
  return new Promise((resolve) => {
    if (remembered && readChoice('location', ['off'], null) === 'off') {
      resolve({ found: false, cause: 'denied' });
      return;
    }

    const geolocation = globalThis.navigator?.geolocation ?? null;
    if (geolocation === null) {
      resolve({ found: false, cause: 'unsupported' });
      return;
    }

    geolocation.getCurrentPosition(
      (position) => resolve({ found: true, lat: position.coords.latitude, lon: position.coords.longitude }),
      (error) => {
        if (error?.code === 1) writePref('location', 'off');
        resolve({ found: false, cause: causeOf(error) });
      },
      { timeout: GEO_TIMEOUT_MS, maximumAge: GEO_MAX_AGE_MS },
    );
  });
}

/**
 * A stored position as the owner reads it. Three decimals is about a hundred
 * meters, which is enough to tell a home from an office and short enough to read.
 */
export function positionLine(position) {
  return `${position.lat.toFixed(3)}, ${position.lon.toFixed(3)}`;
}
