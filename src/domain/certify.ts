/**
 * Resolve a proposal against the menu, then check the constraints that could
 * not be filters: the warmth sum, and the book donts that need the pieces seen
 * together.
 *
 * Rejection, never repair. A repaired outfit is a different outfit from the one
 * the rationale describes, so repairing would ship a rationale that no longer
 * matches the clothes.
 */

import { RULES_BY_ID } from './bookRules';
import type {
  BodyType,
  BookRule,
  CertifiedOutfit,
  Constraints,
  Garment,
  LayerSlot,
  Menu,
  OutfitProposal,
  RejectionReason,
  RequiredSlot,
  ResolvedOutfit,
  Slot,
} from './types';

const REQUIRED_SLOTS: readonly RequiredSlot[] = ['base', 'bottom', 'shoes'];

const OPTIONAL_LAYERS: readonly ('top' | 'mid' | 'outer')[] = ['top', 'mid', 'outer'];

/**
 * Warmth counts the layer slots only. Bottoms and shoes do not stack on top of
 * anything, so folding them in would add a constant to every band and make the
 * numbers mean less, not more.
 */
const CORE_LAYERS: readonly LayerSlot[] = ['base', 'top', 'mid'];

function findInMenu(menu: Menu, slot: Slot, id: string): Garment | undefined {
  return menu.bySlot[slot].find((entry) => entry.garment.id === id)?.garment;
}

interface Naming {
  readonly slot: Slot;
  readonly id: string;
}

/**
 * Ids resolve against the menu and never against the wardrobe. That is what
 * makes every distributive constraint inherited rather than rechecked here.
 */
export function resolveOutfit(
  proposal: OutfitProposal,
  menu: Menu,
): ResolvedOutfit | RejectionReason[] {
  const reasons: RejectionReason[] = [];
  const named: Naming[] = [];

  for (const slot of REQUIRED_SLOTS) {
    const id = proposal[slot].trim();
    if (id === '') {
      reasons.push({ kind: 'missing_required_slot', slot });
      continue;
    }
    named.push({ slot, id });
  }

  for (const slot of OPTIONAL_LAYERS) {
    const id = proposal[slot]?.trim();
    if (id === undefined || id === '') continue;
    named.push({ slot, id });
  }

  for (const raw of proposal.accessories ?? []) {
    named.push({ slot: 'accessory', id: raw.trim() });
  }

  const slotsById = new Map<string, Slot[]>();
  for (const naming of named) {
    const seen = slotsById.get(naming.id);
    if (seen === undefined) slotsById.set(naming.id, [naming.slot]);
    else seen.push(naming.slot);
  }

  // A garment lives in one slot, so the second naming would otherwise come back
  // as an unknown garment and hide the real mistake.
  const duplicated = new Set<string>();
  for (const [id, slots] of slotsById) {
    if (slots.length < 2) continue;
    duplicated.add(id);
    reasons.push({ kind: 'duplicate_garment', id, slots });
  }

  const pieces: Partial<Record<Slot, Garment>> = {};
  const accessories: Garment[] = [];
  for (const naming of named) {
    if (duplicated.has(naming.id)) continue;
    const garment = findInMenu(menu, naming.slot, naming.id);
    if (garment === undefined) {
      reasons.push({ kind: 'unknown_garment', slot: naming.slot, id: naming.id });
      continue;
    }
    if (naming.slot === 'accessory') accessories.push(garment);
    else pieces[naming.slot] = garment;
  }

  if (reasons.length > 0) return reasons;
  return { pieces, accessories, proposal };
}

function appliesTo(rule: BookRule, bodyType: BodyType): boolean {
  return rule.appliesTo === 'all' || rule.appliesTo === bodyType;
}

function wornIn(outfit: ResolvedOutfit, slots: readonly Slot[]): readonly Garment[] {
  const worn: Garment[] = [];
  for (const slot of slots) {
    if (slot === 'accessory') {
      worn.push(...outfit.accessories);
      continue;
    }
    const piece = outfit.pieces[slot];
    if (piece !== undefined) worn.push(piece);
  }
  return worn;
}

function violates(rule: BookRule, outfit: ResolvedOutfit): boolean {
  if (rule.kind === 'outfit') return !rule.test(outfit);
  return wornIn(outfit, rule.slots).some((garment) => !rule.test(garment));
}

function sumWarmth(outfit: ResolvedOutfit, slots: readonly LayerSlot[]): number {
  return slots.reduce((total, slot) => total + (outfit.pieces[slot]?.warmth ?? 0), 0);
}

function outOfBand(value: number, band: { readonly min: number; readonly max: number }): boolean {
  return value < band.min || value > band.max;
}

export function certify(
  resolved: ResolvedOutfit,
  constraints: Constraints,
  bodyType: BodyType,
): CertifiedOutfit | RejectionReason[] {
  const reasons: RejectionReason[] = [];

  const warmthCore = sumWarmth(resolved, CORE_LAYERS);
  const warmthWithOuter = warmthCore + (resolved.pieces.outer?.warmth ?? 0);

  if (outOfBand(warmthCore, constraints.warmth.core)) {
    reasons.push({ kind: 'warmth_out_of_band', band: 'core', got: warmthCore });
  }
  if (outOfBand(warmthWithOuter, constraints.warmth.withOuter)) {
    reasons.push({ kind: 'warmth_out_of_band', band: 'withOuter', got: warmthWithOuter });
  }

  const applicable = [...RULES_BY_ID.values()].filter((rule) => appliesTo(rule, bodyType));

  // A `require` garment rule is already a menu filter, so that half fires only
  // on a buildMenu bug. A `require` outfit rule has no filter to live in, so
  // this is the only place it is ever enforced.
  for (const rule of applicable) {
    if (rule.severity === 'require' && violates(rule, resolved)) {
      reasons.push({ kind: 'broke_required_rule', id: rule.id });
    }
  }

  const cited: BookRule[] = [];
  for (const id of resolved.proposal.citedRules) {
    const rule = RULES_BY_ID.get(id);
    if (rule === undefined) {
      reasons.push({ kind: 'unknown_rule', id });
      continue;
    }
    if (!appliesTo(rule, bodyType)) {
      reasons.push({ kind: 'rule_not_for_this_body', id });
      continue;
    }
    if (violates(rule, resolved)) {
      reasons.push({ kind: 'cited_violated_rule', id });
      continue;
    }
    cited.push(rule);
  }

  if (reasons.length > 0) return reasons;

  const missed = applicable.filter(
    (rule) => rule.severity === 'prefer' && violates(rule, resolved),
  );

  const checked: Omit<CertifiedOutfit, symbol> = {
    ...resolved,
    cited,
    missed,
    warmthCore,
    warmthWithOuter,
  };
  return checked as CertifiedOutfit;
}
