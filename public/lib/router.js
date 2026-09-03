const ROUTES = new Set(['upload', 'review', 'wardrobe']);

export function parseRoute(hash) {
  const path = String(hash ?? '').replace(/^#\/?/, '');
  const [name, id] = path.split('/');
  if (!ROUTES.has(name)) return { name: 'wardrobe', id: null };
  return { name, id: id === undefined || id === '' ? null : decodeURIComponent(id) };
}

export function routeHash(name, id = null) {
  return id === null ? `#/${name}` : `#/${name}/${encodeURIComponent(id)}`;
}
