import { Hono } from 'hono';
import type { Handler } from 'hono';
import { z } from 'zod';
import { deriveConstraints } from '../../domain/constraints';
import { buildMenu } from '../../domain/menu';
import type { Moment } from '../../domain/types';
import { compose } from '../compose';
import type { RecommendResponse, WeatherResponse } from '../contract';
import type { Env } from '../env';
import { getProfile } from '../profile';
import { listGarments } from '../repo';
import { describeWeather, fetchWeather } from '../weather';
import { WEAR_WINDOW_DAYS, day, recentWear } from './wear';

const MS_PER_DAY = 86_400_000;

const RecommendRequestSchema = z.object({
  event: z.enum(['home', 'errands', 'work', 'social', 'dinner', 'formal', 'active']),
  timeOfDay: z.enum(['morning', 'afternoon', 'evening']),
  hoursOutdoors: z.number().min(0).max(24),
  mood: z.string().optional(),
  tempC: z.number().optional(),
  feelsLikeC: z.number().optional(),
  precipProbability: z.number().min(0).max(1).optional(),
  windKph: z.number().min(0).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
});

type RecommendInput = z.infer<typeof RecommendRequestSchema>;

/**
 * Sent weather wins over a location, so a phone that already has a reading does
 * not pay for a second lookup. A temperature with no `feelsLikeC` beside it
 * stands in for itself rather than defaulting to a number nobody measured.
 */
async function weatherFor(request: RecommendInput): Promise<WeatherResponse | null> {
  if (request.tempC !== undefined) {
    return describeWeather({
      tempC: request.tempC,
      feelsLikeC: request.feelsLikeC ?? request.tempC,
      precipProbability: request.precipProbability ?? 0,
      windKph: request.windKph ?? 0,
    });
  }
  if (request.lat !== undefined && request.lon !== undefined) {
    return fetchWeather(request.lat, request.lon);
  }
  return null;
}

function momentFrom(request: RecommendInput, weather: WeatherResponse, now: Date): Moment {
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
  return request.mood === undefined ? moment : { ...moment, mood: request.mood };
}

export const recommend = new Hono<{ Bindings: Env }>();

recommend.post('/', async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  const parsed = RecommendRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid request', issues: parsed.error.issues }, 400);
  }

  const profile = await getProfile(c.env.DB);
  if (profile === null) {
    return c.json(
      { error: 'no body profile yet. Fill the mirror questions first, at PUT /api/profile.' },
      409,
    );
  }

  let weather: WeatherResponse | null;
  try {
    weather = await weatherFor(parsed.data);
  } catch (error) {
    console.error('weather lookup failed', { error });
    return c.json({ error: 'weather lookup failed' }, 502);
  }
  if (weather === null) {
    return c.json({ error: 'send tempC, or send lat and lon' }, 400);
  }

  const now = new Date();
  const moment = momentFrom(parsed.data, weather, now);
  const constraints = deriveConstraints(moment);

  const [stored, recent] = await Promise.all([
    listGarments(c.env.DB, {}),
    recentWear(c.env.DB, day(new Date(now.getTime() - WEAR_WINDOW_DAYS * MS_PER_DAY))),
  ]);

  const menu = buildMenu(
    stored.map((row) => row.garment),
    constraints,
    recent,
    profile.bodyType,
    now,
  );

  let composed: Awaited<ReturnType<typeof compose>>;
  try {
    composed = await compose(c.env, { profile, constraints, menu, moment });
  } catch (error) {
    console.error('composing failed', { error });
    return c.json({ error: 'composing failed' }, 502);
  }

  const response: RecommendResponse = {
    outfits: composed.outfits,
    weather,
    season: constraints.season,
    minFormality: constraints.minFormality,
    warmthLabel: constraints.warmth.label,
    starved: menu.starved,
    rejected: composed.rejected,
  };
  return c.json(response);
});

/**
 * Lives beside the recommender because it exists to fill the same request: the
 * PWA shows the reading, the user adjusts the rest of the moment, and the
 * numbers come back inline on the POST.
 */
export const currentWeather: Handler<{ Bindings: Env }> = async (c) => {
  const lat = Number(c.req.query('lat'));
  const lon = Number(c.req.query('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return c.json({ error: 'lat and lon are required, in degrees' }, 400);
  }

  try {
    return c.json(await fetchWeather(lat, lon));
  } catch (error) {
    console.error('weather lookup failed', { lat, lon, error });
    return c.json({ error: 'weather lookup failed' }, 502);
  }
};
