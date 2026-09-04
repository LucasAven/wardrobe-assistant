/**
 * The morning question, turned into a RecommendRequest.
 *
 * Weather is optional in the contract on purpose: send a location and the
 * Worker fetches it, or send the numbers. Both shapes are built here so the
 * screen never assembles a request by hand.
 */

export const EVENTS = [
  { value: 'home', label: 'home' },
  { value: 'errands', label: 'errands' },
  { value: 'work', label: 'work' },
  { value: 'social', label: 'social' },
  { value: 'dinner', label: 'dinner' },
  { value: 'formal', label: 'formal' },
  { value: 'active', label: 'active' },
];

export const TIMES_OF_DAY = [
  { value: 'morning', label: 'morning' },
  { value: 'afternoon', label: 'afternoon' },
  { value: 'evening', label: 'evening' },
];

/**
 * Four steps, not a slider. They land in different bands in
 * src/domain/constraints.ts: rain stops mattering below half an hour, and the
 * outer layer allowance steps at 1.5 and 4 hours.
 */
export const OUTDOORS = [
  { value: 0, label: 'barely outside' },
  { value: 1, label: 'about an hour' },
  { value: 3, label: 'a few hours' },
  { value: 6, label: 'most of the day' },
];

export const DEFAULT_EVENT = 'work';
export const DEFAULT_HOURS_OUTDOORS = 1;

/** The rain toggle says it will rain. The engine treats anything over 0.4 as rain. */
export const RAIN_PROBABILITY = 0.8;

const MORNING_ENDS_AT = 12;
const AFTERNOON_ENDS_AT = 18;

export function defaultTimeOfDay(date = new Date()) {
  const hour = date.getHours();
  if (hour < MORNING_ENDS_AT) return 'morning';
  if (hour < AFTERNOON_ENDS_AT) return 'afternoon';
  return 'evening';
}

const MIN_TEMP_C = -60;
const MAX_TEMP_C = 60;

/** A typed temperature, or null. Accepts the comma a Spanish keyboard offers first. */
export function parseTemperature(text) {
  const cleaned = String(text ?? '')
    .trim()
    .replace(',', '.');
  if (cleaned === '') return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < MIN_TEMP_C || value > MAX_TEMP_C) return null;
  return value;
}

export function locatedWeather(position) {
  return { source: 'location', lat: position.coords.latitude, lon: position.coords.longitude };
}

export function typedWeather(tempC, rain) {
  return { source: 'manual', tempC, rain };
}

/**
 * One typed number answers both temperature fields, because the bands read
 * `feelsLikeC` and a person typing a single number means that one. Wind stays
 * at zero: nothing was typed for it, and wind only ever shifts the band up.
 */
export function weatherFields(weather) {
  if (weather?.source === 'location' && Number.isFinite(weather.lat) && Number.isFinite(weather.lon)) {
    return { lat: weather.lat, lon: weather.lon };
  }
  if (weather?.source === 'manual' && Number.isFinite(weather.tempC)) {
    return {
      tempC: weather.tempC,
      feelsLikeC: weather.tempC,
      precipProbability: weather.rain === true ? RAIN_PROBABILITY : 0,
      windKph: 0,
    };
  }
  return {};
}

/** False while the location is still being asked for and nothing has been typed. */
export function weatherReady(weather) {
  return Object.keys(weatherFields(weather)).length > 0;
}

export function buildRecommendRequest(state) {
  const request = {
    event: state.event,
    timeOfDay: state.timeOfDay,
    hoursOutdoors: state.hoursOutdoors,
    ...weatherFields(state.weather),
  };

  const mood = String(state.mood ?? '').trim();
  return mood === '' ? request : { ...request, mood };
}

/**
 * A WeatherResponse, read only to show it. The request still travels as a
 * location, so a weather read that fails or comes back in a shape this does not
 * recognise costs the screen a line of text and nothing else.
 */
export function readWeather(body) {
  if (body === null || typeof body !== 'object') return null;
  const { tempC, feelsLikeC, precipProbability, windKph } = body;
  if (![tempC, feelsLikeC, precipProbability, windKph].every((value) => Number.isFinite(value))) return null;
  return { tempC, feelsLikeC, precipProbability, windKph };
}

/** `label` is not read: it says the temperature in words, and the numbers are already here. */
export function weatherLine(weather) {
  const parts = [`${Math.round(weather.tempC)}°, feels like ${Math.round(weather.feelsLikeC)}°`];
  if (weather.precipProbability > 0) parts.push(`${Math.round(weather.precipProbability * 100)}% rain`);
  return parts.join(', ');
}
