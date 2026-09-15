import { beforeEach, describe, expect, it, vi } from 'vitest';

const { parseMock } = vi.hoisted(() => ({ parseMock: vi.fn() }));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    public messages = { parse: parseMock };
    constructor(public readonly options: unknown) {}
  },
}));

import { BOOK_RULES, PRINCIPLE, rulesFor } from '../src/domain/bookRules';
import { deriveConstraints } from '../src/domain/constraints';
import { buildMenu } from '../src/domain/menu';
import type { BodyProfile, BodyType, BookRule, Constraints, Menu } from '../src/domain/types';
import type { ComposeInput, RawProposal } from '../src/worker/compose';
import {
  calibrationAnchors,
  compose,
  ruleLine,
  ruleScope,
  ruleView,
  systemPrompt,
  userMessage,
} from '../src/worker/compose';
import type { Env } from '../src/worker/env';
import { AUTUMN_DAY, MILD_ERRANDS, WARDROBE } from './fixtures';

const ENV = { ANTHROPIC_API_KEY: 'test-key' } as unknown as Env;

const RECTANGLE: BodyProfile = {
  shouldersVsHips: 'equal',
  waistIsWidest: false,
  volume: 'even',
  line: 'straight',
  thinLegs: false,
  bodyType: 'rectangle',
  language: 'en',
};

const CONSTRAINTS: Constraints = deriveConstraints(MILD_ERRANDS);
const MENU: Menu = buildMenu(WARDROBE, CONSTRAINTS, [], 'rectangle', AUTUMN_DAY);

const INPUT: ComposeInput = {
  profile: RECTANGLE,
  constraints: CONSTRAINTS,
  menu: MENU,
  moment: MILD_ERRANDS,
};

function proposal(over: Partial<RawProposal>): RawProposal {
  return {
    base: 'tee-white',
    top: 'oxford-blue',
    mid: null,
    outer: 'trench-navy',
    bottom: 'jeans-indigo',
    shoes: 'sneakers-white',
    accessories: ['belt-brown'],
    rationale: 'A layered look that gives the torso some depth for a mild errand run.',
    citedRules: ['rect-01'],
    ...over,
  };
}

/** Three that certify, different enough from each other to stand in for a real answer. */
const GOOD_A = proposal({});
const GOOD_B = proposal({
  base: 'henley-navy',
  top: null,
  mid: 'cardigan-gray',
  outer: 'gilet-olive',
  bottom: 'chinos-stone',
  shoes: 'loafers-brown',
  accessories: [],
});
const GOOD_C = proposal({
  base: 'tee-merino-white',
  top: 'polo-navy',
  mid: null,
  outer: null,
  bottom: 'trousers-wool-charcoal',
  shoes: 'chelsea-boots-black',
  accessories: [],
});

const OFF_MENU = proposal({ base: 'tee-navy-slub', citedRules: [] });
const TOO_COLD = proposal({ top: null, outer: null, citedRules: [] });

function answer(...outfits: readonly RawProposal[]): unknown {
  return { parsed_output: { outfits }, stop_reason: 'end_turn' };
}

function callArgs(index: number): { system: { text: string }[]; messages: { content: string }[] } {
  const call: unknown = parseMock.mock.calls[index]?.[0];
  return call as { system: { text: string }[]; messages: { content: string }[] };
}

const systemOf = (index: number): string => callArgs(index).system[0]?.text ?? '';
const userOf = (index: number): string => callArgs(index).messages[0]?.content ?? '';

beforeEach(() => {
  parseMock.mockReset();
});

describe('the menu is the whole world', () => {
  it('throws away an outfit that names a garment the menu does not hold', async () => {
    parseMock.mockResolvedValueOnce(answer(GOOD_A, GOOD_B, OFF_MENU));

    const result = await compose(ENV, INPUT);

    expect(result.outfits).toHaveLength(2);
    expect(result.rejected).toEqual(['outfit 3: tee-navy-slub is not in the base menu']);
  });

  it('says which slot the missing id was named in', async () => {
    parseMock.mockResolvedValueOnce(
      answer(GOOD_A, GOOD_B, proposal({ shoes: 'derbies-oxblood', citedRules: [] })),
    );

    const result = await compose(ENV, INPUT);

    expect(result.rejected[0]).toContain('shoes menu');
  });
});

