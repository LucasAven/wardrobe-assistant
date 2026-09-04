import { Hono } from 'hono';
import { classify } from '../../domain/bodyType';
import type { BodyProfile } from '../../domain/types';
import type { ProfileResponse } from '../contract';
import type { Env } from '../env';
import { ProfileInputSchema, getProfile, profileFrom, putProfile } from '../profile';

export const profile = new Hono<{ Bindings: Env }>();

/**
 * `suggestedType` is recomputed from the stored observations on every read, so a
 * hand-corrected `bodyType` shows up as a disagreement the user can see rather
 * than being quietly overwritten.
 */
function withSuggestion(stored: BodyProfile | null): ProfileResponse {
  return { profile: stored, suggestedType: stored === null ? null : classify(stored) };
}

profile.get('/', async (c) => {
  return c.json(withSuggestion(await getProfile(c.env.DB)));
});

profile.put('/', async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  const parsed = ProfileInputSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid profile', issues: parsed.error.issues }, 400);
  }

  const stored = await putProfile(c.env.DB, profileFrom(parsed.data));
  return c.json(withSuggestion(stored));
});
