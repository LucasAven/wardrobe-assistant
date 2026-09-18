import { uploadContentType } from './photo.js';

/**
 * The wire types, taken from the Worker's own contract rather than redeclared
 * here. `tsc` reads these through JSDoc, so nothing is imported at runtime and
 * the bundle never reaches into `src/`.
 *
 * @typedef {import('../../src/worker/contract').StoredGarmentView} GarmentRow
 * @typedef {import('../../src/worker/contract').ProfileResponse} ProfileResponse
 * @typedef {import('../../src/worker/contract').WeatherResponse} WeatherResponse
 */

/** A tagging call runs a vision request, so the cap is generous. It exists so a
 * connection that died mid switch from wifi to cellular frees its upload slot. */
const UPLOAD_TIMEOUT_MS = 120000;

export class NetworkError extends Error {
  constructor(message = 'No connection. The request never left the phone.') {
    super(message);
    this.name = 'NetworkError';
  }
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export class AuthError extends ApiError {
  constructor(message = 'The session ended. Log in again.') {
    super(401, message);
    this.name = 'AuthError';
  }
}

async function errorMessage(response) {
  try {
    const body = await response.json();
    if (body !== null && typeof body === 'object' && typeof body.error === 'string') return body.error;
  } catch {
    // An error page with no JSON body is still an error, and the status carries it.
  }
  return `The server answered ${response.status}.`;
}

function timedOut(error) {
  return error?.name === 'TimeoutError' || error?.name === 'AbortError';
}

export function createApi(options = {}) {
  const doFetch = options.fetchImpl ?? ((path, init) => globalThis.fetch(path, init));
  const onUnauthorized = options.onUnauthorized ?? null;
  let authRun = null;

  /**
   * One login prompt for the whole batch: fifty uploads whose cookie expired
   * together must not open fifty of them.
   */
  function reauthenticate() {
    if (onUnauthorized === null) return Promise.resolve(false);
    if (authRun === null) {
      authRun = Promise.resolve()
        .then(() => onUnauthorized())
        .then(
          () => true,
          () => false,
        )
        .finally(() => {
          authRun = null;
        });
    }
    return authRun;
  }

  async function send(path, init, allowRetry) {
    let response;
    try {
      response = await doFetch(path, { credentials: 'same-origin', ...init });
    } catch (error) {
      throw timedOut(error) ? new NetworkError('That took too long. Try it again.') : new NetworkError();
    }

    if (response.status === 401) {
      if (allowRetry && (await reauthenticate())) return send(path, init, false);
      throw new AuthError();
    }
    if (!response.ok) throw new ApiError(response.status, await errorMessage(response));
    return response;
  }

  async function json(path, init = {}) {
    const response = await send(path, init, true);
    try {
      return await response.json();
    } catch {
      throw new ApiError(response.status, 'The server sent back something the app could not read.');
    }
  }

  const jsonBody = (value) => ({
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });

  return {
    async login(password) {
      let response;
      try {
        response = await doFetch('/api/login', {
          method: 'POST',
          credentials: 'same-origin',
          ...jsonBody({ password }),
        });
      } catch {
        throw new NetworkError();
      }
      if (response.status === 401) throw new AuthError('That password did not work.');
      if (!response.ok) throw new ApiError(response.status, await errorMessage(response));
      return true;
    },

    listGaps() {
      return json('/api/garments/gaps');
    },

    /**
     * @param {{ reviewed?: boolean }} [filter]
     * @returns {Promise<GarmentRow[]>}
     */
    listGarments(filter = {}) {
      const path =
        filter.reviewed === undefined ? '/api/garments' : `/api/garments?reviewed=${filter.reviewed ? '1' : '0'}`;
      return json(path);
    },

    /**
     * @param {Blob} file
     * @param {{ cutout?: boolean }} [options]
     * @returns {Promise<GarmentRow>}
     */
    uploadGarment(file, { cutout = false } = {}) {
      const contentType = uploadContentType(file);
      if (contentType === null) {
        return Promise.reject(new ApiError(415, 'This file is not an image the app can read.'));
      }
      return json(cutout ? '/api/garments?cutout=skip' : '/api/garments', {
        method: 'POST',
        headers: { 'content-type': contentType },
        body: file,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
    },

    /**
     * @param {string} id
     * @param {Record<string, unknown>} patch
     * @returns {Promise<GarmentRow>}
     */
    patchGarment(id, patch) {
      return json(`/api/garments/${encodeURIComponent(id)}`, { method: 'PATCH', ...jsonBody(patch) });
    },

    /** @param {string} id @returns {Promise<GarmentRow>} */
    retagGarment(id) {
      return json(`/api/garments/${encodeURIComponent(id)}/retag`, { method: 'POST' });
    },

    /** @param {string} id @param {Blob} blob @returns {Promise<GarmentRow>} */
    putCutout(id, blob) {
      return json(`/api/garments/${encodeURIComponent(id)}/cutout`, {
        method: 'PUT',
        headers: { 'content-type': 'image/png' },
        body: blob,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
    },

    /** @param {string} id @returns {Promise<GarmentRow>} */
    resetCutout(id) {
      return json(`/api/garments/${encodeURIComponent(id)}/cutout/reset`, { method: 'POST' });
    },

    /**
     * @param {string} id
     * @param {Blob} body
     * @param {string} contentType
     * @returns {Promise<GarmentRow>}
     */
    replacePhoto(id, body, contentType) {
      return json(`/api/garments/${encodeURIComponent(id)}/photo`, {
        method: 'PUT',
        headers: { 'content-type': contentType },
        body,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
    },

    archiveGarment(id) {
      return json(`/api/garments/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },

    /** @returns {Promise<ProfileResponse>} */
    getProfile() {
      return json('/api/profile');
    },

    /** @param {unknown} profile @returns {Promise<ProfileResponse>} */
    saveProfile(profile) {
      return json('/api/profile', { method: 'PUT', ...jsonBody(profile) });
    },

    /** @param {number} lat @param {number} lon @returns {Promise<ProfileResponse>} */
    saveHome(lat, lon) {
      return json('/api/profile/home', { method: 'PUT', ...jsonBody({ lat, lon }) });
    },

    /** @returns {Promise<ProfileResponse>} */
    clearHome() {
      return json('/api/profile/home', { method: 'DELETE' });
    },

    /** @param {number} lat @param {number} lon @returns {Promise<WeatherResponse>} */
    getWeather(lat, lon) {
      return json(`/api/weather?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`);
    },

    getTodayOutfits() {
      return json('/api/outfits/today');
    },

    listOutfits(limit) {
      return json(`/api/outfits?limit=${encodeURIComponent(limit)}`);
    },

    // One posting for the three edits a card can make, so the name is the wide
    // one. The path stays `/swap`: it is private, and a second name for it would
    // only be a second thing to keep in step.
    editPiece(id, edit) {
      return json(`/api/outfits/${encodeURIComponent(id)}/swap`, { method: 'POST', ...jsonBody(edit) });
    },

    removeOutfit(id) {
      return json(`/api/outfits/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },

    wear(entry) {
      return json('/api/wear', { method: 'POST', ...jsonBody(entry) });
    },
  };
}
