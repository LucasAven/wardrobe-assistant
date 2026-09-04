/**
 * The book's mirror protocol, as a function. Four types, decided from the five
 * observations in `docs/book/rules.md` under "Body profile inputs the book
 * needs".
 *
 * The order of the checks follows the book's own definitions, with the one
 * exception noted below. A waist that is the widest point of the body is the
 * circular type's defining clause, so it is read before the shoulder-to-hip
 * comparison that separates the other three. After that the width comparison
 * decides, because "hips and thighs wider than shoulders" and "shoulders notably
 * wider than hips" are what the book says triangle and inverted triangle are.
 * Volume only breaks the tie the width comparison leaves, which is the case the
 * book's protocol asks the volume question for.
 *
 * The exception: a widest waist and hips wider than the shoulders satisfy the
 * circular clause and the triangle clause at the same time, and the book never
 * says which one wins. Reading the waist first picks circular. That precedence
 * is a decision this file makes, not a line in `docs/book/rules.md`, so a reader
 * will not find it there.
 *
 * `line` and `thinLegs` are stored but never classify. The book uses `line` to
 * describe the rectangle rather than to find it, and says outright that leg
 * thickness only hardens one inverted triangle rule.
 */

import type { BodyProfile, BodyType } from './types';

/**
 * The same five fields as `BodyObservations` in the wire contract, derived from
 * the profile instead of imported, so the domain does not depend on the worker.
 */
export type BodyObservations = Pick<
  BodyProfile,
  'shouldersVsHips' | 'waistIsWidest' | 'volume' | 'line' | 'thinLegs'
>;

export interface BodyReading {
  readonly bodyType: BodyType;
  /** One sentence naming the observations that decided it. Shown to the user. */
  readonly because: string;
}

export function classifyWithReason(o: BodyObservations): BodyReading {
  if (o.waistIsWidest) {
    return {
      bodyType: 'circular',
      because: 'The waist is the widest part of the body, so the volume reads as concentrated in the center.',
    };
  }

  if (o.shouldersVsHips === 'narrower') {
    return {
      bodyType: 'triangle',
      because: 'The hips and thighs are wider than the shoulders, so the volume sits low.',
    };
  }

  if (o.shouldersVsHips === 'wider') {
    return {
      bodyType: 'inverted_triangle',
      because: 'The shoulders are notably wider than the hips, so the volume sits up top.',
    };
  }

  if (o.volume === 'center') {
    return {
      bodyType: 'circular',
      because: 'Shoulders and hips are about equal, but the volume sits in the center.',
    };
  }

  if (o.volume === 'bottom') {
    return {
      bodyType: 'triangle',
      because: 'Shoulders and hips are about equal, but the volume sits low.',
    };
  }

  if (o.volume === 'top') {
    return {
      bodyType: 'inverted_triangle',
      because: 'Shoulders and hips are about equal, but the volume sits up top.',
    };
  }

  return {
    bodyType: 'rectangle',
    because: 'Shoulders, waist and hips are about the same width and no zone carries marked volume.',
  };
}

export function classify(o: BodyObservations): BodyType {
  return classifyWithReason(o).bodyType;
}

/** What the book says the type is, for the composer's system prompt. */
export const BODY_TYPE_MEANING: Readonly<Record<BodyType, string>> = {
  rectangle:
    'Shoulders, waist and hips are about the same width, the lines are straight and no zone carries marked volume. The book calls this the most common male type and the most ignored.',
  triangle: 'The hips and thighs are wider than the shoulders and the volume is concentrated low.',
  inverted_triangle:
    'The shoulders are notably wider than the hips, with much volume on top and little below.',
  circular: 'The waist is the widest part of the body and the volume is concentrated in the center.',
};
