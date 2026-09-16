/**
 * The two routes the web app reads saved outfits through. Nothing saved today
 * is a normal state with a screen of its own, so it answers an empty list and
 * 200 rather than a 404 the app would have to read as a broken request.
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
import {
  clearHome,
  homeLocation,
  insertOutfit,
  putHome,
  readOutfits,
  recentTitles,
  removeOutfit,
  titleTaken,
} from '../src/worker/outfits';
import { WARDROBE, makeGarment } from './fixtures';
import { FakeDb, garmentRow } from './stubs/fake-env';

const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;
const PASSWORD = 'pw';

const OUTFIT: Omit<NewOutfit, 'planId'> = {
  event: 'errands',
  title: 'Errands without trying too hard',
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

/** Every garment `OUTFIT` wears, which is what a wear of it logs. */
const WORN_IDS = ['tee-white', 'jeans-indigo', 'sneakers-white', 'belt-brown'];

/**
 * Two torso layers, so `rect-01` holds for it and dropping the mid breaks it.
 * `all-01` holds for every outfit there is, so it is the citation that survives.
 */
const LAYERED: Omit<NewOutfit, 'planId'> = {
  event: 'work',
  title: 'A client day, layered',
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

/**
 * Three accessories, which is the shape a slot cannot name a piece in. The belt,
 * the scarf and the cap all sit in `accessory`, so only an id says which one a
 * tap meant.
 */
const ACCESSORIZED: Omit<NewOutfit, 'planId'> = {
  ...OUTFIT,
  pieces: [
    { slot: 'base', id: 'tee-white' },
    { slot: 'bottom', id: 'jeans-indigo' },
    { slot: 'shoes', id: 'sneakers-white' },
    { slot: 'accessory', id: 'belt-brown' },
    { slot: 'accessory', id: 'scarf-wool-charcoal' },
    { slot: 'accessory', id: 'cap-navy' },
  ],
};

/** Two accessories the fixture wardrobe has none of, so a swap has somewhere to land. */
const SUNGLASSES = makeGarment({
  id: 'sunglasses-black',
  slot: 'accessory',
  subtype: 'sunglasses',
  accessoryKind: 'glasses',
  colors: ['black'],
  warmth: 0,
  formality: 2,
});

const SECOND_BELT = makeGarment({
  id: 'belt-black',
  slot: 'accessory',
  subtype: 'woven belt',
  accessoryKind: 'belt',
  colors: ['black'],
  warmth: 0,
  formality: 3,
});

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

/** Everything the Today screen would draw, newest first. */
async function todayOutfits(): Promise<readonly SavedOutfit[]> {
  const body = await bodyOf<{ outfits: readonly SavedOutfit[] }>(
    await call('http://x/api/outfits/today'),
  );
  return body.outfits;
}

/** The newest of them, for a day that holds one, and a failure when it holds none. */
async function todayOutfit(): Promise<SavedOutfit> {
  const [outfit] = await todayOutfits();
  if (outfit === undefined) throw new Error('nothing is saved for today');
  return outfit;
}

async function saveLayered(): Promise<string> {
  db.profile = { data: JSON.stringify(RECTANGLE) };
  return insertOutfit(db as unknown as D1Database, { ...LAYERED, planId: 'p1' }, new Date());
}

async function wear(entry: unknown): Promise<Response> {
  return call('http://x/api/wear', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(entry),
  });
}

