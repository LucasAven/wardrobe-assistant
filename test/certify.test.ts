import { describe, expect, it } from 'vitest';
import { RULES_BY_ID, outermostTorso } from '../src/domain/bookRules';
import { certify, resolveOutfit } from '../src/domain/certify';
import { deriveConstraints } from '../src/domain/constraints';
import { buildMenu } from '../src/domain/menu';
import type {
  CertifiedOutfit,
  Constraints,
  Menu,
  RejectionReason,
  ResolvedOutfit,
} from '../src/domain/types';
import {
  AUTUMN_DAY,
  HOT_ERRANDS,
  MILD_ERRANDS,
  SUMMER_DAY,
  WARDROBE,
  garmentById,
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
    ).toEqual([{ kind: 'broke_required_rule', id: 'tri-08b' }]);
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
    ).toEqual([{ kind: 'broke_required_rule', id: 'circ-06b' }]);

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
});
