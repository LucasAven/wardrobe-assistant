/**
 * The weather on the Today screen, read only to show it.
 *
 * Nothing composes here any more, so these numbers are information and never a
 * request: a read that fails costs a line of text and nothing else.
 */

export function locatedWeather(position) {
  return { source: 'location', lat: position.coords.latitude, lon: position.coords.longitude };
}

/** A WeatherResponse, or null when it came back in a shape the app does not know. */
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
