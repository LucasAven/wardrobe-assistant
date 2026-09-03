import type { Env } from './env';
import type { SmallImage } from './vision';

const ACCEPTED_UPLOAD_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
  'image/heic',
  'image/heif',
]);

/** Width the vision call sees. A 12MP phone photo carries no extra signal here. */
const VISION_WIDTH = 768;
const VISION_QUALITY = 80;

export function origKey(id: string): string {
  return `orig/${id}`;
}

export function cutKey(id: string): string {
  return `cut/${id}.png`;
}

/** Strips the charset and any other parameter a phone may append. */
export function normalizeImageType(header: string | undefined): string | null {
  if (header === undefined) return null;
  const type = header.split(';')[0]?.trim().toLowerCase();
  if (type === undefined || !ACCEPTED_UPLOAD_TYPES.has(type)) return null;
  return type;
}

export async function storeOriginal(
  env: Env,
  id: string,
  body: ReadableStream,
  contentType: string,
): Promise<string> {
  const key = origKey(id);
  await env.PHOTOS.put(key, body, { httpMetadata: { contentType } });
  return key;
}

/**
 * Returns the cutout key, or null when segmentation failed. Reading the original
 * back out of R2 rather than teeing the upload stream keeps the guarantee that
 * the photo is already durable before anything else can throw.
 */
export async function makeCutout(env: Env, id: string): Promise<string | null> {
  try {
    const original = await env.PHOTOS.get(origKey(id));
    if (original === null) return null;

    const cut = await env.IMAGES.input(original.body)
      .transform({ segment: 'foreground' })
      .output({ format: 'image/png' });

    const key = cutKey(id);
    await env.PHOTOS.put(key, cut.image(), { httpMetadata: { contentType: 'image/png' } });
    return key;
  } catch (error) {
    console.error('cutout failed', { id, error });
    return null;
  }
}

/**
 * A transparent cutout flattens onto white rather than the default, so the model
 * sees the garment against paper instead of against its own dark silhouette.
 */
export async function smallImageFor(env: Env, key: string): Promise<SmallImage> {
  const source = await env.PHOTOS.get(key);
  if (source === null) throw new Error(`missing image at ${key}`);

  const small = await env.IMAGES.input(source.body)
    .transform({ width: VISION_WIDTH, fit: 'scale-down' })
    .output({ format: 'image/jpeg', quality: VISION_QUALITY, background: '#ffffff' });

  const base64 = await new Response(small.image({ encoding: 'base64' })).text();
  return { base64, mediaType: 'image/jpeg' };
}
