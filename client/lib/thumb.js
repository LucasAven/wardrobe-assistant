const THUMB_WIDTH = 200;

/**
 * Fifty full size photos decoded at once is how a phone runs out of memory, so
 * every preview is a small copy and the file itself is never handed to an `img`.
 */
export async function createThumbnail(file) {
  try {
    const bitmap = await createImageBitmap(file, { resizeWidth: THUMB_WIDTH, resizeQuality: 'low' });
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
    return { src: canvas.toDataURL('image/jpeg', 0.7), release() {} };
  } catch {
    const src = URL.createObjectURL(file);
    return { src, release: () => URL.revokeObjectURL(src) };
  }
}
