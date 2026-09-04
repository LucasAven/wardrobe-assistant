import { z } from 'zod';
import { classify } from '../domain/bodyType';
import type { BodyProfile } from '../domain/types';

const ObservationsSchema = z.object({
  shouldersVsHips: z.enum(['wider', 'narrower', 'equal']),
  waistIsWidest: z.boolean(),
  volume: z.enum(['top', 'bottom', 'center', 'even']),
  line: z.enum(['straight', 'curved']),
  thinLegs: z.boolean(),
});

const BodyTypeSchema = z.enum(['rectangle', 'triangle', 'inverted_triangle', 'circular']);

const StoredProfileSchema = ObservationsSchema.extend({
  bodyType: BodyTypeSchema,
  language: z.enum(['es', 'en']),
});

/**
 * `bodyType` is optional on the way in and derived when it is left out. Sending
 * it is how a wrong classification gets corrected by hand without faking the
 * observations that produced it.
 */
export const ProfileInputSchema = ObservationsSchema.extend({
  bodyType: BodyTypeSchema.optional(),
  language: z.enum(['es', 'en']).default('en'),
});

export type ProfileInput = z.infer<typeof ProfileInputSchema>;

/** The return type is the compiler's check that the schema still covers the domain shape. */
export function profileFrom(input: ProfileInput): BodyProfile {
  return {
    shouldersVsHips: input.shouldersVsHips,
    waistIsWidest: input.waistIsWidest,
    volume: input.volume,
    line: input.line,
    thinLegs: input.thinLegs,
    bodyType: input.bodyType ?? classify(input),
    language: input.language,
  };
}

interface ProfileRow {
  readonly data: string;
}

export async function getProfile(db: D1Database): Promise<BodyProfile | null> {
  const row = await db.prepare('SELECT data FROM profile WHERE id = 1').first<ProfileRow>();
  if (row === null) return null;
  return StoredProfileSchema.parse(JSON.parse(row.data));
}

export async function putProfile(db: D1Database, profile: BodyProfile): Promise<BodyProfile> {
  await db
    .prepare(
      `INSERT INTO profile (id, data, updated_at) VALUES (1, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    )
    .bind(JSON.stringify(profile))
    .run();
  return profile;
}
