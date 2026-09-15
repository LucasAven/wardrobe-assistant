import { describe, expect, it } from 'vitest';
import { wardrobeGaps } from '../src/domain/gaps';
import { rulesFor } from '../src/domain/bookRules';
import type { Garment } from '../src/domain/types';
import { makeGarment } from './fixtures';

/**
 * `inv-02` wants a structured, solid, unpadded garment in base, top or mid, and
 * `inv-06` wants a belt among the accessories. They are the two shapes a gap
 * can take, so the wardrobes below are built to hit one or the other.
 */
const PASSES_INV_02 = { structured: true, pattern: 'solid', shoulderBulk: false } as const;

function wardrobe(...garments: readonly Garment[]): readonly Garment[] {
  return garments;
}

const base = (id: string, spec = {}) => makeGarment({ id, slot: 'base', subtype: 'tee', ...spec });
const mid = (id: string, spec = {}) => makeGarment({ id, slot: 'mid', subtype: 'hoodie', ...spec });
const belt = makeGarment({ id: 'belt-1', slot: 'accessory', subtype: 'leather belt' });
const ring = makeGarment({ id: 'ring-1', slot: 'accessory', subtype: 'silver ring' });

const ids = (garments: readonly Garment[]) =>
  wardrobeGaps(garments, 'inverted_triangle').map((gap) => gap.id);

describe('a rule about how a garment must look', () => {
  it('is a gap when the owner owns things in a slot every outfit fills and none of them pass', () => {
    const gaps = wardrobeGaps(wardrobe(base('tee-1'), ring), 'inverted_triangle');
    const found = gaps.find((gap) => gap.id === 'inv-02');

    expect(found?.slots).toEqual(['base']);
    expect(found?.needs).toBe(null);
    expect(found?.because).toBe(rulesFor('inverted_triangle').find((r) => r.id === 'inv-02')?.because);
  });

  it('stops being a gap as soon as one garment in that slot passes', () => {
    expect(ids(wardrobe(base('tee-1'), base('tee-2', PASSES_INV_02), ring))).not.toContain('inv-02');
  });

  /**
   * The rule is only ever judged against garments that are worn, so a layer the
   * owner can leave off cannot make an outfit miss it. Calling that a gap would
   * hide a miss on the card that a different outfit really could have avoided.
   */
  it('is not a gap when the only slot short of one is a layer an outfit can leave off', () => {
    // `base` is required and passes, `mid` is optional and does not, so the
    // owner can wear the tee alone and meet the rule. Counting `mid` here would
    // silence the miss on the card the day they do put the hoodie on.
    const onlyMidIsShort = wardrobe(base('tee-1', PASSES_INV_02), mid('hoodie-1'), ring);

    expect(ids(onlyMidIsShort)).not.toContain('inv-02');
    expect(ids(wardrobe(base('tee-1'), mid('hoodie-1'), ring))).toContain('inv-02');
  });

  it('is not a gap for a slot the owner owns nothing in, because nothing is worn there', () => {
    expect(ids(wardrobe(ring))).not.toContain('inv-02');
  });
});

describe('a rule that asks the outfit to contain a garment', () => {
  it('is a gap when nothing owned answers it, and says what is missing in plain words', () => {
    const found = wardrobeGaps(wardrobe(ring), 'inverted_triangle').find((gap) => gap.id === 'inv-06');

    expect(found?.needs).toBe('a belt');
    expect(found?.slots).toEqual(['accessory']);
  });

  /**
   * Unlike the rule above, absence is the failure, so owning nothing at all in
   * the slot is the gap rather than a reason to skip it.
   */
  it('is a gap when the owner owns no accessories at all', () => {
    expect(ids(wardrobe(base('tee-1', PASSES_INV_02)))).toContain('inv-06');
  });

  it('stops being a gap when one owned garment answers it', () => {
    expect(ids(wardrobe(base('tee-1', PASSES_INV_02), belt))).not.toContain('inv-06');
  });
});

describe('what a gap is never', () => {
  /**
   * A `require` garment rule is a menu filter, so a wardrobe short of one
   * empties the slot and the outfit is refused. It is never quietly missed, so
   * reporting it here would describe a failure that cannot happen.
   */
  it('a require rule, whichever body it is written for', () => {
    const empty: readonly Garment[] = [];

    for (const bodyType of ['rectangle', 'triangle', 'inverted_triangle', 'circular'] as const) {
      const required = new Set(
        rulesFor(bodyType).filter((rule) => rule.severity === 'require').map((rule) => rule.id),
      );
      for (const gap of wardrobeGaps(empty, bodyType)) expect(required.has(gap.id)).toBe(false);
    }
  });

  it('a rule about how the pieces sit together, which composing differently can always meet', () => {
    const relational = new Set(['inv-03', 'inv-04', 'all-01', 'all-02']);

    for (const id of ids(wardrobe(base('tee-1'), ring))) expect(relational.has(id)).toBe(false);
  });
});
