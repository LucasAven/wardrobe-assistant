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
 * The cutout the owner edited by hand. `orig/<id>` is never written again after
 * the upload, so whatever this stores can always be thrown away and re-derived.
 */
export async function storeCutout(
  env: Env,
  id: string,
  body: ReadableStream,
  contentType: string,
): Promise<string> {
  const key = cutKey(id);
  await env.PHOTOS.put(key, body, { httpMetadata: { contentType } });
  return key;
}

/**
 * The same shape as the `ConfigFault` in `auth.ts`, and separate from it because
 * no command fixes this one. A secret is a line in a terminal, Images is a switch
 * in the dashboard.
 */
export interface SetupFault {
  readonly error: string;
  readonly needsSetup: 'cloudflare-images';
}

export const IMAGES_SETUP_FAULT: SetupFault = {
  error:
    'Cloudflare Images is not enabled for this account, so background removal and the downscale before tagging both fail. Turn Images on in the Cloudflare dashboard. The CLI cannot do it.',
  needsSetup: 'cloudflare-images',
};

/** For the call that owes its caller an image and has nothing to fall back on. */
export class ImagesUnusableError extends Error {
  public readonly fault: SetupFault = IMAGES_SETUP_FAULT;

  constructor() {
    super(IMAGES_SETUP_FAULT.error);
    this.name = 'ImagesUnusableError';
  }
}

/** The one account level code the Images docs give: the plan does not carry the binding. */
const BINDING_NOT_AVAILABLE = 9432;

/**
 * `ImagesError` carries a numeric code, but the docs list none for Images that
 * was never switched on, which is the case a fresh deploy hits, so that one is
 * only readable in the message. It is the single message match in this file and
 * it stays this narrow on purpose: a photo the segmenter could not lift must
 * never come back as a broken account.
 */
const NOT_ENABLED = /\bnot (?:enabled|entitled)\b/i;

function imagesIsOff(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { code } = error as { readonly code?: unknown };
  return code === BINDING_NOT_AVAILABLE || NOT_ENABLED.test(error.message);
}

/**
 * One transform, with a product that is off told apart from bytes it could not
 * read. Both Images calls in this file go through here, so an account with the
 * switch still down reports one cause whichever call the request reached first.
 */
async function usingImages<T>(env: Env, run: (images: ImagesBinding) => Promise<T>): Promise<T> {
  const images: ImagesBinding | undefined = env.IMAGES;
  if (images === undefined) throw new ImagesUnusableError();

  try {
    return await run(images);
  } catch (error) {
    if (imagesIsOff(error)) throw new ImagesUnusableError();
    throw error;
  }
}

export interface CutoutResult {
  /** The stored cutout, or null when the garment keeps its original photo. */
  readonly key: string | null;
  /** Set only when Images itself is unusable, never for a photo it could not segment. */
  readonly fault: SetupFault | null;
}

export const NO_CUTOUT: CutoutResult = { key: null, fault: null };

/**
 * Reading the original back out of R2 rather than teeing the upload stream keeps
 * the guarantee that the photo is already durable before anything else can throw.
 */
export async function makeCutout(env: Env, id: string): Promise<CutoutResult> {
  try {
    const original = await env.PHOTOS.get(origKey(id));
    if (original === null) return NO_CUTOUT;

    const cut = await usingImages(env, (images) =>
      images
        .input(original.body)
        .transform({ segment: 'foreground' })
        .output({ format: 'image/png' }),
    );

    const key = cutKey(id);
    await env.PHOTOS.put(key, cut.image(), { httpMetadata: { contentType: 'image/png' } });
    return { key, fault: null };
  } catch (error) {
    console.error('cutout failed', { id, error });
    // A garment the segmenter could not lift is one photo and stays in the log.
    // An account with Images off is every photo, so it rides back with the row.
    return error instanceof ImagesUnusableError ? { key: null, fault: error.fault } : NO_CUTOUT;
  }
}

/**
 * A transparent cutout flattens onto white rather than the default, so the model
 * sees the garment against paper instead of against its own dark silhouette.
 */
export async function smallImageFor(env: Env, key: string): Promise<SmallImage> {
  const source = await env.PHOTOS.get(key);
  if (source === null) throw new Error(`missing image at ${key}`);

  const small = await usingImages(env, (images) =>
    images
      .input(source.body)
      .transform({ width: VISION_WIDTH, fit: 'scale-down' })
      .output({ format: 'image/jpeg', quality: VISION_QUALITY, background: '#ffffff' }),
  );

  const base64 = await new Response(small.image({ encoding: 'base64' })).text();
  return { base64, mediaType: 'image/jpeg' };
}
