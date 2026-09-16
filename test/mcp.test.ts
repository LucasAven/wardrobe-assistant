/**
 * The seven connector tools, driven without a transport: every tool is parsed and
 * run the way `tools/call` would run it, and nothing here opens a socket.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { parseMock } = vi.hoisted(() => ({ parseMock: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    public messages = { parse: parseMock };
    constructor(public readonly options: unknown) {}
  },
}));

import type { CallToolResult } from '@modelcontextprotocol/server';
import type { BodyProfile } from '../src/domain/types';
import type { Env } from '../src/worker/env';
import { wardrobeTools } from '../src/worker/mcp/tools';
import { MAX_OUTFITS } from '../src/worker/outfits';
import type { ToolSpec } from '../src/worker/mcp/tools';
import { AUTUMN_DAY, WARDROBE, makeGarment } from './fixtures';
import { FAKE_IMAGES, FAKE_PHOTOS, FakeDb, FakeKv, garmentRow } from './stubs/fake-env';

const RECTANGLE: BodyProfile = {
  shouldersVsHips: 'equal',
  waistIsWidest: false,
  volume: 'even',
  line: 'straight',
  thinLegs: false,
  bodyType: 'rectangle',
  language: 'en',
};

const TRIANGLE: BodyProfile = { ...RECTANGLE, bodyType: 'triangle', language: 'es' };

/**
 * Mild autumn errands. The bands this lands on are core 2 to 6 and total 4 to 8,
 * which is what makes the outfits below pass or fail the way they do.
 */
const MOMENT = {
  event: 'errands',
  timeOfDay: 'morning',
  hoursOutdoors: 2,
  weather: { tempC: 16, feelsLikeC: 15 },
} as const;

/** Core warmth 6 and no outer layer, so both bands are satisfied. */
const GOOD_PIECES = {
  base: 'tee-white',
  top: 'oxford-blue',
  mid: 'cardigan-gray',
  bottom: 'jeans-indigo',
  shoes: 'sneakers-white',
};

let db: FakeDb;
let kv: FakeKv;
let tools: ReadonlyMap<string, ToolSpec>;

function env(): Env {
  return { DB: db, OAUTH_KV: kv, PHOTOS: FAKE_PHOTOS, IMAGES: FAKE_IMAGES } as unknown as Env;
}

function tool(name: string): ToolSpec {
  const found = tools.get(name);
  if (found === undefined) throw new Error(`no tool named ${name}`);
  return found;
}

function textOf(result: CallToolResult): string {
  return (result.content ?? [])
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n');
}

function build(profile: BodyProfile | null): void {
  db = new FakeDb();
  kv = new FakeKv();
  if (profile !== null) db.profile = { data: JSON.stringify(profile) };
  db.garments = WARDROBE.map((garment) => garmentRow(garment));
  tools = new Map(
    wardrobeTools({
      env: env(),
      userId: 'owner',
      origin: 'https://wardrobe.example',
      now: () => AUTUMN_DAY,
    }).map((spec) => [spec.name, spec]),
  );
}

/** One correction the owner made, straight into the table `plan_outfit` reads. */
function corrected(row: Record<string, unknown>): void {
  db.outfits = [
    {
      id: 'o1',
      event: 'work',
      // The outfit the corrected piece was standing in. A reason like "too many
      // layers" names no layers without it.
      pieces: JSON.stringify([
        { slot: 'base', id: 'tee-white' },
        { slot: 'bottom', id: 'jeans-indigo' },
        { slot: 'shoes', id: 'sneakers-white' },
      ]),
    },
  ];
  db.feedback.push({ outfit_id: 'o1', created_at: '2026-05-10T07:30:00.000Z', ...row });
}

async function plan(args: Record<string, unknown> = {}): Promise<string> {
  const result = await tool('plan_outfit').call({ ...MOMENT, ...args });
  const planId = /PLAN (\S+)/.exec(textOf(result))?.[1];
  if (planId === undefined) throw new Error(`no planId in:\n${textOf(result)}`);
  return planId;
}

beforeEach(() => {
  parseMock.mockReset();
  build(RECTANGLE);
});

describe('the tool surface', () => {
  it('exposes exactly the seven tools the design names, each with a real description', () => {
    expect([...tools.keys()]).toEqual([
      'wardrobe_status',
      'next_untagged',
      'set_garment_tags',
      'plan_outfit',
      'save_outfit',
      'past_outfits',
      'log_wear',
    ]);
    for (const spec of tools.values()) {
      expect(spec.description.length).toBeGreaterThan(200);
    }
  });
});

