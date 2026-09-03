/**
 * Narrow the wardrobe to a per-slot menu.
 *
 * This is where the guarantee in `types.ts` is manufactured. Every distributive
 * constraint is applied here, so an outfit assembled only from menu entries is
 * formal enough, in season, ready for rain and clear of every book dont that no
 * other garment could cover. A dont about how a covered layer looks needs the
 * assembled outfit, so `certify` holds those.
 */

import { rulesFor } from './bookRules';
import type {
  BodyType,
  Constraints,
  Garment,
  GarmentRule,
  Menu,
  MenuEntry,
  RequiredSlot,
  Slot,
  WearEvent,
} from './types';

const REQUIRED_SLOTS: readonly RequiredSlot[] = ['base', 'bottom', 'shoes'];

const MS_PER_DAY = 86_400_000;

function emptyBySlot(): Record<Slot, MenuEntry[]> {
  return { base: [], top: [], mid: [], outer: [], bottom: [], shoes: [], accessory: [] };
}

function utcDayNumber(date: Date): number {
  return Math.floor(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / MS_PER_DAY,
  );
}

/**
 * Calendar days rather than elapsed hours, so a shirt worn yesterday evening is
 * one day old this morning instead of zero.
 */
function daysSinceByGarment(
  recentWear: readonly WearEvent[],
  now: Date,
): ReadonlyMap<string, number> {
  const today = utcDayNumber(now);
  const freshest = new Map<string, number>();
  for (const event of recentWear) {
    const days = Math.max(today - utcDayNumber(event.wornOn), 0);
    for (const id of event.garmentIds) {
      const seen = freshest.get(id);
      if (seen === undefined || days < seen) freshest.set(id, days);
    }
  }
  return freshest;
}

/** A rule's `test` reports whether a garment satisfies it, so a ban keeps what passes. */
function bansFor(bodyType: BodyType): readonly GarmentRule[] {
  return rulesFor(bodyType).filter(
    (rule): rule is GarmentRule => rule.kind === 'garment' && rule.severity === 'require',
  );
}

function isAllowed(
  garment: Garment,
  constraints: Constraints,
  bans: readonly GarmentRule[],
): boolean {
  if (!garment.seasons.includes(constraints.season)) return false;
  if (garment.formality < constraints.minFormality) return false;
  if (
    constraints.rainProof &&
    (garment.slot === 'outer' || garment.slot === 'shoes') &&
    !garment.waterResistant
  ) {
    return false;
  }
  return bans.every((rule) => !rule.slots.includes(garment.slot) || rule.test(garment));
}

/**
 * Subtracting the two would give `NaN` for a pair of never-worn garments, and
 * `sort` reads `NaN` as "equal" by accident rather than by intent.
 */
function byRecencyThenId(a: MenuEntry, b: MenuEntry): number {
  if (a.daysSince !== b.daysSince) return b.daysSince > a.daysSince ? 1 : -1;
  if (a.garment.id === b.garment.id) return 0;
  return a.garment.id < b.garment.id ? -1 : 1;
}

/** The seam where ranking goes if the wardrobe reaches ~200 garments. Currently sorts by recency. */
export function rankSlot(
  entries: readonly MenuEntry[],
  constraints: Constraints,
): readonly MenuEntry[] {
  return [...entries].sort(byRecencyThenId);
}

/**
 * Cooldown is waived before a hard constraint is, and a hard constraint is
 * never waived at all: re-admitting a garment that fails one would break the
 * invariant the whole menu exists to hold. A required slot with nothing left
 * after the waiver is reported as starved instead of quietly emptied.
 */
export function buildMenu(
  garments: readonly Garment[],
  constraints: Constraints,
  recentWear: readonly WearEvent[],
  bodyType: BodyType,
  now: Date,
): Menu {
  const freshest = daysSinceByGarment(recentWear, now);
  const bans = bansFor(bodyType);

  const admitted = emptyBySlot();
  const benched = emptyBySlot();

  for (const garment of garments) {
    if (!isAllowed(garment, constraints, bans)) continue;
    const daysSince = freshest.get(garment.id) ?? Infinity;
    const entry: MenuEntry = { garment, daysSince, reAdmitted: false };
    const rested = daysSince >= constraints.cooldownDays[garment.slot];
    (rested ? admitted : benched)[garment.slot].push(entry);
  }

  const starved: RequiredSlot[] = [];
  for (const slot of REQUIRED_SLOTS) {
    if (admitted[slot].length > 0) continue;
    for (const entry of benched[slot]) admitted[slot].push({ ...entry, reAdmitted: true });
    if (admitted[slot].length === 0) starved.push(slot);
  }

  return {
    bySlot: {
      base: rankSlot(admitted.base, constraints),
      top: rankSlot(admitted.top, constraints),
      mid: rankSlot(admitted.mid, constraints),
      outer: rankSlot(admitted.outer, constraints),
      bottom: rankSlot(admitted.bottom, constraints),
      shoes: rankSlot(admitted.shoes, constraints),
      accessory: rankSlot(admitted.accessory, constraints),
    },
    starved,
  };
}
