/**
 * One rule, two implementations.
 *
 * `classify` in `src/domain/bodyType.ts` is the body type every recommendation
 * is computed from. `deriveBodyType` in `public/lib/body.js` is a client copy,
 * so the profile screen can name a type the moment the fifth question is
 * answered instead of waiting for a round trip. Nothing but this file stops the
 * two from drifting, and the symptom of drift is quiet: the screen shows one
 * body type while every outfit is built for another.
 *
 * The five observations have 3 x 2 x 4 x 2 x 2 = 96 combinations, so this does
 * not sample the input space, it enumerates it.
 */

import { describe, expect, it } from 'vitest';
// `public/lib` is plain JS outside the tsconfig `include`, so it ships no
// declaration file. The shape is stated once here and the rest of the file is
// typed normally.
// @ts-expect-error TS7016: untyped ES module.
import { deriveBodyType as untypedDeriveBodyType } from '../public/lib/body.js';
import type { BodyObservations } from '../src/domain/bodyType';
import { classify } from '../src/domain/bodyType';
import type { BodyType } from '../src/domain/types';

/** Returns null on an incomplete profile, which the sweep never produces. */
const deriveBodyType: (o: BodyObservations) => BodyType | null = untypedDeriveBodyType;

const SHOULDERS_VS_HIPS = ['wider', 'narrower', 'equal'] as const;
const WAIST_IS_WIDEST = [true, false] as const;
const VOLUMES = ['top', 'bottom', 'center', 'even'] as const;
const LINES = ['straight', 'curved'] as const;
const THIN_LEGS = [true, false] as const;
const BODY_TYPES = ['rectangle', 'triangle', 'inverted_triangle', 'circular'] as const;

/** `true` only when the list names every value of the field. Otherwise `never`. */
type Covers<Field, Listed> = [Exclude<Field, Listed>] extends [never] ? true : never;

/**
 * A widened field in `BodyProfile` breaks the build on this line rather than
 * shrinking the sweep in silence, which the count alone cannot catch.
 */
const EVERY_VALUE_LISTED: [
  Covers<BodyObservations['shouldersVsHips'], (typeof SHOULDERS_VS_HIPS)[number]>,
  Covers<BodyObservations['waistIsWidest'], (typeof WAIST_IS_WIDEST)[number]>,
  Covers<BodyObservations['volume'], (typeof VOLUMES)[number]>,
  Covers<BodyObservations['line'], (typeof LINES)[number]>,
  Covers<BodyObservations['thinLegs'], (typeof THIN_LEGS)[number]>,
  Covers<BodyType, (typeof BODY_TYPES)[number]>,
] = [true, true, true, true, true, true];

function everyObservation(): readonly BodyObservations[] {
  const all: BodyObservations[] = [];
  for (const shouldersVsHips of SHOULDERS_VS_HIPS) {
    for (const waistIsWidest of WAIST_IS_WIDEST) {
      for (const volume of VOLUMES) {
        for (const line of LINES) {
          for (const thinLegs of THIN_LEGS) {
            all.push({ shouldersVsHips, waistIsWidest, volume, line, thinLegs });
          }
        }
      }
    }
  }
  return all;
}

const EVERY_OBSERVATION = everyObservation();

describe('the server and client body type classifiers', () => {
  it('agree on every one of the 96 observations', () => {
    const disagreements = EVERY_OBSERVATION.filter((o) => classify(o) !== deriveBodyType(o)).map(
      (o) => `${JSON.stringify(o)} server=${classify(o)} client=${deriveBodyType(o)}`,
    );
    expect(disagreements).toEqual([]);
  });

  it('are swept over all 96 combinations, and over every value of every field', () => {
    expect(EVERY_VALUE_LISTED).toHaveLength(6);
    expect(EVERY_OBSERVATION).toHaveLength(96);
    expect(new Set(EVERY_OBSERVATION.map((o) => JSON.stringify(o))).size).toBe(96);
  });

  it('each reach all four body types, so neither can pass by returning a constant', () => {
    const sorted = (types: Iterable<BodyType | null>) => [...new Set(types)].sort();
    expect(sorted(EVERY_OBSERVATION.map((o) => classify(o)))).toEqual([...BODY_TYPES].sort());
    expect(sorted(EVERY_OBSERVATION.map((o) => deriveBodyType(o)))).toEqual([...BODY_TYPES].sort());
  });
});
