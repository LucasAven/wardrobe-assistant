/** The stored original is only ever shown phone sized, and the vision pass cuts it to 768 anyway. */
const MAX_DIMENSION = 2048;
const JPEG_QUALITY = 0.85;

export function targetSize(width, height) {
  const longest = Math.max(width, height);
  if (longest <= MAX_DIMENSION) return { width, height };

  const scale = MAX_DIMENSION / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * A garment lifted in the Photos app arrives as a transparent PNG, and JPEG has
 * no alpha, so re-encoding that one as JPEG would paint the background back in.
 */
export function normalizedType(alreadyCutOut) {
  return alreadyCutOut ? 'image/png' : 'image/jpeg';
}

function drawScaled(bitmap, width, height, type) {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    return canvas.convertToBlob({ type, quality: JPEG_QUALITY });
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob(resolve, type, JPEG_QUALITY));
}

async function reencode(file, type) {
  // Re-encoding drops the EXIF tag, so the rotation has to be baked into the pixels here.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const { width, height } = targetSize(bitmap.width, bitmap.height);
    return await drawScaled(bitmap, width, height, type);
  } finally {
    bitmap.close();
  }
}

/**
 * A phone photo runs about 3MB, so a fifty garment batch is 150MB of cellular
 * for pixels nothing downstream reads. Every upload goes up re-encoded and
 * capped instead. It doubles as the HEIC escape hatch: Safari decodes HEIC
 * natively, so a file Cloudflare Images cannot read still reaches the worker as
 * something it can, and the garment gets its tags.
 *
 * A decode or an export that fails hands back the untouched file. A slow upload
 * beats a garment that never lands.
 */
/**
 * @param {Blob} file
 * @param {{ cutout?: boolean }} [options]
 * @returns {Promise<{ body: Blob, normalized: boolean }>}
 */
export async function normalizeForUpload(file, { cutout = false } = {}) {
  try {
    const blob = await reencode(file, normalizedType(cutout));
    return blob === null ? { body: file, normalized: false } : { body: blob, normalized: true };
  } catch {
    return { body: file, normalized: false };
  }
}
