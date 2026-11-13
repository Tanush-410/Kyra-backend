// GET /api/v2/context: the weather at the venue, for the greeting on Rate and changes ("19°", cloudy).
// Asks Open-Meteo (free, no key) with the venue's coordinates only (VENUE_LAT, VENUE_LON), at most every
// 30 minutes; nothing about visitors is sent. Without coordinates, or when the service can't be reached,
// weather is null and the kiosk shows the date and time only.
const CACHE_MS = 30 * 60 * 1000;

// WMO weather codes -> a simple kind the kiosk draws an icon for.
export function weatherKind(code) {
  if (code === 0) return 'clear';
  if ([1, 2].includes(code)) return 'partly-cloudy';
  if (code === 3 || code === 45 || code === 48) return 'cloudy';
  if (code >= 51 && code <= 67) return 'rain';
  if (code >= 71 && code <= 77) return 'snow';
  if (code >= 80 && code <= 82) return 'rain';
  if (code >= 95) return 'storm';
  return 'cloudy';
}

export default async function contextRoutes(app, { config, fetchWeather = globalThis.fetch }) {
  let cached = null;
  let cachedAt = 0;

  app.get('/api/v2/context', async () => {
    if (config.venueLat == null || config.venueLon == null) return { weather: null };
    if (cached && Date.now() - cachedAt < CACHE_MS) return { weather: cached };
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${config.venueLat}&longitude=${config.venueLon}&current=temperature_2m,weather_code`;
      const response = await fetchWeather(url, { signal: AbortSignal.timeout(4000) });
      const json = await response.json();
      const temperature = Number(json?.current?.temperature_2m);
      if (!response.ok || !Number.isFinite(temperature)) throw new Error('no weather');
      cached = { temperatureC: Math.round(temperature), kind: weatherKind(Number(json.current.weather_code)) };
      cachedAt = Date.now();
      return { weather: cached };
    } catch (error) {
      app.log.warn({ error: error.message }, 'Weather unavailable');
      return { weather: cached }; // the last reading, or null
    }
  });
}
