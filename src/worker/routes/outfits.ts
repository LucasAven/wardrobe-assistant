/**
 * What the web app reads and writes about outfits Claude composed.
 *
 * The swap is the only write. It answers the whole outfit back, so the card the
 * owner is looking at redraws from the response instead of guessing at what the
 * row now says.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import { MAX_OUTFITS, recentOutfits, swapPiece, todayOutfit } from '../outfits';
import { VOCABULARIES } from '../vision';

/**
 * The reason is required. A piece that changed with nothing saying why teaches
 * the next plan nothing, and the sentence is the whole point of the write.
 */
const SwapSchema = z.object({
  slot: z.enum(VOCABULARIES.slot.values),
  toId: z.string().min(1).nullable(),
  reason: z.string().trim().min(1).max(280),
});

export const outfits = new Hono<{ Bindings: Env }>();

/**
 * `null` rather than a 404: nothing saved today is a normal state the app has a
 * screen for, and a 404 would read as a broken request instead.
 */
outfits.get('/today', async (c) => {
  return c.json({ outfit: await todayOutfit(c.env.DB, new Date()) });
});

outfits.get('/', async (c) => {
  const asked = Number(c.req.query('limit') ?? MAX_OUTFITS);
  const limit = Number.isFinite(asked) && asked > 0 ? asked : MAX_OUTFITS;
  return c.json({ outfits: await recentOutfits(c.env.DB, limit) });
});

outfits.post('/:id/swap', async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  const parsed = SwapSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'send a slot, a garment id or null, and one line saying why', issues: parsed.error.issues },
      400,
    );
  }

  const result = await swapPiece(c.env.DB, c.req.param('id'), parsed.data, new Date());
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
