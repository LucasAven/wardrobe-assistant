import { describe, expect, it } from 'vitest';
import { BOOK_RULES, RULES_BY_ID } from '../src/domain/bookRules';
import { deriveConstraints } from '../src/domain/constraints';
import { buildMenu, rankSlot } from '../src/domain/menu';
import { resolveOutfit } from '../src/domain/certify';
import type { GarmentRule, Menu, MenuEntry, Slot, WearEvent } from '../src/domain/types';
import {
  AUTUMN_DAY,
  COOL_FORMAL,
  HOT_ERRANDS,
  MILD_ERRANDS,
  SUMMER_DAY,
  WARDROBE,
  WET_FORMAL,
  WINTER_DAY,
  daysBefore,
  garmentById,
  proposal,
} from './fixtures';

const SLOTS: readonly Slot[] = ['base', 'top', 'mid', 'outer', 'bottom', 'shoes', 'accessory'];

function idsIn(menu: Menu, slot: Slot): readonly string[] {
  return menu.bySlot[slot].map((entry) => entry.garment.id);
}

function everyEntry(menu: Menu): readonly MenuEntry[] {
  return SLOTS.flatMap((slot) => [...menu.bySlot[slot]]);
}

describe('distributive filters', () => {
  it('drops every casual piece at a formal event', () => {
    const constraints = deriveConstraints(COOL_FORMAL);
    const menu = buildMenu(WARDROBE, constraints, [], 'rectangle', WINTER_DAY);

    expect(constraints.minFormality).toBe(4);
    for (const entry of everyEntry(menu)) {
      expect(entry.garment.formality).toBeGreaterThanOrEqual(4);
    }
    expect(idsIn(menu, 'base')).not.toContain('tee-white');
    expect(idsIn(menu, 'bottom')).not.toContain('jeans-indigo');
    expect(idsIn(menu, 'shoes')).not.toContain('sneakers-white');
    expect(menu.starved).toEqual([]);
  });

  it('leaves no way to name an under-formal piece in a proposal', () => {
    const constraints = deriveConstraints(COOL_FORMAL);
    const menu = buildMenu(WARDROBE, constraints, [], 'rectangle', WINTER_DAY);

    const result = resolveOutfit(
      proposal({
        base: 'tee-white',
        bottom: 'trousers-wool-charcoal',
        shoes: 'oxfords-black',
      }),
      menu,
    );

    expect(result).toEqual([{ kind: 'unknown_garment', slot: 'base', id: 'tee-white' }]);
  });

  it('drops out-of-season pieces', () => {
    const constraints = deriveConstraints({ ...MILD_ERRANDS, date: WINTER_DAY });
    const menu = buildMenu(WARDROBE, constraints, [], 'rectangle', WINTER_DAY);

    expect(idsIn(menu, 'bottom')).not.toContain('shorts-khaki');
    expect(idsIn(menu, 'bottom')).toContain('jeans-indigo');
  });

  it('drops soakable outers and shoes only when it will actually rain on you', () => {
    const wet = buildMenu(
      WARDROBE,
      deriveConstraints({ ...MILD_ERRANDS, precipProbability: 0.7, hoursOutdoors: 3 }),
      [],
      'rectangle',
      AUTUMN_DAY,
    );
    const dry = buildMenu(WARDROBE, deriveConstraints(MILD_ERRANDS), [], 'rectangle', AUTUMN_DAY);

    expect(idsIn(wet, 'outer')).not.toContain('wool-coat-camel');
    expect(idsIn(wet, 'outer')).toContain('trench-navy');
    expect(idsIn(wet, 'shoes')).not.toContain('loafers-brown');
    expect(idsIn(dry, 'outer')).toContain('wool-coat-camel');
    expect(idsIn(dry, 'shoes')).toContain('loafers-brown');
  });

  it('applies only the book donts that are require and garment shaped', () => {
    const constraints = deriveConstraints(MILD_ERRANDS);
    const rectangle = buildMenu(WARDROBE, constraints, [], 'rectangle', AUTUMN_DAY);
    const triangle = buildMenu(WARDROBE, constraints, [], 'triangle', AUTUMN_DAY);

    expect(idsIn(rectangle, 'bottom')).not.toContain('jeans-black-skinny');
    expect(idsIn(triangle, 'bottom')).not.toContain('jeans-black-skinny');
    expect(idsIn(rectangle, 'bottom')).toContain('jeans-indigo');
    expect(idsIn(triangle, 'bottom')).toContain('jeans-indigo');
  });
});

