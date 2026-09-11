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

/** Every slot an outfit reads its formality from, which is every slot but `accessory`. */
function clothing(menu: Menu): readonly MenuEntry[] {
  return SLOTS.filter((slot) => slot !== 'accessory').flatMap((slot) => [...menu.bySlot[slot]]);
}

describe('distributive filters', () => {
  it('drops every casual piece of clothing at a formal event', () => {
    const constraints = deriveConstraints(COOL_FORMAL);
    const menu = buildMenu(WARDROBE, constraints, [], 'rectangle', WINTER_DAY);

    expect(constraints.minFormality).toBe(4);
    for (const entry of clothing(menu)) {
      expect(entry.garment.formality).toBeGreaterThanOrEqual(4);
    }
    expect(idsIn(menu, 'base')).not.toContain('tee-white');
    expect(idsIn(menu, 'bottom')).not.toContain('jeans-indigo');
    expect(idsIn(menu, 'shoes')).not.toContain('sneakers-white');
    expect(menu.starved).toEqual([]);
  });

  it('keeps an accessory the floor would have taken, because the floor is about the clothing', () => {
    const constraints = deriveConstraints(COOL_FORMAL);
    const menu = buildMenu(WARDROBE, constraints, [], 'rectangle', WINTER_DAY);

    expect(garmentById('cap-navy').formality).toBe(1);
    expect(idsIn(menu, 'accessory')).toContain('cap-navy');
    expect(garmentById('jeans-indigo').formality).toBe(2);
    expect(idsIn(menu, 'bottom')).not.toContain('jeans-indigo');
  });

  it('still drops an accessory that is out of season', () => {
    const menu = buildMenu(WARDROBE, deriveConstraints(HOT_ERRANDS), [], 'rectangle', SUMMER_DAY);

    expect(garmentById('scarf-wool-charcoal').seasons).not.toContain('summer');
    expect(idsIn(menu, 'accessory')).not.toContain('scarf-wool-charcoal');
    expect(idsIn(menu, 'accessory')).toContain('cap-navy');
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

  it('still refuses a padded jacket, which is the half of inv-02 that reaches a coat', () => {
    const menu = buildMenu(
      WARDROBE,
      deriveConstraints({ ...MILD_ERRANDS, date: WINTER_DAY }),
      [],
      'inverted_triangle',
      WINTER_DAY,
    );

    const plainTops = RULES_BY_ID.get('inv-02');
    if (plainTops?.kind !== 'garment') throw new Error('inv-02 should be a garment rule');

    expect(plainTops.slots).not.toContain('outer');
    expect(RULES_BY_ID.get('inv-08a')?.severity).toBe('require');
    expect(garmentById('puffer-navy').shoulderBulk).toBe(true);
    expect(idsIn(menu, 'outer')).not.toContain('puffer-navy');
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

  it('admits an accessory worn yesterday, and still knows when it was worn', () => {
    const constraints = deriveConstraints(MILD_ERRANDS);
    const recentWear: readonly WearEvent[] = [
      { wornOn: daysBefore(AUTUMN_DAY, 1), garmentIds: ['belt-brown'] },
    ];
    const menu = buildMenu(WARDROBE, constraints, recentWear, 'rectangle', AUTUMN_DAY);
    const belt = menu.bySlot.accessory.find((entry) => entry.garment.id === 'belt-brown');

    expect(constraints.cooldownDays.accessory).toBe(0);
    expect(belt?.daysSince).toBe(1);
    expect(belt?.admittedBy).toEqual({ by: 'rested' });
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
    expect(menu.bySlot.shoes[0]?.admittedBy).toEqual({ by: 'starved_slot' });
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
    expect(menu.bySlot.shoes.every((entry) => entry.admittedBy.by === 'rested')).toBe(true);
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

describe("an owner's request", () => {
  const CONSTRAINTS = deriveConstraints(MILD_ERRANDS);

  function entryFor(menu: Menu, slot: Slot, id: string): MenuEntry | undefined {
    return menu.bySlot[slot].find((one) => one.garment.id === id);
  }

  it('admits an out of season garment and says the season is what it waived', () => {
    const plain = buildMenu(WARDROBE, CONSTRAINTS, [], 'rectangle', AUTUMN_DAY);
    expect(idsIn(plain, 'mid')).not.toContain('knit-cream-heavy');

    const asked = buildMenu(WARDROBE, CONSTRAINTS, [], 'rectangle', AUTUMN_DAY, ['knit-cream-heavy']);

    expect(entryFor(asked, 'mid', 'knit-cream-heavy')?.admittedBy).toEqual({
      by: 'owner_asked',
      waived: ['season'],
    });
  });

  it('waives the cooldown too, and names it alongside whatever else it waived', () => {
    const recentWear: readonly WearEvent[] = [
      { wornOn: daysBefore(AUTUMN_DAY, 1), garmentIds: ['knit-cream-heavy', 'wool-coat-camel'] },
    ];
    const menu = buildMenu(WARDROBE, CONSTRAINTS, recentWear, 'rectangle', AUTUMN_DAY, [
      'knit-cream-heavy',
      'wool-coat-camel',
    ]);

    expect(entryFor(menu, 'mid', 'knit-cream-heavy')?.admittedBy).toEqual({
      by: 'owner_asked',
      waived: ['season', 'cooldown'],
    });
    expect(entryFor(menu, 'outer', 'wool-coat-camel')?.admittedBy).toEqual({
      by: 'owner_asked',
      waived: ['cooldown'],
    });
  });

  it('marks a garment that needed no waiver, so nothing is claimed to be overridden', () => {
    const menu = buildMenu(WARDROBE, CONSTRAINTS, [], 'rectangle', AUTUMN_DAY, ['jeans-indigo']);

    expect(entryFor(menu, 'bottom', 'jeans-indigo')?.admittedBy).toEqual({
      by: 'owner_asked',
      waived: [],
    });
  });

  it('opens the door for that garment only, and for nothing else the same filter holds out', () => {
    const plain = buildMenu(WARDROBE, CONSTRAINTS, [], 'rectangle', AUTUMN_DAY);
    const asked = buildMenu(WARDROBE, CONSTRAINTS, [], 'rectangle', AUTUMN_DAY, ['knit-cream-heavy']);

    const added = idsIn(asked, 'mid').filter((id) => !idsIn(plain, 'mid').includes(id));
    expect(added).toEqual(['knit-cream-heavy']);
    for (const slot of SLOTS.filter((one) => one !== 'mid')) {
      expect(idsIn(asked, slot)).toEqual(idsIn(plain, slot));
    }
  });

  it('refuses a garment the guide bans, because a request is about today and the guide is not', () => {
    const menu = buildMenu(WARDROBE, CONSTRAINTS, [], 'rectangle', AUTUMN_DAY, ['jeans-black-skinny']);

    expect(idsIn(menu, 'bottom')).not.toContain('jeans-black-skinny');
    expect(menu.refused).toEqual([
      { kind: 'book_dont', id: 'jeans-black-skinny', subtype: 'skinny jeans', ruleId: 'rect-05a' },
    ]);
  });

  it('refuses an id no garment has, rather than dropping it in silence', () => {
    const menu = buildMenu(WARDROBE, CONSTRAINTS, [], 'rectangle', AUTUMN_DAY, ['no-such-garment']);

    expect(menu.refused).toEqual([{ kind: 'not_in_wardrobe', id: 'no-such-garment' }]);
  });

  it('sorts what was asked for to the top of its slot', () => {
    const menu = buildMenu(WARDROBE, CONSTRAINTS, [], 'rectangle', AUTUMN_DAY, ['knit-cream-heavy']);

    expect(menu.bySlot.mid[0]?.garment.id).toBe('knit-cream-heavy');
  });
});

describe('held back', () => {
  const CONSTRAINTS = deriveConstraints(MILD_ERRANDS);

  it('names every garment a filter removed, with what removed it', () => {
    const menu = buildMenu(WARDROBE, CONSTRAINTS, [], 'rectangle', AUTUMN_DAY);
    const held = menu.heldBack.find((one) => one.garment.id === 'knit-cream-heavy');

    expect(held?.why).toEqual(['season']);
    expect(held?.bookDonts).toEqual([]);
  });

  it('holds back what the cooldown benched, which is the one the owner overrides most', () => {
    const recentWear: readonly WearEvent[] = [
      { wornOn: daysBefore(AUTUMN_DAY, 1), garmentIds: ['wool-coat-camel'] },
    ];
    const menu = buildMenu(WARDROBE, CONSTRAINTS, recentWear, 'rectangle', AUTUMN_DAY);

    expect(menu.heldBack.find((one) => one.garment.id === 'wool-coat-camel')?.why).toEqual([
      'cooldown',
    ]);
  });

  it('marks a guide ban as a guide ban, so nothing offers it as askable', () => {
    const menu = buildMenu(WARDROBE, CONSTRAINTS, [], 'rectangle', AUTUMN_DAY);

    expect(menu.heldBack.find((one) => one.garment.id === 'jeans-black-skinny')?.bookDonts).toEqual([
      'rect-05a',
    ]);
  });

  it('never names a garment the menu already holds', () => {
    const menu = buildMenu(WARDROBE, CONSTRAINTS, [], 'rectangle', AUTUMN_DAY);
    const inMenu = new Set(SLOTS.flatMap((slot) => idsIn(menu, slot)));

    for (const held of menu.heldBack) expect(inMenu.has(held.garment.id)).toBe(false);
  });

  it('says nothing about a garment a starved slot let back early', () => {
    const recentWear: readonly WearEvent[] = [
      { wornOn: daysBefore(WINTER_DAY, 0), garmentIds: WARDROBE.map((garment) => garment.id) },
    ];
    const menu = buildMenu(WARDROBE, deriveConstraints(COOL_FORMAL), recentWear, 'rectangle', WINTER_DAY);
    const backEarly = menu.bySlot.shoes.filter((entry) => entry.admittedBy.by === 'starved_slot');

    expect(backEarly.length).toBeGreaterThan(0);
    for (const entry of backEarly) {
      expect(menu.heldBack.some((held) => held.garment.id === entry.garment.id)).toBe(false);
    }
  });
});

/**
 * The request is applied to the menu as it already stands, so these are about
 * what it must never do rather than about what it does.
 */
describe('a request only ever adds', () => {
  const CONSTRAINTS = deriveConstraints(MILD_ERRANDS);

  it('does not stop a starved slot from being rescued, and takes nothing out', () => {
    // Every shoe worn today, so the shoes menu exists only because starvation
    // let the benched ones back in. Asking for one of them must not be the
    // thing that empties the slot of the others.
    const recentWear: readonly WearEvent[] = [
      { wornOn: AUTUMN_DAY, garmentIds: WARDROBE.map((garment) => garment.id) },
    ];
    const plain = buildMenu(WARDROBE, CONSTRAINTS, recentWear, 'rectangle', AUTUMN_DAY);
    const rescued = idsIn(plain, 'shoes');
    expect(rescued.length).toBeGreaterThan(1);

    const asked = buildMenu(WARDROBE, CONSTRAINTS, recentWear, 'rectangle', AUTUMN_DAY, [
      rescued[0] as string,
    ]);

    expect([...idsIn(asked, 'shoes')].sort()).toEqual([...rescued].sort());
  });

  it('claims no waiver for a garment that was in the menu anyway', () => {
    const recentWear: readonly WearEvent[] = [
      { wornOn: AUTUMN_DAY, garmentIds: WARDROBE.map((garment) => garment.id) },
    ];
    const plain = buildMenu(WARDROBE, CONSTRAINTS, recentWear, 'rectangle', AUTUMN_DAY);
    const rescued = idsIn(plain, 'shoes')[0] as string;
    const asked = buildMenu(WARDROBE, CONSTRAINTS, recentWear, 'rectangle', AUTUMN_DAY, [rescued]);

    expect(asked.bySlot.shoes.find((one) => one.garment.id === rescued)?.admittedBy).toEqual({
      by: 'owner_asked',
      waived: [],
    });
  });

  it('never shrinks a slot, whatever is asked for and whatever was worn', () => {
    const recentWear: readonly WearEvent[] = [
      { wornOn: daysBefore(AUTUMN_DAY, 1), garmentIds: WARDROBE.map((garment) => garment.id) },
    ];
    const plain = buildMenu(WARDROBE, CONSTRAINTS, recentWear, 'rectangle', AUTUMN_DAY);

    for (const garment of WARDROBE) {
      const asked = buildMenu(WARDROBE, CONSTRAINTS, recentWear, 'rectangle', AUTUMN_DAY, [
        garment.id,
      ]);
      for (const slot of SLOTS) {
        for (const id of idsIn(plain, slot)) {
          expect(idsIn(asked, slot), `${garment.id} removed ${id} from ${slot}`).toContain(id);
        }
      }
    }
  });

  it('un-starves a required slot the request itself fills', () => {
    // The one water resistant pair taken out, on a day that asks for rain
    // proof shoes, so the slot is empty for a reason a request can waive.
    const noDryShoes = WARDROBE.filter((garment) => garment.id !== 'chelsea-boots-black');
    const wet = deriveConstraints(WET_FORMAL);
    const plain = buildMenu(noDryShoes, wet, [], 'rectangle', WINTER_DAY);
    const shoes = plain.heldBack.find((held) => held.garment.slot === 'shoes');

    expect(plain.starved).toContain('shoes');
    expect(shoes).toBeDefined();

    const asked = buildMenu(noDryShoes, wet, [], 'rectangle', WINTER_DAY, [
      (shoes as { garment: { id: string } }).garment.id,
    ]);

    expect(asked.starved).not.toContain('shoes');
  });

  it('reads an id with stray spaces as the id it is', () => {
    const menu = buildMenu(WARDROBE, CONSTRAINTS, [], 'rectangle', AUTUMN_DAY, [
      '  knit-cream-heavy  ',
    ]);

    expect(idsIn(menu, 'mid')).toContain('knit-cream-heavy');
    expect(menu.refused).toEqual([]);
  });

  it('orders held back by slot, so a cut off list is not all one reason', () => {
    const recentWear: readonly WearEvent[] = [
      { wornOn: AUTUMN_DAY, garmentIds: WARDROBE.map((garment) => garment.id) },
    ];
    const menu = buildMenu(WARDROBE, deriveConstraints(HOT_ERRANDS), recentWear, 'rectangle', SUMMER_DAY);
    const order = menu.heldBack.map((held) => SLOTS.indexOf(held.garment.slot));

    expect(menu.heldBack.length).toBeGreaterThan(2);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});
