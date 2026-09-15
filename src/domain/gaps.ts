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
 */

import { rulesFor } from './bookRules';
import type { BodyType, Garment, Slot } from './types';

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
  wardrobe: readonly Garment[],
  bodyType: BodyType,
): readonly WardrobeGap[] {
  const gaps: WardrobeGap[] = [];

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