async function editPiece(id: string, edit: unknown): Promise<Response> {
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
  it('answers 200 and an empty list when nothing was saved today', async () => {
    const response = await call('http://x/api/outfits/today');

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ outfits: [] });
  });

  it('still answers an empty list when the only saved outfit is from another day', async () => {
    await save('p1', new Date(Date.now() - 2 * MS_PER_DAY));

    expect(await todayOutfits()).toEqual([]);
  });

  it('hands back every outfit saved today, newest first', async () => {
    const older = await save('p1', new Date(Date.now() - 2 * MS_PER_MINUTE));
    const middle = await save('p1', new Date(Date.now() - MS_PER_MINUTE));
    const newest = await save('p1', new Date());

    expect((await todayOutfits()).map((outfit) => outfit.id)).toEqual([newest, middle, older]);
  });

  /**
   * The one thing that says two cards are two answers to one request. Without it
   * the app has no way to draw them as a set instead of as unrelated outfits.
   */
  it('carries the plan each outfit was composed against', async () => {
    await save('p1', new Date(Date.now() - 2 * MS_PER_MINUTE));
    await save('p1', new Date(Date.now() - MS_PER_MINUTE));
    await save('p2', new Date());

    expect((await todayOutfits()).map((outfit) => outfit.planId)).toEqual(['p2', 'p1', 'p1']);
  });

  /**
   * A row dated ahead of the clock. The lower bound alone would leave it on
   * Today every day after, which the old limit of one was hiding rather than
   * preventing.
   */
  it('leaves out an outfit dated tomorrow', async () => {
    await save('p1', new Date(Date.now() + MS_PER_DAY));
    const today = await save('p1', new Date());

    expect((await todayOutfits()).map((outfit) => outfit.id)).toEqual([today]);
  });

  it('hydrates the garment rows so the app can render the photos', async () => {
    const id = await save('p1', new Date());

    const outfit = await todayOutfit();

    expect(outfit.id).toBe(id);
    expect(outfit.pieces.map((piece) => piece.slot)).toEqual(['base', 'bottom', 'shoes']);
    expect(outfit.pieces[0]?.garment.subtype).toBe('cotton t-shirt');
    expect(outfit.accessories.map((garment) => garment.id)).toEqual(['belt-brown']);
    expect(outfit.cited).toEqual([
      { id: 'rect-01', short: 'Layers or a V-neckline', because: expect.stringContaining('V-necks') },
    ]);
    expect(outfit.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(outfit.worn).toBe(false);
  });

  it('reads as worn once the wear log holds every garment for that day', async () => {
    await save('p1', new Date());

    expect((await todayOutfit()).worn).toBe(false);

    await wear({ garmentIds: WORN_IDS });

    expect((await todayOutfit()).worn).toBe(true);
  });

  it('stays unworn while any one of its garments is missing from the log', async () => {
    await save('p1', new Date());

    await wear({ garmentIds: ['tee-white', 'jeans-indigo', 'sneakers-white'] });

    expect((await todayOutfit()).worn).toBe(false);
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

    const outfit = await todayOutfit();

    expect(outfit.pieces.map((piece) => piece.slot)).toEqual(['base', 'shoes']);
    expect(outfit.rationale).toBe(OUTFIT.rationale);
  });

  it('still reads as worn when an archived garment was logged before it went', async () => {
    await save('p1', new Date());
    await wear({ garmentIds: WORN_IDS });
    db.garments = db.garments.map((row) =>
      row.id === 'jeans-indigo' ? { ...row, archived: 1 } : row,
    );

    expect((await todayOutfit()).worn).toBe(true);
  });
});

/**
 * A day can hold an outfit for the day, one for the afternoon and one for a
 * night out, and every one of them wears much the same clothes. The row that
 * names an outfit is the only thing that can tell them apart.
 */
