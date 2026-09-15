/**
 * A plan is everything the deterministic half of the app decided about one
 * moment: the weather it read, the constraints it derived, and the menu it
 * narrowed the wardrobe down to.
 *
 * `save_outfit` certifies against the menu the plan named, never against a
 * rebuilt one. Rebuilding would drift, because the wardrobe can change between
 * the two calls and `now` crossing a day boundary moves every cooldown. So the
 * plan is written to KV under a short TTL and read back by id.
 */

import { z } from 'zod';
import { deriveConstraints } from '../../domain/constraints';
import type { WardrobeGap } from '../../domain/gaps';
import { wardrobeGaps } from '../../domain/gaps';
import { buildMenu } from '../../domain/menu';
import type {
  BodyProfile,
  BodyType,
  Constraints,
  EventKind,
  Admission,
  Garment,
  GarmentId,
  Menu,
  MenuChoices,
  MenuEntry,
  Moment,
  Slot,
  TimeOfDay,
} from '../../domain/types';
import type { WeatherResponse } from '../contract';
import type { Env } from '../env';
import { homeLocation } from '../outfits';
import { getProfile } from '../profile';
import { listGarments } from '../repo';
import { WEAR_WINDOW_DAYS, day, recentWear } from '../routes/wear';
import { GarmentDraftSchema } from '../vision';
import { describeWeather, fetchWeather } from '../weather';

const MS_PER_DAY = 86_400_000;

/** Long enough to compose in, short enough that a stale menu never gets used. */
export const PLAN_TTL_SECONDS = 3600;

export const EVENTS = [
  'home',
  'errands',
  'work',
  'social',
  'dinner',
  'formal',
  'active',
] as const satisfies readonly EventKind[];

export const TIMES_OF_DAY = ['morning', 'afternoon', 'evening'] as const satisfies readonly TimeOfDay[];

const SLOTS = [
  'base',
  'top',
  'mid',
  'outer',
  'bottom',
  'shoes',
  'accessory',
] as const satisfies readonly Slot[];

/**
 * Optional fields are spelled `| undefined` rather than left bare, because every
 * value here arrives as parsed JSON where an absent key and an undefined one are
 * the same thing.
 */
export interface WeatherInput {
  readonly tempC: number;
  readonly feelsLikeC?: number | undefined;
  readonly precipProbability?: number | undefined;
  readonly windKph?: number | undefined;
}

/**
 * A garment the owner asked for by name, and the words they asked in. One
 * object rather than two fields, so a waiver can never exist without the words
 * that justify it: that pairing is the only thing standing between an override
 * and a filter the composer turned off by itself.
 */
export interface OwnerAsked {
  readonly garmentIds: readonly string[];
  readonly words: string;
}

export interface PlanRequest {
  readonly event: EventKind;
  readonly timeOfDay: TimeOfDay;
  readonly hoursOutdoors: number;
  readonly mood?: string | undefined;
  readonly weather?: WeatherInput | undefined;
  readonly ownerAsked?: OwnerAsked | undefined;
}

export interface Plan {
  readonly profile: BodyProfile;
  readonly moment: Moment;
  readonly weather: WeatherResponse;
  readonly constraints: Constraints;
  readonly menu: Menu;
  readonly ownerAsked: OwnerAsked | null;
  /**
   * Read off the whole wardrobe and not off the menu, because a gap is about
   * what the owner owns and today's filters have nothing to do with it.
   */
  readonly gaps: readonly WardrobeGap[];
}

/** Why no plan exists, written for the caller to act on rather than to log. */
export interface PlanFailure {
  readonly problem: string;
}

export function planFailed(plan: Plan | PlanFailure): plan is PlanFailure {
  return 'problem' in plan;
}

