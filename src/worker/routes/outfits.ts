/**
 * What the web app reads and writes about outfits Claude composed.
 *
 * The edit and the delete are the only writes. The edit answers the whole outfit
 * back, so the card the owner is looking at redraws from the response instead of
 * guessing at what the row now says.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import type { OutfitEdit } from '../outfits';
import { MAX_OUTFITS, editPiece, readOutfits, removeOutfit, todayOutfits } from '../outfits';

/**
 * The reason is required in all three directions. A piece that changed with
 * nothing saying why teaches the next plan nothing, and the sentence is the
 * whole point of the write.
 */
const Reason = z.string().trim().min(1).max(280);

/**
 * A union of three rather than one object with two nullable ids, so a body
 * naming neither garment is a shape this cannot parse at all rather than one the
 * domain has to turn away later. Each member hands the domain its own kind, so
 * nothing downstream reads a null to work out which of the three happened.
 *
 * The bodies the app sent before the add existed still land where they did: both
 * ids present is the swap, and a null `toId` is the drop.
 *
 * An add carries no slot. Every garment knows its own, so the garment coming in
 * names the slot and there is nothing here for the client and the server to
 * disagree about.
 */
const EditSchema = z.union([
  z
    .object({ fromId: z.string().min(1), toId: z.string().min(1), reason: Reason })
    .transform((body): OutfitEdit => ({
      kind: 'swap',
      fromId: body.fromId,
      toId: body.toId,
      reason: body.reason,
    })),
  z
    .object({ fromId: z.string().min(1), toId: z.null().default(null), reason: Reason })
    .transform((body): OutfitEdit => ({ kind: 'drop', fromId: body.fromId, reason: body.reason })),
  z
    .object({ fromId: z.null().default(null), toId: z.string().min(1), reason: Reason })
    .transform((body): OutfitEdit => ({ kind: 'add', toId: body.toId, reason: body.reason })),
]);

export const outfits = new Hono<{ Bindings: Env }>();

/**
 * Every outfit saved today, newest first, because one request can be answered
 * with two or three for the owner to pick from. An empty list rather than a
 * 404: nothing saved today is still the normal state the app has a screen for,
 * and a 404 would read as a broken request instead.
 */
outfits.get('/today', async (c) => {
  return c.json({ outfits: await todayOutfits(c.env.DB, new Date()) });
});

outfits.get('/', async (c) => {
  const asked = Number(c.req.query('limit') ?? MAX_OUTFITS);
  const limit = Number.isFinite(asked) && asked > 0 ? asked : MAX_OUTFITS;
  return c.json({ outfits: (await readOutfits(c.env.DB, { limit })).outfits });
});

/**
 * Still `/swap` after the add arrived. The path is private, so renaming it would
 * cost the client a change and buy nothing.
 */
outfits.post('/:id/swap', async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  const parsed = EditSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error:
          'send the garment going out, the garment coming in, or both, and one line saying why',
        issues: parsed.error.issues,
      },
      400,
    );
  }

  const result = await editPiece(c.env.DB, c.req.param('id'), parsed.data, new Date());
  switch (result.kind) {
    case 'missing':
      return c.json({ error: 'not found' }, 404);
    case 'worn':
      return c.json(
        {
          error:
            'You logged this as worn, so it is the record of what you wore. Ask Claude for a new outfit instead.',
        },
        409,
      );
    case 'refused':
      return c.json({ error: result.error }, 400);
    case 'saved':
      return c.json({ outfit: result.outfit });
  }
});

/**
 * No 409 for an outfit logged as worn, which is the one case the edit turns
 * away. An edit would leave the wear log describing clothes the outfit no longer
 * holds, while this takes with it every wear that named the outfit, and taking
 * those is what the owner is asking for. A wear that named no outfit stays, for
 * the reason `removeOutfit` gives.
 */
outfits.delete('/:id', async (c) => {
  const removed = await removeOutfit(c.env.DB, c.req.param('id'));
  if (!removed) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});
