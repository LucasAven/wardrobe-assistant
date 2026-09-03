import { beforeEach, describe, expect, it, vi } from 'vitest';

const { parseMock } = vi.hoisted(() => ({ parseMock: vi.fn() }));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    public messages = { parse: parseMock };
    constructor(public readonly options: unknown) {}
  },
}));

import type { Env } from '../src/worker/env';
import { parseGarmentRow } from '../src/worker/repo';
import type { GarmentDraft, RawGarmentDraft } from '../src/worker/vision';
import {
  GarmentDraftSchema,
  RawGarmentDraftSchema,
  TAGGED_FIELDS,
  VISION_SYSTEM_PROMPT,
  VOCABULARIES,
  blankDraft,
  coerceDraft,
  draftToTags,
  tagGarment,
} from '../src/worker/vision';

const ENV = { ANTHROPIC_API_KEY: 'test-key' } as unknown as Env;

const OXFORD: GarmentDraft = {
  slot: 'base',
  subtype: 'oxford shirt',
  colors: ['light blue'],
  colorRole: 'neutral',
  pattern: 'solid',
  fabric: 'cotton',
  warmth: 2,
  formality: 4,
  fit: 'regular',
  structured: true,
  rise: null,
  leg: null,
  hem: 'hip',
  neckline: 'open',
  sleeves: 'long',
  shoulderBulk: false,
  waterResistant: false,
  seasons: ['spring', 'autumn', 'winter'],
  notes: null,
  uncertain: ['fit'],
};

const JEANS: GarmentDraft = {
  slot: 'bottom',
  subtype: 'slim jeans',
  colors: ['indigo'],
  colorRole: 'neutral',
  pattern: 'solid',
  fabric: 'denim',
  warmth: 2,
  formality: 2,
  fit: 'fitted',
  structured: false,
  rise: 'mid',
  leg: 'tapered',
  hem: null,
  neckline: null,
  sleeves: null,
  shoulderBulk: false,
  waterResistant: false,
  seasons: ['spring', 'summer', 'autumn', 'winter'],
  notes: null,
  uncertain: [],
};

/** The oxford with nothing flagged, so `uncertain` reads as the coercion's own work. */
const SURE: GarmentDraft = { ...OXFORD, uncertain: [] };

/** A model answer: `SURE` with the fields under test written the model's way. */
const said = (overrides: Partial<RawGarmentDraft>): RawGarmentDraft => ({ ...SURE, ...overrides });

const read = (draft: GarmentDraft, field: string): unknown =>
  (draft as unknown as Record<string, unknown>)[field];

const normalized = (word: string): string => word.trim().toLowerCase().replace(/[\s-]+/g, '_');

/** Encodes a draft the way the repo writes it, so the round trip is the real one. */
function rowFrom(draft: GarmentDraft, id = 'row-1') {
  return {
    id,
    slot: draft.slot,
    subtype: draft.subtype,
    image_original: `orig/${id}`,
    image_cutout: `cut/${id}.png`,
    colors: JSON.stringify(draft.colors),
    color_role: draft.colorRole,
    pattern: draft.pattern,
    fabric: draft.fabric,
    warmth: draft.warmth,
    formality: draft.formality,
    fit: draft.fit,
    structured: draft.structured ? 1 : 0,
    rise: draft.rise,
    leg: draft.leg,
    hem: draft.hem,
    neckline: draft.neckline,
    sleeves: draft.sleeves,
    shoulder_bulk: draft.shoulderBulk ? 1 : 0,
    water_resistant: draft.waterResistant ? 1 : 0,
    seasons: JSON.stringify(draft.seasons),
    notes: draft.notes,
    reviewed: 0,
    uncertain: JSON.stringify(draft.uncertain),
    archived: 0,
    created_at: '2026-09-03 10:00:00',
  };
}