describe('a wear that names the outfit it was', () => {
  it('marks that outfit worn on the row alone', async () => {
    const id = await save('p1', new Date());

    // One garment of the four, so the day and the garments could never call this
    // outfit worn. What the row names is the whole of the reading.
    await wear({ garmentIds: ['tee-white'], outfitId: id });

    expect((await todayOutfit()).worn).toBe(true);
  });

  it('leaves the other outfit of that day unworn, wearing the same clothes or not', async () => {
    const morning = await save('p1', new Date());
    const afternoon = await save('p2', new Date());

    await wear({ garmentIds: WORN_IDS, outfitId: afternoon });

    const saved = (await readOutfits(db as unknown as D1Database, { limit: 5 })).outfits;
    expect(saved.find((outfit) => outfit.id === afternoon)?.worn).toBe(true);
    expect(saved.find((outfit) => outfit.id === morning)?.worn).toBe(false);
  });

  it('still reads a row that names no outfit off the day and the garments', async () => {
    await save('p1', new Date());
    // A row from before the column existed, which is the shape of every wear
    // this app logged until now.
    db.wear.unshift({
      worn_on: new Date().toISOString().slice(0, 10),
      garment_ids: JSON.stringify(WORN_IDS),
      event: null,
    });

    expect((await todayOutfit()).worn).toBe(true);
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
    expect((await editPiece('nope', { fromId: 'cardigan-gray', toId: null, reason: 'too warm' })).status).toBe(404);
  });

  it('refuses to empty a slot every outfit needs', async () => {
    const id = await saveLayered();
    const response = await editPiece(id, { fromId: 'sneakers-white', toId: null, reason: 'barefoot day' });

    expect(response.status).toBe(400);
    expect((await bodyOf<{ error: string }>(response)).error).toContain('cannot be left empty');
    expect(db.feedback).toHaveLength(0);
  });

  it('refuses a garment that lives in another slot, and says what it is', async () => {
    const id = await saveLayered();
    const response = await editPiece(id, { fromId: 'cardigan-gray', toId: 'loafers-brown', reason: 'nicer' });

    expect(response.status).toBe(400);
    expect((await bodyOf<{ error: string }>(response)).error).toContain('is a shoes, not a mid');
    expect(db.feedback).toHaveLength(0);
  });

  it('refuses a garment this wardrobe does not have', async () => {
    const id = await saveLayered();
    const response = await editPiece(id, { fromId: 'cardigan-gray', toId: 'not-a-garment', reason: 'nicer' });

    expect(response.status).toBe(400);
    expect((await bodyOf<{ error: string }>(response)).error).toContain('not in your wardrobe');
  });

  it('refuses a garment the outfit is not wearing', async () => {
    const id = await saveLayered();
    const response = await editPiece(id, { fromId: 'puffer-navy', toId: 'trench-navy', reason: 'colder now' });

    expect(response.status).toBe(400);
    expect((await bodyOf<{ error: string }>(response)).error).toContain('not in this outfit');
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

    const response = await editPiece(id, { fromId: 'cardigan-gray', toId: 'blazer-navy', reason: 'too casual' });
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

    const response = await editPiece(id, { fromId: 'cardigan-gray', toId: 'blazer-navy', reason: 'too casual' });

    expect((await bodyOf<{ outfit: SavedOutfit }>(response)).outfit.ownerRequest).toBeNull();
  });

  it('refuses a reason that is only blank space', async () => {
    const id = await saveLayered();
    expect((await editPiece(id, { fromId: 'cardigan-gray', toId: 'blazer-navy', reason: '   ' })).status).toBe(400);
  });

  /** `wasWorn` reads the stored ids, so a swap would turn a worn outfit back into an unworn one. */
  it('answers 409 once the outfit is logged as worn', async () => {
    const id = await save('p1', new Date());
    await wear({ garmentIds: WORN_IDS });

    const response = await editPiece(id, { fromId: 'sneakers-white', toId: 'loafers-brown', reason: 'wrong shoes' });

    expect(response.status).toBe(409);
    expect(db.feedback).toHaveLength(0);
    expect(JSON.parse(String(db.outfits[0]?.pieces))).toContainEqual({ slot: 'shoes', id: 'sneakers-white' });
  });

  it('writes the new pieces and the reason together, and hands the outfit back', async () => {
    const id = await saveLayered();
    const response = await editPiece(id, {
      fromId: 'cardigan-gray',
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
        alongside: [
          { slot: 'base', subtype: 'cotton t-shirt' },
          { slot: 'bottom', subtype: 'jeans' },
          { slot: 'shoes', subtype: 'leather sneakers' },
        ],
      },
    ]);
  });

  it('leaves the rationale, the event and the day it was saved alone', async () => {
    const id = await saveLayered();
    const before = { ...db.outfits[0] };

    await editPiece(id, { fromId: 'cardigan-gray', toId: 'blazer-navy', reason: 'sharper for a client day' });

    expect(db.outfits[0]?.rationale).toBe(before.rationale);
    expect(db.outfits[0]?.event).toBe(before.event);
    expect(db.outfits[0]?.created_at).toBe(before.created_at);
    expect(db.outfits[0]?.plan_id).toBe(before.plan_id);
  });

  it('drops a citation the swap broke, keeps one that still holds, and re-sums the warmth', async () => {
    const id = await saveLayered();
    const response = await editPiece(id, { fromId: 'cardigan-gray', toId: null, reason: 'too warm indoors' });

    const { outfit } = await bodyOf<{ outfit: SavedOutfit }>(response);
    expect(outfit.cited.map((rule) => rule.id)).toEqual(['all-01']);
    expect(outfit.missed.map((rule) => rule.id)).toContain('rect-01');

    // The base alone, so the cardigan's 3 goes with it.
    expect(outfit.warmthCore).toBe(1);
    expect(db.outfits[0]?.warmth_core).toBe(1);
    expect(db.outfits[0]?.cited_rules).toBe('["all-01"]');
  });

  /**
   * The whole of backlog item 3: an outfit wears as many accessories as the
   * owner likes, so naming the piece by its slot picked whichever one happened
   * to be stored first and the other two could not be reached at all.
   */
  it('changes the accessory it was handed and leaves the others alone', async () => {
    db.profile = { data: JSON.stringify(RECTANGLE) };
    db.garments = [...db.garments, garmentRow(SUNGLASSES)];
    const id = await insertOutfit(
      db as unknown as D1Database,
      { ...ACCESSORIZED, planId: 'p1' },
      new Date(),
    );

    const response = await editPiece(id, {
      fromId: 'cap-navy',
      toId: 'sunglasses-black',
      reason: 'the cap does not go with the scarf',
    });

    expect(response.status).toBe(200);
    const { outfit } = await bodyOf<{ outfit: SavedOutfit }>(response);
    expect(outfit.accessories.map((garment) => garment.id)).toEqual([
      'belt-brown',
      'scarf-wool-charcoal',
      'sunglasses-black',
    ]);
    expect(db.feedback[0]).toMatchObject({
      slot: 'accessory',
      from_id: 'cap-navy',
      to_id: 'sunglasses-black',
    });
    // The rules were judged, not skipped. `recheck` hands back two empty lists
    // when it has no body type, which is what this test would silently get if
    // the profile above went missing.
    expect(outfit.missed.length + outfit.broke.length).toBeGreaterThan(0);
  });

  /**
   * `certify` refuses this at save time, so a swap that recorded it as a miss
   * would let a hand change reach a state no composed outfit is allowed to.
   */
  it('refuses a swap that would put two of a kind the body has one place for', async () => {
    db.profile = { data: JSON.stringify(RECTANGLE) };
    db.garments = [...db.garments, garmentRow(SECOND_BELT)];
    const id = await insertOutfit(
      db as unknown as D1Database,
      { ...ACCESSORIZED, planId: 'p1' },
      new Date(),
    );

    const response = await editPiece(id, {
      fromId: 'cap-navy',
      toId: 'belt-black',
      reason: 'the woven one is better',
    });

    expect(response.status).toBe(400);
    expect((await bodyOf<{ error: string }>(response)).error).toContain('second belt');
    expect(db.feedback).toHaveLength(0);
    expect(JSON.parse(String(db.outfits[0]?.pieces))).toContainEqual({
      slot: 'accessory',
      id: 'cap-navy',
    });
  });

  /**
   * The guard reads the garment coming in and not the outfit as a whole, which
   * is the difference between refusing a change and locking the owner out of an
   * outfit. Retagging a hat as a belt is enough to reach a saved outfit already
   * wearing two, and a guard on the whole outfit would then refuse every swap on
   * it, naming a belt while the owner was changing their shoes.
   */
  it('lets an outfit already wearing two of a kind be changed somewhere else', async () => {
    db.profile = { data: JSON.stringify(RECTANGLE) };
    db.garments = [...db.garments, garmentRow(SECOND_BELT)];
    const id = await insertOutfit(
      db as unknown as D1Database,
      {
        ...ACCESSORIZED,
        pieces: [...ACCESSORIZED.pieces, { slot: 'accessory', id: 'belt-black' }],
        planId: 'p1',
      },
      new Date(),
    );

    const response = await editPiece(id, {
      fromId: 'sneakers-white',
      toId: 'loafers-brown',
      reason: 'smarter for the evening',
    });

    expect(response.status).toBe(200);
    const { outfit } = await bodyOf<{ outfit: SavedOutfit }>(response);
    expect(outfit.pieces.find((piece) => piece.slot === 'shoes')?.garment.id).toBe('loafers-brown');
    expect(outfit.accessories.map((garment) => garment.id)).toContain('belt-black');
  });

  it('reads a dont the swap broke apart from the preferences it set aside', async () => {
    const id = await saveLayered();

    const response = await editPiece(id, {
      fromId: 'cardigan-gray',
      toId: 'knit-cream-heavy',
      reason: 'the office is freezing',
    });

    const { outfit } = await bodyOf<{ outfit: SavedOutfit }>(response);
    // The oversized knit is the layer on show, which rect-06b requires it not be.
    expect(outfit.broke.map((rule) => rule.id)).toContain('rect-06b');
    expect(outfit.missed.map((rule) => rule.id)).not.toContain('rect-06b');
  });

  it('judges nothing when no body type is stored, rather than erroring', async () => {
    const id = await saveLayered();
    db.profile = null;

    const response = await editPiece(id, { fromId: 'cardigan-gray', toId: null, reason: 'too warm indoors' });

    const { outfit } = await bodyOf<{ outfit: SavedOutfit }>(response);
    expect(outfit.cited).toEqual([]);
    expect(outfit.missed).toEqual([]);
    expect(outfit.warmthCore).toBe(1);
  });

  /**
   * The second half of what the owner asked for. A slot the outfit never had
   * has no garment to name, so the add is the one edit that sends no `fromId`.
   */
  describe('adding a piece the outfit never had', () => {
    it('writes the new piece at its place in the order, not at the end', async () => {
      const id = await saveLayered();
      const response = await editPiece(id, {
        fromId: null,
        toId: 'trench-navy',
        reason: 'it turned cold after lunch',
      });

      expect(response.status).toBe(200);
      const { outfit } = await bodyOf<{ outfit: SavedOutfit }>(response);
      expect(outfit.pieces.map((piece) => piece.garment.id)).toEqual([
        'tee-white',
        'cardigan-gray',
        'trench-navy',
        'jeans-indigo',
        'sneakers-white',
      ]);

      // `past_outfits` reads the stored array as it stands and sorts nothing, so
      // the outer has to be stored between the mid and the bottom and not after
      // the shoes.
      expect(JSON.parse(String(db.outfits[0]?.pieces))).toEqual([
        { slot: 'base', id: 'tee-white' },
        { slot: 'mid', id: 'cardigan-gray' },
        { slot: 'outer', id: 'trench-navy' },
        { slot: 'bottom', id: 'jeans-indigo' },
        { slot: 'shoes', id: 'sneakers-white' },
      ]);
    });

    it('records the reason with no garment going out', async () => {
      const id = await saveLayered();
      const response = await editPiece(id, {
        fromId: null,
        toId: 'trench-navy',
        reason: 'it turned cold after lunch',
      });

      expect(db.feedback).toHaveLength(1);
      expect(db.feedback[0]).toMatchObject({
        outfit_id: id,
        slot: 'outer',
        from_id: null,
        to_id: 'trench-navy',
        reason: 'it turned cold after lunch',
      });

      const { outfit } = await bodyOf<{ outfit: SavedOutfit }>(response);
      expect(outfit.corrections[0]).toMatchObject({
        slot: 'outer',
        from: null,
        to: { id: 'trench-navy', subtype: 'trench coat' },
        reason: 'it turned cold after lunch',
      });
    });

    it('adds a second accessory, because accessories are a list and are never full', async () => {
      db.profile = { data: JSON.stringify(RECTANGLE) };
      db.garments = [...db.garments, garmentRow(SUNGLASSES)];
      const id = await insertOutfit(
        db as unknown as D1Database,
        { ...ACCESSORIZED, planId: 'p1' },
        new Date(),
      );

      const response = await editPiece(id, {
        fromId: null,
        toId: 'sunglasses-black',
        reason: 'the sun is in my eyes all afternoon',
      });

      expect(response.status).toBe(200);
      const { outfit } = await bodyOf<{ outfit: SavedOutfit }>(response);
      expect(outfit.accessories.map((garment) => garment.id)).toEqual([
        'belt-brown',
        'scarf-wool-charcoal',
        'cap-navy',
        'sunglasses-black',
      ]);
    });

    /**
     * The one refusal that keeps a second row for one clothing slot out of
     * storage. Two of them round-trip and then collapse out of the warmth sum
     * with nothing reporting it.
     */
    it('refuses a clothing slot the outfit already fills, and names what fills it', async () => {
      const id = await saveLayered();
      const response = await editPiece(id, {
        fromId: null,
        toId: 'blazer-navy',
        reason: 'sharper',
      });

      expect(response.status).toBe(400);
      expect((await bodyOf<{ error: string }>(response)).error).toBe(
        'The mid is already the cardigan in this outfit.',
      );
      expect(db.feedback).toHaveLength(0);
      expect(JSON.parse(String(db.outfits[0]?.pieces))).toHaveLength(4);
    });

    it('refuses a garment this wardrobe does not have', async () => {
      const id = await saveLayered();
      const response = await editPiece(id, {
        fromId: null,
        toId: 'not-a-garment',
        reason: 'it turned cold',
      });

      expect(response.status).toBe(400);
      expect((await bodyOf<{ error: string }>(response)).error).toContain('not in your wardrobe');
      expect(db.feedback).toHaveLength(0);
    });

    it('refuses an accessory the outfit is already wearing', async () => {
      db.profile = { data: JSON.stringify(RECTANGLE) };
      const id = await insertOutfit(
        db as unknown as D1Database,
        { ...ACCESSORIZED, planId: 'p1' },
        new Date(),
      );

      const response = await editPiece(id, {
        fromId: null,
        toId: 'belt-brown',
        reason: 'it needs a belt',
      });

      expect(response.status).toBe(400);
      expect((await bodyOf<{ error: string }>(response)).error).toBe(
        'The leather belt is already in this outfit.',
      );
      expect(db.feedback).toHaveLength(0);
    });

    it('refuses a second of a kind the body has one place for', async () => {
      db.profile = { data: JSON.stringify(RECTANGLE) };
      db.garments = [...db.garments, garmentRow(SECOND_BELT)];
      const id = await insertOutfit(
        db as unknown as D1Database,
        { ...ACCESSORIZED, planId: 'p1' },
        new Date(),
      );

      const response = await editPiece(id, {
        fromId: null,
        toId: 'belt-black',
        reason: 'the woven one is better',
      });

      expect(response.status).toBe(400);
      expect((await bodyOf<{ error: string }>(response)).error).toContain('second belt');
      expect(db.feedback).toHaveLength(0);
    });

    it('answers 409 once the outfit is logged as worn', async () => {
      const id = await save('p1', new Date());
      await wear({ garmentIds: WORN_IDS });

      const response = await editPiece(id, {
        fromId: null,
        toId: 'cardigan-gray',
        reason: 'it was colder than this says',
      });

      expect(response.status).toBe(409);
      expect(db.feedback).toHaveLength(0);
      expect(JSON.parse(String(db.outfits[0]?.pieces))).toHaveLength(4);
    });

    /**
     * On purpose, and the one thing about the add that is easy to read as a bug
     * later. A layer arriving re-aims several book rules, so an outfit that
     * broke nothing can gain a broken one. The card says so and nothing is
     * refused, because refusing would be the app telling the owner he cannot
     * put his own jacket on.
     */
    it('lands even when the piece arriving breaks a dont, and says it broke one', async () => {
      db.profile = { data: JSON.stringify(RECTANGLE) };
      const id = await save('p1', new Date());
      const response = await editPiece(id, {
        fromId: null,
        toId: 'knit-cream-heavy',
        reason: 'the office is freezing',
      });

      expect(response.status).toBe(200);
      const { outfit } = await bodyOf<{ outfit: SavedOutfit }>(response);
      expect(outfit.broke.map((rule) => rule.id)).toContain('rect-06b');
    });

    it('refuses a body that names neither garment', async () => {
      const id = await saveLayered();
      expect((await editPiece(id, { fromId: null, toId: null, reason: 'nothing' })).status).toBe(400);
      expect(db.feedback).toHaveLength(0);
    });
  });
});

