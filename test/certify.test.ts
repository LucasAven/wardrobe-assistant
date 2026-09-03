import { describe, expect, it } from 'vitest';
import { RULES_BY_ID, outermostTorso } from '../src/domain/bookRules';
import { certify, resolveOutfit } from '../src/domain/certify';
import { deriveConstraints } from '../src/domain/constraints';
import { buildMenu } from '../src/domain/menu';
import type {
  BodyType,
  CertifiedOutfit,
  Constraints,
  Garment,
  GarmentRule,
  Menu,
  OutfitProposal,
  OutfitRule,
  RejectionReason,
  ResolvedOutfit,
  Slot,
} from '../src/domain/types';
import {
  AUTUMN_DAY,
  HOT_ERRANDS,
  MILD_ERRANDS,
  SUMMER_DAY,
  WARDROBE,
  garmentById,
  makeGarment,
  proposal,
} from './fixtures';

const CONSTRAINTS: Constraints = deriveConstraints(MILD_ERRANDS);
const MENU: Menu = buildMenu(WARDROBE, CONSTRAINTS, [], 'rectangle', AUTUMN_DAY);

const LAYERED = proposal({
  base: 'tee-white',
  top: 'oxford-blue',
  outer: 'trench-navy',
  bottom: 'jeans-indigo',
  shoes: 'sneakers-white',
  accessories: ['belt-brown'],
  citedRules: ['rect-01', 'all-01'],
});

function resolved(result: ResolvedOutfit | RejectionReason[]): ResolvedOutfit {
  if (Array.isArray(result)) throw new Error(`unexpected rejection: ${JSON.stringify(result)}`);
  return result;
}

function rejected(result: ResolvedOutfit | RejectionReason[]): readonly RejectionReason[] {
  if (!Array.isArray(result)) throw new Error('expected a rejection');
  return result;
}

function certified(result: CertifiedOutfit | RejectionReason[]): CertifiedOutfit {
  if (Array.isArray(result)) throw new Error(`unexpected rejection: ${JSON.stringify(result)}`);
  return result;
}

function certifyRejected(result: CertifiedOutfit | RejectionReason[]): readonly RejectionReason[] {
  if (!Array.isArray(result)) throw new Error('expected a rejection');
  return result;
}

function garmentRule(id: string): GarmentRule {
  const rule = RULES_BY_ID.get(id);
  if (rule === undefined || rule.kind !== 'garment') throw new Error(`no garment rule ${id}`);
  return rule;
}

function outfitRule(id: string): OutfitRule {
  const rule = RULES_BY_ID.get(id);
  if (rule === undefined || rule.kind !== 'outfit') throw new Error(`no outfit rule ${id}`);
  return rule;
}

/** Enough of an outfit to run one rule against. Never certified, so warmth is free. */
function wearing(pieces: Readonly<Partial<Record<Slot, Garment>>>): ResolvedOutfit {
  return { pieces, accessories: [], proposal: proposal({ citedRules: [] }) };
}

function missedFor(
  outfit: OutfitProposal,
  menu: Menu,
  constraints: Constraints,
  bodyType: BodyType,
): readonly string[] {
  return certified(certify(resolved(resolveOutfit(outfit, menu)), constraints, bodyType)).missed.map(
    (rule) => rule.id,
  );
}