describe('GarmentDraftSchema', () => {
  it('accepts a top and a bottom', () => {
    expect(GarmentDraftSchema.parse(OXFORD)).toEqual(OXFORD);
    expect(GarmentDraftSchema.parse(JEANS)).toEqual(JEANS);
  });

  it('holds warmth to 0 through 5 and formality to 1 through 5', () => {
    expect(GarmentDraftSchema.safeParse({ ...OXFORD, warmth: 6 }).success).toBe(false);
    expect(GarmentDraftSchema.safeParse({ ...OXFORD, warmth: -1 }).success).toBe(false);
    expect(GarmentDraftSchema.safeParse({ ...OXFORD, warmth: 2.5 }).success).toBe(false);
    expect(GarmentDraftSchema.safeParse({ ...OXFORD, formality: 0 }).success).toBe(false);
    expect(GarmentDraftSchema.safeParse({ ...OXFORD, formality: 6 }).success).toBe(false);
    expect(GarmentDraftSchema.safeParse({ ...OXFORD, warmth: 0 }).success).toBe(true);
    expect(GarmentDraftSchema.safeParse({ ...OXFORD, formality: 5 }).success).toBe(true);
  });

  it('rejects a value outside the book vocabulary', () => {
    expect(GarmentDraftSchema.safeParse({ ...OXFORD, slot: 'jacket' }).success).toBe(false);
    expect(GarmentDraftSchema.safeParse({ ...OXFORD, neckline: 'collar' }).success).toBe(false);
    expect(GarmentDraftSchema.safeParse({ ...JEANS, leg: 'bootcut' }).success).toBe(false);
    expect(GarmentDraftSchema.safeParse({ ...JEANS, seasons: ['monsoon'] }).success).toBe(false);
  });

  it('lets every optional shape field be null', () => {
    const bare = {
      ...OXFORD,
      slot: 'shoes',
      fabric: null,
      fit: null,
      hem: null,
      neckline: null,
      sleeves: null,
      notes: null,
    };
    expect(GarmentDraftSchema.safeParse(bare).success).toBe(true);
  });

  it('requires uncertain to be present', () => {
    const { uncertain: _dropped, ...withoutUncertain } = OXFORD;
    expect(GarmentDraftSchema.safeParse(withoutUncertain).success).toBe(false);
  });
});

describe('the wire schema', () => {
  it('takes the words the domain schema turns away, so one of them cannot sink the record', () => {
    for (const answer of [
      { ...OXFORD, neckline: 'collar' },
      { ...OXFORD, slot: 'jacket' },
      { ...JEANS, leg: 'bootcut' },
      { ...JEANS, seasons: ['monsoon'] },
      { ...OXFORD, warmth: 9 },
    ]) {
      expect(RawGarmentDraftSchema.safeParse(answer).success).toBe(true);
      expect(GarmentDraftSchema.safeParse(answer).success).toBe(false);
    }
  });

  it('still asks for the structure the domain needs', () => {
    expect(RawGarmentDraftSchema.safeParse({ ...OXFORD, warmth: 'warm' }).success).toBe(false);
    expect(RawGarmentDraftSchema.safeParse({ ...OXFORD, colors: 'blue' }).success).toBe(false);
    expect(RawGarmentDraftSchema.safeParse({ ...OXFORD, structured: 'yes' }).success).toBe(false);
    const { neckline: _dropped, ...missingField } = OXFORD;
    expect(RawGarmentDraftSchema.safeParse(missingField).success).toBe(false);
  });

  it('carries each vocabulary in the description, which is all the model ever sees', () => {
    const shape = RawGarmentDraftSchema.shape;
    expect(shape.neckline.description).toContain('crew, v, open, high, none');
    expect(shape.slot.description).toContain('base, top, mid, outer, bottom, shoes, accessory');
    expect(shape.leg.description).toContain('skinny, tapered, straight, relaxed, wide');
    expect(shape.seasons.description).toContain('spring, summer, autumn, winter');
    expect(shape.warmth.description).toContain('0 to 5');
    expect(shape.formality.description).toContain('1 to 5');
  });
});

