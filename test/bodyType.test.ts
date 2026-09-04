import { describe, expect, it } from 'vitest';
import type { BodyObservations } from '../src/domain/bodyType';
import { classify, classifyWithReason } from '../src/domain/bodyType';
import type { BodyType } from '../src/domain/types';

const SHOULDERS: readonly BodyObservations['shouldersVsHips'][] = ['wider', 'narrower', 'equal'];
const VOLUMES: readonly BodyObservations['volume'][] = ['top', 'bottom', 'center', 'even'];
const LINES: readonly BodyObservations['line'][] = ['straight', 'curved'];
const BOOLS: readonly boolean[] = [true, false];

const TYPES: readonly BodyType[] = ['rectangle', 'triangle', 'inverted_triangle', 'circular'];

function everyObservation(): readonly BodyObservations[] {
  const all: BodyObservations[] = [];
  for (const shouldersVsHips of SHOULDERS) {
    for (const waistIsWidest of BOOLS) {
      for (const volume of VOLUMES) {
        for (const line of LINES) {
          for (const thinLegs of BOOLS) {
            all.push({ shouldersVsHips, waistIsWidest, volume, line, thinLegs });
          }
        }
      }
    }
  }
  return all;
}

/** The four the book describes, spelled the way its classification protocol asks them. */
const RECTANGLE: BodyObservations = {
  shouldersVsHips: 'equal',
  waistIsWidest: false,
  volume: 'even',
  line: 'straight',
  thinLegs: false,
};

const TRIANGLE: BodyObservations = {
  shouldersVsHips: 'narrower',
  waistIsWidest: false,
  volume: 'bottom',
  line: 'curved',
  thinLegs: false,
};

const INVERTED_TRIANGLE: BodyObservations = {
  shouldersVsHips: 'wider',
  waistIsWidest: false,
  volume: 'top',
  line: 'straight',
  thinLegs: true,
};

const CIRCULAR: BodyObservations = {
  shouldersVsHips: 'equal',
  waistIsWidest: true,
  volume: 'center',
  line: 'curved',
  thinLegs: false,
};

describe('the four types the book names', () => {
  it('reads shoulders, waist and hips about equal with no marked volume as a rectangle', () => {
    expect(classify(RECTANGLE)).toBe('rectangle');
  });

  it('reads hips and thighs wider than the shoulders with volume low as a triangle', () => {
    expect(classify(TRIANGLE)).toBe('triangle');
  });

  it('reads shoulders notably wider than the hips with volume on top as an inverted triangle', () => {
    expect(classify(INVERTED_TRIANGLE)).toBe('inverted_triangle');
  });

  it('reads the waist as the widest part with volume in the center as circular', () => {
    expect(classify(CIRCULAR)).toBe('circular');
  });
});

describe('precedence', () => {
  it('lets the widest waist decide circular before the shoulder comparison is read', () => {
    for (const shouldersVsHips of SHOULDERS) {
      for (const volume of VOLUMES) {
        expect(classify({ ...RECTANGLE, waistIsWidest: true, shouldersVsHips, volume })).toBe(
          'circular',
        );
      }
    }
  });

  it('lets the shoulder to hip comparison beat volume when the two disagree', () => {
    expect(classify({ ...TRIANGLE, volume: 'top' })).toBe('triangle');
    expect(classify({ ...INVERTED_TRIANGLE, volume: 'bottom' })).toBe('inverted_triangle');
    expect(classify({ ...TRIANGLE, volume: 'even' })).toBe('triangle');
    expect(classify({ ...INVERTED_TRIANGLE, volume: 'center' })).toBe('inverted_triangle');
  });

  it('falls to volume only when shoulders and hips are about equal', () => {
    const equal = { ...RECTANGLE };
    expect(classify({ ...equal, volume: 'center' })).toBe('circular');
    expect(classify({ ...equal, volume: 'bottom' })).toBe('triangle');
    expect(classify({ ...equal, volume: 'top' })).toBe('inverted_triangle');
    expect(classify({ ...equal, volume: 'even' })).toBe('rectangle');
  });

  it('never lets the silhouette line or leg thickness change the answer', () => {
    for (const observation of everyObservation()) {
      const flipped = { ...observation, line: observation.line === 'straight' ? 'curved' : 'straight', thinLegs: !observation.thinLegs } as const;
      expect(classify(flipped)).toBe(classify(observation));
    }
  });
});

describe('totality', () => {
  it('lands every combination of the five observations on one of the four types', () => {
    const seen = new Set<BodyType>();
    for (const observation of everyObservation()) {
      const type = classify(observation);
      expect(TYPES).toContain(type);
      seen.add(type);
    }
    expect([...seen].sort()).toEqual([...TYPES].sort());
  });
});

describe('the reason', () => {
  it('agrees with the type it explains', () => {
    for (const observation of everyObservation()) {
      const reading = classifyWithReason(observation);
      expect(reading.bodyType).toBe(classify(observation));
      expect(reading.because.length).toBeGreaterThan(0);
    }
  });

  it('names the observation that decided, so the user can argue with it', () => {
    expect(classifyWithReason(CIRCULAR).because).toContain('waist');
    expect(classifyWithReason(TRIANGLE).because).toContain('hips');
    expect(classifyWithReason(INVERTED_TRIANGLE).because).toContain('shoulders');
    expect(classifyWithReason({ ...RECTANGLE, volume: 'center' }).because).toContain('center');
  });
});