describe('argument schemas', () => {
  const valid: Readonly<Record<string, unknown>> = {
    wardrobe_status: {},
    next_untagged: {},
    set_garment_tags: { id: 'tee-white', tags: { warmth: 3, slot: 'base' } },
    plan_outfit: MOMENT,
    save_outfit: {
      planId: 'p1',
      pieces: GOOD_PIECES,
      title: 'A mild morning',
      rationale: 'Layered for a mild morning.',
      citedRules: ['rect-01'],
    },
    past_outfits: { limit: 3, from: '2026-09-01', to: '2026-09-11' },
    log_wear: { garmentIds: ['tee-white'] },
  };

  const malformed: Readonly<Record<string, unknown>> = {
    wardrobe_status: { unexpected: 1, id: 5 },
    next_untagged: { id: 5 },
    set_garment_tags: { id: 'tee-white', tags: { warmth: 9 } },
    plan_outfit: { ...MOMENT, event: 'brunch' },
    save_outfit: {
      planId: 'p1',
      pieces: { base: 'tee-white' },
      title: 'x',
      rationale: 'x',
      citedRules: ['rect-01'],
    },
    past_outfits: { from: 'last friday' },
    log_wear: { garmentIds: [] },
  };

  for (const name of Object.keys(valid)) {
    it(`${name} accepts a valid call`, () => {
      expect(tool(name).inputSchema.safeParse(valid[name]).success).toBe(true);
    });
  }

  // wardrobe_status and next_untagged take nothing, and zod drops unknown keys
  // rather than refusing them, so those two are only checked above.
  for (const name of ['set_garment_tags', 'plan_outfit', 'save_outfit', 'log_wear']) {
    it(`${name} refuses a malformed call`, async () => {
      expect(tool(name).inputSchema.safeParse(malformed[name]).success).toBe(false);

      const result = await tool(name).call(malformed[name]);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('cannot read');
    });
  }
});

describe('wardrobe_status', () => {
  it('counts the wardrobe, the untagged rows and the profile', async () => {
    db.garments = [
      garmentRow(WARDROBE[0]!, { reviewed: true }),
      garmentRow(WARDROBE[1]!, { untagged: true }),
      garmentRow(WARDROBE[2]!, { reviewed: false, uncertain: ['warmth'] }),
    ];
    const text = textOf(await tool('wardrobe_status').call({}));

    expect(text).toContain('Wardrobe: 3 garments');
    expect(text).toContain('Untagged: 1');
    expect(text).toContain('Waiting for the owner: 1');
    expect(text).toContain('Body type rectangle');
    expect(text).toContain('Home location: not set');
  });

  it('says plainly that no profile is stored', async () => {
    build(null);
    expect(textOf(await tool('wardrobe_status').call({}))).toContain('Body profile: not set');
  });
});

describe('next_untagged', () => {
  it('returns the garment id and its photo as an image block', async () => {
    db.garments = [
      garmentRow(WARDROBE[0]!, { reviewed: true }),
      garmentRow(WARDROBE[1]!, { untagged: true, createdAt: '2026-05-02 09:00:00' }),
    ];

    const result = await tool('next_untagged').call({});
    const image = (result.content ?? []).find((block) => block.type === 'image');

    expect(image).toEqual({ type: 'image', data: 'aGVsbG8=', mimeType: 'image/jpeg' });
    expect(textOf(result)).toContain('id: tank-gray');
    expect(textOf(result)).toContain('1 garment still untagged');
  });

  it('says there is nothing left, with no image, once everything is tagged', async () => {
    const result = await tool('next_untagged').call({});

    expect(result.isError).toBe(false);
    expect((result.content ?? []).some((block) => block.type === 'image')).toBe(false);
    expect(textOf(result)).toContain('Nothing is untagged');
  });
});

