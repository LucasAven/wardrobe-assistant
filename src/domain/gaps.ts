/**
 * Guide rules this wardrobe misses on every outfit, whatever the owner wears.
 *
 * Such a rule is a fact about what they own and not a complaint about what they
 * wore today. Left on the card it crowds out the misses they could actually
 * have avoided, so it is named once, on the wardrobe screen, and dropped from
 * the rest.
 *
 * `require` rules are left out. One over a garment is a menu filter, so it
 * empties the slot instead of being missed, and one over an outfit is a book
 * dont that rejects the outfit outright.
 *
 * What this does not catch: an outfit rule about how the pieces sit together
 * that a wardrobe happens to block anyway, such as a triangle owning no dark
 * trousers for `tri-01`. Answering that needs a search over the outfits the
 * wardrobe can build rather than a test on one garment, so those rules keep
 * appearing on every card until someone builds it.
 */

import { rulesFor } from './bookRules';
import type { BodyType, Garment, GarmentRule, Slot } from './types';

/** An outfit without one of these is not an outfit, so one is always worn. */
const ALWAYS_WORN: readonly Slot[] = ['base', 'bottom', 'shoes'];

export interface WardrobeGap {
  readonly id: string;
  /** The book's own sentence, the same one the outfit card shows. */
  readonly because: string;
  /** The garment the rule asks for and the wardrobe has none of, or null. */
  readonly needs: string | null;
  /** Where the wardrobe falls short. */
  readonly slots: readonly Slot[];
}

/**
 * The two shapes are not one shape with a flag, because the question differs.
 *
 * A rule about how a garment must look is judged only against garments the
 * owner is wearing. It falls short in a slot they own things in where none of
 * them passes, and that shortfall is unavoidable only when the slot is one no
 * outfit can leave empty. A slot they can simply leave off is not a gap: they
 * own no coat that works, so they wear no coat, and the rule is never missed.
 *
 * A rule asking the outfit to contain something is judged against its absence,
 * so owning nothing that answers it is the gap, and no outfit escapes it.
 */
export function wardrobeGaps(
  all: readonly Garment[],
  bodyType: BodyType,
): readonly WardrobeGap[] {
  const gaps: WardrobeGap[] = [];
  const wardrobe = wearable(all, bodyType);

  for (const rule of rulesFor(bodyType)) {
    if (rule.severity !== 'prefer') continue;

    if (rule.kind === 'outfit') {
      const want = rule.wants;
      if (want === undefined) continue;
      if (wardrobe.some((garment) => want.slots.includes(garment.slot) && want.test(garment))) {
        continue;
      }
      gaps.push({ id: rule.id, because: rule.because, needs: want.name, slots: want.slots });
      continue;
    }

    const short = rule.slots.filter((slot) => {
      const owned = wardrobe.filter((garment) => garment.slot === slot);
      return owned.length > 0 && !owned.some((garment) => rule.test(garment));
    });
    if (!short.some((slot) => ALWAYS_WORN.includes(slot))) continue;
    gaps.push({ id: rule.id, because: rule.because, needs: null, slots: short });
  }

  return gaps;
}

/**
 * What the owner can actually put on. A `require` garment rule is one of the
 * book's donts, and `buildMenu` drops what breaks it from every menu on every
 * day, so such a garment can never answer a rule. Counting it here would hide a
 * gap behind a garment the owner is never offered: the one wide-leg trouser
 * that is also too tight to wear says the wide-leg rule is met, while every
 * outfit they can build misses it.
 */
function wearable(all: readonly Garment[], bodyType: BodyType): readonly Garment[] {
  const donts = rulesFor(bodyType).filter(
    (rule): rule is GarmentRule => rule.kind === 'garment' && rule.severity === 'require',
  );
  return all.filter((garment) =>
    donts.every((dont) => !dont.slots.includes(garment.slot) || dont.test(garment)),
  );
}
