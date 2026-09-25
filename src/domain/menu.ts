/**
 * Narrow the wardrobe to a per-slot menu.
 *
 * This is where the guarantee in `types.ts` is manufactured. Every distributive
 * constraint is applied here, so an outfit assembled only from menu entries is
 * formal enough, in season and clear of every book dont that no
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
 *
 * Exported for `failedFilters` in `client/lib/outfitcard.js`, the copy the swap
 * picker labels a candidate with, and for `test/swapLabelParity.test.ts`, which
 * is the only thing that stops the two from drifting.
 */
export function failedFilters(garment: Garment, constraints: Constraints): readonly Waived[] {
  const failed: Waived[] = [];
  if (!garment.seasons.includes(constraints.season)) failed.push('season');
  // The floor is about the silhouette, and an outfit reads as the lowest of its
  // clothing. A ring is not part of that silhouette, so holding one to the floor
  // would only empty the accessory menu at the events that ask for the most.
  if (garment.slot !== 'accessory' && garment.formality < constraints.minFormality) {
    failed.push('formality');
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

/**
 * Held back is read by eye and then cut off at a limit, so it is ordered the way
 * the menu is rather than the way the loops above happened to fill it. Grouping
 * it by what removed each garment would put every cooldown row last, which is
 * the one the owner overrides most and so the worst one to truncate away.
 */
function bySlotThenName(a: HeldBack, b: HeldBack): number {
  const rank = (held: HeldBack) => ALL_SLOTS.indexOf(held.garment.slot);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  return a.garment.subtype.localeCompare(b.garment.subtype);
}

/** The seam where ranking goes if the wardrobe reaches ~200 garments. Currently sorts by recency. */
export function rankSlot(
  entries: readonly MenuEntry[],
  _constraints: Constraints,
): readonly MenuEntry[] {
  return [...entries].sort(byRecencyThenId);
}

/**
 * Cooldown is waived before a hard constraint is, and a hard constraint is
 * waived for one reason only: the owner asked for that garment by name.
 *
 * `wants` carries those ids, and it is applied last, to the menu as it already
 * stands. That order is the whole correctness of it. Deciding the request first
 * would let an asked-for garment fill a required slot, stop the starvation
 * rescue firing, and quietly delete the garments that rescue would have brought
 * back, and it would then credit the request with waiving a cooldown that the
 * rescue had already forgiven. Applied last, a request only ever adds, and what
 * it says it waived is what was still keeping the garment out.
 *
 * A book dont is never waived by one, because it is a fact about this person's
 * body rather than about today, and because `certify` re-checks every `require`
 * rule and would reject the outfit anyway. A request for such a garment comes
 * back in `refused` rather than being dropped.
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

  const admitted = emptyBySlot();
  const benched = emptyBySlot();
  const daysById = new Map<string, number>();
  /** What the filters kept out, by id. A request takes some of it back. */
  const out = new Map<string, HeldBack>();

  for (const garment of garments) {
    const daysSince = freshest.get(garment.id) ?? Infinity;
    daysById.set(garment.id, daysSince);
    const rested = daysSince >= constraints.cooldownDays[garment.slot];
    const failed = failedFilters(garment, constraints);
    const donts = brokenDonts(garment, bans);

    if (failed.length > 0 || donts.length > 0) {
      out.set(garment.id, { garment, why: against(failed, rested), bookDonts: donts });
      continue;
    }

    const entry: MenuEntry = { garment, daysSince, admittedBy: RESTED };
    (rested ? admitted : benched)[garment.slot].push(entry);
  }

  for (const slot of REQUIRED_SLOTS) {
    if (admitted[slot].length > 0) continue;
    for (const entry of benched[slot]) admitted[slot].push({ ...entry, admittedBy: STARVED });
    benched[slot] = [];
  }

  // Whatever the cooldown benched and starvation did not rescue is held back by
  // the cooldown and nothing else, which is the one the owner overrides most.
  for (const slot of ALL_SLOTS) {
    for (const entry of benched[slot]) {
      out.set(entry.garment.id, { garment: entry.garment, why: ['cooldown'], bookDonts: [] });
    }
  }

  const refused: RefusedRequest[] = [];
  const byId = new Map<string, Garment>(garments.map((garment) => [garment.id, garment]));
  for (const id of new Set(wants.map((want) => want.trim()))) {
    const garment = byId.get(id);
    if (garment === undefined) {
      refused.push({ kind: 'not_in_wardrobe', id });
      continue;
    }

    const held = out.get(id);
    const dont = held?.bookDonts[0];
    if (dont !== undefined) {
      refused.push({ kind: 'book_dont', id, subtype: garment.subtype, ruleId: dont });
      continue;
    }

    // Already in the menu, so the request waived nothing and says so. It is
    // still marked, because the owner asking for a garment is worth knowing
    // about whether or not it cost anything.
    const seat = admitted[garment.slot].findIndex((entry) => entry.garment.id === id);
    if (seat >= 0) {
      const entry = admitted[garment.slot][seat] as MenuEntry;
      admitted[garment.slot][seat] = { ...entry, admittedBy: { by: 'owner_asked', waived: [] } };
      continue;
    }

    admitted[garment.slot].push({
      garment,
      daysSince: daysById.get(id) ?? Infinity,
      admittedBy: { by: 'owner_asked', waived: held?.why ?? [] },
    });
    out.delete(id);
  }

  // Read after the request, not before it: a request can be the thing that
  // fills an otherwise empty required slot, and a plan that still called it
  // starved would tell the composer no outfit exists while holding one.
  const starved = REQUIRED_SLOTS.filter((slot) => admitted[slot].length === 0);

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
    heldBack: [...out.values()].sort(bySlotThenName),
    refused,
  };
}
