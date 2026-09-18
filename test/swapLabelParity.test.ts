/**
 * Two rules, two implementations each.
 *
 * `deriveConstraints` in `src/domain/constraints.ts` turns a moment into the
 * season and the formality floor every recommendation is built from, and
 * `failedFilters` in `src/domain/menu.ts` says which of those two a garment
 * fails. `outfitDay` in `client/lib/outfits.js` and `failedFilters` in
 * `client/lib/outfitcard.js` are the client copies, so the swap picker can
 * label a candidate with what the outfit's own day would have said about it.
 * The picker reads the wardrobe already on the phone and makes no call at all,
 * so it cannot ask for either answer.
 *
 * Nothing but this file stops the copies from drifting, and the symptom is
 * quiet: a tile cautions against a garment the engine would have admitted, or
 * stays silent about one the engine holds back, and the owner reads either
 * label as the engine's own word.
 *
 * Both sweeps enumerate. The day is 12 months by 7 events, and the predicate is
 * every subset of the four seasons by 7 slots by 5 garment formalities by 4
 * constraint seasons by 5 floors.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// `client/lib` is plain JS outside the tsconfig `include`, so it ships no
// declaration file. The shapes are stated once here and the rest is typed.
// @ts-expect-error TS7016: untyped ES module.
import { failedFilters as untypedClientFailedFilters } from '../client/lib/outfitcard.js';
// @ts-expect-error TS7016: untyped ES module.
import { outfitDay as untypedOutfitDay } from '../client/lib/outfits.js';
import { deriveConstraints } from '../src/domain/constraints';
import { failedFilters as serverFailedFilters } from '../src/domain/menu';
import type {
  Constraints,
  EventKind,
  Formality,
  Garment,
  Season,
  Slot,
  Waived,
} from '../src/domain/types';
import { MILD_ERRANDS, makeGarment } from './fixtures';

/** What a saved outfit can still say about the day it was built for. */
interface Day {
  readonly season: Season | null;
  readonly minFormality: Formality | null;
}

/** The two fields of a `SavedOutfit` that `outfitDay` reads. */
interface DayInput {
  readonly createdAt: string;
  readonly event: EventKind | null;
}

const outfitDay: (outfit: DayInput) => Day = untypedOutfitDay;
const clientFailedFilters: (garment: Garment, day: Day) => readonly string[] =
  untypedClientFailedFilters;

const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
const EVENTS = ['home', 'errands', 'work', 'social', 'dinner', 'formal', 'active'] as const;
const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;
const SLOTS = ['base', 'top', 'mid', 'outer', 'bottom', 'shoes', 'accessory'] as const;
const FORMALITIES = [1, 2, 3, 4, 5] as const;

/** `true` only when the list names every value of the type. Otherwise `never`. */
type Covers<Field, Listed> = [Exclude<Field, Listed>] extends [never] ? true : never;

/**
 * A widened domain type breaks the build on these lines rather than shrinking
 * either sweep in silence, which the counts alone cannot catch.
 */
const EVERY_VALUE_LISTED: [
  Covers<EventKind, (typeof EVENTS)[number]>,
  Covers<Season, (typeof SEASONS)[number]>,
  Covers<Slot, (typeof SLOTS)[number]>,
  Covers<Formality, (typeof FORMALITIES)[number]>,
] = [true, true, true, true];

// ---------------------------------------------------------------------------
// The day
// ---------------------------------------------------------------------------

interface DayCase {
  readonly month: number;
  readonly event: EventKind;
  readonly date: Date;
}

/** Midday in the middle of the month, so the only edge in this sweep is the named one below. */
function middayOf(month: number): Date {
  return new Date(Date.UTC(2026, month - 1, 15, 12, 0, 0));
}

const EVERY_DAY: readonly DayCase[] = MONTHS.flatMap((month) =>
  EVENTS.map((event) => ({ month, event, date: middayOf(month) })),
);

/**
 * Through the public door rather than at `seasonOf` and the table behind it.
 * That also pins the composition, so a `deriveConstraints` that stopped calling
 * `seasonOf` could not pass a test aimed straight at `seasonOf`.
 */
