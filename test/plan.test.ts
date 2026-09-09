/**
 * A plan has to survive KV unchanged, because `save_outfit` certifies against
 * the menu it names and nothing rebuilds that menu.
 */
import { describe, expect, it, vi } from 'vitest';

const { parseMock } = vi.hoisted(() => ({ parseMock: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    public messages = { parse: parseMock };
    constructor(public readonly options: unknown) {}
  },
}));

import { deriveConstraints } from '../src/domain/constraints';
import { buildMenu } from '../src/domain/menu';
import type { BodyProfile } from '../src/domain/types';
import type { Env } from '../src/worker/env';
import { buildPlan, planFailed, readPlan, savePlan } from '../src/worker/mcp/plan';
import { AUTUMN_DAY, WARDROBE, daysBefore } from './fixtures';
import { FakeDb, FakeKv, garmentRow } from './stubs/fake-env';

const RECTANGLE: BodyProfile = {
  shouldersVsHips: 'equal',
  waistIsWidest: false,
  volume: 'even',
  line: 'straight',
  thinLegs: false,
  bodyType: 'rectangle',
  language: 'en',
};

const MILD = { tempC: 16, feelsLikeC: 15 };

function envWith(db: FakeDb, kv: FakeKv): Env {
  return { DB: db, OAUTH_KV: kv } as unknown as Env;
}

function stocked(): FakeDb {
  const db = new FakeDb();
  db.profile = { data: JSON.stringify(RECTANGLE) };
  db.garments = WARDROBE.map((garment) => garmentRow(garment));
  return db;
}

const REQUEST = {
  event: 'errands',
  timeOfDay: 'morning',
  hoursOutdoors: 2,
} as const;

describe('buildPlan', () => {
  it('refuses without a body profile and says where one comes from', async () => {
    const plan = await buildPlan(envWith(new FakeDb(), new FakeKv()), REQUEST, AUTUMN_DAY);
    expect(planFailed(plan)).toBe(true);
    if (!planFailed(plan)) return;
    expect(plan.problem).toContain('body profile');
    expect(plan.problem).toContain('Profile screen');
  });

  it('refuses without weather or a stored home location, and names the field to send', async () => {
    const plan = await buildPlan(envWith(stocked(), new FakeKv()), REQUEST, AUTUMN_DAY);
    expect(planFailed(plan)).toBe(true);
    if (!planFailed(plan)) return;
    expect(plan.problem).toContain('home location');
    expect(plan.problem).toContain('tempC');
  });

  it('derives the constraints and the menu from a sent reading', async () => {
    const plan = await buildPlan(
      envWith(stocked(), new FakeKv()),
      { ...REQUEST, weather: MILD },
      AUTUMN_DAY,
    );
    expect(planFailed(plan)).toBe(false);
    if (planFailed(plan)) return;

    expect(plan.constraints.season).toBe('autumn');
    expect(plan.constraints.warmth.label).toBe('mild');
    expect(plan.menu.starved).toEqual([]);
    // Summer only, so it cannot be on an autumn menu.
    expect(plan.menu.bySlot.base.map((entry) => entry.garment.id)).not.toContain('tank-gray');
  });

  it('reads the weather from the stored home location when none is sent', async () => {
    const db = stocked();
    db.profile = { data: JSON.stringify(RECTANGLE), home_lat: -34.6, home_lon: -58.4 };

    const forecast = {
      current: {
        time: '2026-05-12T09:00',
        temperature_2m: 16,
        apparent_temperature: 15,
        wind_speed_10m: 5,
        precipitation_probability: 0,
      },
    };
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(forecast));

    const plan = await buildPlan(envWith(db, new FakeKv()), REQUEST, AUTUMN_DAY);
    const asked = String(spy.mock.calls[0]?.[0]);
    spy.mockRestore();

    expect(planFailed(plan)).toBe(false);
    if (planFailed(plan)) return;
    expect(plan.weather.feelsLikeC).toBe(15);
    expect(asked).toContain('latitude=-34.6');
  });
});

describe('the plan round trip through KV', () => {
  it('brings the menu back with the never-worn marker intact', async () => {
    const kv = new FakeKv();
    const env = envWith(new FakeDb(), kv);

    const constraints = deriveConstraints({
      tempC: 16,
      feelsLikeC: 15,
      precipProbability: 0,
      windKph: 0,
      event: 'errands',
      timeOfDay: 'morning',
      hoursOutdoors: 2,
      date: AUTUMN_DAY,
    });
    const menu = buildMenu(
      WARDROBE,
      constraints,
      [{ wornOn: daysBefore(AUTUMN_DAY, 3), garmentIds: ['jeans-indigo'] }],
      'rectangle',
      AUTUMN_DAY,
    );

    const planId = await savePlan(env, 'owner', {
      menu,
      constraints,
      bodyType: 'rectangle',
      event: 'errands',
    });
    const read = await readPlan(env, 'owner', planId);

    expect(read).not.toBeNull();
    expect(read?.constraints).toEqual(constraints);
    expect(read?.menu.bySlot.base.map((entry) => entry.garment.id)).toEqual(
      menu.bySlot.base.map((entry) => entry.garment.id),
    );

    const neverWorn = read?.menu.bySlot.shoes[0];
    expect(neverWorn?.daysSince).toBe(Infinity);

    const jeans = read?.menu.bySlot.bottom.find((entry) => entry.garment.id === 'jeans-indigo');
    expect(jeans?.daysSince).toBe(3);
    expect(jeans?.garment.fabric).toBe('denim');
  });

  it('answers null for an id it never minted', async () => {
    const env = envWith(new FakeDb(), new FakeKv());
    expect(await readPlan(env, 'owner', 'never-existed')).toBeNull();
  });

  it('keeps one grant out of another grant of the same plan', async () => {
    const kv = new FakeKv();
    const env = envWith(new FakeDb(), kv);
    const constraints = deriveConstraints({
      tempC: 16,
      feelsLikeC: 15,
      precipProbability: 0,
      windKph: 0,
      event: 'errands',
      timeOfDay: 'morning',
      hoursOutdoors: 2,
      date: AUTUMN_DAY,
    });
    const menu = buildMenu(WARDROBE, constraints, [], 'rectangle', AUTUMN_DAY);

    const planId = await savePlan(env, 'owner', {
      menu,
      constraints,
      bodyType: 'rectangle',
      event: 'errands',
    });

    expect(await readPlan(env, 'owner', planId)).not.toBeNull();
    expect(await readPlan(env, 'someone-else', planId)).toBeNull();
  });

  it('expires the stored plan after an hour', async () => {
    const kv = new FakeKv();
    const put = vi.spyOn(kv, 'put');
    const env = envWith(new FakeDb(), kv);
    const constraints = deriveConstraints({
      tempC: 16,
      feelsLikeC: 15,
      precipProbability: 0,
      windKph: 0,
      event: 'errands',
      timeOfDay: 'morning',
      hoursOutdoors: 2,
      date: AUTUMN_DAY,
    });

    await savePlan(env, 'owner', {
      menu: buildMenu(WARDROBE, constraints, [], 'rectangle', AUTUMN_DAY),
      constraints,
      bodyType: 'rectangle',
      event: 'errands',
    });

    expect(put.mock.calls[0]?.[2]).toEqual({ expirationTtl: 3600 });
  });
});