describe('warmth', () => {
  it('throws away an outfit whose layers do not reach the band for the day', async () => {
    parseMock.mockResolvedValueOnce(answer(GOOD_A, GOOD_B, TOO_COLD));

    const result = await compose(ENV, INPUT);

    expect(result.outfits).toHaveLength(2);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]).toContain('core warmth came to 1');
    expect(result.rejected[0]).toContain(`${CONSTRAINTS.warmth.core.min} to ${CONSTRAINTS.warmth.core.max}`);
  });
});

describe('resampling', () => {
  it('does not call twice when the first set already gives two outfits', async () => {
    parseMock.mockResolvedValueOnce(answer(GOOD_A, GOOD_B, OFF_MENU));

    await compose(ENV, INPUT);

    expect(parseMock).toHaveBeenCalledTimes(1);
  });

  it('makes exactly one more call when fewer than two certify', async () => {
    parseMock
      .mockResolvedValueOnce(answer(GOOD_A, OFF_MENU, TOO_COLD))
      .mockResolvedValueOnce(answer(GOOD_B, GOOD_C, OFF_MENU));

    const result = await compose(ENV, INPUT);

    expect(parseMock).toHaveBeenCalledTimes(2);
    expect(result.outfits).toHaveLength(3);
    expect(result.rejected).toHaveLength(3);
  });

  it('hands the second call what failed and asks for a fresh composition, not a repair', async () => {
    parseMock
      .mockResolvedValueOnce(answer(GOOD_A, OFF_MENU, TOO_COLD))
      .mockResolvedValueOnce(answer(GOOD_B, GOOD_C, GOOD_A));

    await compose(ENV, INPUT);

    const second = userOf(1);
    expect(second).toContain('tee-navy-slub is not in the base menu');
    expect(second).toContain('core warmth came to 1');
    expect(second).toContain('write new rationales');
    expect(second).not.toContain(GOOD_A.rationale);
  });

  it('keeps the system prompt byte for byte across both calls, so the cached prefix holds', async () => {
    parseMock
      .mockResolvedValueOnce(answer(OFF_MENU, OFF_MENU, OFF_MENU))
      .mockResolvedValueOnce(answer(GOOD_A, GOOD_B, GOOD_C));

    await compose(ENV, INPUT);

    expect(systemOf(1)).toBe(systemOf(0));
  });

  it('stops at two calls even when the second set fails as badly as the first', async () => {
    parseMock
      .mockResolvedValueOnce(answer(OFF_MENU, TOO_COLD))
      .mockResolvedValueOnce(answer(OFF_MENU, TOO_COLD))
      .mockResolvedValueOnce(answer(GOOD_A, GOOD_B, GOOD_C));

    const result = await compose(ENV, INPUT);

    expect(parseMock).toHaveBeenCalledTimes(2);
    expect(result.outfits).toHaveLength(0);
  });

  it('answers with nothing and says why rather than inventing an outfit', async () => {
    parseMock
      .mockResolvedValueOnce(answer(OFF_MENU, TOO_COLD))
      .mockResolvedValueOnce(answer(OFF_MENU, TOO_COLD));

    const result = await compose(ENV, INPUT);

    expect(result.outfits).toEqual([]);
    expect(result.rejected).toHaveLength(4);
    for (const reason of result.rejected) expect(reason).toMatch(/^outfit \d: \S/);
  });

  it('treats an unparsable answer as a failed round rather than a crash', async () => {
    parseMock
      .mockResolvedValueOnce({ parsed_output: null, stop_reason: 'max_tokens' })
      .mockResolvedValueOnce(answer(GOOD_A, GOOD_B, GOOD_C));

    const result = await compose(ENV, INPUT);

    expect(parseMock).toHaveBeenCalledTimes(2);
    expect(result.outfits).toHaveLength(3);
    expect(result.rejected[0]).toContain('nothing in the shape asked for');
  });
});

