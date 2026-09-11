/**
 * The six connector tools, driven without a transport: every tool is parsed and
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
  db.outfits = [{ id: 'o1', event: 'work' }];
  db.feedback.push({ outfit_id: 'o1', created_at: '2026-05-10T07:30:00.000Z', ...row });
}

async function plan(): Promise<string> {
  const result = await tool('plan_outfit').call(MOMENT);
  const planId = /PLAN (\S+)/.exec(textOf(result))?.[1];
  if (planId === undefined) throw new Error(`no planId in:\n${textOf(result)}`);
  return planId;
}

beforeEach(() => {
  parseMock.mockReset();
  build(RECTANGLE);
});

describe('the tool surface', () => {
  it('exposes exactly the six tools the design names, each with a real description', () => {
    expect([...tools.keys()]).toEqual([
      'wardrobe_status',
      'next_untagged',
      'set_garment_tags',
      'plan_outfit',
      'save_outfit',
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
      rationale: 'Layered for a mild morning.',
      citedRules: ['rect-01'],
    },
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
      rationale: 'x',
      citedRules: ['rect-01'],
    },
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

    expect(text).toContain('THE MENU');
    expect(text).toContain('Every garment you may name, and nothing else.');
    expect(text).toContain('tee-white | cotton t-shirt');
    // Summer only, so an autumn menu cannot hold it.
    expect(text).not.toContain('tank-gray |');
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
    expect(text).toContain('They are not from the guide, nothing filtered the menu on them');
    expect(text).toContain(
      '- 2026-05-10, work: you picked the cardigan for mid, they changed it to the heavy knit sweater. "the cardigan itches at the office"',
    );
    // Last thing read before the instruction, so the framing is still fresh.
    expect(text.indexOf('WHAT THE OWNER CORRECTED')).toBeLessThan(text.indexOf('WHAT TO DO NEXT'));
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
      rationale: 'Three layers so the shape reads, and nothing here fights the weather.',
      citedRules: ['rect-01'],
    });

    expect(result.isError).toBe(false);
    expect(textOf(result)).toContain('link: https://wardrobe.example/#/today');
    expect(textOf(result)).toContain('Guide rules it follows: rect-01');

    expect(db.outfits).toHaveLength(1);
    const stored = db.outfits[0];
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

  it('fails on an unknown planId and says to call plan_outfit', async () => {
    const result = await tool('save_outfit').call({
      planId: 'not-a-plan',
      pieces: GOOD_PIECES,
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

  it('does not let a garment archived since the plan slip into the log', async () => {
    db.garments = [
      garmentRow(makeGarment({ id: 'gone', slot: 'base', subtype: 'old tee' }), { archived: true }),
    ];
    const result = await tool('log_wear').call({ garmentIds: ['gone'] });

    expect(result.isError).toBe(true);
    expect(db.wear).toHaveLength(0);
  });
});
