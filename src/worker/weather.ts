/**
 * Open-Meteo, no API key. The field names below were read off a live response
 * rather than recalled: `current.temperature_2m`, `current.apparent_temperature`,
 * `current.wind_speed_10m` and `current.precipitation_probability`, with the
 * same probability repeated hourly.
 *
 * `precipitation_probability` is the one field that is not always there. Some of
 * the models Open-Meteo blends do not produce it, and then the key is present
 * with a `null` value in both `current` and `hourly`. Asking for it in `hourly`
 * as well costs nothing and covers the case where only the hourly series has it.
 */

import { z } from 'zod';
import type { WeatherResponse } from './contract';

const ENDPOINT = 'https://api.open-meteo.com/v1/forecast';

/**
 * `timezone=auto` is what makes the hour lookup below work: it puts
 * `current.time` and every `hourly.time` in the same local zone, so the two can
 * be compared as strings.
 */
function urlFor(lat: number, lon: number): string {
  const query = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: 'temperature_2m,apparent_temperature,precipitation_probability,wind_speed_10m',
    hourly: 'precipitation_probability',
    temperature_unit: 'celsius',
    wind_speed_unit: 'kmh',
    timezone: 'auto',
    forecast_days: '1',
  });
  return `${ENDPOINT}?${query.toString()}`;
}

const ForecastSchema = z.object({
  current: z.object({
    time: z.string(),
    temperature_2m: z.number(),
    apparent_temperature: z.number(),
    wind_speed_10m: z.number(),
    precipitation_probability: z.number().nullish(),
  }),
  hourly: z
    .object({
      time: z.array(z.string()),
      precipitation_probability: z.array(z.number().nullable()),
    })
    .nullish(),
});

type Forecast = z.infer<typeof ForecastSchema>;

/** "2026-09-04T11:15" and "2026-09-04T11:00" are the same hour. */
function truncateToHour(time: string): string {
  return `${time.slice(0, 13)}:00`;
}

function hourlyProbability(forecast: Forecast): number | null {
  const hourly = forecast.hourly;
  if (hourly === null || hourly === undefined) return null;

  const index = hourly.time.indexOf(truncateToHour(forecast.current.time));
  if (index < 0) return null;
  return hourly.precipitation_probability[index] ?? null;
}

const WINDY_KPH = 25;
const RAIN_LIKELY = 0.4;

export function weatherLabel(weather: Omit<WeatherResponse, 'label'>): string {
  const degrees = Math.round(weather.tempC);
  const parts = [
    `${degrees} ${Math.abs(degrees) === 1 ? 'degree' : 'degrees'}`,
    `feels like ${Math.round(weather.feelsLikeC)}`,
  ];
  if (weather.windKph >= WINDY_KPH) parts.push('windy');
  if (weather.precipProbability >= RAIN_LIKELY) parts.push('rain likely');
  return parts.join(', ');
}

export function describeWeather(weather: Omit<WeatherResponse, 'label'>): WeatherResponse {
  return { ...weather, label: weatherLabel(weather) };
}

/**
 * A forecast with no usable probability reads as zero rather than as rain. The
 * only thing the number drives is whether the menu demands water resistant
 * outerwear, and emptying that slot over a missing field would be worse than
 * getting caught in a shower.
 */
export function parseForecast(payload: unknown): WeatherResponse {
  const forecast = ForecastSchema.parse(payload);
  const percent = forecast.current.precipitation_probability ?? hourlyProbability(forecast) ?? 0;

  return describeWeather({
    tempC: forecast.current.temperature_2m,
    feelsLikeC: forecast.current.apparent_temperature,
    precipProbability: percent / 100,
    windKph: forecast.current.wind_speed_10m,
  });
}

export async function fetchWeather(lat: number, lon: number): Promise<WeatherResponse> {
  const response = await fetch(urlFor(lat, lon));
  if (!response.ok) {
    throw new Error(`open-meteo answered ${response.status}`);
  }
  return parseForecast(await response.json());
}