describe('the vocabulary tables', () => {
  it('keeps every word in normalized form, which is what makes one lookup enough', () => {
    for (const vocab of Object.values(VOCABULARIES)) {
      for (const value of vocab.values) expect(normalized(value), value).toBe(value);
      for (const written of Object.keys(vocab.synonyms)) {
        expect(normalized(written), written).toBe(written);
        expect(vocab.values as readonly string[], written).not.toContain(written);
      }
    }
  });

  it('maps every synonym it lists onto the field it belongs to', () => {
    let checked = 0;
    for (const [field, vocab] of Object.entries(VOCABULARIES)) {
      for (const [written, meant] of Object.entries(vocab.synonyms)) {
        const answer = field === 'seasons' ? [written] : written;
        const coerced = coerceDraft({ ...SURE, [field]: answer } as unknown as RawGarmentDraft);
        const got = read(coerced, field);
        expect(Array.isArray(got) ? got[0] : got, `${field}: ${written}`).toBe(meant);
        expect(coerced.uncertain, `${field}: ${written}`).not.toContain(field);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(60);
  });

  it('reads the words a model actually writes', () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ['neckline', 'collar', 'open'],
      ['neckline', 'collared', 'open'],
      ['neckline', 'open_collar', 'open'],
      ['neckline', 'button_down', 'open'],
      ['neckline', 'vneck', 'v'],
      ['neckline', 'v-neck', 'v'],
      ['neckline', 'v_neck', 'v'],
      ['neckline', 'turtleneck', 'high'],
      ['neckline', 'mock_neck', 'high'],
      ['sleeves', 'sleeveless', 'none'],
      ['sleeves', 'short_sleeve', 'short'],
      ['sleeves', 'long_sleeve', 'long'],
      ['fit', 'slim', 'fitted'],
      ['fit', 'loose', 'relaxed'],
      ['fit', 'baggy', 'relaxed'],
      ['leg', 'bootcut', 'wide'],
      ['leg', 'flare', 'wide'],
      ['rise', 'high_rise', 'high'],
      ['rise', 'high_waisted', 'high'],
      ['rise', 'midi', 'mid'],
      ['hem', 'hip_length', 'hip'],
      ['hem', 'cropped', 'above_waist'],
      ['pattern', 'striped', 'stripe'],
      ['pattern', 'checked', 'check'],
      ['pattern', 'plaid', 'check'],
      ['pattern', 'patterned', 'print'],
      ['pattern', 'graphic', 'print'],
      ['pattern', 'floral', 'print'],
      ['fabric', 'polyester', 'synthetic'],
      ['fabric', 'suede', 'leather'],
      ['slot', 'footwear', 'shoes'],
    ];

    for (const [field, written, meant] of cases) {
      const coerced = coerceDraft({ ...SURE, [field]: written } as unknown as RawGarmentDraft);
      expect(read(coerced, field), `${field}: ${written}`).toBe(meant);
      expect(coerced.uncertain, `${field}: ${written}`).toEqual([]);
    }
  });

  it('reads a word past case, spaces and hyphens', () => {
    expect(coerceDraft(said({ neckline: 'V-Neck' })).neckline).toBe('v');
    expect(coerceDraft(said({ hem: ' Above Waist ' })).hem).toBe('above_waist');
    expect(coerceDraft(said({ slot: 'BOTTOM' })).slot).toBe('bottom');
    expect(coerceDraft(said({ sleeves: 'Long-Sleeved' })).sleeves).toBe('long');
    expect(coerceDraft(said({ seasons: ['Fall'] })).seasons).toEqual(['autumn']);
  });
});