describe('resolveOutfit', () => {
  it('turns menu ids into garments', () => {
    const outfit = resolved(resolveOutfit(LAYERED, MENU));

    expect(outfit.pieces.base?.subtype).toBe('cotton t-shirt');
    expect(outfit.pieces.outer?.id).toBe('trench-navy');
    expect(outfit.pieces.mid).toBeUndefined();
    expect(outfit.accessories.map((g) => g.id)).toEqual(['belt-brown']);
    expect(outfit.proposal).toBe(LAYERED);
  });

  it('rejects an id that is in the wardrobe but not in the menu', () => {
    const inWardrobe = WARDROBE.some((g) => g.id === 'shorts-khaki');
    const inMenu = MENU.bySlot.bottom.some((entry) => entry.garment.id === 'shorts-khaki');

    expect(inWardrobe).toBe(true);
    expect(inMenu).toBe(false);
    expect(rejected(resolveOutfit(proposal({ bottom: 'shorts-khaki' }), MENU))).toEqual([
      { kind: 'unknown_garment', slot: 'bottom', id: 'shorts-khaki' },
    ]);
  });

  it('rejects an id that exists nowhere at all', () => {
    expect(rejected(resolveOutfit(proposal({ shoes: 'invented-clogs' }), MENU))).toEqual([
      { kind: 'unknown_garment', slot: 'shoes', id: 'invented-clogs' },
    ]);
  });

  it('collects every bad id instead of stopping at the first', () => {
    const reasons = rejected(
      resolveOutfit(
        proposal({ base: 'tank-gray', mid: 'knit-cream-heavy', accessories: ['no-such-belt'] }),
        MENU,
      ),
    );

    expect(reasons.map((r) => r.kind)).toEqual([
      'unknown_garment',
      'unknown_garment',
      'unknown_garment',
    ]);
  });

  it('names an empty required slot as missing rather than unknown', () => {
    expect(rejected(resolveOutfit(proposal({ shoes: '' }), MENU))).toEqual([
      { kind: 'missing_required_slot', slot: 'shoes' },
    ]);
  });

  it('rejects the same garment worn in two slots', () => {
    expect(
      rejected(resolveOutfit(proposal({ base: 'tee-white', top: 'tee-white' }), MENU)),
    ).toEqual([{ kind: 'duplicate_garment', id: 'tee-white', slots: ['base', 'top'] }]);
  });

  it('rejects the same accessory named twice', () => {
    expect(
      rejected(resolveOutfit(proposal({ accessories: ['belt-brown', 'belt-brown'] }), MENU)),
    ).toEqual([
      { kind: 'duplicate_garment', id: 'belt-brown', slots: ['accessory', 'accessory'] },
    ]);
  });
});

describe('outermostTorso', () => {
  it('reads outer before mid before top before base', () => {
    const outfit = resolved(resolveOutfit(LAYERED, MENU));

    expect(outfit.pieces.base?.id).toBe('tee-white');
    expect(outermostTorso(outfit)?.id).toBe('trench-navy');
  });

  it('is null when nothing is on the torso', () => {
    const bottomOnly: ResolvedOutfit = {
      pieces: { bottom: garmentById('jeans-indigo'), shoes: garmentById('sneakers-white') },
      accessories: [],
      proposal: proposal({ citedRules: [] }),
    };

    expect(outermostTorso(bottomOnly)).toBeNull();
  });
});

