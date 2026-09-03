/**
 * Every number the engine chooses, in one function over small tables.
 *
 * Tuning the app means editing this file and nothing else. That is the whole
 * argument against a weighted scorer: numbers a person can reason about
 * instead of weights in a sum with no ground truth.
 */

import type {
  Constraints,
  EventKind,
  Formality,
  Moment,
  Season,
  Slot,
  WarmthBands,
} from './types';

interface WarmthRow {
  readonly min: number;
  readonly max: number;
  readonly label: string;
}

/** Warmth summed over every worn layer, before the core is split out of it. */
const TOTAL_WARMTH_BY_FEELS_LIKE: readonly (WarmthRow & { readonly atOrAboveC: number })[] = [
  { atOrAboveC: 24, min: 0, max: 3, label: 'hot' },
  { atOrAboveC: 18, min: 2, max: 5, label: 'warm' },
  { atOrAboveC: 12, min: 4, max: 8, label: 'mild' },
  { atOrAboveC: 5, min: 6, max: 11, label: 'cool' },
  { atOrAboveC: 0, min: 9, max: 14, label: 'cold' },
];

const BELOW_ZERO: WarmthRow = { min: 11, max: 15, label: 'freezing' };

const WIND_SHIFT_BY_KPH: readonly { readonly atOrAboveKph: number; readonly shift: number }[] = [
  { atOrAboveKph: 40, shift: 2 },
  { atOrAboveKph: 25, shift: 1 },
];

/** Wind is what an outer layer is for, so it stops mattering once nobody would wear one. */
const WIND_MATTERS_BELOW_C = 18;

/**
 * How much of the total warmth the outer layer is allowed to carry, by how much
 * of the day is spent outside.
 */
const OUTER_ALLOWANCE_BY_HOURS: readonly { readonly atOrAboveHours: number; readonly allowance: number }[] = [
  { atOrAboveHours: 4, allowance: 1 },
  { atOrAboveHours: 1.5, allowance: 2 },
];

const MOSTLY_INDOORS_ALLOWANCE = 4;

/** A band of zero width would reject every outfit that is one point off. */
const MIN_BAND_WIDTH = 2;

const MAX_TOTAL_WARMTH = 15;

const MIN_FORMALITY_BY_EVENT: Readonly<Record<EventKind, Formality>> = {
  home: 1,
  active: 1,
  errands: 1,
  work: 3,
  social: 3,
  dinner: 3,
  formal: 4,
};

const RAIN_PROBABILITY_THRESHOLD = 0.4;

/** A dash to the car gets wet. It does not need boots. */
const RAIN_MIN_HOURS_OUTDOORS = 0.5;

const COOLDOWN_DAYS: Readonly<Record<Slot, number>> = {
  outer: 5,
  mid: 3,
  accessory: 3,
  top: 2,
  shoes: 2,
  bottom: 1,
  base: 1,
};

/**
 * Buenos Aires. A northern-hemisphere table would put winter in the wrong half
 * of the year, and this app has one user in one hemisphere.
 */
function seasonOf(date: Date): Season {
  const month = date.getUTCMonth() + 1;
  if (month === 12 || month <= 2) return 'summer';
  if (month <= 5) return 'autumn';
  if (month <= 8) return 'winter';
  return 'spring';
}

function warmthRowFor(feelsLikeC: number): WarmthRow {
  return TOTAL_WARMTH_BY_FEELS_LIKE.find((row) => feelsLikeC >= row.atOrAboveC) ?? BELOW_ZERO;
}

function windShiftFor(moment: Moment): number {
  if (moment.feelsLikeC >= WIND_MATTERS_BELOW_C) return 0;
  return WIND_SHIFT_BY_KPH.find((row) => moment.windKph >= row.atOrAboveKph)?.shift ?? 0;
}

function outerAllowanceFor(hoursOutdoors: number): number {
  return (
    OUTER_ALLOWANCE_BY_HOURS.find((row) => hoursOutdoors >= row.atOrAboveHours)?.allowance ??
    MOSTLY_INDOORS_ALLOWANCE
  );
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * Two bands because the outer layer comes off at the door. `core` is what is
 * actually worn for most of the day, so how much of the total it has to carry
 * depends on how much of the day is spent outside: a desk day can put nearly
 * all of its warmth in a coat and sit in a light shirt, while a day spent
 * outdoors is worn at the outdoor temperature the whole time and the core has
 * to be warm on its own.
 */
function warmthBandsFor(moment: Moment): WarmthBands {
  const row = warmthRowFor(moment.feelsLikeC);
  const shift = windShiftFor(moment);

  const withOuterMin = clamp(row.min + shift, 0, MAX_TOTAL_WARMTH);
  const withOuterMax = clamp(row.max + shift, withOuterMin + MIN_BAND_WIDTH, MAX_TOTAL_WARMTH);

  const allowance = outerAllowanceFor(moment.hoursOutdoors);
  const coreMin = Math.max(withOuterMin - allowance, 0);
  const coreMax = Math.max(withOuterMax - allowance, coreMin + MIN_BAND_WIDTH);

  return {
    core: { min: coreMin, max: coreMax },
    withOuter: { min: withOuterMin, max: withOuterMax },
    label: shift > 0 ? `${row.label}, windy` : row.label,
  };
}

export function deriveConstraints(moment: Moment): Constraints {
  return {
    warmth: warmthBandsFor(moment),
    minFormality: MIN_FORMALITY_BY_EVENT[moment.event],
    rainProof: moment.precipProbability >= RAIN_PROBABILITY_THRESHOLD && moment.hoursOutdoors >= RAIN_MIN_HOURS_OUTDOORS,
    season: seasonOf(moment.date),
    cooldownDays: COOLDOWN_DAYS,
  };
}