describe('coerceDraft', () => {
  it('leaves a draft already in the vocabulary alone', () => {
    expect(coerceDraft(OXFORD)).toEqual(OXFORD);
    expect(coerceDraft(JEANS)).toEqual(JEANS);
  });

  it('sends an unreadable nullable field to null and flags it, keeping the rest', () => {
    const coerced = coerceDraft(said({ neckline: 'scoop' }));

    expect(coerced.neckline).toBeNull();
    expect(coerced.uncertain).toEqual(['neckline']);
    for (const field of TAGGED_FIELDS) {
      if (field === 'neckline') continue;
      expect(read(coerced, field), field).toEqual(read(SURE, field));
    }
  });

  it('does not flag a nullable field the model deliberately left null', () => {
    const coerced = coerceDraft(said({ fabric: null, fit: null, neckline: null, sleeves: null }));
    expect(coerced.uncertain).toEqual([]);
    expect(coerced.fabric).toBeNull();
    expect(coerced.fit).toBeNull();
  });

  it('clamps a warmth of 9 into the scale and flags it', () => {
    const coerced = coerceDraft(said({ warmth: 9 }));
    expect(coerced.warmth).toBe(5);
    expect(coerced.uncertain).toEqual(['warmth']);
    expect(GarmentDraftSchema.safeParse(coerced).success).toBe(true);
  });

  it('rounds and clamps the other way too', () => {
    expect(coerceDraft(said({ warmth: -3 })).warmth).toBe(0);
    expect(coerceDraft(said({ formality: 0 })).formality).toBe(1);
    expect(coerceDraft(said({ formality: 12 })).formality).toBe(5);
    expect(coerceDraft(said({ warmth: 3.4 })).warmth).toBe(3);
    expect(coerceDraft(said({ warmth: 3.4 })).uncertain).toEqual(['warmth']);
    expect(coerceDraft(said({ warmth: Number.NaN })).warmth).toBe(2);
    expect(coerceDraft(said({ formality: Number.NaN })).formality).toBe(3);
  });

  it('keeps the sixteen good fields when three are outside the vocabulary', () => {
    const coerced = coerceDraft(said({ neckline: 'scoop', fabric: 'jersey', fit: 'athletic' }));
    const spoiled = ['neckline', 'fabric', 'fit'];
    const kept = TAGGED_FIELDS.filter((field) => !spoiled.includes(field));

    expect(kept).toHaveLength(16);
    for (const field of kept) {
      expect(read(coerced, field), field).toEqual(read(SURE, field));
    }
    expect([coerced.neckline, coerced.fabric, coerced.fit]).toEqual([null, null, null]);
    expect([...coerced.uncertain].sort()).toEqual(spoiled.sort());
  });

  it('keeps the seasons it can read and flags the list once for the ones it cannot', () => {
    const coerced = coerceDraft(said({ seasons: ['Fall', 'winter', 'monsoon', 'autumn', 'dry'] }));
    expect(coerced.seasons).toEqual(['autumn', 'winter']);
    expect(coerced.uncertain).toEqual(['seasons']);
  });

  it("merges the model's own doubts with the fields that fell back, once each", () => {
    const both = coerceDraft(said({ uncertain: ['warmth', 'neckline'], warmth: 9, neckline: 'scoop' }));
    expect(both.uncertain).toEqual(['warmth', 'neckline']);

    const apart = coerceDraft(said({ uncertain: ['subtype'], neckline: 'scoop' }));
    expect(apart.uncertain).toEqual(['subtype', 'neckline']);

    const modelOnly = coerceDraft(said({ uncertain: ['warmth', 'formality'] }));
    expect(modelOnly.uncertain).toEqual(['warmth', 'formality']);
  });

  it('lands on the domain schema whatever the model wrote', () => {
    const nonsense = coerceDraft({
      ...SURE,
      slot: 'jacket',
      colorRole: 'loud',
      pattern: 'swirl',
      fabric: 'jersey',
      warmth: 99,
      formality: -4,
      fit: 'athletic',
      rise: 'saggy',
      leg: 'jodhpur',
      hem: 'ankle',
      neckline: 'scoop',
      sleeves: 'three_quarter',
      seasons: ['monsoon'],
    } as unknown as RawGarmentDraft);

    expect(GarmentDraftSchema.safeParse(nonsense).success).toBe(true);
    expect(nonsense.slot).toBe('accessory');
    expect(nonsense.colorRole).toBe('neutral');
    expect(nonsense.pattern).toBe('solid');
    expect(nonsense.warmth).toBe(5);
    expect(nonsense.formality).toBe(1);
    expect(nonsense.seasons).toEqual([]);
    expect(nonsense.subtype).toBe(SURE.subtype);
    expect([...nonsense.uncertain].sort()).toEqual(
      [
        'colorRole',
        'fabric',
        'fit',
        'formality',
        'hem',
        'leg',
        'neckline',
        'pattern',
        'rise',
        'seasons',
        'sleeves',
        'slot',
        'warmth',
      ].sort(),
    );
  });
});

describe('blankDraft', () => {
  it('names every tagged field as uncertain', () => {
    const draft = blankDraft();
    expect(GarmentDraftSchema.safeParse(draft).success).toBe(true);
    expect([...draft.uncertain].sort()).toEqual([...TAGGED_FIELDS].sort());
    expect(draft.uncertain).not.toContain('uncertain');
  });

  it('lands on a slot no outfit requires and on no season', () => {
    const draft = blankDraft();
    expect(draft.slot).toBe('accessory');
    expect(draft.seasons).toEqual([]);
  });
});

describe('the calibration prompt', () => {
  it('anchors both scales with examples', () => {
    for (const anchor of [
      '0  tank top',
      '1  t-shirt',
      '2  long sleeve shirt',
      '3  sweater',
      '4  wool coat',
      '5  heavy parka',
    ]) {
      expect(VISION_SYSTEM_PROMPT).toContain(anchor);
    }
    for (const anchor of [
      '1  gym and loungewear',
      '2  casual',
      '3  smart casual',
      '4  dressy',
      '5  formal',
    ]) {
      expect(VISION_SYSTEM_PROMPT).toContain(anchor);
    }
  });

  it('tells the model to take the middle value and flag it', () => {
    expect(VISION_SYSTEM_PROMPT).toContain('pick the middle of the range');
    expect(VISION_SYSTEM_PROMPT).toContain('add the field name to "uncertain"');
  });

  it('says which fields belong to bottoms and which to tops', () => {
    expect(VISION_SYSTEM_PROMPT).toContain('BOTTOMS ONLY');
    expect(VISION_SYSTEM_PROMPT).toContain('TOPS ONLY');
    expect(VISION_SYSTEM_PROMPT).toContain('Shoes and accessories get null');
  });

  it('asks for the listed words, since the schema no longer holds the model to them', () => {
    expect(VISION_SYSTEM_PROMPT).toContain('takes one of the listed words and nothing else');
  });
});

