/**
 * What one saved outfit's card computes, kept apart from what it draws.
 *
 * `client/screens/OutfitCard.tsx` draws it. Everything here is pure, and it
 * stays a plain ES module because `test/ui.selftest.mjs` imports it under node
 * with no transform, and because `test/swapLabelParity.test.ts` and
 * `test/accessoryParity.test.ts` pin two of these exports against `src/domain/`.
 */
import { tagState } from './garments.js';
import { LAYER_ORDER } from './outfits.js';

/** An outfit without one of these is not an outfit, so neither side offers to empty one. */
export const REQUIRED_SLOTS = ['base', 'bottom', 'shoes'];

/** The layers an outfit can go without, which are the only ones it can be missing. */
const ADDABLE_LAYERS = LAYER_ORDER.filter((slot) => !REQUIRED_SLOTS.includes(slot));

/**
 * The slots the card offers to fill: every layer the outfit is not already
 * wearing, and `accessory` every time, because an outfit wears as many of those
 * as the owner likes, so the first one and the fourth are the same gesture.
 *
 * `worn` comes in rather than being read off the outfit, since a wear logged on
 * this phone counts the same as one the server already knows about. A worn
 * outfit is the record of a day and the server refuses to change one, so it
 * offers nothing at all.
 */
export function addableSlots(outfit, worn) {
  if (worn) return [];
  const held = new Set((outfit?.pieces ?? []).map((piece) => piece.slot));
  return [...ADDABLE_LAYERS.filter((slot) => !held.has(slot)), 'accessory'];
}

const MISSING_NAME = 'a garment no longer in the wardrobe';

/**
 * What a tile calls the piece under it. Every other slot holds one garment and
 * the slot's own name says which one that is, but an outfit wears as many
 * accessories as the owner likes, so the kind is the only thing that tells two
 * of them apart.
 */
export function pieceLabel(slot, garment) {
  if (slot !== 'accessory') return slot;
  const kind = garment.accessoryKind;
  // `other` is a real choice on the review screen and names nothing, so it
  // falls back with the untagged ones rather than reading "Change the other".
  return kind === null || kind === undefined || kind === 'other' ? 'accessory' : kind;
}

/** `outer` and `accessory` both open on a vowel, and "Add a outer" is not a sentence. */
export const article = (word) => ('aeiou'.includes(word[0]) ? 'an' : 'a');

/**
 * Kinds a body has one place for, copied from `ONE_PER_OUTFIT` in
 * `src/domain/certify.ts`, which is the list `save_outfit` and the swap both
 * refuse a second of. The picker needs it to stop offering a garment the server
 * will turn down, and it cannot ask for it: the grid reads the wardrobe already
 * on the phone and makes no call at all. `test/accessoryParity.test.ts` fails
 * when the two drift, and nothing else would notice.
 */
export const ONE_PER_OUTFIT = ['glasses', 'hat', 'scarf', 'belt', 'bag', 'watch', 'earrings'];

export function changeLine(correction) {
  const into = correction.to === null ? 'nothing' : (correction.to.subtype ?? MISSING_NAME);
  // A row with neither side never reaches the card, `readCorrections` drops it,
  // so a missing `from` is always a real garment arriving on its own.
  if (correction.from === null) return `${correction.slot}: ${into} added`;
  const out = correction.from.subtype ?? MISSING_NAME;
  return `${correction.slot}: ${out} out, ${into} in`;
}

/**
 * The three sentences this side mirrors from `FILTER_WORDS` in
 * src/worker/compose.ts. Fixed words rather than a table with rules in it, so
 * the copy cannot drift into saying something the engine does not do.
 *
 * Nothing pins the two tables together, and they have already parted: the
 * formality line here says "the day's" where the server's says "today's". This
 * is the right claim on a card about an outfit saved days ago, so the gap is
 * worth knowing about rather than closing from this side.
 */
/** @type {Record<string, string>} */
export const FILTER_WORDS = {
  season: 'out of season',
  formality: "under the day's formality floor",
  cooldown: 'worn too recently to come back yet',
};

