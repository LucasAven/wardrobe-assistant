import { Hono } from 'hono';
import type { Env } from '../env';
import { makeCutout, normalizeImageType, origKey, smallImageFor, storeOriginal } from '../photos';
import {
  GarmentPatchSchema,
  archiveGarment,
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

  const id = crypto.randomUUID();
  const imageOriginal = await storeOriginal(c.env, id, body, contentType);

  // `?cutout=skip` means the phone already lifted the subject, so the original
  // is the transparent PNG and there is nothing to store under `cut/`.
  const imageCutout =
    c.req.query('cutout') === 'skip' ? null : await makeCutout(c.env, id);

  let draft: GarmentDraft;
  try {
    draft = await tagFromStoredImage(c.env, imageCutout ?? origKey(id));
  } catch (error) {
    console.error('vision tagging failed', { id, error });
    draft = blankDraft();
  }

  const stored = await insertGarment(c.env.DB, {
    id,
    imageOriginal,
    imageCutout,
    tags: draftToTags(draft),
    uncertain: draft.uncertain,
  });
  return c.json(toJson(stored), 201);
});

garments.post('/:id/retag', async (c) => {
  const id = c.req.param('id');
  const existing = await getGarment(c.env.DB, id);
  if (existing === null) return c.json({ error: 'not found' }, 404);

  let draft: GarmentDraft;
  try {
    draft = await tagFromStoredImage(c.env, existing.garment.imageCutout ?? existing.garment.imageOriginal);
  } catch (error) {
    // Unlike the upload path there is nothing to protect here, so a failed call
    // leaves the tags the row already has rather than blanking them.
    console.error('retag failed', { id, error });
    return c.json({ error: 'tagging failed' }, 502);
  }

  const updated = await replaceTags(c.env.DB, id, draftToTags(draft), draft.uncertain);
  if (updated === null) return c.json({ error: 'not found' }, 404);
  return c.json(toJson(updated));
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