describe('tagGarment', () => {
  beforeEach(() => {
    parseMock.mockReset();
  });

  it('sends the pinned model, the effort, and a cached system prompt', async () => {
    parseMock.mockResolvedValue({ parsed_output: OXFORD, stop_reason: 'end_turn' });

    const draft = await tagGarment(ENV, { base64: 'ZmFrZQ==', mediaType: 'image/jpeg' });
    expect(draft).toEqual(OXFORD);

    const params = parseMock.mock.calls[0]?.[0];
    expect(params.model).toBe('claude-opus-5');
    expect(params.max_tokens).toBe(4000);
    expect(params.output_config.effort).toBe('medium');
    expect(params.output_config.format.type).toBe('json_schema');
    expect(params.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(params.system[0].text).toBe(VISION_SYSTEM_PROMPT);
    expect(params.messages[0].content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: 'ZmFrZQ==' },
    });
    expect(params.tools).toBeUndefined();
  });

  it('coerces what came back instead of handing the caller a raw answer', async () => {
    parseMock.mockResolvedValue({
      parsed_output: said({ neckline: 'Collar', fabric: 'jersey', warmth: 9 }),
      stop_reason: 'end_turn',
    });

    const draft = await tagGarment(ENV, { base64: 'ZmFrZQ==', mediaType: 'image/jpeg' });
    expect(draft.neckline).toBe('open');
    expect(draft.fabric).toBeNull();
    expect(draft.warmth).toBe(5);
    expect(draft.subtype).toBe('oxford shirt');
    expect([...draft.uncertain].sort()).toEqual(['fabric', 'warmth']);
    expect(GarmentDraftSchema.safeParse(draft).success).toBe(true);
  });

  it('throws when the model returned nothing parsable', async () => {
    parseMock.mockResolvedValue({ parsed_output: null, stop_reason: 'max_tokens' });
    await expect(tagGarment(ENV, { base64: 'ZmFrZQ==', mediaType: 'image/jpeg' })).rejects.toThrow(
      /no parsable output/,
    );
  });

  it('lets a transport failure through to the caller', async () => {
    parseMock.mockRejectedValue(new Error('529 overloaded'));
    await expect(tagGarment(ENV, { base64: 'ZmFrZQ==', mediaType: 'image/jpeg' })).rejects.toThrow(
      /overloaded/,
    );
  });
});

describe('draft to row to Garment', () => {
  it('round trips a top', () => {
    const { uncertain, ...tags } = draftToTags(OXFORD) as GarmentDraft;
    const stored = parseGarmentRow(rowFrom(OXFORD));
    expect(stored.garment).toEqual({
      id: 'row-1',
      imageOriginal: 'orig/row-1',
      imageCutout: 'cut/row-1.png',
      ...tags,
    });
    expect(stored.uncertain).toEqual(uncertain);
  });

  it('round trips a bottom, keeping the top-only fields null', () => {
    const stored = parseGarmentRow(rowFrom(JEANS, 'row-2'));
    expect(stored.garment.leg).toBe('tapered');
    expect(stored.garment.rise).toBe('mid');
    expect(stored.garment.hem).toBeNull();
    expect(stored.garment.neckline).toBeNull();
    expect(stored.garment.sleeves).toBeNull();
    expect(stored.uncertain).toEqual([]);
    expect(stored.reviewed).toBe(false);
  });

  it('carries the uncertain list out of the row', () => {
    const stored = parseGarmentRow(rowFrom(blankDraft(), 'row-3'));
    expect([...stored.uncertain].sort()).toEqual([...TAGGED_FIELDS].sort());
  });

  it('stores a coerced draft, so one bad word does not cost the row', () => {
    const coerced = coerceDraft(said({ neckline: 'collar', leg: 'bootcut', warmth: 9 }));
    const stored = parseGarmentRow(rowFrom(coerced, 'row-4'));
    expect(stored.garment.neckline).toBe('open');
    expect(stored.garment.leg).toBe('wide');
    expect(stored.garment.warmth).toBe(5);
    expect(stored.garment.subtype).toBe('oxford shirt');
    expect(stored.uncertain).toEqual(['warmth']);
  });
});