describe('certify', () => {
  it('passes an outfit that sits inside both warmth bands', () => {
    const outfit = certified(certify(resolved(resolveOutfit(LAYERED, MENU)), CONSTRAINTS, 'rectangle'));

    expect(outfit.warmthCore).toBe(3);
    expect(outfit.warmthWithOuter).toBe(6);
    expect(outfit.warmthCore).toBeGreaterThanOrEqual(CONSTRAINTS.warmth.core.min);
    expect(outfit.warmthCore).toBeLessThanOrEqual(CONSTRAINTS.warmth.core.max);
    expect(outfit.cited.map((rule) => rule.id)).toEqual(['rect-01', 'all-01']);
  });

  it('rejects a core that is too light even when the coat covers the total', () => {
    const bare = proposal({ base: 'tee-white', outer: 'wool-coat-camel', citedRules: [] });
    const reasons = certifyRejected(
      certify(resolved(resolveOutfit(bare, MENU)), CONSTRAINTS, 'rectangle'),
    );

    expect(reasons).toContainEqual({ kind: 'warmth_out_of_band', band: 'core', got: 1 });
  });

  it('rejects a stack that is too warm once the coat goes on', () => {
    const heavy = proposal({
      base: 'tee-white',
      top: 'flannel-check',
      mid: 'blazer-navy',
      outer: 'wool-coat-camel',
      citedRules: [],
    });
    const reasons = certifyRejected(
      certify(resolved(resolveOutfit(heavy, MENU)), CONSTRAINTS, 'rectangle'),
    );

    expect(reasons).toContainEqual({ kind: 'warmth_out_of_band', band: 'withOuter', got: 12 });
  });

  it('rejects a citation of a rule the outfit violates', () => {
    const jeans = garmentById('jeans-indigo');
    const straightLegRule = RULES_BY_ID.get('rect-04');

    expect(straightLegRule?.kind).toBe('garment');
    expect(jeans.leg).toBe('straight');

    const reasons = certifyRejected(
      certify(
        resolved(resolveOutfit(proposal({ ...LAYERED, citedRules: ['rect-04'] }), MENU)),
        CONSTRAINTS,
        'rectangle',
      ),
    );

    expect(reasons).toEqual([{ kind: 'cited_violated_rule', id: 'rect-04' }]);
  });

  it('rejects a citation of a rule written for another body', () => {
    const reasons = certifyRejected(
      certify(
        resolved(resolveOutfit(proposal({ ...LAYERED, citedRules: ['circ-04'] }), MENU)),
        CONSTRAINTS,
        'rectangle',
      ),
    );

    expect(RULES_BY_ID.has('circ-04')).toBe(true);
    expect(reasons).toEqual([{ kind: 'rule_not_for_this_body', id: 'circ-04' }]);
  });

  it('rejects a citation of a rule that does not exist', () => {
    const reasons = certifyRejected(
      certify(
        resolved(resolveOutfit(proposal({ ...LAYERED, citedRules: ['rect-99'] }), MENU)),
        CONSTRAINTS,
        'rectangle',
      ),
    );

    expect(reasons).toEqual([{ kind: 'unknown_rule', id: 'rect-99' }]);
  });

  it('reports the prefer rules the outfit misses without repairing anything', () => {
    const outfit = certified(certify(resolved(resolveOutfit(LAYERED, MENU)), CONSTRAINTS, 'rectangle'));
    const missedIds = outfit.missed.map((rule) => rule.id);

    expect(missedIds).toContain('rect-04');
    expect(missedIds).not.toContain('rect-01');
    expect(outfit.missed.every((rule) => rule.severity === 'prefer')).toBe(true);
    expect(outfit.pieces.bottom?.id).toBe('jeans-indigo');
  });

  it('catches a menu that let a required book dont through', () => {
    const offBook: ResolvedOutfit = {
      pieces: {
        base: garmentById('tee-white'),
        bottom: garmentById('jeans-indigo'),
        shoes: garmentById('sneakers-white'),
      },
      accessories: [],
      proposal: proposal({ citedRules: [] }),
    };

    const reasons = certifyRejected(certify(offBook, CONSTRAINTS, 'circular'));

    expect(reasons).toContainEqual({ kind: 'broke_required_rule', id: 'circ-08' });
  });
});

