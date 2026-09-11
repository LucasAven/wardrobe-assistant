import { Hono } from 'hono';
import { z } from 'zod';
import { classify } from '../../domain/bodyType';
import type { ProfileResponse } from '../contract';
import type { Env } from '../env';
import { clearHome, homeLocation, putHome } from '../outfits';
import { ProfileInputSchema, getProfile, profileFrom, putProfile } from '../profile';

export const profile = new Hono<{ Bindings: Env }>();

/** The same degrees `currentWeather` accepts, and stored at full precision. */
const HomeSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});

/**
 * The one answer this file sends, so every route hands the screen the whole
 * record and it redraws from one reply.
 *
 * `suggestedType` is recomputed from the stored observations on every read, so a
 * hand-corrected `bodyType` shows up as a disagreement the user can see rather
 * than being quietly overwritten. The home is read back rather than echoed,
 * because a write against a profile row that does not exist yet stores nothing.
 */
async function profileResponse(db: D1Database): Promise<ProfileResponse> {
  const [stored, home] = await Promise.all([getProfile(db), homeLocation(db)]);
  return { profile: stored, suggestedType: stored === null ? null : classify(stored), home };
}

profile.get('/', async (c) => {
  return c.json(await profileResponse(c.env.DB));
});

profile.put('/', async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  const parsed = ProfileInputSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid profile', issues: parsed.error.issues }, 400);
  }

  await putProfile(c.env.DB, profileFrom(parsed.data));
  return c.json(await profileResponse(c.env.DB));
});

profile.put('/home', async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  const parsed = HomeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'send lat between -90 and 90, and lon between -180 and 180', issues: parsed.error.issues },
      400,
    );
  }

  await putHome(c.env.DB, parsed.data);
  return c.json(await profileResponse(c.env.DB));
});

profile.delete('/home', async (c) => {
  await clearHome(c.env.DB);
  return c.json(await profileResponse(c.env.DB));
});
