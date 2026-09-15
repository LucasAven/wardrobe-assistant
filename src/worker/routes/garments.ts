import { Hono } from 'hono';
import { wardrobeGaps } from '../../domain/gaps';
import { missingConfig } from '../auth';
import { gapView } from '../compose';
import { getProfile } from '../profile';
import type { Env } from '../env';
import type { SetupFault } from '../photos';
import {
  ImagesUnusableError,
  NO_CUTOUT,
  makeCutout,
  normalizeImageType,
  origKey,
  smallImageFor,
  storeCutout,
  storeOriginal,
} from '../photos';
import {
  GarmentPatchSchema,
  archiveGarment,
  bumpPhotoVersion,
  getGarment,
  insertGarment,
  listGarments,
  patchGarment,
  replaceTags,
  toJson,
} from '../repo';
import type { GarmentDraft } from '../vision';
import { blankDraft, draftToTags, tagGarment } from '../vision';

export const garments = new Hono<{ Bindings: Env }>();

async function tagFromStoredImage(env: Env, key: string): Promise<GarmentDraft> {
  return tagGarment(env, await smallImageFor(env, key));
}

garments.post('/', async (c) => {
  const contentType = normalizeImageType(c.req.header('content-type'));
  if (contentType === null) return c.json({ error: 'send one image as the raw body' }, 415);

  const body = c.req.raw.body;
  if (body === null) return c.json({ error: 'empty body' }, 400);

  // The photo is the expensive part, so an unset key costs the tagging and not
  // the upload. It is still a configuration error and not a photo the model
  // could not read, so the answer names it rather than handing back a row of
  // uncertain fields with no reason for them.
  const fault = missingConfig(c.env, ['ANTHROPIC_API_KEY']);

  const id = crypto.randomUUID();
  const imageOriginal = await storeOriginal(c.env, id, body, contentType);

  // `?cutout=skip` means the phone already lifted the subject, so the original
  // is the transparent PNG and there is nothing to store under `cut/`.
  const cutout = c.req.query('cutout') === 'skip' ? NO_CUTOUT : await makeCutout(c.env, id);

  // Both the cutout and the downscale before tagging run on Images, so an
  // account with it switched off gets one answer covering both, and not a
  // missing cutout and blank tags that read as two unrelated problems.
  let setup: SetupFault | null = cutout.fault;

  let draft: GarmentDraft;
  if (fault !== null) {
    draft = blankDraft();
  } else {
    try {
      draft = await tagFromStoredImage(c.env, cutout.key ?? origKey(id));
    } catch (error) {
      if (error instanceof ImagesUnusableError) setup = error.fault;
      console.error('vision tagging failed', { id, error });
      draft = blankDraft();
    }
  }

  const stored = await insertGarment(c.env.DB, {
    id,
    imageOriginal,
    imageCutout: cutout.key,
    tags: draftToTags(draft),
    uncertain: draft.uncertain,
  });

  const row = toJson(stored);
  return c.json(
    {
      ...row,
      ...(fault === null ? {} : { taggingError: fault.error, missing: fault.missing }),
      ...(setup === null ? {} : { imagesError: setup.error, needsSetup: setup.needsSetup }),
    },
    201,
  );
});

/**
 * Puts a garment back in the connector's queue. Tagging runs on the owner's
 * Claude subscription now, so this Worker has no model to call and nothing to
 * retag with. What it can do is blank the row back to placeholders, which is
 * the one state next_untagged looks for, so Claude hands the photo back on its
 * next pass. The tags go rather than being kept and re-flagged, because the
 * photo is what next_untagged asks Claude to judge and stale values sitting
 * next to it read as evidence.
 */
garments.post('/:id/retag', async (c) => {
  const id = c.req.param('id');
  const blank = blankDraft();
  const updated = await replaceTags(c.env.DB, id, draftToTags(blank), blank.uncertain);
  if (updated === null) return c.json({ error: 'not found' }, 404);
  return c.json(toJson(updated));
});

/**
 * The cutout with the parts that are not the garment erased by hand. Images
 * segments on what it can see, so a photo taken standing up keeps the legs and
 * the slippers, and the owner is the only one who can say where the sweater ends.
 * Writes `cut/<id>.png` and nothing else: the upload under `orig/<id>` stays put
 * so the reset below always has the real photo to go back to.
 */