async function weatherFor(
  env: Env,
  request: PlanRequest,
): Promise<WeatherResponse | PlanFailure> {
  const sent = request.weather;
  if (sent !== undefined) {
    return describeWeather({
      tempC: sent.tempC,
      feelsLikeC: sent.feelsLikeC ?? sent.tempC,
      precipProbability: sent.precipProbability ?? 0,
      windKph: sent.windKph ?? 0,
    });
  }

  const home = await homeLocation(env.DB);
  if (home === null) {
    return {
      problem:
        'No home location is stored for this wardrobe, so the weather cannot be looked up. Call plan_outfit again with the weather field filled in: tempC is enough, and feelsLikeC, precipProbability and windKph sharpen it.',
    };
  }

  try {
    return await fetchWeather(home.lat, home.lon);
  } catch {
    return {
      problem:
        'The weather service did not answer for the stored home location. Call plan_outfit again with the weather field filled in.',
    };
  }
}

function momentFrom(request: PlanRequest, weather: WeatherResponse, now: Date): Moment {
  const moment = {
    tempC: weather.tempC,
    feelsLikeC: weather.feelsLikeC,
    precipProbability: weather.precipProbability,
    windKph: weather.windKph,
    event: request.event,
    timeOfDay: request.timeOfDay,
    hoursOutdoors: request.hoursOutdoors,
    date: now,
  };
  const mood = request.mood?.trim();
  return mood === undefined || mood === '' ? moment : { ...moment, mood };
}

export async function buildPlan(
  env: Env,
  request: PlanRequest,
  now: Date,
): Promise<Plan | PlanFailure> {
  const profile = await getProfile(env.DB);
  if (profile === null) {
    return {
      problem:
        'No body profile is stored yet, and every rule in the styling book is written against a body type. The owner fills the five mirror questions in the web app, on the Profile screen, before this tool can plan anything.',
    };
  }

  const weather = await weatherFor(env, request);
  if ('problem' in weather) return weather;

  const moment = momentFrom(request, weather, now);
  const constraints = deriveConstraints(moment);

  const [stored, recent] = await Promise.all([
    listGarments(env.DB, {}),
    recentWear(env.DB, day(new Date(now.getTime() - WEAR_WINDOW_DAYS * MS_PER_DAY))),
  ]);

  const ownerAsked = request.ownerAsked ?? null;

  const menu = buildMenu(
    stored.map((row) => row.garment),
    constraints,
    recent,
    profile.bodyType,
    now,
    ownerAsked?.garmentIds ?? [],
  );

  const wardrobe = stored.map((row) => row.garment);
  return {
    profile,
    moment,
    weather,
    constraints,
    menu,
    ownerAsked,
    gaps: wardrobeGaps(wardrobe, profile.bodyType),
  };
}

// ---------------------------------------------------------------------------
// What survives the round trip through KV
// ---------------------------------------------------------------------------

export interface StoredPlan {
  /**
   * Only what `save_outfit` resolves against. A plan's `heldBack` and `refused`
   * are its own report to the composer and die with the call that made them, so
   * carrying them to KV would only give a later reader a second list to confuse
   * with the menu.
   */
  readonly menu: MenuChoices;
  readonly constraints: Constraints;
  readonly bodyType: BodyType;
  readonly event: EventKind;
  /**
   * Captured here rather than asked for again at save time. The words are the
   * owner's, so the composer gets to report them once and never to revise them
   * into something the waivers fit better.
   */
  readonly ownerAsked: OwnerAsked | null;
  /**
   * The ids of the rules this wardrobe could not satisfy when the plan was
   * made, and not recomputed at save time. What `save_outfit` says it missed
   * has to match the guide the composer was given, and a plan lives an hour, so
   * a garment uploaded in between would otherwise make the two disagree.
   */
  readonly gaps: readonly string[];
}

/**
 * The transform's return type is the compiler's check that the schema still
 * covers the domain shape, so a field added to `Garment` fails here rather than
 * going missing from a read-back menu.
 */
const GarmentSchema = GarmentDraftSchema.omit({ uncertain: true })
  .extend({
    id: z.string(),
    imageOriginal: z.string(),
    imageCutout: z.string().nullable(),
  })
  .transform(
    (row): Garment => ({
      ...row,
      // Minted by resolving against a Menu everywhere else. This id came out of
      // one, went to KV and came back, so it is already a real one.
      id: row.id as GarmentId,
    }),
  );

