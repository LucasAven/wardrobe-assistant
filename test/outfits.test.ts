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

import type { BodyProfile } from '../src/domain/types';
import worker from '../src/worker/index';
import type { NewOutfit, SavedOutfit } from '../src/worker/outfits';
import { clearHome, homeLocation, insertOutfit, putHome, readOutfits } from '../src/worker/outfits';
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
  ownerRequest: null,
};

/**
 * Two torso layers, so `rect-01` holds for it and dropping the mid breaks it.
 * `all-01` holds for every outfit there is, so it is the citation that survives.
 */
const LAYERED: Omit<NewOutfit, 'planId'> = {
  event: 'work',
  pieces: [
    { slot: 'base', id: 'tee-white' },
    { slot: 'mid', id: 'cardigan-gray' },
    { slot: 'bottom', id: 'jeans-indigo' },
    { slot: 'shoes', id: 'sneakers-white' },
  ],
  rationale: 'Two layers so the torso reads as having shape.',
  citedRules: ['rect-01', 'all-01'],
  missedRules: [],
  warmthCore: 4,
  warmthWithOuter: 4,
  ownerRequest: null,
};

const RECTANGLE: BodyProfile = {
  shouldersVsHips: 'equal',
  waistIsWidest: false,
  volume: 'even',
  line: 'straight',
  thinLegs: false,
  bodyType: 'rectangle',
  language: 'en',
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

async function saveLayered(): Promise<string> {
  db.profile = { data: JSON.stringify(RECTANGLE) };
  return insertOutfit(db as unknown as D1Database, { ...LAYERED, planId: 'p1' }, new Date());
}

async function swapPiece(id: string, edit: unknown): Promise<Response> {
  return call(`http://x/api/outfits/${id}/swap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(edit),
  });
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

describe('POST /api/outfits/:id/swap', () => {
  it('answers 404 for an outfit that is not there', async () => {
    expect((await swapPiece('nope', { slot: 'mid', toId: null, reason: 'too warm' })).status).toBe(404);
  });

  it('refuses to empty a slot every outfit needs', async () => {
    const id = await saveLayered();
    const response = await swapPiece(id, { slot: 'shoes', toId: null, reason: 'barefoot day' });

    expect(response.status).toBe(400);
    expect((await bodyOf<{ error: string }>(response)).error).toContain('cannot be left empty');
    expect(db.feedback).toHaveLength(0);
  });

  it('refuses a garment that lives in another slot, and says what it is', async () => {
    const id = await saveLayered();
    const response = await swapPiece(id, { slot: 'mid', toId: 'loafers-brown', reason: 'nicer' });

    expect(response.status).toBe(400);
    expect((await bodyOf<{ error: string }>(response)).error).toContain('is a shoes, not a mid');
    expect(db.feedback).toHaveLength(0);
  });

  it('refuses a garment this wardrobe does not have', async () => {
    const id = await saveLayered();
    const response = await swapPiece(id, { slot: 'mid', toId: 'not-a-garment', reason: 'nicer' });

    expect(response.status).toBe(400);
    expect((await bodyOf<{ error: string }>(response)).error).toContain('not in your wardrobe');
  });

  it('refuses a slot the outfit has nothing in', async () => {
    const id = await saveLayered();
    const response = await swapPiece(id, { slot: 'outer', toId: 'trench-navy', reason: 'colder now' });

    expect(response.status).toBe(400);
    expect((await bodyOf<{ error: string }>(response)).error).toContain('nothing in outer');
  });

  it('drops a request for the piece that was swapped out, and keeps the rest', async () => {
    db.profile = { data: JSON.stringify(RECTANGLE) };
    const id = await insertOutfit(
      db as unknown as D1Database,
      {
        ...LAYERED,
        planId: 'p1',
        ownerRequest: {
          words: 'the gray cardigan and the indigo jeans',
          disagreement: 'The blazer was smarter.',
          honored: [
            { id: 'cardigan-gray', waived: ['season'] },
            { id: 'jeans-indigo', waived: [] },
          ],
        },
      },
      new Date(),
    );

    const response = await swapPiece(id, { slot: 'mid', toId: 'blazer-navy', reason: 'too casual' });
    const body = await bodyOf<{ outfit: SavedOutfit }>(response);

    expect(response.status).toBe(200);
    expect(body.outfit.ownerRequest?.honored.map((one) => one.id)).toEqual(['jeans-indigo']);
    expect(body.outfit.ownerRequest?.words).toBe('the gray cardigan and the indigo jeans');
  });

  it('drops the whole request once nothing it asked for is still worn', async () => {
    db.profile = { data: JSON.stringify(RECTANGLE) };
    const id = await insertOutfit(
      db as unknown as D1Database,
      {
        ...LAYERED,
        planId: 'p1',
        ownerRequest: {
          words: 'the gray cardigan',
          disagreement: 'The blazer was smarter.',
          honored: [{ id: 'cardigan-gray', waived: ['season'] }],
        },
      },
      new Date(),
    );

    const response = await swapPiece(id, { slot: 'mid', toId: 'blazer-navy', reason: 'too casual' });

    expect((await bodyOf<{ outfit: SavedOutfit }>(response)).outfit.ownerRequest).toBeNull();
  });

  it('refuses a reason that is only blank space', async () => {
    const id = await saveLayered();
    expect((await swapPiece(id, { slot: 'mid', toId: 'blazer-navy', reason: '   ' })).status).toBe(400);
  });

  /** `wasWorn` reads the stored ids, so a swap would turn a worn outfit back into an unworn one. */
  it('answers 409 once the outfit is logged as worn', async () => {
    const id = await save('p1', new Date());
    await call('http://x/api/wear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        garmentIds: ['tee-white', 'jeans-indigo', 'sneakers-white', 'belt-brown'],
      }),
    });

    const response = await swapPiece(id, { slot: 'shoes', toId: 'loafers-brown', reason: 'wrong shoes' });

    expect(response.status).toBe(409);
    expect(db.feedback).toHaveLength(0);
    expect(JSON.parse(String(db.outfits[0]?.pieces))).toContainEqual({ slot: 'shoes', id: 'sneakers-white' });
  });

  it('writes the new pieces and the reason together, and hands the outfit back', async () => {
    const id = await saveLayered();
    const response = await swapPiece(id, {
      slot: 'mid',
      toId: 'knit-cream-heavy',
      reason: 'the cardigan itches at the office',
    });

    expect(response.status).toBe(200);
    const { outfit } = await bodyOf<{ outfit: SavedOutfit }>(response);
    expect(outfit.pieces.map((piece) => piece.garment.id)).toEqual([
      'tee-white',
      'knit-cream-heavy',
      'jeans-indigo',
      'sneakers-white',
    ]);

    expect(JSON.parse(String(db.outfits[0]?.pieces))).toEqual([
      { slot: 'base', id: 'tee-white' },
      { slot: 'mid', id: 'knit-cream-heavy' },
      { slot: 'bottom', id: 'jeans-indigo' },
      { slot: 'shoes', id: 'sneakers-white' },
    ]);
    expect(db.feedback).toHaveLength(1);
    expect(db.feedback[0]).toMatchObject({
      outfit_id: id,
      slot: 'mid',
      from_id: 'cardigan-gray',
      to_id: 'knit-cream-heavy',
      reason: 'the cardigan itches at the office',
    });

    expect(outfit.corrections).toEqual([
      {
        at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        event: 'work',
        slot: 'mid',
        from: { id: 'cardigan-gray', subtype: 'cardigan' },
        to: { id: 'knit-cream-heavy', subtype: 'heavy knit sweater' },
        reason: 'the cardigan itches at the office',
      },
    ]);
  });

  it('leaves the rationale, the event and the day it was saved alone', async () => {
    const id = await saveLayered();
    const before = { ...db.outfits[0] };

    await swapPiece(id, { slot: 'mid', toId: 'blazer-navy', reason: 'sharper for a client day' });

    expect(db.outfits[0]?.rationale).toBe(before.rationale);
    expect(db.outfits[0]?.event).toBe(before.event);
    expect(db.outfits[0]?.created_at).toBe(before.created_at);
    expect(db.outfits[0]?.plan_id).toBe(before.plan_id);
  });

  it('drops a citation the swap broke, keeps one that still holds, and re-sums the warmth', async () => {
    const id = await saveLayered();
    const response = await swapPiece(id, { slot: 'mid', toId: null, reason: 'too warm indoors' });

    const { outfit } = await bodyOf<{ outfit: SavedOutfit }>(response);
    expect(outfit.cited.map((rule) => rule.id)).toEqual(['all-01']);
    expect(outfit.missed.map((rule) => rule.id)).toContain('rect-01');

    // The base alone, so the cardigan's 3 goes with it.
    expect(outfit.warmthCore).toBe(1);
    expect(db.outfits[0]?.warmth_core).toBe(1);
    expect(db.outfits[0]?.cited_rules).toBe('["all-01"]');
  });

  it('judges nothing when no body type is stored, rather than erroring', async () => {
    const id = await saveLayered();
    db.profile = null;

    const response = await swapPiece(id, { slot: 'mid', toId: null, reason: 'too warm indoors' });

    const { outfit } = await bodyOf<{ outfit: SavedOutfit }>(response);
    expect(outfit.cited).toEqual([]);
    expect(outfit.missed).toEqual([]);
    expect(outfit.warmthCore).toBe(1);
  });
});

/**
 * The whole feature is this round trip: what the Profile screen writes is what
 * `plan_outfit` reads the weather from, so the two are checked against each other.
 */
describe("an owner's request on a stored outfit", () => {
  it('comes back with the garment named from the live wardrobe', async () => {
    const db = new FakeDb();
    db.garments = WARDROBE.map((garment) => garmentRow(garment));
    await insertOutfit(
      db as unknown as D1Database,
      {
        ...OUTFIT,
        planId: 'p1',
        ownerRequest: {
          words: 'I want the beige linen shirt',
          disagreement: 'The oxford was warmer.',
          honored: [{ id: 'linen-shirt-beige', waived: ['season'] }],
        },
      },
      new Date('2026-05-10T08:00:00.000Z'),
    );

    const saved = (await readOutfits(db as unknown as D1Database, { limit: 5 })).outfits;

    expect(saved[0]?.ownerRequest).toEqual({
      words: 'I want the beige linen shirt',
      disagreement: 'The oxford was warmer.',
      honored: [{ id: 'linen-shirt-beige', subtype: 'linen shirt', waived: ['season'] }],
    });
  });

  it('is null on an outfit nobody overrode a filter for', async () => {
    const db = new FakeDb();
    db.garments = WARDROBE.map((garment) => garmentRow(garment));
    await insertOutfit(
      db as unknown as D1Database,
      { ...OUTFIT, planId: 'p1' },
      new Date('2026-05-10T08:00:00.000Z'),
    );

    const page = await readOutfits(db as unknown as D1Database, { limit: 5 });
    expect(page.outfits[0]?.ownerRequest).toBeNull();
  });
});

describe('the home location', () => {
  const HOME = { lat: -34.901112, lon: -56.164531 };

  it('reads back exactly what was written, to the digit', async () => {
    db.profile = { data: JSON.stringify(RECTANGLE) };

    await putHome(db as unknown as D1Database, HOME);

    expect(await homeLocation(db as unknown as D1Database)).toEqual(HOME);
  });

  it('reads back nothing once it is cleared', async () => {
    db.profile = { data: JSON.stringify(RECTANGLE) };
    await putHome(db as unknown as D1Database, HOME);

    await clearHome(db as unknown as D1Database);

    expect(await homeLocation(db as unknown as D1Database)).toBeNull();
  });

  it('writes nothing and throws nothing when no profile row exists yet', async () => {
    await putHome(db as unknown as D1Database, HOME);

    expect(await homeLocation(db as unknown as D1Database)).toBeNull();
  });
});

describe('the session guard', () => {
  it('covers every outfit route', async () => {
    cookie = '';
    expect((await call('http://x/api/outfits/today')).status).toBe(401);
    expect((await call('http://x/api/outfits')).status).toBe(401);
    expect((await swapPiece('o1', { slot: 'mid', toId: null, reason: 'no' })).status).toBe(401);
  });
});
