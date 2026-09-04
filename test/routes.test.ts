import { beforeEach, describe, expect, it, vi } from 'vitest';

const { parseMock } = vi.hoisted(() => ({ parseMock: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    public messages = { parse: parseMock };
    constructor(public readonly options: unknown) {}
  },
}));

import app from '../src/worker/index';

type Row = Record<string, unknown>;

class FakeDb {
  public profile: Row[] = [];
  public wear: Row[] = [];
  public garments: Row[] = [];

  prepare(sql: string) {
    const self = this;
    const make = (args: unknown[]) => ({
      bind: (...next: unknown[]) => make(next),
      first: async () => self.exec(sql, args)[0] ?? null,
      all: async () => ({ results: self.exec(sql, args) }),
      run: async () => {
        self.exec(sql, args);
        return { success: true };
      },
    });
    return make([]);
  }

  private exec(sql: string, args: unknown[]): Row[] {
    if (sql.includes('FROM profile')) return this.profile;
    if (sql.includes('INSERT INTO profile')) {
      this.profile = [{ data: args[0] }];
      return [];
    }
    if (sql.includes('INSERT INTO wear_log')) {
      this.wear.unshift({ worn_on: args[1], garment_ids: args[2], event: args[3] });
      return [];
    }
    if (sql.includes('FROM wear_log')) return this.wear;
    if (sql.includes('FROM garment')) return this.garments;
    throw new Error(`unstubbed sql: ${sql}`);
  }
}

const OBSERVATIONS = {
  shouldersVsHips: 'narrower',
  waistIsWidest: false,
  volume: 'bottom',
  line: 'curved',
  thinLegs: false,
  language: 'es',
};

let db: FakeDb;
let env: Record<string, unknown>;
let cookie: string;

async function call(method: string, url: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, headers: { cookie } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { cookie, 'content-type': 'application/json' };
  }
  return app.fetch(new Request(url, init), env as never);
}

beforeEach(async () => {
  db = new FakeDb();
  env = { DB: db, SESSION_SECRET: 'secret', APP_PASSWORD: 'pw', ANTHROPIC_API_KEY: 'k' };
  parseMock.mockReset();
  const login = await app.fetch(
    new Request('http://x/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'pw' }),
    }),
    env as never,
  );
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
});

describe('profile route', () => {
  it('derives the body type on write and re-derives the suggestion on read', async () => {
    const written = await call('PUT', 'http://x/api/profile', OBSERVATIONS);
    expect(written.status).toBe(200);
    expect(await written.json()).toMatchObject({
      profile: { bodyType: 'triangle', language: 'es' },
      suggestedType: 'triangle',
    });

    const read = await call('GET', 'http://x/api/profile');
    expect(await read.json()).toMatchObject({ suggestedType: 'triangle' });
  });

  it('shows a hand correction as a disagreement instead of overwriting it', async () => {
    await call('PUT', 'http://x/api/profile', { ...OBSERVATIONS, bodyType: 'rectangle' });
    const read = await call('GET', 'http://x/api/profile');
    expect(await read.json()).toMatchObject({
      profile: { bodyType: 'rectangle' },
      suggestedType: 'triangle',
    });
  });

  it('answers null for both before anything is stored', async () => {
    expect(await (await call('GET', 'http://x/api/profile')).json()).toEqual({
      profile: null,
      suggestedType: null,
    });
  });
});

describe('wear route', () => {
  it('logs a wear and reads it back', async () => {
    const posted = await call('POST', 'http://x/api/wear', {
      garmentIds: ['tee-white', 'jeans-indigo'],
      event: 'work',
    });
    expect(posted.status).toBe(201);

    const listed = await (await call('GET', 'http://x/api/wear')).json();
    expect(listed).toMatchObject([{ garmentIds: ['tee-white', 'jeans-indigo'], event: 'work' }]);
  });

  it('refuses a since that is not a date', async () => {
    expect((await call('GET', 'http://x/api/wear?since=yesterday')).status).toBe(400);
  });
});

describe('weather route', () => {
  it('turns a live payload into the contract shape', async () => {
    const payload = {
      current: {
        time: '2026-09-04T11:15',
        temperature_2m: 13.2,
        apparent_temperature: 11.4,
        wind_speed_10m: 6.9,
        precipitation_probability: 0,
      },
    };
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(payload));

    const res = await call('GET', 'http://x/api/weather?lat=-34.6&lon=-58.4');
    expect(await res.json()).toEqual({
      tempC: 13.2,
      feelsLikeC: 11.4,
      precipProbability: 0,
      windKph: 6.9,
      label: '13 degrees, feels like 11',
    });
    expect(spy.mock.calls[0]?.[0]).toContain('api.open-meteo.com');
    spy.mockRestore();
  });

  it('refuses a missing location', async () => {
    expect((await call('GET', 'http://x/api/weather')).status).toBe(400);
  });
});

describe('recommend route', () => {
  it('refuses to guess a body type when no profile exists', async () => {
    const res = await call('POST', 'http://x/api/recommend', {
      event: 'work',
      timeOfDay: 'morning',
      hoursOutdoors: 2,
      tempC: 15,
    });
    expect(res.status).toBe(409);
  });

  it('runs the whole chain and answers honestly with an empty wardrobe', async () => {
    await call('PUT', 'http://x/api/profile', OBSERVATIONS);

    const res = await call('POST', 'http://x/api/recommend', {
      event: 'work',
      timeOfDay: 'morning',
      hoursOutdoors: 2,
      tempC: 15,
      feelsLikeC: 13,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      outfits: [],
      weather: { tempC: 15, feelsLikeC: 13, label: '15 degrees, feels like 13' },
      minFormality: 3,
      starved: ['base', 'bottom', 'shoes'],
    });
    expect(parseMock).not.toHaveBeenCalled();
  });

  it('needs either a reading or a location', async () => {
    await call('PUT', 'http://x/api/profile', OBSERVATIONS);
    const res = await call('POST', 'http://x/api/recommend', {
      event: 'work',
      timeOfDay: 'morning',
      hoursOutdoors: 2,
    });
    expect(res.status).toBe(400);
  });
});