/**
 * `missed_rules` is one column and holds both severities, because `recheck`
 * recomputes the whole list after a hand swap. Which of the two a rule is stays
 * in the book, so the reader is the only place the column is split.
 */
describe('DELETE /api/outfits/:id', () => {
  async function remove(id: string): Promise<Response> {
    return call(`http://x/api/outfits/${id}`, { method: 'DELETE' });
  }

  it('answers ok, and the outfit is gone', async () => {
    const id = await save('p1', new Date());

    const response = await remove(id);

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ ok: true });
    expect(db.outfits).toHaveLength(0);
  });

  it('answers 404 for an outfit that is not there, the way the garment route does', async () => {
    const response = await remove('never-saved');

    expect(response.status).toBe(404);
    expect(await bodyOf(response)).toEqual({ error: 'not found' });
  });

  /** The one case the swap answers 409 to, because here the wear goes with it. */
  it('removes an outfit logged as worn', async () => {
    const id = await save('p1', new Date());
    await wear({ garmentIds: WORN_IDS, outfitId: id });

    expect((await remove(id)).status).toBe(200);
    expect(db.wear).toHaveLength(0);
  });
});

describe('removing an outfit', () => {
  async function remove(id: string): Promise<boolean> {
    return removeOutfit(db as unknown as D1Database, id);
  }

  it('takes the outfit and the wear that named it', async () => {
    const id = await save('p1', new Date());
    await wear({ garmentIds: WORN_IDS, outfitId: id });

    expect(await remove(id)).toBe(true);

    expect(db.outfits).toHaveLength(0);
    expect(db.wear).toHaveLength(0);
  });

  it('leaves the wear of the other outfit worn that day', async () => {
    const morning = await save('p1', new Date());
    const afternoon = await save('p2', new Date());
    await wear({ garmentIds: WORN_IDS, outfitId: morning });
    await wear({ garmentIds: WORN_IDS, outfitId: afternoon });

    await remove(afternoon);

    expect(db.outfits.map((row) => row.id)).toEqual([morning]);
    expect(db.wear.map((row) => row.outfit_id)).toEqual([morning]);
  });

  it('leaves a wear that names no outfit, because reading it off the day is a guess', async () => {
    const id = await save('p1', new Date());
    await wear({ garmentIds: WORN_IDS });

    await remove(id);

    expect(db.wear).toHaveLength(1);
    expect(db.wear[0]?.outfit_id).toBeNull();
  });

  it('leaves the cooldown standing when worn came off the day rather than the id', async () => {
    const id = await save('p1', new Date());
    await wear({ garmentIds: WORN_IDS });

    // True through the fallback, which is what every row saved before migration
    // 009 reads as, so this is the common case on the day the column ships and
    // not a corner of it.
    const before = (await readOutfits(db as unknown as D1Database, { limit: 5 })).outfits[0];
    expect(before?.worn).toBe(true);
    // The pair the card reads apart. Telling the owner the cooldown goes off
    // `worn` would be false here, which is why the control is told on this.
    expect(before?.wearNamed).toBe(false);

    await remove(id);

    expect(db.wear).toHaveLength(1);
  });

  it('keeps the corrections, which are the only record of what the owner refused', async () => {
    const id = await saveLayered();
    await editPiece(id, { fromId: 'cardigan-gray', toId: null, reason: 'too warm indoors' });

    await remove(id);

    expect(db.outfits).toHaveLength(0);
    expect(db.feedback).toHaveLength(1);
  });

  it('answers false for an outfit that was never there, and touches nothing', async () => {
    const id = await save('p1', new Date());

    expect(await remove('never-saved')).toBe(false);

    expect(db.outfits).toHaveLength(1);
    expect(db.outfits[0]?.id).toBe(id);
  });
});