describe('donts a later layer could cover', () => {
  it('keeps a sleeveless base for a triangle, because a top can still cover it', () => {
    const menu = buildMenu(WARDROBE, deriveConstraints(HOT_ERRANDS), [], 'triangle', SUMMER_DAY);

    expect(garmentById('tank-gray').sleeves).toBe('none');
    expect(idsIn(menu, 'base')).toContain('tank-gray');
  });

  it('keeps a past-waist shirt for a circular body instead of starving the torso', () => {
    const menu = buildMenu(WARDROBE, deriveConstraints(MILD_ERRANDS), [], 'circular', AUTUMN_DAY);

    expect(garmentById('oxford-blue').hem).toBe('past_waist');
    expect(idsIn(menu, 'top')).toContain('oxford-blue');
    expect(menu.bySlot.base.length).toBeGreaterThan(0);
  });

  it('filters the on-show half of a split rule and leaves the coverable half alone', () => {
    const menu = buildMenu(WARDROBE, deriveConstraints(HOT_ERRANDS), [], 'rectangle', SUMMER_DAY);

    expect(RULES_BY_ID.get('rect-05a')?.kind).toBe('garment');
    expect(RULES_BY_ID.get('rect-05b')?.kind).toBe('outfit');
    expect(garmentById('jeans-black-skinny').fit).toBe('tight');
    expect(garmentById('tank-gray').fit).toBe('tight');
    expect(idsIn(menu, 'bottom')).not.toContain('jeans-black-skinny');
    expect(idsIn(menu, 'base')).toContain('tank-gray');
  });

  it('keeps every coat for a circular body, because the tops rules are not about outerwear', () => {
    const menu = buildMenu(WARDROBE, deriveConstraints(MILD_ERRANDS), [], 'circular', AUTUMN_DAY);

    expect(RULES_BY_ID.get('circ-06')?.kind).toBe('outfit');
    expect(garmentById('wool-coat-camel').hem).toBe('below_hip');
    expect(garmentById('trench-navy').hem).toBe('below_hip');
    expect(idsIn(menu, 'outer')).toContain('wool-coat-camel');
    expect(idsIn(menu, 'outer')).toContain('trench-navy');
    expect(idsIn(menu, 'outer')).toContain('rain-jacket-black');
  });

  it('still filters a garment nothing can cover', () => {
    const menu = buildMenu(
      WARDROBE,
      deriveConstraints({ ...MILD_ERRANDS, date: WINTER_DAY }),
      [],
      'inverted_triangle',
      WINTER_DAY,
    );

    expect(garmentById('puffer-navy').shoulderBulk).toBe(true);
    expect(idsIn(menu, 'outer')).not.toContain('puffer-navy');
    expect(idsIn(menu, 'mid')).toContain('knit-cream-heavy');
  });

  it('has no require garment rule over a slot another layer can cover', () => {
    const coverable: readonly Slot[] = ['base', 'top', 'mid'];
    const filters = BOOK_RULES.filter(
      (rule): rule is GarmentRule => rule.kind === 'garment' && rule.severity === 'require',
    );

    expect(filters.length).toBeGreaterThan(0);
    expect(
      filters
        .filter((rule) => rule.slots.some((slot) => coverable.includes(slot)))
        .map((rule) => rule.id),
    ).toEqual([]);
  });
});

describe('cooldown', () => {
  it('hides a jacket worn two days ago and keeps the one that was not', () => {
    const constraints = deriveConstraints(MILD_ERRANDS);
    const recentWear: readonly WearEvent[] = [
      { wornOn: daysBefore(AUTUMN_DAY, 2), garmentIds: ['wool-coat-camel'] },
    ];
    const menu = buildMenu(WARDROBE, constraints, recentWear, 'rectangle', AUTUMN_DAY);

    expect(constraints.cooldownDays.outer).toBeGreaterThan(2);
    expect(idsIn(menu, 'outer')).not.toContain('wool-coat-camel');
    expect(idsIn(menu, 'outer')).toContain('trench-navy');
  });

  it('lets a jacket back once its cooldown has run out', () => {
    const constraints = deriveConstraints(MILD_ERRANDS);
    const recentWear: readonly WearEvent[] = [
      { wornOn: daysBefore(AUTUMN_DAY, 6), garmentIds: ['wool-coat-camel'] },
    ];
    const menu = buildMenu(WARDROBE, constraints, recentWear, 'rectangle', AUTUMN_DAY);

    expect(idsIn(menu, 'outer')).toContain('wool-coat-camel');
  });

  it('counts calendar days, so last night counts as one day ago', () => {
    const constraints = deriveConstraints(MILD_ERRANDS);
    const lastNight = new Date('2026-05-11T21:00:00Z');
    const menu = buildMenu(
      WARDROBE,
      constraints,
      [{ wornOn: lastNight, garmentIds: ['jeans-indigo'] }],
      'rectangle',
      AUTUMN_DAY,
    );

    const jeans = menu.bySlot.bottom.find((entry) => entry.garment.id === 'jeans-indigo');
    expect(jeans?.daysSince).toBe(1);
  });
});