const AdmissionSchema = z
  .discriminatedUnion('by', [
    z.object({ by: z.literal('rested') }),
    z.object({ by: z.literal('starved_slot') }),
    z.object({
      by: z.literal('owner_asked'),
      waived: z.array(z.enum(['season', 'formality', 'cooldown'])),
    }),
  ])
  .transform((value): Admission => value);

/** `Infinity` has no JSON spelling, so a never-worn garment stores as `null`. */
const MenuEntrySchema = z
  .object({
    garment: GarmentSchema,
    daysSince: z.number().nullable(),
    admittedBy: AdmissionSchema,
  })
  .transform(
    (entry): MenuEntry => ({
      garment: entry.garment,
      daysSince: entry.daysSince ?? Infinity,
      admittedBy: entry.admittedBy,
    }),
  );

const BandSchema = z.object({ min: z.number(), max: z.number() });

const ConstraintsSchema = z
  .object({
    warmth: z.object({ core: BandSchema, withOuter: BandSchema, label: z.string() }),
    minFormality: z.literal([1, 2, 3, 4, 5]),
    season: z.enum(['spring', 'summer', 'autumn', 'winter']),
    cooldownDays: z.object({
      base: z.number(),
      top: z.number(),
      mid: z.number(),
      outer: z.number(),
      bottom: z.number(),
      shoes: z.number(),
      accessory: z.number(),
    }),
  })
  .transform((value): Constraints => value);

const StoredPlanSchema = z
  .object({
    menu: z.object({
      bySlot: z.object({
        base: z.array(MenuEntrySchema),
        top: z.array(MenuEntrySchema),
        mid: z.array(MenuEntrySchema),
        outer: z.array(MenuEntrySchema),
        bottom: z.array(MenuEntrySchema),
        shoes: z.array(MenuEntrySchema),
        accessory: z.array(MenuEntrySchema),
      }),
    }),
    constraints: ConstraintsSchema,
    bodyType: z.enum(['rectangle', 'triangle', 'inverted_triangle', 'circular']),
    event: z.enum(EVENTS),
    ownerAsked: z
      .object({ garmentIds: z.array(z.string()), words: z.string() })
      .nullable()
      .transform((value): OwnerAsked | null => value),
    // Defaulted rather than required, so a plan written before gaps existed is
    // still readable for the hour it has left instead of reading as expired.
    gaps: z.array(z.string()).default([]),
  })
  .transform((value): StoredPlan => value);

function forStorage(plan: StoredPlan): unknown {
  const bySlot: Record<string, unknown[]> = {};
  for (const slot of SLOTS) {
    bySlot[slot] = plan.menu.bySlot[slot].map((entry) => ({
      garment: entry.garment,
      daysSince: Number.isFinite(entry.daysSince) ? entry.daysSince : null,
      admittedBy: entry.admittedBy,
    }));
  }
  return {
    menu: { bySlot },
    constraints: plan.constraints,
    bodyType: plan.bodyType,
    event: plan.event,
    ownerAsked: plan.ownerAsked,
    gaps: plan.gaps,
  };
}

/** Scoped by grant, so one connection's plans are unreadable from another. */
function planKey(userId: string, planId: string): string {
  return `plan:${userId}:${planId}`;
}

export async function savePlan(env: Env, userId: string, plan: StoredPlan): Promise<string> {
  const planId = crypto.randomUUID();
  await env.OAUTH_KV.put(planKey(userId, planId), JSON.stringify(forStorage(plan)), {
    expirationTtl: PLAN_TTL_SECONDS,
  });
  return planId;
}

export async function readPlan(
  env: Env,
  userId: string,
  planId: string,
): Promise<StoredPlan | null> {
  const raw: unknown = await env.OAUTH_KV.get(planKey(userId, planId), { type: 'json' });
  if (raw === null) return null;

  const parsed = StoredPlanSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