function serverDay(one: DayCase): Day {
  const constraints = deriveConstraints({ ...MILD_ERRANDS, date: one.date, event: one.event });
  return { season: constraints.season, minFormality: constraints.minFormality };
}

function clientDay(one: DayCase): Day {
  return outfitDay({ createdAt: one.date.toISOString(), event: one.event });
}

describe('the server and client readings of an outfit day', () => {
  it('agree on every one of the 84 days', () => {
    const disagreements = EVERY_DAY.filter((one) => {
      const server = serverDay(one);
      const client = clientDay(one);
      return server.season !== client.season || server.minFormality !== client.minFormality;
    }).map((one) => {
      const server = serverDay(one);
      const client = clientDay(one);
      return `month ${one.month} ${one.event}: server=${server.season}/${server.minFormality} client=${client.season}/${client.minFormality}`;
    });

    expect(disagreements).toEqual([]);
  });

  it('are swept over all 84 days, and over every month and every event', () => {
    expect(EVERY_VALUE_LISTED).toHaveLength(4);
    expect(EVERY_DAY).toHaveLength(84);
    expect(new Set(EVERY_DAY.map((one) => `${one.month}/${one.event}`)).size).toBe(84);
  });

  it('each reach all four seasons, so neither can pass by naming one', () => {
    const seasons = (days: readonly DayCase[], read: (one: DayCase) => Day) =>
      [...new Set(days.map((one) => read(one).season))].sort();

    expect(seasons(EVERY_DAY, serverDay)).toEqual([...SEASONS].sort());
    expect(seasons(EVERY_DAY, clientDay)).toEqual([...SEASONS].sort());
  });

  it('each reach all three floors, so neither can pass by naming one', () => {
    const floors = (days: readonly DayCase[], read: (one: DayCase) => Day) =>
      [...new Set(days.map((one) => read(one).minFormality))].sort();

    expect(floors(EVERY_DAY, serverDay)).toEqual([1, 3, 4]);
    expect(floors(EVERY_DAY, clientDay)).toEqual([1, 3, 4]);
  });
});

// ---------------------------------------------------------------------------
// The predicate
// ---------------------------------------------------------------------------

/** Every subset of the four seasons, which is the honest way to sweep an empty one. */
function seasonSets(): readonly (readonly Season[])[] {
  return SEASONS.reduce<readonly (readonly Season[])[]>(
    (sets, season) => [...sets, ...sets.map((set) => [...set, season])],
    [[]],
  );
}

const SEASON_SETS = seasonSets();

/** Only `season` and `minFormality` are swept, so the rest of the day is held still. */
const BASE_CONSTRAINTS = deriveConstraints(MILD_ERRANDS);

interface FilterCase {
  readonly garment: Garment;
  readonly constraints: Constraints;
}

function everyFilterCase(): readonly FilterCase[] {
  const all: FilterCase[] = [];
  for (const seasons of SEASON_SETS) {
    for (const slot of SLOTS) {
      for (const formality of FORMALITIES) {
        const garment = makeGarment({ id: 'swept', slot, subtype: 'a garment', seasons, formality });
        for (const season of SEASONS) {
          for (const minFormality of FORMALITIES) {
            all.push({ garment, constraints: { ...BASE_CONSTRAINTS, season, minFormality } });
          }
        }
      }
    }
  }
  return all;
}

const EVERY_FILTER_CASE = everyFilterCase();

/** The list is ordered, so joining it compares the order as well as the members. */
const serverFailures = (one: FilterCase): string =>
  serverFailedFilters(one.garment, one.constraints).join('|');

const clientFailures = (one: FilterCase): string =>
  clientFailedFilters(one.garment, {
    season: one.constraints.season,
    minFormality: one.constraints.minFormality,
  }).join('|');

/**
 * The whole output space of a function returning a subset of a two element
 * ordered list, so a side that ignores either clause reaches at most two of the
 * four.
 */
const EVERY_OUTCOME = ['', 'formality', 'season', 'season|formality'] as const;

/**
 * `cooldown` is the third `Waived` code and neither predicate can reach it: it
 * needs the wear window, which the picker has none of. A fourth code added to
 * the type breaks the build here, because `EVERY_OUTCOME` above would stop
 * being the whole output space.
 */