describe('the rules a stored outfit missed', () => {
  it('reads a dont as broken and a preference as set aside', async () => {
    db.profile = { data: JSON.stringify(RECTANGLE) };
    const id = await insertOutfit(
      db as unknown as D1Database,
      { ...OUTFIT, planId: 'p1', missedRules: ['rect-02', 'rect-04', 'rect-06b'] },
      new Date(),
    );

    const outfit = await todayOutfit();

    expect(outfit.id).toBe(id);
    // rect-02 asks for structured fabric this wardrobe has none of in a slot
    // every outfit fills, so the preference half still drops it as a gap.
    expect(outfit.missed.map((rule) => rule.id)).toEqual(['rect-04']);
    expect(outfit.broke.map((rule) => rule.id)).toEqual(['rect-06b']);
  });

  it('leaves both lists empty for an outfit that missed nothing', async () => {
    db.profile = { data: JSON.stringify(RECTANGLE) };
    await insertOutfit(
      db as unknown as D1Database,
      { ...OUTFIT, planId: 'p1', missedRules: [] },
      new Date(),
    );

    const outfit = await todayOutfit();

    expect(outfit.missed).toEqual([]);
    expect(outfit.broke).toEqual([]);
  });
});

describe('the photo version on a stored outfit', () => {
  /**
   * `/img/:kind/:id` answers `immutable` and an edited cutout rewrites the same
   * key, so the version in the URL is the only thing that changes when the owner
   * fixes a photo by hand. A piece that reaches the card without one points at a
   * URL the phone already holds, and the card draws the photo from before the
   * edit for as long as that cache lives.
   */
  it('carries the version onto every piece and accessory, so an edited cutout reaches the card', async () => {
    const db = new FakeDb();
    db.garments = WARDROBE.map((garment) =>
      garmentRow(garment, { photoVersion: garment.id === 'tee-white' ? 3 : 0 }),
    );
    await insertOutfit(
      db as unknown as D1Database,
      { ...OUTFIT, planId: 'p1' },
      new Date('2026-05-10T08:00:00.000Z'),
    );

    const page = await readOutfits(db as unknown as D1Database, { limit: 5 });
    const outfit = page.outfits[0];

    const edited = outfit?.pieces.find((piece) => piece.garment.id === 'tee-white');
    expect(edited?.garment.photoVersion).toBe(3);
    for (const piece of outfit?.pieces ?? []) {
      expect(piece.garment.photoVersion).toBeTypeOf('number');
    }
    // The accessories are drawn from the same payload and were the other half of
    // the miss, so they are asserted rather than assumed.
    for (const garment of outfit?.accessories ?? []) {
      expect(garment.photoVersion).toBeTypeOf('number');
    }
  });
});