describe('require rules that need the assembled outfit', () => {
  const SUMMER: Constraints = deriveConstraints(HOT_ERRANDS);
  const TRIANGLE_MENU: Menu = buildMenu(WARDROBE, SUMMER, [], 'triangle', SUMMER_DAY);

  it('rejects a tank a triangle leaves on show', () => {
    const bare = proposal({
      base: 'tank-gray',
      bottom: 'jeans-indigo',
      shoes: 'sneakers-white',
      citedRules: [],
    });

    expect(garmentById('tank-gray').sleeves).toBe('none');
    expect(
      certifyRejected(certify(resolved(resolveOutfit(bare, TRIANGLE_MENU)), SUMMER, 'triangle')),
    ).toEqual([{ kind: 'broke_required_rule', id: 'tri-08' }]);
  });

  it('accepts the same tank once a shirt covers it', () => {
    const covered = proposal({
      base: 'tank-gray',
      top: 'polo-navy',
      bottom: 'jeans-indigo',
      shoes: 'sneakers-white',
      citedRules: [],
    });

    const outfit = certified(
      certify(resolved(resolveOutfit(covered, TRIANGLE_MENU)), SUMMER, 'triangle'),
    );

    expect(outfit.pieces.base?.id).toBe('tank-gray');
    expect(outermostTorso(outfit)?.id).toBe('polo-navy');
  });

  it('accepts a tank under a long sleeve shirt', () => {
    const covered = proposal({
      base: 'tank-gray',
      top: 'linen-shirt-beige',
      bottom: 'jeans-indigo',
      shoes: 'sneakers-white',
      citedRules: [],
    });

    expect(garmentById('linen-shirt-beige').sleeves).toBe('long');

    const outfit = certified(
      certify(resolved(resolveOutfit(covered, TRIANGLE_MENU)), SUMMER, 'triangle'),
    );

    expect(outfit.pieces.base?.id).toBe('tank-gray');
    expect(outermostTorso(outfit)?.id).toBe('linen-shirt-beige');
  });

  it('accepts a sleeveless gilet over a long sleeve tee', () => {
    const autumnMenu = buildMenu(WARDROBE, CONSTRAINTS, [], 'triangle', AUTUMN_DAY);
    const gileted = proposal({
      base: 'henley-navy',
      outer: 'gilet-olive',
      bottom: 'jeans-indigo',
      shoes: 'sneakers-white',
      citedRules: [],
    });

    expect(garmentById('gilet-olive').sleeves).toBe('none');
    expect(garmentById('henley-navy').sleeves).toBe('long');

    const outfit = certified(
      certify(resolved(resolveOutfit(gileted, autumnMenu)), CONSTRAINTS, 'triangle'),
    );

    expect(outermostTorso(outfit)?.id).toBe('gilet-olive');
  });

  it('judges a past-waist shirt only while it is the layer on show', () => {
    const warm = deriveConstraints({ ...MILD_ERRANDS, feelsLikeC: 20 });
    const warmMenu = buildMenu(WARDROBE, warm, [], 'circular', AUTUMN_DAY);
    const onShow = proposal({
      base: 'tee-white',
      top: 'oxford-blue',
      bottom: 'chinos-stone',
      shoes: 'sneakers-white',
      citedRules: [],
    });

    expect(garmentById('oxford-blue').hem).toBe('past_waist');
    expect(
      certifyRejected(certify(resolved(resolveOutfit(onShow, warmMenu)), warm, 'circular')),
    ).toEqual([{ kind: 'broke_required_rule', id: 'circ-06' }]);

    const cool = deriveConstraints({ ...MILD_ERRANDS, feelsLikeC: 8, hoursOutdoors: 1 });
    const coolMenu = buildMenu(WARDROBE, cool, [], 'circular', AUTUMN_DAY);
    const outfit = certified(
      certify(
        resolved(resolveOutfit(proposal({ ...onShow, mid: 'cardigan-gray' }), coolMenu)),
        cool,
        'circular',
      ),
    );

    expect(outfit.pieces.top?.id).toBe('oxford-blue');
    expect(outermostTorso(outfit)?.id).toBe('cardigan-gray');
  });

  it('stops judging a past-waist shirt once a coat is the layer on show', () => {
    const warm = deriveConstraints({ ...MILD_ERRANDS, feelsLikeC: 20 });
    const warmMenu = buildMenu(WARDROBE, warm, [], 'circular', AUTUMN_DAY);
    const onShow = proposal({
      base: 'tee-white',
      top: 'oxford-blue',
      bottom: 'chinos-stone',
      shoes: 'sneakers-white',
      citedRules: [],
    });

    expect(
      certifyRejected(certify(resolved(resolveOutfit(onShow, warmMenu)), warm, 'circular')),
    ).toEqual([{ kind: 'broke_required_rule', id: 'circ-06' }]);

    const coated = certified(
      certify(
        resolved(resolveOutfit(proposal({ ...onShow, outer: 'rain-jacket-black' }), warmMenu)),
        warm,
        'circular',
      ),
    );

    expect(garmentById('rain-jacket-black').hem).toBe('hip');
    expect(coated.pieces.top?.id).toBe('oxford-blue');
    expect(outermostTorso(coated)?.id).toBe('rain-jacket-black');
  });
});