/**
 * What a picker tile says, and deliberately not `FILTER_WORDS`. The two are
 * allowed to disagree, and the reason for a second table is length.
 *
 * "under the day's formality floor" is 31 characters. Measured in the real grid
 * at a 375px screen, where a tile is 97.66px wide, it takes two lines on its own
 * and three once the season line joins it, which drags every tile in that row
 * from 119px to 171px. That is not a rare case: a formal outfit has a floor of
 * 4, and in a 47 garment wardrobe every bottom, every mid and every base sits
 * under it, so nearly every tile in the grid would carry the long line at once.
 *
 * The other table's words are also fragments, written to be swallowed by the
 * sentence `honoredLine` wraps them in. These stand alone under a photo.
 *
 * 'out of season' is the same string in both, which is the short one already
 * being right rather than a reference the two share.
 */
/** @type {Record<string, string>} */
export const CAUTION_WORDS = {
  untagged: 'not tagged yet',
  no_season: 'no season set',
  season: 'out of season',
  formality: 'too casual',
};

export function honoredLine(honored) {
  const name = honored.subtype ?? MISSING_NAME;
  if (honored.waived.length === 0) return `${name}, which fit the day anyway`;
  return `${name}: in only because you asked, ${honored.waived.map((one) => FILTER_WORDS[one]).join(' and ')}`;
}

/**
 * Which of the outfit's own filters a candidate fails, copied from
 * `failedFilters` in `src/domain/menu.ts`. The picker reads the wardrobe
 * already on the phone and makes no call at all, so it cannot ask the engine
 * what it would have said about this garment.
 * `test/swapLabelParity.test.ts` fails when the two drift, and nothing else
 * would notice: a tile would warn about a garment the engine admits, or say
 * nothing about one the engine holds back, and the owner reads either as the
 * engine's own word.
 *
 * The two null tests are the whole of what the server's has no need for. A
 * saved outfit can be missing the event that gives it a floor, and a row with
 * an unreadable date names no season, while a `Constraints` always has both.
 *
 * Accessories are exempt from the floor because the floor is about the
 * silhouette and a ring is not part of one. Named rather than cited by line,
 * because the line moved inside the commit that first cited it: it is the
 * `garment.slot !== 'accessory'` clause of the server's own `failedFilters`.
 * That is one clause, it could be edited away there, and the only symptom here
 * would be an accessory tile saying the outfit is too formal for it.
 *
 * A list rather than a boolean for the server's own reason: out of season and
 * under the floor stay told apart, and the tile is the one screen where the
 * owner reads them.
 */
export function failedFilters(garment, day) {
  const failed = [];
  if (day.season !== null && !garment.seasons.includes(day.season)) failed.push('season');
  if (day.minFormality !== null && garment.slot !== 'accessory' && garment.formality < day.minFormality) {
    failed.push('formality');
  }
  return failed;
}

/**
 * What the tile says about a candidate, judged against the day the outfit was
 * built for.
 *
 * An untagged garment says one thing and stops. `blankDraft` writes
 * `seasons: []` and `formality: 3`, so the predicate above calls it out of
 * season and a floor of 4 calls it too casual. Both are true of the engine and
 * lies about the garment, since nobody has looked at the photo yet. A vision
 * guess is a reading and is judged like any other, so only the placeholder is
 * held back.
 *
 * "no season set" is this file's own, and it sits above the copied predicate on
 * purpose: what comes from the server is pinned by the parity test, what is
 * invented here is covered by the selftest, and this function is the seam. A
 * reviewed garment can carry an empty season list too, so the split is not the
 * untagged test over again.
 */
export function cautionsFor(garment, day) {
  if (tagState(garment) === 'untagged') return ['untagged'];

  const failed = failedFilters(garment, day);
  const cautions = [];
  if (failed.includes('season')) {
    cautions.push(garment.seasons.length === 0 ? 'no_season' : 'season');
  }
  if (failed.includes('formality')) cautions.push('formality');
  return cautions;
}
