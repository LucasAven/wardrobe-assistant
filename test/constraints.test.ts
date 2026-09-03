import { describe, expect, it } from 'vitest';
import { deriveConstraints } from '../src/domain/constraints';
import type { Moment } from '../src/domain/types';
import { COOL_FORMAL, MILD_ERRANDS, SUMMER_DAY, WINTER_DAY } from './fixtures';

function moment(over: Partial<Moment>): Moment {
  return { ...MILD_ERRANDS, ...over };
}

describe('warmth bands', () => {
  it('pushes warmth into the core as more of the day moves outdoors', () => {
    const indoors = deriveConstraints(moment({ feelsLikeC: 8, hoursOutdoors: 1 }));
    const outdoors = deriveConstraints(moment({ feelsLikeC: 8, hoursOutdoors: 6 }));

    expect(indoors.warmth.withOuter).toEqual(outdoors.warmth.withOuter);
    expect(indoors.warmth.core.min).toBeLessThan(outdoors.warmth.core.min);
    expect(indoors.warmth.core.max).toBeLessThan(outdoors.warmth.core.max);
  });

  it('keeps the core band at or below the total in every case', () => {
    for (const feelsLikeC of [-5, 2, 8, 14, 20, 27]) {
      for (const hoursOutdoors of [0, 1, 2, 4, 8]) {
        const { warmth } = deriveConstraints(moment({ feelsLikeC, hoursOutdoors }));
        expect(warmth.core.min).toBeLessThanOrEqual(warmth.withOuter.min);
        expect(warmth.core.max).toBeLessThanOrEqual(warmth.withOuter.max);
        expect(warmth.core.min).toBeLessThan(warmth.core.max);
        expect(warmth.core.min).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('asks for more warmth as it gets colder', () => {
    const mild = deriveConstraints(moment({ feelsLikeC: 15 }));
    const cold = deriveConstraints(moment({ feelsLikeC: 2 }));
    const freezing = deriveConstraints(moment({ feelsLikeC: -6 }));

    expect(mild.warmth.withOuter.min).toBeLessThan(cold.warmth.withOuter.min);
    expect(cold.warmth.withOuter.min).toBeLessThan(freezing.warmth.withOuter.min);
    expect(freezing.warmth.label).toBe('freezing');
  });

  it('reads feelsLikeC and not tempC', () => {
    const still = deriveConstraints(moment({ tempC: 12, feelsLikeC: 12 }));
    const biting = deriveConstraints(moment({ tempC: 12, feelsLikeC: 2 }));

    expect(biting.warmth.withOuter.min).toBeGreaterThan(still.warmth.withOuter.min);
  });

  it('shifts the band up in cold wind and says so in the label', () => {
    const calm = deriveConstraints(moment({ feelsLikeC: 6, windKph: 5 }));
    const windy = deriveConstraints(moment({ feelsLikeC: 6, windKph: 30 }));
    const gale = deriveConstraints(moment({ feelsLikeC: 6, windKph: 55 }));

    expect(windy.warmth.withOuter.min).toBe(calm.warmth.withOuter.min + 1);
    expect(gale.warmth.withOuter.min).toBe(calm.warmth.withOuter.min + 2);
    expect(windy.warmth.label).toContain('windy');
    expect(calm.warmth.label).not.toContain('windy');
  });

  it('ignores wind on a warm day', () => {
    const calm = deriveConstraints(moment({ feelsLikeC: 25, windKph: 5 }));
    const windy = deriveConstraints(moment({ feelsLikeC: 25, windKph: 55 }));

    expect(windy.warmth).toEqual(calm.warmth);
  });
});

describe('formality floor', () => {
  it('rises with the event', () => {
    const home = deriveConstraints(moment({ event: 'home' }));
    const work = deriveConstraints(moment({ event: 'work' }));
    const formal = deriveConstraints(COOL_FORMAL);

    expect(home.minFormality).toBe(1);
    expect(work.minFormality).toBe(3);
    expect(formal.minFormality).toBe(4);
  });
});

describe('rain', () => {
  it('needs both a real chance of rain and time spent in it', () => {
    const dry = deriveConstraints(moment({ precipProbability: 0.1, hoursOutdoors: 4 }));
    const dashToTheCar = deriveConstraints(moment({ precipProbability: 0.9, hoursOutdoors: 0.2 }));
    const soaked = deriveConstraints(moment({ precipProbability: 0.6, hoursOutdoors: 4 }));

    expect(dry.rainProof).toBe(false);
    expect(dashToTheCar.rainProof).toBe(false);
    expect(soaked.rainProof).toBe(true);
  });
});

describe('season', () => {
  it('follows the southern hemisphere calendar', () => {
    expect(deriveConstraints(MILD_ERRANDS).season).toBe('autumn');
    expect(deriveConstraints(moment({ date: WINTER_DAY })).season).toBe('winter');
    expect(deriveConstraints(moment({ date: SUMMER_DAY })).season).toBe('summer');
    expect(deriveConstraints(moment({ date: new Date('2026-10-05T09:00:00Z') })).season).toBe(
      'spring',
    );
  });

  it('reads the season from the same instant as the weather', () => {
    const winterWeatherOnASummerDay = deriveConstraints(
      moment({ feelsLikeC: 2, date: SUMMER_DAY }),
    );

    expect(winterWeatherOnASummerDay.season).toBe('summer');
    expect(winterWeatherOnASummerDay.warmth.label).toBe('cold');
  });
});

describe('cooldown', () => {
  it('holds a jacket back for longer than a pair of jeans', () => {
    const { cooldownDays } = deriveConstraints(MILD_ERRANDS);

    expect(cooldownDays.outer).toBeGreaterThan(cooldownDays.mid);
    expect(cooldownDays.mid).toBeGreaterThan(cooldownDays.bottom);
    expect(cooldownDays.bottom).toBeLessThan(cooldownDays.shoes);
  });
});
