const ROUTES = new Set(['today', 'outfits', 'profile', 'upload', 'review', 'wardrobe', 'edit']);

/** @typedef {{ name: string, id: string | null }} Route */

/**
 * @param {string | null | undefined} hash
 * @returns {Route}
 */
export function parseRoute(hash) {
  const path = String(hash ?? '').replace(/^#\/?/, '');
  const [name = '', id] = path.split('/');
  if (!ROUTES.has(name)) return { name: 'wardrobe', id: null };
  return { name, id: id === undefined || id === '' ? null : decodeURIComponent(id) };
}

/**
 * @param {string} name
 * @param {string | null} [id]
 * @returns {string}
 */
export function routeHash(name, id = null) {
  return id === null ? `#/${name}` : `#/${name}/${encodeURIComponent(id)}`;
}