describe('prefer rules and outerwear', () => {
  const COOL: Constraints = deriveConstraints({ ...MILD_ERRANDS, feelsLikeC: 8, hoursOutdoors: 1 });
  const MILD: Constraints = deriveConstraints({ ...MILD_ERRANDS, feelsLikeC: 12, hoursOutdoors: 1 });

  const COATED = proposal({
    base: 'henley-navy',
    outer: 'wool-coat-camel',
    bottom: 'trousers-wool-charcoal',
    shoes: 'chelsea-boots-black',
    citedRules: [],
  });

  const SHELLED = proposal({
    base: 'tee-merino-white',
    outer: 'rain-jacket-black',
    bottom: 'trousers-wool-charcoal',
    shoes: 'chelsea-boots-black',
    citedRules: [],
  });

  it('does not judge a coat by the circular rule about tops', () => {
    const menu = buildMenu(WARDROBE, COOL, [], 'circular', AUTUMN_DAY);

    expect(garmentById('wool-coat-camel').hem).toBe('below_hip');
    expect(garmentRule('circ-02').test(garmentById('wool-coat-camel'))).toBe(false);
    expect(missedFor(COATED, menu, COOL, 'circular')).not.toContain('circ-02');
    expect(garmentRule('circ-02').slots).toEqual(['base', 'top', 'mid']);
  });

  it('still trips the circular tops rule on a shirt under that coat', () => {
    const menu = buildMenu(WARDROBE, COOL, [], 'circular', AUTUMN_DAY);
    const shirted = proposal({ ...COATED, top: 'flannel-check' });

    expect(garmentById('flannel-check').hem).toBe('hip');
    expect(missedFor(shirted, menu, COOL, 'circular')).toContain('circ-02');
  });

  it('does not judge a coat by the rectangle rule about tops', () => {
    const menu = buildMenu(WARDROBE, COOL, [], 'rectangle', AUTUMN_DAY);

    expect(garmentById('henley-navy').neckline).toBe('v');
    expect(garmentRule('rect-03').test(garmentById('wool-coat-camel'))).toBe(false);
    expect(missedFor(COATED, menu, COOL, 'rectangle')).not.toContain('rect-03');
    expect(garmentRule('rect-03').slots).toEqual(['base', 'top', 'mid']);
  });

  it('still trips the rectangle tops rule on a polo under that coat', () => {
    const menu = buildMenu(WARDROBE, COOL, [], 'rectangle', AUTUMN_DAY);
    const poloed = proposal({ ...COATED, top: 'polo-navy' });

    expect(garmentById('polo-navy').hem).toBe('at_waist');
    expect(missedFor(poloed, menu, COOL, 'rectangle')).toContain('rect-03');
  });

  it('does not judge a coat by the inverted triangle rule about plain tops', () => {
    const menu = buildMenu(WARDROBE, MILD, [], 'inverted_triangle', AUTUMN_DAY);

    expect(garmentById('rain-jacket-black').structured).toBe(false);
    expect(garmentRule('inv-02').test(garmentById('rain-jacket-black'))).toBe(false);
    expect(missedFor(SHELLED, menu, MILD, 'inverted_triangle')).not.toContain('inv-02');
    expect(garmentRule('inv-02').slots).toEqual(['base', 'top', 'mid']);
  });

  it('still trips the plain tops rule on a polo under that shell', () => {
    const menu = buildMenu(WARDROBE, MILD, [], 'inverted_triangle', AUTUMN_DAY);
    const poloed = proposal({ ...SHELLED, top: 'polo-navy' });

    expect(garmentById('polo-navy').structured).toBe(false);
    expect(missedFor(poloed, menu, MILD, 'inverted_triangle')).toContain('inv-02');
  });

  it('reads a fitted coat as outerwear and a fitted tee as a top', () => {
    const bomber = makeGarment({
      id: 'bomber-fitted',
      slot: 'outer',
      subtype: 'bomber jacket',
      fit: 'fitted',
      neckline: 'high',
      sleeves: 'long',
      hem: 'at_waist',
    });
    const volumeBelow = { bottom: garmentById('trousers-wool-charcoal') };

    expect(garmentById('trousers-wool-charcoal').leg).toBe('wide');
    expect(garmentById('tee-white').fit).toBe('fitted');
    expect(
      outfitRule('inv-03').test(wearing({ ...volumeBelow, base: garmentById('henley-navy'), outer: bomber })),
    ).toBe(true);
    expect(outfitRule('inv-03').test(wearing({ ...volumeBelow, base: garmentById('tee-white') }))).toBe(
      false,
    );

    const skinny = { bottom: garmentById('jeans-black-skinny') };
    expect(garmentById('jeans-black-skinny').fit).toBe('tight');
    expect(outfitRule('inv-04').test(wearing({ ...skinny, outer: bomber }))).toBe(true);
    expect(outfitRule('inv-04').test(wearing({ ...skinny, base: garmentById('tee-white') }))).toBe(false);
  });

  it('reads a tight or sleeveless coat as outerwear and a tank as a top', () => {
    const vest = makeGarment({
      id: 'vest-tight',
      slot: 'outer',
      subtype: 'quilted vest',
      fit: 'tight',
      sleeves: 'none',
      hem: 'at_waist',
    });
    const tank = garmentById('tank-gray');
    const straight = { bottom: garmentById('jeans-indigo') };
    const tight = { bottom: garmentById('jeans-black-skinny') };

    expect(tank.fit).toBe('tight');
    expect(tank.sleeves).toBe('none');
    expect(garmentById('jeans-indigo').leg).toBe('straight');

    expect(outfitRule('rect-07').test(wearing({ ...straight, outer: vest }))).toBe(true);
    expect(outfitRule('rect-07').test(wearing({ ...straight, base: tank }))).toBe(false);
    expect(outfitRule('circ-09').test(wearing({ ...straight, outer: vest }))).toBe(true);
    expect(outfitRule('circ-09').test(wearing({ ...straight, base: tank }))).toBe(false);
    expect(outfitRule('tri-07').test(wearing({ ...tight, outer: vest }))).toBe(true);
    expect(outfitRule('tri-07').test(wearing({ ...tight, base: tank }))).toBe(false);
  });

  it('still judges a coat for structure and for the dark vertical line', () => {
    expect(garmentRule('rect-02').slots).toContain('outer');
    expect(garmentRule('rect-02').test(garmentById('rain-jacket-black'))).toBe(false);
    expect(garmentRule('rect-02').test(garmentById('wool-coat-camel'))).toBe(true);

    expect(garmentRule('circ-01').slots).toContain('outer');
    expect(garmentRule('circ-01').test(garmentById('wool-coat-camel'))).toBe(false);
    expect(garmentRule('circ-01').test(garmentById('trench-navy'))).toBe(true);
  });

  it('lets a coat satisfy the layering and shoulder color rules', () => {
    const tee = garmentById('tee-white');
    const shell = garmentById('rain-jacket-black');

    expect(shell.neckline).toBe('high');
    expect(outfitRule('rect-01').test(wearing({ base: tee }))).toBe(false);
    expect(outfitRule('rect-01').test(wearing({ base: tee, outer: shell }))).toBe(true);

    const creamCoat = makeGarment({
      id: 'coat-cream',
      slot: 'outer',
      subtype: 'wool coat',
      colors: ['cream'],
      fit: 'regular',
      hem: 'below_hip',
    });
    const darkBelow = { bottom: garmentById('trousers-wool-charcoal') };
    const navyBase = garmentById('henley-navy');

    expect(outfitRule('tri-01').test(wearing({ ...darkBelow, base: navyBase }))).toBe(false);
    expect(outfitRule('tri-01').test(wearing({ ...darkBelow, base: navyBase, outer: creamCoat }))).toBe(
      true,
    );

    expect(outfitRule('tri-03').test(wearing({ base: tee }))).toBe(false);
    expect(outfitRule('tri-03').test(wearing({ base: tee, outer: garmentById('trench-navy') }))).toBe(
      true,
    );
  });

  it('counts a coat in the one color check', () => {
    const navy = { base: garmentById('henley-navy'), top: garmentById('polo-navy') };

    expect(outfitRule('circ-03').test(wearing(navy))).toBe(true);
    expect(outfitRule('circ-03').test(wearing({ ...navy, outer: garmentById('wool-coat-camel') }))).toBe(
      false,
    );
  });
});
