import { uploadContentType } from './photo.js';

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

    listGarments(filter = {}) {
      const path =
        filter.reviewed === undefined ? '/api/garments' : `/api/garments?reviewed=${filter.reviewed ? '1' : '0'}`;
      return json(path);
    },

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

    patchGarment(id, patch) {
      return json(`/api/garments/${encodeURIComponent(id)}`, { method: 'PATCH', ...jsonBody(patch) });
    },

    retagGarment(id) {
      return json(`/api/garments/${encodeURIComponent(id)}/retag`, { method: 'POST' });
    },

    putCutout(id, blob) {
      return json(`/api/garments/${encodeURIComponent(id)}/cutout`, {
        method: 'PUT',
        headers: { 'content-type': 'image/png' },
        body: blob,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
    },

    resetCutout(id) {
      return json(`/api/garments/${encodeURIComponent(id)}/cutout/reset`, { method: 'POST' });
    },

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

    getProfile() {
      return json('/api/profile');
    },

    saveProfile(profile) {
      return json('/api/profile', { method: 'PUT', ...jsonBody(profile) });
    },

    saveHome(lat, lon) {
      return json('/api/profile/home', { method: 'PUT', ...jsonBody({ lat, lon }) });
    },

    clearHome() {
      return json('/api/profile/home', { method: 'DELETE' });
    },

    getWeather(lat, lon) {
      return json(`/api/weather?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`);
    },

    getTodayOutfit() {
      return json('/api/outfits/today');
    },

    listOutfits(limit) {
      return json(`/api/outfits?limit=${encodeURIComponent(limit)}`);
    },

    swapPiece(id, edit) {
      return json(`/api/outfits/${encodeURIComponent(id)}/swap`, { method: 'POST', ...jsonBody(edit) });
    },

    wear(entry) {
      return json('/api/wear', { method: 'POST', ...jsonBody(entry) });
    },
  };
}
