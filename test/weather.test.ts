import { describe, expect, it } from 'vitest';
import { parseForecast, weatherLabel } from '../src/worker/weather';

/**
 * Every fixture below is a response captured from api.open-meteo.com, pasted
 * whole. `MID_PACIFIC` was fetched without `precipitation_probability` in the
 * `current` list, which is what a response looks like when only the hourly
 * series carries it. `JMA_ONLY` pins a single weather model that does not
 * produce the field at all, so the key is there with a null under it in both
 * blocks.
 */

const BUENOS_AIRES = JSON.parse(
  `{"latitude":-34.622143,"longitude":-58.40909,"generationtime_ms":0.14007091522216797,"utc_offset_seconds":-10800,"timezone":"America/Argentina/Buenos_Aires","timezone_abbreviation":"GMT-3","elevation":18.0,"current_units":{"time":"iso8601","interval":"seconds","temperature_2m":"°C","apparent_temperature":"°C","precipitation_probability":"%","wind_speed_10m":"km/h"},"current":{"time":"2026-09-04T11:15","interval":900,"temperature_2m":13.2,"apparent_temperature":11.4,"precipitation_probability":0,"wind_speed_10m":6.9},"hourly_units":{"time":"iso8601","precipitation_probability":"%"},"hourly":{"time":["2026-09-04T00:00","2026-09-04T01:00","2026-09-04T02:00","2026-09-04T03:00","2026-09-04T04:00","2026-09-04T05:00","2026-09-04T06:00","2026-09-04T07:00","2026-09-04T08:00","2026-09-04T09:00","2026-09-04T10:00","2026-09-04T11:00","2026-09-04T12:00","2026-09-04T13:00","2026-09-04T14:00","2026-09-04T15:00","2026-09-04T16:00","2026-09-04T17:00","2026-09-04T18:00","2026-09-04T19:00","2026-09-04T20:00","2026-09-04T21:00","2026-09-04T22:00","2026-09-04T23:00"],"precipitation_probability":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]}}`,
) as unknown;

const MID_PACIFIC = JSON.parse(
  `{"latitude":0.035149384,"longitude":-139.97662,"generationtime_ms":0.11742115020751953,"utc_offset_seconds":0,"timezone":"GMT","timezone_abbreviation":"GMT","elevation":0.0,"current_units":{"time":"iso8601","interval":"seconds","temperature_2m":"°C","apparent_temperature":"°C","wind_speed_10m":"km/h"},"current":{"time":"2026-09-04T14:15","interval":900,"temperature_2m":27.5,"apparent_temperature":32.0,"wind_speed_10m":10.1},"hourly_units":{"time":"iso8601","precipitation_probability":"%"},"hourly":{"time":["2026-09-04T00:00","2026-09-04T01:00","2026-09-04T02:00","2026-09-04T03:00","2026-09-04T04:00","2026-09-04T05:00","2026-09-04T06:00","2026-09-04T07:00","2026-09-04T08:00","2026-09-04T09:00","2026-09-04T10:00","2026-09-04T11:00","2026-09-04T12:00","2026-09-04T13:00","2026-09-04T14:00","2026-09-04T15:00","2026-09-04T16:00","2026-09-04T17:00","2026-09-04T18:00","2026-09-04T19:00","2026-09-04T20:00","2026-09-04T21:00","2026-09-04T22:00","2026-09-04T23:00"],"precipitation_probability":[78,83,84,84,82,79,78,82,88,92,90,85,82,84,88,90,88,83,78,72,65,59,54,50]}}`,
) as unknown;

const JMA_ONLY = JSON.parse(
  `{"latitude":-34.5,"longitude":-58.5,"generationtime_ms":0.1323223114013672,"utc_offset_seconds":-10800,"timezone":"America/Argentina/Buenos_Aires","timezone_abbreviation":"GMT-3","elevation":18.0,"current_units":{"time":"iso8601","interval":"seconds","temperature_2m":"°C","apparent_temperature":"°C","precipitation_probability":"undefined","wind_speed_10m":"km/h"},"current":{"time":"2026-09-04T11:15","interval":900,"temperature_2m":12.7,"apparent_temperature":9.8,"precipitation_probability":null,"wind_speed_10m":8.4},"hourly_units":{"time":"iso8601","precipitation_probability":"undefined"},"hourly":{"time":["2026-09-04T00:00","2026-09-04T01:00","2026-09-04T02:00","2026-09-04T03:00","2026-09-04T04:00","2026-09-04T05:00","2026-09-04T06:00","2026-09-04T07:00","2026-09-04T08:00","2026-09-04T09:00","2026-09-04T10:00","2026-09-04T11:00","2026-09-04T12:00","2026-09-04T13:00","2026-09-04T14:00","2026-09-04T15:00","2026-09-04T16:00","2026-09-04T17:00","2026-09-04T18:00","2026-09-04T19:00","2026-09-04T20:00","2026-09-04T21:00","2026-09-04T22:00","2026-09-04T23:00"],"precipitation_probability":[null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null]}}`,
) as unknown;