describe('set_garment_tags', () => {
  it('writes the fields and reports how many are left', async () => {
    db.garments = [
      garmentRow(WARDROBE[0]!, { untagged: true }),
      garmentRow(WARDROBE[1]!, { untagged: true }),
      garmentRow(WARDROBE[2]!, { untagged: true }),
    ];

    const text = textOf(
      await tool('set_garment_tags').call({
        id: 'tee-white',
        tags: { subtype: 'linen tee', warmth: 1, seasons: ['summer'] },
      }),
    );

    expect(text).toContain('Tagged tee-white as "linen tee"');
    expect(text).toContain('2 garments still untagged');
    expect(db.garments[0]?.subtype).toBe('linen tee');
    // The owner confirms on the Review screen. A tool write that claimed the
    // review had happened is what used to hide these from them entirely.
    expect(db.garments[0]?.reviewed).toBe(0);
  });

  it('leaves a garment the owner already confirmed confirmed', async () => {
    db.garments = [garmentRow(WARDROBE[0]!, { reviewed: true })];
    await tool('set_garment_tags').call({ id: 'tee-white', tags: { warmth: 1 } });

    expect(db.garments[0]?.warmth).toBe(1);
    expect(db.garments[0]?.reviewed).toBe(1);
  });

  it('reports nothing left when it tags the last one', async () => {
    db.garments = [garmentRow(WARDROBE[0]!, { untagged: true })];
    const text = textOf(
      await tool('set_garment_tags').call({ id: 'tee-white', tags: { warmth: 1 } }),
    );
    expect(text).toContain('Nothing is left untagged');
  });

  it('refuses an id the wardrobe does not have', async () => {
    const result = await tool('set_garment_tags').call({
      id: 'invented-shirt',
      tags: { warmth: 1 },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('invented-shirt');
  });

  it('refuses an empty patch rather than clearing the placeholders', async () => {
    db.garments = [garmentRow(WARDROBE[0]!, { untagged: true })];
    const result = await tool('set_garment_tags').call({ id: 'tee-white', tags: {} });

    expect(result.isError).toBe(true);
    expect(JSON.parse(String(db.garments[0]?.uncertain))).toContain('warmth');
  });
});

describe('plan_outfit', () => {
  it('carries only the rules for this body type', async () => {
    const text = textOf(await tool('plan_outfit').call(MOMENT));

    expect(text).toContain('rect-01');
    expect(text).toContain('all-01');
    for (const foreign of ['tri-01', 'inv-01', 'circ-01']) {
      expect(text).not.toContain(foreign);
    }
  });

  it('carries the other body type when the profile holds it', async () => {
    build(TRIANGLE);
    const text = textOf(await tool('plan_outfit').call(MOMENT));

    expect(text).toContain('tri-01');
    expect(text).not.toContain('rect-01');
    expect(text).toContain('Spanish');
  });

  it('states both warmth bands as numbers and says what each one means', async () => {
    const text = textOf(await tool('plan_outfit').call(MOMENT));

    expect(text).toContain('between 2 and 6');
    expect(text).toContain('once the coat comes off');
    expect(text).toContain('with the outer layer added, between 4 and 8');
    expect(text).toContain('formality floor');
    expect(text).toContain('season           autumn');
  });

  it('lists the menu and says that nothing outside it may be named', async () => {
    const text = textOf(await tool('plan_outfit').call(MOMENT));
    const menu = text.slice(text.indexOf('THE MENU'), text.indexOf('HELD BACK BY TODAY'));

    expect(text).toContain('THE MENU');
    expect(text).toContain('Every garment you may name, and nothing else.');
    expect(menu).toContain('tee-white | cotton t-shirt');
    // Summer only, so an autumn menu cannot hold it. It is still named further
    // down, under held back, which is the one place an unusable id is allowed.
    expect(menu).not.toContain('tank-gray |');
  });

  it('says what each accessory is, so four rings do not read as four of one thing', async () => {
    const text = textOf(await tool('plan_outfit').call(MOMENT));

    expect(text).toContain('belt-brown | leather belt | brown | kind belt');
    expect(text).toContain('cap-navy | baseball cap | navy | kind hat');
  });

  it('refuses to compose when a required slot cannot be filled', async () => {
    db.garments = [garmentRow(WARDROBE[0]!)];
    const text = textOf(await tool('plan_outfit').call(MOMENT));

    expect(text).toContain('NO COMPLETE OUTFIT EXISTS TODAY');
    expect(text).toContain('bottom or shoes');
  });

  it('says nothing at all about corrections when the owner has made none', async () => {
    const text = textOf(await tool('plan_outfit').call(MOMENT));

    expect(text).not.toContain('WHAT THE OWNER CORRECTED');
  });

  it('carries what the owner corrected, in their words, and says it is not the guide', async () => {
    corrected({
      slot: 'mid',
      from_id: 'cardigan-gray',
      to_id: 'knit-cream-heavy',
      reason: 'the cardigan itches at the office',
    });

    const text = textOf(await tool('plan_outfit').call(MOMENT));

    expect(text).toContain('WHAT THE OWNER CORRECTED');
    expect(text).toContain('These are not from the guide, so never cite one as a rule id.');
    expect(text).toContain('Putting back together a combination they already took apart');
    // The shape the rejected piece was standing in, without which a reason like
    // "too many layers" names no layers.
    expect(text).toContain('the rest of that outfit: base cotton t-shirt, bottom jeans, shoes leather sneakers');
    expect(text).toContain(
      '- 2026-05-10, work: you picked the cardigan for mid, they changed it to the heavy knit sweater. "the cardigan itches at the office"',
    );
    // Last thing read before the instruction, so the framing is still fresh.
    expect(text.indexOf('WHAT THE OWNER CORRECTED')).toBeLessThan(text.indexOf('WHAT TO DO NEXT'));
  });

  it('says nothing about names when no outfit carries one yet', async () => {
    const text = textOf(await tool('plan_outfit').call(MOMENT));

    expect(text).not.toContain('NAMES ALREADY TAKEN');
    expect(text).not.toContain('Read NAMES ALREADY TAKEN above');
  });

  it('lists the names already taken, with the day each one was used', async () => {
    db.outfits = [
      { id: 'o1', title: 'A client day, layered', created_at: '2026-05-10T08:00:00.000Z' },
      { id: 'o2', title: 'Errands and nothing else', created_at: '2026-05-11T08:00:00.000Z' },
    ];

    const text = textOf(await tool('plan_outfit').call(MOMENT));

    expect(text).toContain('NAMES ALREADY TAKEN');
    expect(text).toContain('  2026-05-11  Errands and nothing else');
    expect(text).toContain('  2026-05-10  A client day, layered');
    expect(text).toContain('Read NAMES ALREADY TAKEN above before you settle on one.');
    // Read before the instruction that sends the composer looking for a new one.
    expect(text.indexOf('NAMES ALREADY TAKEN')).toBeLessThan(text.indexOf('WHAT TO DO NEXT'));
  });

  it('asks for a name of its own, and says how long it can be', async () => {
    const text = textOf(await tool('plan_outfit').call(MOMENT));
    const next = text.slice(text.indexOf('WHAT TO DO NEXT'));

    expect(next).toContain('Name it, in English and in at most 56 characters.');
    expect(next).toContain('"Easy Friday drinks with friends" is the shape of it, not a name to copy.');
    expect(next).toContain('save_outfit refuses a repeat.');
  });

  /**
   * The ordinary morning, and the sentence it opens with is the one thing that
   * has to stay exactly as it reads today. A set is the exception, so the
   * absence of optionsWanted cannot start drifting toward one.
   */
  it('asks for one outfit when the owner asked for no options', async () => {
    const text = textOf(await tool('plan_outfit').call(MOMENT));
    const next = text.slice(text.indexOf('WHAT TO DO NEXT'));

    expect(next).toContain(
      'Compose one outfit. Fill base, bottom and shoes, and add top, mid, outer and accessories when the day calls for them.',
    );
    expect(next).not.toContain('different from each other');
    expect(next).not.toContain('same planId');
  });

  it('asks for three outfits on one plan when the owner wants to pick', async () => {
    const text = textOf(await tool('plan_outfit').call({ ...MOMENT, optionsWanted: 3 }));
    const next = text.slice(text.indexOf('WHAT TO DO NEXT'));

    // Verbatim from the composer written for the API path, which is the one
    // piece of that dead path worth keeping.
    expect(next).toContain(
      'Compose 3 outfits, different from each other in more than one piece. Every one fills base, bottom and shoes, and adds top, mid, outer and accessories when the day calls for them.',
    );
    expect(next).toContain('Save every one of them with this same planId');
    expect(next).toContain('one at a time, and wait for each answer before you send the next');
    expect(next).toContain('a name of its own and a rationale of its own');
    expect(next).not.toContain('Compose one outfit.');
  });

  it('refuses a count outside the two or three the owner can choose between', async () => {
    const result = await tool('plan_outfit').call({ ...MOMENT, optionsWanted: 4 });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('optionsWanted');
  });

  it('writes the example name in the language the owner reads', async () => {
    build(TRIANGLE);
    const text = textOf(await tool('plan_outfit').call(MOMENT));

    expect(text).toContain('Name it, in Spanish');
    expect(text).toContain('"Chill para unas birras a la noche" is the shape of it');
  });

  it('still reads a correction whose outfit was removed, with no occasion and no rest', async () => {
    corrected({
      slot: 'mid',
      from_id: 'cardigan-gray',
      to_id: 'knit-cream-heavy',
      reason: 'the cardigan itches at the office',
    });
    // What `removeOutfit` leaves behind on purpose: the words survive the outfit
    // they were said about, and the LEFT JOIN answers null for everything else.
    db.outfits = [];

    const text = textOf(await tool('plan_outfit').call(MOMENT));

    expect(text).toContain(
      '- 2026-05-10: you picked the cardigan for mid, they changed it to the heavy knit sweater. "the cardigan itches at the office"',
    );
    expect(text).not.toContain('the rest of that outfit');
  });

  it('names the slot alone for a garment archived since the correction', async () => {
    corrected({ slot: 'accessory', from_id: 'gone-for-good', to_id: null, reason: 'cut me in half' });

    const text = textOf(await tool('plan_outfit').call(MOMENT));

    expect(text).toContain(
      '- 2026-05-10, work: you picked something for accessory that is gone from the wardrobe, they took it out and left the slot empty. "cut me in half"',
    );
  });
});

describe('save_outfit', () => {
  it('stores a certified outfit and hands back an id and a link', async () => {
    const planId = await plan();
    const result = await tool('save_outfit').call({
      planId,
      pieces: GOOD_PIECES,
      title: 'Errands without trying too hard',
      rationale: 'Three layers so the shape reads, and nothing here fights the weather.',
      citedRules: ['rect-01'],
    });

    expect(result.isError).toBe(false);
    expect(textOf(result)).toContain('link: https://wardrobe.example/#/today');
    expect(textOf(result)).toContain('Guide rules it follows: rect-01');

    expect(db.outfits).toHaveLength(1);
    const stored = db.outfits[0];
    expect(stored?.title).toBe('Errands without trying too hard');
    expect(stored?.rationale).toContain('Three layers');
    expect(stored?.cited_rules).toBe('["rect-01"]');
    expect(JSON.parse(String(stored?.pieces))).toEqual([
      { slot: 'base', id: 'tee-white' },
      { slot: 'top', id: 'oxford-blue' },
      { slot: 'mid', id: 'cardigan-gray' },
      { slot: 'bottom', id: 'jeans-indigo' },
      { slot: 'shoes', id: 'sneakers-white' },
    ]);
    expect(textOf(result)).toContain(String(stored?.id));
  });

  it('tells the model to log the wear against the outfit it just saved', async () => {
    const planId = await plan();
    const result = await tool('save_outfit').call({
      planId,
      pieces: GOOD_PIECES,
      title: 'Nothing to prove on a Tuesday',
      rationale: 'Three layers so the shape reads.',
      citedRules: [],
    });

    // The one sentence that puts `outfitId` in front of the model, and a wear
    // that names no outfit is the one thing removing the outfit cannot take
    // with it.
    expect(textOf(result)).toContain(`with outfitId ${String(db.outfits[0]?.id)} and these garment ids`);
  });

  /**
   * A tool result is text, so the count is the only way a composer part way
   * through a set learns that its earlier save landed on the same plan.
   */
  it('says where an outfit sits in the set its plan holds', async () => {
    const planId = await plan();
    const first = await tool('save_outfit').call({
      planId,
      pieces: GOOD_PIECES,
      title: 'The easy one for a mild morning',
      rationale: 'Three layers so the shape reads.',
      citedRules: [],
    });

    expect(textOf(first)).toContain('It is the only outfit on this plan.');

    const second = await tool('save_outfit').call({
      planId,
      // Core warmth 4 with no shirt over the tee, which both bands still hold.
      pieces: { base: 'tee-white', mid: 'cardigan-gray', bottom: 'jeans-indigo', shoes: 'sneakers-white' },
      title: 'The lighter answer to the same morning',
      rationale: 'One layer fewer for the same errands.',
      citedRules: [],
    });

    expect(second.isError).toBe(false);
    expect(textOf(second)).toContain(
      'It is outfit 2 on this plan, so the owner sees 2 of them side by side as one set.',
    );
    expect(db.outfits).toHaveLength(2);
  });

  it('refuses a second hat and names the kind that was doubled', async () => {
    db.garments.push(
      garmentRow(
        makeGarment({
          id: 'hat-straw',
          slot: 'accessory',
          subtype: 'straw hat',
          accessoryKind: 'hat',
        }),
      ),
    );
    const planId = await plan();

    const result = await tool('save_outfit').call({
      planId,
      pieces: { ...GOOD_PIECES, accessories: ['cap-navy', 'hat-straw'] },
      title: 'Both hats at once',
      rationale: 'Both hats at once.',
      citedRules: [],
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(
      'cap-navy and hat-straw are the same kind of accessory, hat, and only one can be worn',
    );
    expect(db.outfits).toHaveLength(0);
  });

  it('refuses a save with no title, so nothing stored from here is nameless', async () => {
    const planId = await plan();
    const result = await tool('save_outfit').call({
      planId,
      pieces: GOOD_PIECES,
      rationale: 'Three layers so the shape reads.',
      citedRules: [],
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('cannot read');
    expect(db.outfits).toHaveLength(0);
  });

  it('refuses a title too long for the card, and takes one of exactly 56', async () => {
    const planId = await plan();
    const long = (length: number) => ({
      planId,
      pieces: GOOD_PIECES,
      title: 'a'.repeat(length),
      rationale: 'Three layers so the shape reads.',
      citedRules: [],
    });

    expect(tool('save_outfit').inputSchema.safeParse(long(56)).success).toBe(true);

    const result = await tool('save_outfit').call(long(57));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('cannot read');
    expect(db.outfits).toHaveLength(0);
  });

  it('refuses a name another outfit already carries, and stores nothing', async () => {
    const planId = await plan();
    const outfit = {
      planId,
      pieces: GOOD_PIECES,
      title: 'Errands without trying too hard',
      rationale: 'Three layers so the shape reads.',
      citedRules: [],
    };
    expect((await tool('save_outfit').call(outfit)).isError).toBe(false);

    const result = await tool('save_outfit').call(outfit);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(
      'The name "Errands without trying too hard" is already on the outfit saved on 2026-05-12.',
    );
    // The name is the only thing wrong, so the composer is told to keep the clothes.
    expect(textOf(result)).toContain('The clothes passed every check');
    expect(db.outfits).toHaveLength(1);
  });

  it('refuses a name that differs from a taken one only in its capitals', async () => {
    const planId = await plan();
    const outfit = {
      planId,
      pieces: GOOD_PIECES,
      title: 'Errands without trying too hard',
      rationale: 'Three layers so the shape reads.',
      citedRules: [],
    };
    await tool('save_outfit').call(outfit);

    const result = await tool('save_outfit').call({ ...outfit, title: 'ERRANDS Without Trying Too Hard' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('is already on the outfit saved on 2026-05-12.');
    expect(db.outfits).toHaveLength(1);
  });

  it('fails on an unknown planId and says to call plan_outfit', async () => {
    const result = await tool('save_outfit').call({
      planId: 'not-a-plan',
      pieces: GOOD_PIECES,
      title: 'Whatever',
      rationale: 'Whatever.',
      citedRules: [],
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('No plan with id not-a-plan');
    expect(textOf(result)).toContain('Call plan_outfit');
    expect(db.outfits).toHaveLength(0);
  });

  it('rejects a garment outside the plan menu and names it', async () => {
    const planId = await plan();
    const result = await tool('save_outfit').call({
      planId,
      pieces: { ...GOOD_PIECES, bottom: 'jeans-black-skinny' },
      title: 'Skinny jeans day',
      rationale: 'Skinny jeans this time.',
      citedRules: [],
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('jeans-black-skinny is not in the bottom menu');
    expect(db.outfits).toHaveLength(0);
  });

  it('rejects an outfit outside the warmth band and says by how much', async () => {
    const planId = await plan();
    const { mid: _dropped, ...tooLight } = GOOD_PIECES;
    const result = await tool('save_outfit').call({
      planId,
      pieces: tooLight,
      title: 'Just a shirt',
      rationale: 'Just a shirt today.',
      citedRules: [],
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(
      'warmth with the outer layer came to 3, outside the 4 to 8 the day needs',
    );
    expect(textOf(result)).toContain('Compose again');
    expect(db.outfits).toHaveLength(0);
  });

  it('rejects a citation of a rule the outfit breaks', async () => {
    const planId = await plan();
    const result = await tool('save_outfit').call({
      planId,
      pieces: GOOD_PIECES,
      // A rule for another body type, which does not exist for this one.
      citedRules: ['tri-05'],
      title: 'Belted',
      rationale: 'Belted.',
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('tri-05');
    expect(db.outfits).toHaveLength(0);
  });

  it('certifies against the plan menu rather than the wardrobe as it stands now', async () => {
    const planId = await plan();
    // The wardrobe loses the shirt after the plan was minted. The stored menu
    // still holds it, so the outfit still saves.
    db.garments = db.garments.filter((row) => row.id !== 'oxford-blue');

    const result = await tool('save_outfit').call({
      planId,
      pieces: GOOD_PIECES,
      title: 'Straight from the plan',
      rationale: 'Composed from the plan that was handed to me.',
      citedRules: [],
    });

    expect(result.isError).toBe(false);
    expect(db.outfits).toHaveLength(1);
  });
});

describe('log_wear', () => {
  it('records the day and says the cooldown now applies', async () => {
    const result = await tool('log_wear').call({
      garmentIds: ['tee-white', 'jeans-indigo'],
    });

    expect(result.isError).toBe(false);
    expect(textOf(result)).toContain('Logged 2 garments as worn on 2026-05-12');
    expect(textOf(result)).toContain('cooldown');
    expect(db.wear).toHaveLength(1);
    expect(JSON.parse(String(db.wear[0]?.garment_ids))).toEqual(['tee-white', 'jeans-indigo']);
  });

  it('records nothing when an id is not a garment, and names it', async () => {
    const result = await tool('log_wear').call({
      garmentIds: ['tee-white', 'a-coat-i-imagined'],
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('a-coat-i-imagined');
    expect(db.wear).toHaveLength(0);
  });

  it('records which outfit the wear was, so two worn on one day can be told apart', async () => {
    db.outfits = [{ id: 'o1', created_at: '2026-05-12T08:00:00.000Z' }];

    const result = await tool('log_wear').call({ garmentIds: ['tee-white'], outfitId: 'o1' });

    expect(result.isError).toBe(false);
    expect(db.wear[0]?.outfit_id).toBe('o1');
  });

  it('records nothing when no outfit has the id it was given, and names it', async () => {
    const result = await tool('log_wear').call({
      garmentIds: ['tee-white'],
      outfitId: 'an-outfit-i-imagined',
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('an-outfit-i-imagined');
    expect(db.wear).toHaveLength(0);
  });

  it('does not let a garment archived since the plan slip into the log', async () => {
    db.garments = [
      garmentRow(makeGarment({ id: 'gone', slot: 'base', subtype: 'old tee' }), { archived: true }),
    ];
    const result = await tool('log_wear').call({ garmentIds: ['gone'] });

    expect(result.isError).toBe(true);
    expect(db.wear).toHaveLength(0);
  });
});

describe("an owner's request, through the connector", () => {
  /** Spring and summer only, so an autumn plan cannot offer it without being asked. */
  const ASKED = {
    ownerAsked: { garmentIds: ['linen-shirt-beige'], words: 'I want to wear the beige linen shirt' },
  };
  const WITH_ASKED = { ...GOOD_PIECES, top: 'linen-shirt-beige' };

  it('lists what today held back, apart from the menu and marked as unusable', async () => {
    const text = textOf(await tool('plan_outfit').call(MOMENT));

    expect(text).toContain('HELD BACK BY TODAY, AND NOT IN THE MENU');
    expect(text).toContain('linen-shirt-beige | linen shirt | beige | top | out of season');
    expect(text).toContain('throws away the whole outfit');
  });

  it('says a guide ban is one a request cannot turn off, in the held back list itself', async () => {
    const text = textOf(await tool('plan_outfit').call(MOMENT));

    expect(text).toContain("the guide's rect-05a, which a request cannot override");
  });

  it("quotes the owner's words back and names the filter the request turned off", async () => {
    const text = textOf(await tool('plan_outfit').call({ ...MOMENT, ...ASKED }));

    expect(text).toContain('WHAT THE OWNER ASKED FOR');
    expect(text).toContain('They said: "I want to wear the beige linen shirt"');
    expect(text).toContain('there only because they asked. It is out of season');
  });

  it('puts the asked-for garment in the menu, which is what makes it savable', async () => {
    const text = textOf(await tool('plan_outfit').call({ ...MOMENT, ...ASKED }));
    const menu = text.slice(text.indexOf('THE MENU'), text.indexOf('HELD BACK BY TODAY'));

    expect(menu).toContain('linen-shirt-beige | linen shirt');
    expect(menu).toContain('the owner asked for this one and it is here only because they did');
  });

  it('reports a request the guide refuses instead of quietly dropping it', async () => {
    const text = textOf(
      await tool('plan_outfit').call({
        ...MOMENT,
        ownerAsked: { garmentIds: ['jeans-black-skinny'], words: 'the black skinny jeans' },
      }),
    );

    expect(text).toContain("not admitted. It breaks the guide's rect-05a");
    expect(text).toContain('a request does not override the guide');
  });

  it('stores the words, the waiver and the second opinion on the outfit it saved', async () => {
    const planId = await plan(ASKED);
    const result = await tool('save_outfit').call({
      planId,
      pieces: WITH_ASKED,
      title: 'Light and easy',
      rationale: 'Light and easy.',
      citedRules: [],
      disagreement: 'I would have kept the oxford, linen reads thin for sixteen degrees.',
    });

    expect(result.isError).toBeFalsy();
    const stored = JSON.parse(String(db.outfits[0]?.owner_request));
    expect(stored.words).toBe('I want to wear the beige linen shirt');
    expect(stored.disagreement).toContain('oxford');
    expect(stored.honored).toEqual([{ id: 'linen-shirt-beige', waived: ['season'] }]);
  });

  it('says out loud when a filter was waived and no second opinion was written', async () => {
    const planId = await plan(ASKED);
    const text = textOf(
      await tool('save_outfit').call({
        planId,
        pieces: WITH_ASKED,
        title: 'Light and easy',
        rationale: 'Light and easy.',
        citedRules: [],
      }),
    );

    expect(text).toContain('No second opinion was written');
  });

  it('records nothing when the composer did not use what was asked for', async () => {
    const planId = await plan(ASKED);
    await tool('save_outfit').call({
      planId,
      pieces: GOOD_PIECES,
      title: 'Plain and easy',
      rationale: 'Plain and easy.',
      citedRules: [],
    });

    expect(db.outfits[0]?.owner_request).toBeNull();
  });

  /**
   * The whole hole in the menu, tested from the outside. A request waives the
   * four filters that are about today and nothing else, so the warmth sum and
   * the guide's donts still reject an outfit built on one.
   */
  it('still rejects a requested garment that breaks the warmth band or a guide dont', async () => {
    const planId = await plan({
      ownerAsked: { garmentIds: ['knit-cream-heavy'], words: 'the cream knit' },
    });
    const text = textOf(
      await tool('save_outfit').call({
        planId,
        pieces: { ...GOOD_PIECES, mid: 'knit-cream-heavy' },
        title: 'Warm enough',
        rationale: 'Warm.',
        citedRules: [],
      }),
    );

    expect(text).toContain('Rejected. Nothing was stored.');
    expect(text).toContain('core warmth came to 7');
    expect(text).toContain('rect-06b');
  });
});

describe('a request the outfit did not honor', () => {
  it('is said out loud rather than stored as something that happened', async () => {
    const planId = await plan({
      ownerAsked: { garmentIds: ['linen-shirt-beige'], words: 'the linen shirt' },
    });
    const text = textOf(
      await tool('save_outfit').call({
        planId,
        pieces: GOOD_PIECES,
        title: 'Plain and easy',
        rationale: 'Plain and easy.',
        citedRules: [],
      }),
    );

    expect(text).toContain('The owner asked for linen-shirt-beige and this outfit does not wear it');
    expect(db.outfits[0]?.owner_request).toBeNull();
  });
});

describe('past_outfits', () => {
  /** Saved straight into the table `past_outfits` reads, the way `corrected` does. */
  function savedOutfit(row: Record<string, unknown>): void {
    db.outfits.push({
      id: 'o-x',
      plan_id: 'p1',
      event: 'work',
      pieces: JSON.stringify([
        { slot: 'base', id: 'tee-white' },
        { slot: 'bottom', id: 'jeans-indigo' },
        { slot: 'shoes', id: 'sneakers-white' },
        { slot: 'accessory', id: 'belt-brown' },
      ]),
      title: null,
      rationale: 'Plain and easy for a mild morning.',
      cited_rules: JSON.stringify(['rect-01']),
      missed_rules: JSON.stringify(['rect-02', 'rect-04']),
      warmth_core: 1,
      warmth_with_outer: 1,
      owner_request: null,
      created_at: '2026-09-04T08:00:00.000Z',
      ...row,
    });
  }

  it('says what day it is before anything else, because the model cannot know', async () => {
    savedOutfit({});
    const text = textOf(await tool('past_outfits').call({}));

    expect(text.startsWith('TODAY IS 2026-05-12, UTC.')).toBe(true);
    expect(text).toContain('Measure any day the owner named from it.');
  });

  it('reads the newest few and names every piece by id and by name', async () => {
    savedOutfit({});
    const text = textOf(await tool('past_outfits').call({}));

    expect(text).toContain('2026-09-04 | work | not logged as worn');
    expect(text).toContain('base      tee-white | cotton t-shirt');
    expect(text).toContain('accessory belt-brown | leather belt');
    expect(text).toContain('"Plain and easy for a mild morning."');
    expect(text).toContain('follows rect-01');
    expect(text).toContain('misses rect-04');
    expect(text).toContain('warmth 1 at the core, 1 with the outer layer');
  });

  it('leaves out a miss the wardrobe made unavoidable, so the ones left are choices', async () => {
    savedOutfit({});
    const text = textOf(await tool('past_outfits').call({}));

    expect(text).toContain('misses rect-04');
    expect(text).not.toContain('rect-02');
  });

  it('names a dont the outfit breaks, which is never one of the misses', async () => {
    savedOutfit({ missed_rules: JSON.stringify(['rect-04', 'rect-06b']) });
    const text = textOf(await tool('past_outfits').call({}));

    expect(text).toContain('misses rect-04');
    expect(text).toContain('breaks rect-06b, which the book says not to do');
    expect(text).not.toContain('misses rect-04, rect-06b');
  });

  it('says nothing about a broken dont for an outfit that breaks none', async () => {
    savedOutfit({});
    const text = textOf(await tool('past_outfits').call({}));

    expect(text).not.toContain('which the book says not to do');
  });

  it('hands back the outfit id, which is the only way log_wear can name one later', async () => {
    savedOutfit({ id: 'o-friday' });
    const text = textOf(await tool('past_outfits').call({}));

    // Without this the id is spoken once, in the save_outfit reply, so a later
    // conversation can read three outfits from one day and name none of them.
    expect(text).toContain('id: o-friday');
  });

  it('names the outfit with the words it was saved under', async () => {
    savedOutfit({ title: 'Errands without trying too hard' });
    const text = textOf(await tool('past_outfits').call({}));

    expect(text).toContain('you called it "Errands without trying too hard"');
  });

  it('says nothing about a name for an outfit saved before titles existed', async () => {
    savedOutfit({});
    const text = textOf(await tool('past_outfits').call({}));

    expect(text).not.toContain('you called it');
  });

  it('says how many matched, so three out of eight does not read as all of them', async () => {
    for (let day = 1; day <= 8; day += 1) {
      savedOutfit({ id: `o-${day}`, created_at: `2026-09-0${day}T08:00:00.000Z` });
    }
    const text = textOf(await tool('past_outfits').call({}));

    expect(text).toContain('3 of 8 outfits in the whole history, newest first');
    expect(text).toContain('Call again with a higher limit');
  });

  it('reads one day when from and to are the same', async () => {
    savedOutfit({ id: 'o-1', created_at: '2026-09-04T08:00:00.000Z' });
    savedOutfit({ id: 'o-2', created_at: '2026-09-05T08:00:00.000Z' });
    const text = textOf(await tool('past_outfits').call({ from: '2026-09-04', to: '2026-09-04' }));

    expect(text).toContain('1 outfit on 2026-09-04, newest first.');
    expect(text).not.toContain('2026-09-05');
  });

  it('reads a range, and counts the day at each end as inside it', async () => {
    for (let day = 1; day <= 5; day += 1) {
      savedOutfit({ id: `o-${day}`, created_at: `2026-09-0${day}T08:00:00.000Z` });
    }
    const text = textOf(
      await tool('past_outfits').call({ from: '2026-09-02', to: '2026-09-04', limit: 20 }),
    );

    expect(text).toContain('3 outfits between 2026-09-02 and 2026-09-04, newest first.');
  });

  it('says what it searched when it found nothing', async () => {
    const text = textOf(await tool('past_outfits').call({ from: '2026-01-01', to: '2026-01-31' }));

    expect(text).toContain('No saved outfits between 2026-01-01 and 2026-01-31.');
    expect(text).toContain('an outfit that was only talked about is not one this can find');
  });

  it('carries the corrections and the request, which is why the tool exists', async () => {
    savedOutfit({
      owner_request: JSON.stringify({
        words: 'I want the beige linen shirt',
        disagreement: 'The oxford was warmer.',
        honored: [{ id: 'linen-shirt-beige', waived: ['season'] }],
      }),
    });
    db.feedback.push({
      outfit_id: 'o-x',
      slot: 'bottom',
      from_id: 'jeans-indigo',
      to_id: 'chinos-stone',
      reason: 'the jeans were too warm',
      created_at: '2026-09-04T09:00:00.000Z',
    });

    const text = textOf(await tool('past_outfits').call({}));

    expect(text).toContain('they asked: "I want the beige linen shirt"');
    expect(text).toContain('linen shirt (linen-shirt-beige), in only because they asked: out of season');
    expect(text).toContain('you said back: "The oxford was warmer."');
    expect(text).toContain('they changed bottom: jeans out, chinos in. "the jeans were too warm"');
  });

  it("says these ids are not today's menu, which is the mistake it would otherwise cause", async () => {
    savedOutfit({});
    const text = textOf(await tool('past_outfits').call({}));

    expect(text).toContain("the same string everywhere in this app");
    expect(text).toContain("plan_outfit's ownerAsked");
  });

  it('refuses a date it cannot read rather than searching for nothing', async () => {
    const result = await tool('past_outfits').call({ from: 'last friday' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('YYYY-MM-DD');
  });
});

describe('what past_outfits says when the read is partial or impossible', () => {
  function savedOn(day: string, id: string): void {
    db.outfits.push({
      id, plan_id: 'p1', event: 'work',
      pieces: JSON.stringify([{ slot: 'base', id: 'tee-white' }, { slot: 'bottom', id: 'jeans-indigo' }]),
      title: null, rationale: 'Plain.', cited_rules: '[]', missed_rules: '[]',
      warmth_core: 1, warmth_with_outer: 1, owner_request: null,
      created_at: `${day}T08:00:00.000Z`,
    });
  }

  it('points at the date range rather than a limit it would refuse', async () => {
    for (let n = 1; n <= 25; n += 1) savedOn(`2026-09-${String(n).padStart(2, '0')}`, `o-${n}`);
    const text = textOf(await tool('past_outfits').call({ limit: MAX_OUTFITS }));

    expect(text).toContain(`${MAX_OUTFITS} of 25 outfits`);

    expect(text).not.toContain('Call again with a higher limit');
    expect(text).toContain('narrow it with from and to');
  });

  it('offers a higher limit while one is still available', async () => {
    for (let n = 1; n <= 9; n += 1) savedOn(`2026-09-0${n}`, `o-${n}`);
    const text = textOf(await tool('past_outfits').call({}));

    expect(text).toContain(`Call again with a higher limit for the rest, up to ${MAX_OUTFITS}.`);
  });

  it('says a backwards range is backwards instead of reporting an empty wardrobe', async () => {
    savedOn('2026-09-04', 'o-1');
    const result = await tool('past_outfits').call({ from: '2026-09-10', to: '2026-09-01' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('the range runs backwards');
    expect(textOf(result)).not.toContain('No saved outfits');
  });

  it('names a garment archived since, so the outfit is not short a slot', async () => {
    savedOn('2026-09-04', 'o-1');
    db.garments = db.garments.filter((row) => row.id !== 'jeans-indigo');
    const text = textOf(await tool('past_outfits').call({}));

    expect(text).toContain('bottom    jeans-indigo | gone from the wardrobe since');
    expect(text).toContain('base      tee-white | cotton t-shirt');
  });

  it('says an outfit misses nothing rather than saying nothing about what it misses', async () => {
    savedOn('2026-09-04', 'o-1');
    const text = textOf(await tool('past_outfits').call({}));

    expect(text).toContain('misses none of the guide preferences for this body');
  });
});