describe('starvation floor', () => {
  it('re-admits the only waterproof boot rather than emptying the shoes slot', () => {
    const constraints = deriveConstraints(WET_FORMAL);
    const recentWear: readonly WearEvent[] = [
      { wornOn: daysBefore(WINTER_DAY, 1), garmentIds: ['chelsea-boots-black'] },
    ];
    const menu = buildMenu(WARDROBE, constraints, recentWear, 'rectangle', WINTER_DAY);

    expect(menu.bySlot.shoes).toHaveLength(1);
    expect(menu.bySlot.shoes[0]?.garment.id).toBe('chelsea-boots-black');
    expect(menu.bySlot.shoes[0]?.reAdmitted).toBe(true);
    expect(menu.bySlot.shoes[0]?.daysSince).toBe(1);
    expect(menu.starved).toEqual([]);
  });

  it('does not re-admit into a slot that still has a rested option', () => {
    const constraints = deriveConstraints(COOL_FORMAL);
    const recentWear: readonly WearEvent[] = [
      { wornOn: daysBefore(WINTER_DAY, 1), garmentIds: ['chelsea-boots-black'] },
    ];
    const menu = buildMenu(WARDROBE, constraints, recentWear, 'rectangle', WINTER_DAY);

    expect(idsIn(menu, 'shoes')).not.toContain('chelsea-boots-black');
    expect(menu.bySlot.shoes.every((entry) => !entry.reAdmitted)).toBe(true);
  });

  it('never waives a hard constraint, and reports the slot as starved instead', () => {
    const constraints = deriveConstraints({ ...WET_FORMAL, date: SUMMER_DAY });
    const menu = buildMenu(WARDROBE, constraints, [], 'rectangle', SUMMER_DAY);

    expect(menu.bySlot.shoes).toEqual([]);
    expect(menu.starved).toEqual(['shoes']);
    expect(menu.bySlot.base.length).toBeGreaterThan(0);
    expect(menu.bySlot.bottom.length).toBeGreaterThan(0);
  });

  it('leaves an optional slot empty without complaint', () => {
    const constraints = deriveConstraints({
      ...MILD_ERRANDS,
      event: 'formal',
      date: SUMMER_DAY,
    });
    const menu = buildMenu(WARDROBE, constraints, [], 'rectangle', SUMMER_DAY);

    expect(menu.bySlot.outer).toEqual([]);
    expect(menu.starved).toEqual([]);
  });
});

describe('rankSlot', () => {
  it('puts the least recently worn first and never worn ahead of everything', () => {
    const constraints = deriveConstraints(MILD_ERRANDS);
    const recentWear: readonly WearEvent[] = [
      { wornOn: daysBefore(AUTUMN_DAY, 3), garmentIds: ['chinos-stone'] },
      { wornOn: daysBefore(AUTUMN_DAY, 9), garmentIds: ['jeans-indigo'] },
    ];
    const menu = buildMenu(WARDROBE, constraints, recentWear, 'rectangle', AUTUMN_DAY);

    const order = idsIn(menu, 'bottom');
    expect(order.indexOf('trousers-wool-charcoal')).toBeLessThan(order.indexOf('jeans-indigo'));
    expect(order.indexOf('jeans-indigo')).toBeLessThan(order.indexOf('chinos-stone'));
  });

  it('is a total order over never-worn entries rather than a NaN comparison', () => {
    const constraints = deriveConstraints(MILD_ERRANDS);
    const menu = buildMenu(WARDROBE, constraints, [], 'rectangle', AUTUMN_DAY);
    const shuffled = [...menu.bySlot.shoes].reverse();

    expect(rankSlot(shuffled, constraints).map((entry) => entry.garment.id)).toEqual(
      idsIn(menu, 'shoes'),
    );
  });
});