describe('a starved required slot', () => {
  it('answers empty without spending a call', async () => {
    const winterOnly = WARDROBE.filter((g) => g.slot !== 'shoes');
    const starved = buildMenu(winterOnly, CONSTRAINTS, [], 'rectangle', AUTUMN_DAY);

    const result = await compose(ENV, { ...INPUT, menu: starved });

    expect(parseMock).not.toHaveBeenCalled();
    expect(result.outfits).toEqual([]);
    expect(result.rejected[0]).toContain('shoes');
  });
});

describe('the system prompt', () => {
  it('carries only the rules for the body it was built for', async () => {
    const prompt = systemPrompt(RECTANGLE);

    expect(prompt).toContain('rect-01');
    expect(prompt).toContain('rect-07');
    expect(prompt).toContain('all-01');
    expect(prompt).not.toContain('tri-0');
    expect(prompt).not.toContain('inv-0');
    expect(prompt).not.toContain('circ-0');
  });

  it('swaps the whole rule set when the body type changes', () => {
    const circular = systemPrompt({ ...RECTANGLE, bodyType: 'circular' });

    expect(circular).toContain('circ-01');
    expect(circular).toContain('all-02');
    expect(circular).not.toContain('rect-0');
    expect(circular).not.toContain('tri-0');
    expect(circular).not.toContain('inv-0');
  });

  it('reuses the vision pass calibration rather than inventing a second scale', () => {
    const anchors = calibrationAnchors();

    expect(anchors).toContain('WARMTH, 0 to 5.');
    expect(anchors).toContain('FORMALITY, 1 to 5.');
    expect(anchors).toContain('5  heavy parka, expedition coat');
    expect(anchors).toContain('1  gym and loungewear');
    expect(systemPrompt(RECTANGLE)).toContain(anchors);
  });

  it('asks for the rationale in the language the profile stores', () => {
    expect(systemPrompt(RECTANGLE)).toContain('in English');
    expect(systemPrompt({ ...RECTANGLE, language: 'es' })).toContain('in Spanish');
  });

  it('is the cached half of the request', async () => {
    parseMock.mockResolvedValueOnce(answer(GOOD_A, GOOD_B, GOOD_C));

    await compose(ENV, INPUT);

    const call = parseMock.mock.calls[0]?.[0] as {
      model: string;
      system: { cache_control?: { type: string } }[];
    };
    expect(call.model).toBe('claude-opus-5');
    expect(call.system[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('the body the prompt describes', () => {
  const SHOULDER_WORDS: Readonly<Record<BodyProfile['shouldersVsHips'], string>> = {
    wider: 'the shoulders are wider than the hips',
    narrower: 'the shoulders are narrower than the hips',
    equal: 'the shoulders and the hips are about the same width',
  };
  const VOLUME_WORDS: Readonly<Record<BodyProfile['volume'], string>> = {
    top: 'the volume sits up top',
    bottom: 'the volume sits low',
    center: 'the volume sits in the center',
    even: 'the volume is spread evenly',
  };
  const LINE_WORDS: Readonly<Record<BodyProfile['line'], string>> = {
    straight: 'The line of the body is straight, with little marked volume.',
    curved: 'The line of the body is curved.',
  };
  const waistWords = (widest: boolean): string =>
    widest ? 'the waist is the widest part of the body' : 'the waist is not the widest part of the body';
  const legWords = (thin: boolean): string => (thin ? 'The legs are thin.' : 'The legs are not thin.');

  const LINES: readonly BodyProfile['line'][] = ['straight', 'curved'];
  const THIN_LEGS: readonly boolean[] = [true, false];
  const THIN_LEG_NOTE = 'inv-04 is the rule that says so';

  it('carries all five mirror answers, whatever the line and the legs are', () => {
    for (const line of LINES) {
      for (const thinLegs of THIN_LEGS) {
        const prompt = systemPrompt({ ...RECTANGLE, line, thinLegs });

        expect(prompt).toContain(SHOULDER_WORDS[RECTANGLE.shouldersVsHips]);
        expect(prompt).toContain(waistWords(RECTANGLE.waistIsWidest));
        expect(prompt).toContain(VOLUME_WORDS[RECTANGLE.volume]);
        expect(prompt).toContain(LINE_WORDS[line]);
        expect(prompt).toContain(legWords(thinLegs));
      }
    }
  });

  it('says which way each of the three deciding answers went', () => {
    for (const shouldersVsHips of Object.keys(SHOULDER_WORDS) as BodyProfile['shouldersVsHips'][]) {
      expect(systemPrompt({ ...RECTANGLE, shouldersVsHips })).toContain(SHOULDER_WORDS[shouldersVsHips]);
    }
    for (const volume of Object.keys(VOLUME_WORDS) as BodyProfile['volume'][]) {
      expect(systemPrompt({ ...RECTANGLE, volume })).toContain(VOLUME_WORDS[volume]);
    }
    for (const waistIsWidest of [true, false]) {
      expect(systemPrompt({ ...RECTANGLE, waistIsWidest })).toContain(waistWords(waistIsWidest));
    }
  });

  it('says the line and the legs did not decide the type', () => {
    for (const line of LINES) {
      for (const thinLegs of THIN_LEGS) {
        expect(systemPrompt({ ...RECTANGLE, line, thinLegs })).toContain('did not decide the type');
      }
    }
  });

  it('asks for more trouser volume only for an inverted triangle with thin legs', () => {
    const inverted = { ...RECTANGLE, bodyType: 'inverted_triangle' as const };

    expect(systemPrompt({ ...inverted, thinLegs: true })).toContain(THIN_LEG_NOTE);
    expect(systemPrompt({ ...inverted, thinLegs: false })).not.toContain(THIN_LEG_NOTE);

    for (const bodyType of ['rectangle', 'triangle', 'circular'] as const) {
      expect(systemPrompt({ ...RECTANGLE, bodyType, thinLegs: true })).not.toContain(THIN_LEG_NOTE);
    }
  });

  it('leaves the rule text to the rule block rather than repeating it', () => {
    const inv04 = rulesFor('inverted_triangle').find((rule) => rule.id === 'inv-04');
    const prompt = systemPrompt({ ...RECTANGLE, bodyType: 'inverted_triangle', thinLegs: true });

    expect(prompt.split(inv04?.because ?? 'missing').length).toBe(2);
  });
});

describe('the rule lines the prompt carries', () => {
  const BODY_TYPES: readonly BodyType[] = ['rectangle', 'triangle', 'inverted_triangle', 'circular'];

  function ruleById(bodyType: BodyType, id: string): BookRule {
    const rule = rulesFor(bodyType).find((candidate) => candidate.id === id);
    if (rule === undefined) throw new Error(`${id} is not a rule for ${bodyType}`);
    return rule;
  }

  it('renders no two rules the same way, for any body', () => {
    for (const bodyType of BODY_TYPES) {
      const lines = rulesFor(bodyType).map(ruleLine);
      const byMeaning = new Map<string, string[]>();
      for (const rule of rulesFor(bodyType)) {
        // Ids are unique already, so what one line shares with another is
        // everything after the id: the scope and the book's sentence.
        const rest = ruleLine(rule).slice(`  ${rule.id}`.length);
        byMeaning.set(rest, [...(byMeaning.get(rest) ?? []), rule.id]);
      }
      const collisions = [...byMeaning.values()].filter((ids) => ids.length > 1);

      expect({ bodyType, collisions }).toEqual({ bodyType, collisions: [] });
      expect(new Set(lines).size).toBe(lines.length);
    }
  });

  it('gives every line its id and a scope', () => {
    for (const bodyType of BODY_TYPES) {
      const prompt = systemPrompt({ ...RECTANGLE, bodyType });
      for (const rule of rulesFor(bodyType)) {
        const scope = ruleScope(rule);

        expect(scope.trim()).toBe(scope);
        expect(scope).not.toBe('');
        expect(ruleLine(rule)).toBe(`  ${rule.id} (${scope}): ${rule.because}`);
        expect(prompt).toContain(ruleLine(rule));
      }
    }
  });

  it('reads an outfit rule\'s scope off the rule, so a new one cannot be written without one', () => {
    for (const bodyType of BODY_TYPES) {
      for (const rule of rulesFor(bodyType)) {
        if (rule.kind !== 'outfit') continue;

        // The scope used to live in a table in compose.ts keyed by rule id, where
        // a rule nobody added an entry for was described as the whole outfit.
        // That is a lie about what the rule was judged over and it was silent.
        expect(ruleScope(rule)).toBe(rule.scope);
        expect(rule.scope.trim()).not.toBe('');
      }
    }
  });

  it('tells the two halves of one book line apart by what each one reads', () => {
    const halves = [
      ['rectangle', 'rect-05a', 'rect-05b'],
      ['rectangle', 'rect-06a', 'rect-06b'],
      ['inverted_triangle', 'inv-08a', 'inv-08b'],
    ] as const;

    for (const [bodyType, a, b] of halves) {
      expect(ruleById(bodyType, a).because).toBe(ruleById(bodyType, b).because);
      expect(ruleById(bodyType, a).short).toBe(ruleById(bodyType, b).short);
      expect(ruleScope(ruleById(bodyType, a))).not.toBe(ruleScope(ruleById(bodyType, b)));
    }
  });

  it('lets all-01 and all-02 claim a principle instead of a verdict they never give', () => {
    for (const id of ['all-01', 'all-02']) {
      const rule = ruleById('rectangle', id);

      expect(ruleScope(rule)).toBe(PRINCIPLE);
      expect(ruleScope(rule)).not.toBe('the whole outfit');
      expect(ruleLine(rule)).toBe(`  ${id} (${PRINCIPLE}): ${rule.because}`);
    }

    for (const bodyType of BODY_TYPES) {
      for (const rule of rulesFor(bodyType)) {
        if (rule.id.startsWith('all-')) continue;
        expect(ruleScope(rule)).not.toBe(PRINCIPLE);
      }
    }
  });

  it('names one slot in plain words rather than as a list of one', () => {
    expect(ruleScope(ruleById('rectangle', 'rect-04'))).toBe('trousers');
    expect(ruleScope(ruleById('inverted_triangle', 'inv-08a'))).toBe('coats and jackets');
    expect(ruleScope(ruleById('rectangle', 'rect-03'))).toBe('tops');
  });

  it('joins several slots as a sentence and never as a fragment', () => {
    expect(ruleScope(ruleById('rectangle', 'rect-05a'))).toBe('trousers and coats');
    expect(ruleScope(ruleById('rectangle', 'rect-02'))).toBe('tops, coats and trousers');

    for (const bodyType of BODY_TYPES) {
      for (const rule of rulesFor(bodyType)) {
        const scope = ruleScope(rule);

        expect(scope).not.toContain(', and');
        expect(scope.startsWith('and ')).toBe(false);
        expect(scope.endsWith(' and')).toBe(false);
        if (rule.kind === 'garment' && scope.includes(',')) expect(scope).toContain(' and ');
      }
    }
  });
});

describe('the short line on every rule', () => {
  const ids = (failing: (rule: BookRule) => boolean): string[] =>
    BOOK_RULES.filter(failing).map((rule) => rule.id);

  it('is there on every rule and fits on a pill', () => {
    expect(ids((rule) => rule.short.trim() !== rule.short || rule.short === '')).toEqual([]);
    // The pill is roughly 150px wide at 13px. Past six words the grid of them
    // stops being scannable, which is the whole reason the line exists.
    expect(ids((rule) => rule.short.split(/\s+/).length > 6)).toEqual([]);
  });

  it('is a label in sentence case, not a sentence', () => {
    expect(ids((rule) => rule.short.endsWith('.'))).toEqual([]);
    expect(ids((rule) => !/^[A-Z]/.test(rule.short))).toEqual([]);
    // The card shows both, so the two must never say the same thing twice.
    expect(ids((rule) => rule.short === rule.because)).toEqual([]);
  });

  it('travels to the client beside the sentence', () => {
    for (const rule of BOOK_RULES) {
      expect(ruleView(rule)).toEqual({ id: rule.id, short: rule.short, because: rule.because });
    }
  });
});

describe('the user message', () => {
  it('lists the menu by slot with the fields the book rules read', () => {
    const message = userMessage(INPUT);

    expect(message).toContain('trousers-wool-charcoal');
    expect(message).toContain('rise high');
    expect(message).toContain('leg wide');
    expect(message).toContain('neck open');
    expect(message).toContain('warmth 3');
    expect(message).toContain('formality 5');
  });

  it('leaves out every garment the menu already filtered away', () => {
    const message = userMessage(INPUT);

    expect(message).not.toContain('jeans-black-skinny');
    expect(message).not.toContain('shorts-khaki');
  });

  it('says how long ago each piece was worn', () => {
    expect(userMessage(INPUT)).toContain('not worn recently');
  });

  it('spells out both warmth bands with their numbers', () => {
    const message = userMessage(INPUT);

    expect(message).toContain(`between ${CONSTRAINTS.warmth.core.min} and ${CONSTRAINTS.warmth.core.max}`);
    expect(message).toContain(
      `between ${CONSTRAINTS.warmth.withOuter.min} and ${CONSTRAINTS.warmth.withOuter.max}`,
    );
    expect(message).toContain(CONSTRAINTS.warmth.label);
  });

  it('names the moment, the formality floor and the season', () => {
    const message = userMessage(INPUT);

    expect(message).toContain('errands');
    expect(message).toContain('morning');
    expect(message).toContain('autumn');
    expect(message).toContain(`${CONSTRAINTS.minFormality} and up`);
  });

  it('says plainly which slots have nothing in them', () => {
    const noOuter = buildMenu(
      WARDROBE.filter((g) => g.slot !== 'outer'),
      CONSTRAINTS,
      [],
      'rectangle',
      AUTUMN_DAY,
    );

    expect(userMessage({ ...INPUT, menu: noOuter })).toContain('SLOTS WITH NOTHING IN THEM\n  outer');
  });
});

describe('the certified outfit that comes back', () => {
  it('carries the pieces in wearing order with the rules it cited resolved', async () => {
    parseMock.mockResolvedValueOnce(answer(GOOD_A, GOOD_B, GOOD_C));

    const [first] = (await compose(ENV, INPUT)).outfits;

    expect(first?.pieces.map((piece) => piece.slot)).toEqual([
      'base',
      'top',
      'outer',
      'bottom',
      'shoes',
    ]);
    expect(first?.accessories.map((g) => g.id)).toEqual(['belt-brown']);
    expect(first?.rationale).toBe(GOOD_A.rationale);
    expect(first?.cited).toEqual([
      { id: 'rect-01', short: 'Layers or a V-neckline', because: expect.stringContaining('V-necks') },
    ]);
    expect(first?.warmthCore).toBe(3);
    expect(first?.warmthWithOuter).toBe(6);
  });

  it('shows the preference rules it knowingly missed rather than hiding them', async () => {
    parseMock.mockResolvedValueOnce(answer(GOOD_A, GOOD_B, GOOD_C));

    const [first] = (await compose(ENV, INPUT)).outfits;

    expect(first?.missed.length).toBeGreaterThan(0);
    for (const missed of first?.missed ?? []) {
      expect(missed.id.startsWith('rect-') || missed.id.startsWith('all-')).toBe(true);
    }
  });
});

