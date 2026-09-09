/**
 * The two routes the web app reads saved outfits through. Nothing saved today
 * is a normal state with a screen of its own, so it answers `null` and 200
 * rather than a 404 the app would have to read as a broken request.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { parseMock } = vi.hoisted(() => ({ parseMock: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    public messages = { parse: parseMock };
    constructor(public readonly options: unknown) {}
  },
}));

import worker from '../src/worker/index';
import type { NewOutfit, SavedOutfit } from '../src/worker/outfits';
import { insertOutfit } from '../src/worker/outfits';
import { WARDROBE } from './fixtures';
import { FakeDb, garmentRow } from './stubs/fake-env';

const MS_PER_DAY = 86_400_000;
const PASSWORD = 'pw';

const OUTFIT: Omit<NewOutfit, 'planId'> = {
  event: 'errands',
  pieces: [
    { slot: 'base', id: 'tee-white' },
    { slot: 'bottom', id: 'jeans-indigo' },
    { slot: 'shoes', id: 'sneakers-white' },
    { slot: 'accessory', id: 'belt-brown' },
  ],
  rationale: 'Plain and easy for a mild morning.',
  citedRules: ['rect-01'],
  missedRules: ['rect-02'],
  warmthCore: 3,
  warmthWithOuter: 3,
};

let db: FakeDb;
let env: Record<string, unknown>;
let cookie: string;

async function call(url: string, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(new Request(url, { ...init, headers: { cookie, ...init.headers } }), env as never);
}

async function bodyOf<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function save(planId: string, savedAt: Date): Promise<string> {
  return insertOutfit(db as unknown as D1Database, { ...OUTFIT, planId }, savedAt);
}

beforeEach(async () => {
  db = new FakeDb();
  db.garments = WARDROBE.map((garment) => garmentRow(garment));
  env = { DB: db, SESSION_SECRET: 'secret', APP_PASSWORD: PASSWORD };
  cookie = '';

  const login = await worker.fetch(
    new Request('http://x/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    }),
    env as never,
  );
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
});

describe('GET /api/outfits/today', () => {
  it('answers 200 and a null outfit when nothing was saved today', async () => {
    const response = await call('http://x/api/outfits/today');

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ outfit: null });
  });

  it('still answers null when the only saved outfit is from another day', async () => {
    await save('p1', new Date(Date.now() - 2 * MS_PER_DAY));

    const body = await bodyOf<{ outfit: SavedOutfit | null }>(await call('http://x/api/outfits/today'));
    expect(body.outfit).toBeNull();
  });

  it('hydrates the garment rows so the app can render the photos', async () => {
    const id = await save('p1', new Date());

    const body = await bodyOf<{ outfit: SavedOutfit | null }>(await call('http://x/api/outfits/today'));
    const outfit = body.outfit;

    expect(outfit?.id).toBe(id);
    expect(outfit?.pieces.map((piece) => piece.slot)).toEqual(['base', 'bottom', 'shoes']);
    expect(outfit?.pieces[0]?.garment.subtype).toBe('cotton t-shirt');
    expect(outfit?.accessories.map((garment) => garment.id)).toEqual(['belt-brown']);
    expect(outfit?.cited).toEqual([
      { id: 'rect-01', because: expect.stringContaining('V-necks') },
    ]);
    expect(outfit?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(outfit?.worn).toBe(false);
  });

  it('reads as worn once the wear log holds every garment for that day', async () => {
    await save('p1', new Date());

    const unworn = await bodyOf<{ outfit: SavedOutfit }>(await call('http://x/api/outfits/today'));
    expect(unworn.outfit.worn).toBe(false);

    await call('http://x/api/wear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        garmentIds: ['tee-white', 'jeans-indigo', 'sneakers-white', 'belt-brown'],
      }),
    });

    const worn = await bodyOf<{ outfit: SavedOutfit }>(await call('http://x/api/outfits/today'));
    expect(worn.outfit.worn).toBe(true);
  });

  it('stays unworn while any one of its garments is missing from the log', async () => {
    await save('p1', new Date());

    await call('http://x/api/wear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ garmentIds: ['tee-white', 'jeans-indigo', 'sneakers-white'] }),
    });

    const body = await bodyOf<{ outfit: SavedOutfit }>(await call('http://x/api/outfits/today'));
    expect(body.outfit.worn).toBe(false);
  });

  /**
   * The piece drops out of the render and the outfit survives. Losing the whole
   * outfit because one garment was tidied away would be worse than showing it
   * with four pieces instead of five.
   */
  it('drops a garment archived after the outfit was saved, and keeps the rest', async () => {
    await save('p1', new Date());
    db.garments = db.garments.map((row) =>
      row.id === 'jeans-indigo' ? { ...row, archived: 1 } : row,
    );

    const body = await bodyOf<{ outfit: SavedOutfit }>(await call('http://x/api/outfits/today'));

    expect(body.outfit.pieces.map((piece) => piece.slot)).toEqual(['base', 'shoes']);
    expect(body.outfit.rationale).toBe(OUTFIT.rationale);
  });

  it('still reads as worn when an archived garment was logged before it went', async () => {
    await save('p1', new Date());
    await call('http://x/api/wear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        garmentIds: ['tee-white', 'jeans-indigo', 'sneakers-white', 'belt-brown'],
      }),
    });
    db.garments = db.garments.map((row) =>
      row.id === 'jeans-indigo' ? { ...row, archived: 1 } : row,
    );

    const body = await bodyOf<{ outfit: SavedOutfit }>(await call('http://x/api/outfits/today'));
    expect(body.outfit.worn).toBe(true);
  });
});

describe('GET /api/outfits', () => {
  async function saveMany(count: number): Promise<readonly string[]> {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      ids.push(await save(`p${index}`, new Date(Date.now() - index * MS_PER_DAY)));
    }
    return ids;
  }

  it('answers an empty list rather than an error when nothing is stored', async () => {
    expect(await bodyOf(await call('http://x/api/outfits'))).toEqual({ outfits: [] });
  });

  it('returns the newest first', async () => {
    const saved = await saveMany(3);

    const body = await bodyOf<{ outfits: SavedOutfit[] }>(await call('http://x/api/outfits'));
    expect(body.outfits.map((outfit) => outfit.id)).toEqual(saved);
  });

  it('honors a limit', async () => {
    const saved = await saveMany(5);

    const body = await bodyOf<{ outfits: SavedOutfit[] }>(await call('http://x/api/outfits?limit=2'));
    expect(body.outfits.map((outfit) => outfit.id)).toEqual(saved.slice(0, 2));
  });

  it('caps the limit at twenty, whatever is asked for and whatever is sent', async () => {
    await saveMany(22);

    for (const query of ['', '?limit=500', '?limit=nonsense', '?limit=-4']) {
      const body = await bodyOf<{ outfits: SavedOutfit[] }>(
        await call(`http://x/api/outfits${query}`),
      );
      expect(body.outfits).toHaveLength(20);
    }
  });
});

describe('the session guard', () => {
  it('covers both outfit routes', async () => {
    cookie = '';
    expect((await call('http://x/api/outfits/today')).status).toBe(401);
    expect((await call('http://x/api/outfits')).status).toBe(401);
  });
});
