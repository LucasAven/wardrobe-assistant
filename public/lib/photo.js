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
  const key = garment.imageCutout ?? garment.imageOriginal;
  const slash = key.indexOf('/');
  if (slash < 0) return null;

  const kind = key.slice(0, slash) === 'cut' ? 'cut' : 'orig';
  const id = key.slice(slash + 1).replace(/\.png$/, '');
  return `/img/${kind}/${encodeURIComponent(id)}`;
}

/**
 * `/img/*` is behind the session too, so an expired cookie turns every photo
 * into a broken frame. A failed image says so and can be asked again.
 */
export function watchImage(frame, image, { retry = false } = {}) {
  image.addEventListener('error', () => {
    frame.dataset.failed = 'true';
  });
  image.addEventListener('load', () => {
    delete frame.dataset.failed;
  });
  if (!retry) return;

  frame.addEventListener('click', () => {
    if (frame.dataset.failed !== 'true') return;
    image.src = `${image.src.split('?')[0]}?r=${Date.now()}`;
  });
}