const EVERY_WAIVED = ['season', 'formality', 'cooldown'] as const;
const EVERY_CODE_LISTED: Covers<Waived, (typeof EVERY_WAIVED)[number]> = true;

describe('the server and client filter predicates', () => {
  it('agree on every one of the 11200 cases', () => {
    const disagreements = EVERY_FILTER_CASE.filter(
      (one) => serverFailures(one) !== clientFailures(one),
    ).map(
      (one) =>
        `${one.garment.slot} formality ${one.garment.formality} seasons [${one.garment.seasons.join(',')}] against ${one.constraints.season} floor ${one.constraints.minFormality}: server=[${serverFailures(one)}] client=[${clientFailures(one)}]`,
    );

    expect(disagreements).toEqual([]);
  });

  it('are swept over all 11200 cases, and over every subset of the seasons', () => {
    expect(EVERY_CODE_LISTED).toBe(true);
    expect(SEASON_SETS).toHaveLength(16);
    expect(EVERY_FILTER_CASE).toHaveLength(11200);
    expect(new Set(SEASON_SETS.map((set) => [...set].sort().join('|'))).size).toBe(16);
  });

  it('each reach all four outcomes, so neither can pass by returning a constant', () => {
    const reached = (read: (one: FilterCase) => string) =>
      [...new Set(EVERY_FILTER_CASE.map(read))].sort();

    expect(reached(serverFailures)).toEqual([...EVERY_OUTCOME].sort());
    expect(reached(clientFailures)).toEqual([...EVERY_OUTCOME].sort());
  });
});

// ---------------------------------------------------------------------------
// The hour the two calendars disagree on
// ---------------------------------------------------------------------------

const ORIGINAL_TZ = process.env.TZ;

describe('a moment whose local month is not its UTC month', () => {
  beforeAll(() => {
    process.env.TZ = 'America/Argentina/Buenos_Aires';
  });

  afterAll(() => {
    // Assigning `undefined` writes the string "undefined", which leaves the
    // process in UTC rather than back where it started. In a file about reading
    // a calendar that is the one restore that must not be approximate.
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  });

  /**
   * The drift this file exists for. A client rewritten as
   * `new Date(createdAt).getMonth()` reads a row saved in the first hours of a
   * month as the month before it, and on the four months that open a season
   * that is the wrong half of the year.
   */
  it('is read by both sides as the month the row names', () => {
    const iso = '2026-03-01T01:00:00Z';
    const date = new Date(iso);

    expect(date.getMonth()).toBe(1);
    expect(date.getUTCMonth()).toBe(2);

    expect(deriveConstraints({ ...MILD_ERRANDS, date }).season).toBe('autumn');
    expect(outfitDay({ createdAt: iso, event: null }).season).toBe('autumn');
  });

  /**
   * The other half of the same drift, and the half a `toISOString()` sweep
   * cannot reach. `created_at TEXT NOT NULL DEFAULT (datetime('now'))` writes
   * `YYYY-MM-DD HH:MM:SS`, which JS reads as local time, so `new Date` plus
   * `getUTCMonth` moves a row saved in the last hours of a month into the next
   * one. On the four months that open a season that is the wrong half of the
   * year, which is the whole reason the client reads the digits.
   */
  it('reads a space separated row by its own digits, not by a parsed instant', () => {
    const LAST_HOURS: readonly (readonly [string, Season])[] = [
      ['2026-02-28 22:00:00', 'summer'],
      ['2026-05-31 23:00:00', 'autumn'],
      ['2026-08-31 23:30:00', 'winter'],
      ['2026-11-30 21:15:00', 'spring'],
    ];

    const wrong = LAST_HOURS.filter(([createdAt, season]) => {
      const parsed = new Date(createdAt);
      // The case only bites when the two readings really do differ, so a run in
      // a zone where they agree fails here rather than passing on nothing.
      expect(parsed.getUTCMonth()).not.toBe(parsed.getMonth());
      return outfitDay({ createdAt, event: null }).season !== season;
    });

    expect(wrong).toEqual([]);
  });
});