const FALKLANDS = JSON.parse(
  `{"latitude":-51.704746,"longitude":-57.868866,"generationtime_ms":0.09059906005859375,"utc_offset_seconds":-10800,"timezone":"Atlantic/Stanley","timezone_abbreviation":"GMT-3","elevation":17.0,"current_units":{"time":"iso8601","interval":"seconds","temperature_2m":"°C","apparent_temperature":"°C","precipitation_probability":"%","wind_speed_10m":"km/h"},"current":{"time":"2026-09-04T11:30","interval":900,"temperature_2m":0.6,"apparent_temperature":-6.8,"precipitation_probability":9,"wind_speed_10m":30.4},"hourly_units":{"time":"iso8601","precipitation_probability":"%"},"hourly":{"time":["2026-09-04T00:00","2026-09-04T01:00","2026-09-04T02:00","2026-09-04T03:00","2026-09-04T04:00","2026-09-04T05:00","2026-09-04T06:00","2026-09-04T07:00","2026-09-04T08:00","2026-09-04T09:00","2026-09-04T10:00","2026-09-04T11:00","2026-09-04T12:00","2026-09-04T13:00","2026-09-04T14:00","2026-09-04T15:00","2026-09-04T16:00","2026-09-04T17:00","2026-09-04T18:00","2026-09-04T19:00","2026-09-04T20:00","2026-09-04T21:00","2026-09-04T22:00","2026-09-04T23:00"],"precipitation_probability":[0,0,0,2,2,2,2,2,3,4,6,8,10,11,10,10,9,8,8,9,11,12,10,7]}}`,
) as unknown;

const REYKJAVIK = JSON.parse(
  `{"latitude":64.09088,"longitude":-21.90741,"generationtime_ms":0.11789798736572266,"utc_offset_seconds":0,"timezone":"Atlantic/Reykjavik","timezone_abbreviation":"GMT","elevation":23.0,"current_units":{"time":"iso8601","interval":"seconds","temperature_2m":"°C","apparent_temperature":"°C","precipitation_probability":"%","wind_speed_10m":"km/h"},"current":{"time":"2026-09-04T14:30","interval":900,"temperature_2m":10.8,"apparent_temperature":8.1,"precipitation_probability":80,"wind_speed_10m":10.4},"hourly_units":{"time":"iso8601","precipitation_probability":"%"},"hourly":{"time":["2026-09-04T00:00","2026-09-04T01:00","2026-09-04T02:00","2026-09-04T03:00","2026-09-04T04:00","2026-09-04T05:00","2026-09-04T06:00","2026-09-04T07:00","2026-09-04T08:00","2026-09-04T09:00","2026-09-04T10:00","2026-09-04T11:00","2026-09-04T12:00","2026-09-04T13:00","2026-09-04T14:00","2026-09-04T15:00","2026-09-04T16:00","2026-09-04T17:00","2026-09-04T18:00","2026-09-04T19:00","2026-09-04T20:00","2026-09-04T21:00","2026-09-04T22:00","2026-09-04T23:00"],"precipitation_probability":[20,31,49,59,49,30,16,11,10,14,24,39,53,65,76,82,79,71,61,48,34,22,15,11]}}`,
) as unknown;


describe('parseForecast', () => {
  it('reads temperature, apparent temperature, wind and probability off the current block', () => {
    expect(parseForecast(BUENOS_AIRES)).toEqual({
      tempC: 13.2,
      feelsLikeC: 11.4,
      precipProbability: 0,
      windKph: 6.9,
      label: '13 degrees, feels like 11',
    });
  });

  it('falls back to the current hour of the hourly series when the current block has no probability', () => {
    // current.time is 2026-09-04T14:15, so the 14:00 slot is the one that counts.
    expect(parseForecast(MID_PACIFIC)).toMatchObject({
      tempC: 27.5,
      feelsLikeC: 32,
      precipProbability: 0.88,
      windKph: 10.1,
    });
  });

  it('reads a missing probability as no rain rather than as rain', () => {
    expect(parseForecast(JMA_ONLY)).toEqual({
      tempC: 12.7,
      feelsLikeC: 9.8,
      precipProbability: 0,
      windKph: 8.4,
      label: '13 degrees, feels like 10',
    });
  });

  it('converts the percentage the API sends into the 0 to 1 the contract asks for', () => {
    expect(parseForecast(REYKJAVIK).precipProbability).toBeCloseTo(0.8, 10);
    expect(parseForecast(FALKLANDS).precipProbability).toBeCloseTo(0.09, 10);
  });

  it('refuses a payload that is not a forecast', () => {
    expect(() => parseForecast({ error: true, reason: 'Data corrupted at path' })).toThrow();
    expect(() => parseForecast(null)).toThrow();
  });
});

describe('the label', () => {
  it('rounds both temperatures and says nothing else on a calm dry day', () => {
    expect(parseForecast(BUENOS_AIRES).label).toBe('13 degrees, feels like 11');
  });

  it('calls out wind when it is strong enough to want an outer layer', () => {
    expect(parseForecast(FALKLANDS).label).toBe('1 degree, feels like -7, windy');
  });

  it('calls out rain once it is likely enough to change the shoes', () => {
    expect(parseForecast(REYKJAVIK).label).toBe('11 degrees, feels like 8, rain likely');
  });

  it('says both when both are true', () => {
    expect(
      weatherLabel({ tempC: 9, feelsLikeC: 6, precipProbability: 0.7, windKph: 40 }),
    ).toBe('9 degrees, feels like 6, windy, rain likely');
  });
});
