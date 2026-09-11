/**
 * Narrow the wardrobe to a per-slot menu.
 *
 * This is where the guarantee in `types.ts` is manufactured. Every distributive
 * constraint is applied here, so an outfit assembled only from menu entries is
 * formal enough, in season, ready for rain and clear of every book dont that no
 * other garment could cover. A dont about how a covered layer looks needs the
 * assembled outfit, so `certify` holds those.
 *
 * It also produces the menu's shadow. Every garment a filter removed comes back
 * in `heldBack` with the filters that removed it, because a garment with no
 * visible id is a garment the owner cannot ask for, and asking is the whole
 * point of `wants`.
 */

import { rulesFor } from './bookRules';
import type {
  Admission,
  BodyType,
  Constraints,
  Garment,
  GarmentRule,
  HeldBack,
  Menu,
  MenuEntry,
  RefusedRequest,
  RequiredSlot,
  Slot,
  Waived,
  WearEvent,
} from './types';

const REQUIRED_SLOTS: readonly RequiredSlot[] = ['base', 'bottom', 'shoes'];

const ALL_SLOTS: readonly Slot[] = ['base', 'top', 'mid', 'outer', 'bottom', 'shoes', 'accessory'];

const MS_PER_DAY = 86_400_000;

const RESTED: Admission = { by: 'rested' };
const STARVED: Admission = { by: 'starved_slot' };

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

/**
 * Which of today's filters this garment fails, rather than whether it fails any.
 * The list is what an owner's request waives and what the model is shown, so
 * "out of season" and "under the formality floor" have to stay told apart.
 */
function failedFilters(garment: Garment, constraints: Constraints): readonly Waived[] {
  const failed: Waived[] = [];
  if (!garment.seasons.includes(constraints.season)) failed.push('season');
  // The floor is about the silhouette, and an outfit reads as the lowest of its
  // clothing. A ring is not part of that silhouette, so holding one to the floor
  // would only empty the accessory menu at the events that ask for the most.
  if (garment.slot !== 'accessory' && garment.formality < constraints.minFormality) {
    failed.push('formality');
  }
  if (
    constraints.rainProof &&
    (garment.slot === 'outer' || garment.slot === 'shoes') &&
    !garment.waterResistant
  ) {
    failed.push('rain');
  }
  return failed;
}

/** One list, so "out of season" and "worn too recently" are never told apart twice. */
function against(failed: readonly Waived[], rested: boolean): readonly Waived[] {
  return rested ? failed : [...failed, 'cooldown'];
}

function brokenDonts(garment: Garment, bans: readonly GarmentRule[]): readonly string[] {
  return bans
    .filter((rule) => rule.slots.includes(garment.slot) && !rule.test(garment))
    .map((rule) => rule.id);
}

/**
 * Subtracting the two would give `NaN` for a pair of never-worn garments, and
 * `sort` reads `NaN` as "equal" by accident rather than by intent.
 */
function byRecencyThenId(a: MenuEntry, b: MenuEntry): number {
  // What the owner asked for sits at the top of its slot. It is the one entry
  // they have already made a decision about, so burying it under a recency sort
  // would hide the thing the request exists to surface.
  const asked = (entry: MenuEntry) => (entry.admittedBy.by === 'owner_asked' ? 0 : 1);
  if (asked(a) !== asked(b)) return asked(a) - asked(b);
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
 * waived for one reason only: the owner asked for that garment by name. A
 * required slot with nothing left after the waivers is reported as starved
 * instead of quietly emptied.
 *
 * `wants` carries those ids. A book dont is never waived by one, because it is a
 * fact about this person's body rather than about today, and because `certify`
 * re-checks every `require` rule and would reject the outfit anyway. A request
 * for such a garment comes back in `refused` rather than being dropped.
 */
export function buildMenu(
  garments: readonly Garment[],
  constraints: Constraints,
  recentWear: readonly WearEvent[],
  bodyType: BodyType,
  now: Date,
  wants: readonly string[] = [],
): Menu {
  const freshest = daysSinceByGarment(recentWear, now);
  const bans = bansFor(bodyType);
  const asked = new Set(wants);

  const admitted = emptyBySlot();
  const benched = emptyBySlot();
  const heldBack: HeldBack[] = [];
  const refused: RefusedRequest[] = [];

  for (const garment of garments) {
    const daysSince = freshest.get(garment.id) ?? Infinity;
    const rested = daysSince >= constraints.cooldownDays[garment.slot];
    const failed = failedFilters(garment, constraints);
    const donts = brokenDonts(garment, bans);
    const wanted = asked.has(garment.id);

    if (donts.length > 0) {
      if (wanted) {
        refused.push({
          kind: 'book_dont',
          id: garment.id,
          subtype: garment.subtype,
          ruleId: donts[0] as string,
        });
      }
      heldBack.push({
        garment,
        why: against(failed, rested),
        bookDonts: donts,
      });
      continue;
    }

    if (wanted) {
      const waived = against(failed, rested);
      admitted[garment.slot].push({ garment, daysSince, admittedBy: { by: 'owner_asked', waived } });
      continue;
    }

    if (failed.length > 0) {
      heldBack.push({ garment, why: against(failed, rested), bookDonts: [] });
      continue;
    }

    const entry: MenuEntry = { garment, daysSince, admittedBy: RESTED };
    (rested ? admitted : benched)[garment.slot].push(entry);
  }

  const starved: RequiredSlot[] = [];
  const backEarly = new Set<string>();
  for (const slot of REQUIRED_SLOTS) {
    if (admitted[slot].length > 0) continue;
    for (const entry of benched[slot]) {
      admitted[slot].push({ ...entry, admittedBy: STARVED });
      backEarly.add(entry.garment.id);
    }
    if (admitted[slot].length === 0) starved.push(slot);
  }

  // Whatever the cooldown benched and starvation did not rescue is held back by
  // the cooldown and nothing else, which is the one the owner overrides most.
  for (const slot of ALL_SLOTS) {
    for (const entry of benched[slot]) {
      if (backEarly.has(entry.garment.id)) continue;
      heldBack.push({ garment: entry.garment, why: ['cooldown'], bookDonts: [] });
    }
  }

  const known = new Set<string>(garments.map((garment) => garment.id));
  for (const id of asked) {
    if (!known.has(id)) refused.push({ kind: 'not_in_wardrobe', id });
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
    heldBack,
    refused,
  };
}