describe('the title on a stored outfit', () => {
  it('reads back the words it was saved under', async () => {
    const db = new FakeDb();
    db.garments = WARDROBE.map((garment) => garmentRow(garment));
    await insertOutfit(
      db as unknown as D1Database,
      { ...OUTFIT, planId: 'p1' },
      new Date('2026-05-10T08:00:00.000Z'),
    );

    expect(db.outfits[0]?.title).toBe('Errands without trying too hard');

    const page = await readOutfits(db as unknown as D1Database, { limit: 5 });
    expect(page.outfits[0]?.title).toBe('Errands without trying too hard');
  });

  it('is null on a row stored before the column existed', async () => {
    const db = new FakeDb();
    db.garments = WARDROBE.map((garment) => garmentRow(garment));
    await insertOutfit(
      db as unknown as D1Database,
      { ...OUTFIT, planId: 'p1' },
      new Date('2026-05-10T08:00:00.000Z'),
    );
    // What the migration leaves on every outfit that was stored before it ran.
    db.outfits = db.outfits.map((row) => ({ ...row, title: null }));

    const page = await readOutfits(db as unknown as D1Database, { limit: 5 });
    expect(page.outfits[0]?.title).toBeNull();
  });
});

describe('the names already taken', () => {
  async function saveTitled(title: string, savedAt: string): Promise<void> {
    await insertOutfit(db as unknown as D1Database, { ...OUTFIT, planId: 'p1', title }, new Date(savedAt));
  }

  it('reads the names back newest first, each with the day it was used', async () => {
    await saveTitled('A mild morning', '2026-05-10T08:00:00.000Z');
    await saveTitled('A client day, layered', '2026-05-12T08:00:00.000Z');

    expect(await recentTitles(db as unknown as D1Database, 10)).toEqual([
      { title: 'A client day, layered', createdAt: '2026-05-12T08:00:00.000Z' },
      { title: 'A mild morning', createdAt: '2026-05-10T08:00:00.000Z' },
    ]);
  });

  it('passes over an outfit with no name and one whose name is only spaces', async () => {
    await saveTitled('A mild morning', '2026-05-10T08:00:00.000Z');
    await saveTitled('   ', '2026-05-11T08:00:00.000Z');
    await saveTitled('A client day, layered', '2026-05-12T08:00:00.000Z');
    // What the migration leaves on every outfit that was stored before it ran.
    db.outfits = db.outfits.map((row) =>
      row.title === 'A client day, layered' ? { ...row, title: null } : row,
    );

    const titles = await recentTitles(db as unknown as D1Database, 10);

    expect(titles.map((used) => used.title)).toEqual(['A mild morning']);
  });

  it('never reads past the limit it was given', async () => {
    await saveTitled('A mild morning', '2026-05-10T08:00:00.000Z');
    await saveTitled('A client day, layered', '2026-05-11T08:00:00.000Z');
    await saveTitled('Errands and nothing else', '2026-05-12T08:00:00.000Z');

    const titles = await recentTitles(db as unknown as D1Database, 2);

    expect(titles.map((used) => used.title)).toEqual(['Errands and nothing else', 'A client day, layered']);
  });

  it('finds a name whatever its capitals and the spaces around it', async () => {
    await saveTitled('Chill para unas birras', '2026-05-10T08:00:00.000Z');

    expect(await titleTaken(db as unknown as D1Database, '  chill PARA unas birras ')).toBe(
      '2026-05-10T08:00:00.000Z',
    );
  });

  it('hands back the newest day when the same name was used twice', async () => {
    await saveTitled('Chill para unas birras', '2026-05-10T08:00:00.000Z');
    await saveTitled('Chill para unas birras', '2026-05-12T08:00:00.000Z');

    expect(await titleTaken(db as unknown as D1Database, 'Chill para unas birras')).toBe(
      '2026-05-12T08:00:00.000Z',
    );
  });

  it('says nothing is taken for a name nobody has used', async () => {
    await saveTitled('Chill para unas birras', '2026-05-10T08:00:00.000Z');

    expect(await titleTaken(db as unknown as D1Database, 'A client day, layered')).toBeNull();
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
    expect((await editPiece('o1', { fromId: 'cardigan-gray', toId: null, reason: 'no' })).status).toBe(401);
    expect((await call('http://x/api/outfits/o1', { method: 'DELETE' })).status).toBe(401);
  });
});
