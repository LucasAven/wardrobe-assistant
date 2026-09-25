/** Mirrors ACCEPTED_UPLOAD_TYPES in src/worker/photos.ts. */
const ACCEPTED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
  'image/heic',
  'image/heif',
]);

const TYPE_BY_EXTENSION = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
};

/**
 * The upload is a raw body, so the worker reads the type off the header alone.
 * iOS sometimes hands over a file with an empty `type`, and a guess from the
 * name beats a 415 the user cannot act on.
 */
export function uploadContentType(file) {
  const declared = (file.type ?? '').split(';')[0].trim().toLowerCase();
  if (ACCEPTED_TYPES.has(declared)) return declared;

  const name = file.name ?? '';
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  return TYPE_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * R2 keys are `orig/<id>` and `cut/<id>.png`, and `GET /img/:kind/:id` rebuilds
 * the key from the bare id, so the extension has to come back off.
 */
export function imagePath(garment) {
  // A saved outfit is composed in a chat, so a piece can arrive with no photo
  // at all. That is a frame with nothing in it, never a screen that throws.
  const key = garment?.imageCutout ?? garment?.imageOriginal ?? null;
  if (typeof key !== 'string') return null;

  const slash = key.indexOf('/');
  if (slash < 0) return null;

  const kind = key.slice(0, slash) === 'cut' ? 'cut' : 'orig';
  const id = key.slice(slash + 1).replace(/\.png$/, '');
  const path = `/img/${kind}/${encodeURIComponent(id)}`;

  // The route answers `immutable` and an edited cutout rewrites the same key, so
  // a photo the phone already holds is only replaced by a URL it has never seen.
  const version = garment?.photoVersion;
  return Number.isFinite(version) ? `${path}?v=${version}` : path;
}

/**
 * Where the retry below points. The `v` the path carries is the whole reason a
 * new cutout arrives at all, so the cache buster is added to the query rather
 * than handed a query of its own.
 */
export function retryPath(src, now = Date.now()) {
  const url = new URL(src, 'http://images.invalid');
  url.searchParams.set('r', String(now));
  return `${url.pathname}${url.search}`;
}