garments.put('/:id/cutout', async (c) => {
  const contentType = normalizeImageType(c.req.header('content-type'));
  if (contentType !== 'image/png') {
    return c.json({ error: 'send the edited cutout as a raw image/png body' }, 415);
  }

  const body = c.req.raw.body;
  if (body === null) return c.json({ error: 'empty body' }, 400);

  // Read before the write, so an id with no row behind it cannot leave an
  // object in R2 that nothing points at.
  const id = c.req.param('id');
  if ((await getGarment(c.env.DB, id)) === null) return c.json({ error: 'not found' }, 404);

  const key = await storeCutout(c.env, id, body, contentType);
  const updated = await bumpPhotoVersion(c.env.DB, id, key);
  if (updated === null) return c.json({ error: 'not found' }, 404);
  return c.json(toJson(updated));
});

/** Throws the hand edits away and segments `orig/<id>` again. */
garments.post('/:id/cutout/reset', async (c) => {
  const id = c.req.param('id');
  if ((await getGarment(c.env.DB, id)) === null) return c.json({ error: 'not found' }, 404);

  const cutout = await makeCutout(c.env, id);
  if (cutout.fault !== null) return c.json(cutout.fault, 503);

  // A photo the segmenter could not lift comes back with no key, which is not a
  // failure: the garment falls back to its original. The version still moves, so
  // the phone lets go of the edited copy it was showing.
  const updated = await bumpPhotoVersion(c.env.DB, id, cutout.key);
  if (updated === null) return c.json({ error: 'not found' }, 404);
  return c.json(toJson(updated));
});

/**
 * A new photo for a garment that already has its tags. Re-shooting is the answer
 * when the first photo was unusable, and the words the owner confirmed are about
 * the garment rather than about the photo, so every tag column stays as it is,
 * `reviewed` and `uncertain` included.
 */
garments.put('/:id/photo', async (c) => {
  const contentType = normalizeImageType(c.req.header('content-type'));
  if (contentType === null) return c.json({ error: 'send one image as the raw body' }, 415);

  const body = c.req.raw.body;
  if (body === null) return c.json({ error: 'empty body' }, 400);

  const id = c.req.param('id');
  if ((await getGarment(c.env.DB, id)) === null) return c.json({ error: 'not found' }, 404);

  await storeOriginal(c.env, id, body, contentType);
  const cutout = await makeCutout(c.env, id);

  // The new photo is already durable here, so a 503 would leave `image_cutout`
  // pointing at a cutout of the photo this one just replaced. The row is written
  // either way and the answer carries the fault the way the upload route does,
  // so the garment shows the photo that is actually stored.
  const updated = await bumpPhotoVersion(c.env.DB, id, cutout.key);
  if (updated === null) return c.json({ error: 'not found' }, 404);

  const row = toJson(updated);
  return c.json({
    ...row,
    ...(cutout.fault === null
      ? {}
      : { imagesError: cutout.fault.error, needsSetup: cutout.fault.needsSetup }),
  });
});

/**
 * Registered before `/:id` routes would ever see it, and named on the wardrobe
 * rather than on outfits because a gap is a fact about what the owner owns.
 * With no profile there is no body type, so no rule has been judged and the
 * list is empty rather than guessed at.
 */
garments.get('/gaps', async (c) => {
  const profile = await getProfile(c.env.DB);
  if (profile === null) return c.json({ gaps: [] });

  const rows = await listGarments(c.env.DB, {});
  const gaps = wardrobeGaps(rows.map((row) => row.garment), profile.bodyType);
  return c.json({ gaps: gaps.map(gapView) });
});

garments.get('/', async (c) => {
  const reviewed = c.req.query('reviewed');
  const filter = reviewed === undefined ? {} : { reviewed: reviewed !== '0' };
  const rows = await listGarments(c.env.DB, filter);
  return c.json(rows.map(toJson));
});

garments.patch('/:id', async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  const parsed = GarmentPatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid patch', issues: parsed.error.issues }, 400);
  if (Object.keys(parsed.data).length === 0) return c.json({ error: 'patch is empty' }, 400);

  const updated = await patchGarment(c.env.DB, c.req.param('id'), parsed.data);
  if (updated === null) return c.json({ error: 'not found' }, 404);
  return c.json(toJson(updated));
});

garments.delete('/:id', async (c) => {
  const archived = await archiveGarment(c.env.DB, c.req.param('id'));
  if (!archived) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});
