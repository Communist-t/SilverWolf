/**
 * 天气查询技能
 *
 * 从 web-search.ts 提取，使用 Open-Meteo API 查询实时天气和空气质量。
 */

import { logger } from "../logger.js";
import { usAqiText } from "../utils/air-quality.js";
import { fetchWithTimeout, withRetry } from "./http-utils.js";

// ── 类型 ─────────────────────────────────────────────────────

interface OpenMeteoGeocodingResult {
  id?: number;
  name?: string;
  latitude?: number;
  longitude?: number;
  country?: string;
  admin1?: string;
  timezone?: string;
}

interface OpenMeteoGeocodingResponse {
  results?: OpenMeteoGeocodingResult[];
}

interface OpenMeteoForecastResponse {
  timezone?: string;
  current?: {
    time?: string;
    temperature_2m?: number;
    apparent_temperature?: number;
    precipitation?: number;
    rain?: number;
    weather_code?: number;
    wind_speed_10m?: number;
    wind_direction_10m?: number;
  };
  daily?: {
    time?: string[];
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_probability_max?: number[];
    precipitation_sum?: number[];
    wind_speed_10m_max?: number[];
  };
}

interface OpenMeteoAirQualityResponse {
  current?: {
    time?: string;
    us_aqi?: number;
    pm2_5?: number;
    pm10?: number;
  };
}

// ── 天气查询结果类型 ──────────────────────────────────────────

export interface WeatherResult {
  title: string;
  url: string;
  snippet: string;
  content: string;
  sourceType: "official";
  score: number;
  metadata: Record<string, unknown>;
}

// ── 辅助函数 ─────────────────────────────────────────────────

function weatherCodeText(code?: number): string {
  if (code === undefined) return "未知";
  if (code === 0) return "晴";
  if ([1, 2, 3].includes(code)) return "多云";
  if ([45, 48].includes(code)) return "雾";
  if ([51, 53, 55, 56, 57].includes(code)) return "毛毛雨";
  if ([61, 63, 65, 66, 67].includes(code)) return "雨";
  if ([71, 73, 75, 77].includes(code)) return "雪";
  if ([80, 81, 82].includes(code)) return "阵雨";
  if ([85, 86].includes(code)) return "阵雪";
  if ([95, 96, 99].includes(code)) return "雷暴";
  return `天气代码 ${code}`;
}

function extractWeatherLocation(queries: string[]): string {
  const first = queries[0] ?? "";
  return first
    .replace(/\d{4}-\d{2}-\d{2}/g, " ")
    .replace(/今天|今日|明天|明日|后天|后日|现在|实时|天气预报|天气|气温|温度|空气质量/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function weatherForecastIndex(queries: string[]): number {
  const queryText = queries.join(" ");
  if (/后天|后日/.test(queryText)) return 2;
  if (/明天|明日/.test(queryText)) return 1;
  return 0;
}

// ── 主查询函数 ───────────────────────────────────────────────

export async function searchWeather(
  queries: string[],
  signal?: AbortSignal
): Promise<WeatherResult[]> {
  const location = extractWeatherLocation(queries);
  if (!location) {
    logger.warn("weather", "missing location", { queries });
    return [];
  }

  // 地理编码
  const geocodingURL = new URL("https://geocoding-api.open-meteo.com/v1/search");
  geocodingURL.searchParams.set("name", location);
  geocodingURL.searchParams.set("count", "5");
  geocodingURL.searchParams.set("language", "zh");
  geocodingURL.searchParams.set("format", "json");

  const geocodingResponse = await fetchWithTimeout(geocodingURL, 12000, { signal });
  if (!geocodingResponse.ok) {
    throw new Error(`天气地点查询失败: HTTP ${geocodingResponse.status}`);
  }

  const geocoding = (await geocodingResponse.json()) as OpenMeteoGeocodingResponse;
  const candidates = geocoding.results ?? [];
  const place =
    candidates.find((item) => item.name === location && item.country === "中国") ??
    candidates.find((item) => item.country === "中国") ??
    candidates[0];

  if (!place?.name || place.latitude === undefined || place.longitude === undefined) {
    logger.warn("weather", "location not found", { location });
    return [];
  }

  // 天气预报
  const forecastURL = new URL("https://api.open-meteo.com/v1/forecast");
  forecastURL.searchParams.set("latitude", String(place.latitude));
  forecastURL.searchParams.set("longitude", String(place.longitude));
  forecastURL.searchParams.set("timezone", "auto");
  forecastURL.searchParams.set("forecast_days", "3");
  forecastURL.searchParams.set(
    "current",
    "temperature_2m,apparent_temperature,precipitation,rain,weather_code,wind_speed_10m,wind_direction_10m"
  );
  forecastURL.searchParams.set(
    "daily",
    "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max"
  );

  const forecastResponse = await fetchWithTimeout(forecastURL, 12000, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!forecastResponse.ok) {
    throw new Error(`天气预报查询失败: HTTP ${forecastResponse.status}`);
  }

  const forecast = (await forecastResponse.json()) as OpenMeteoForecastResponse;
  const current = forecast.current;
  const daily = forecast.daily;

  // 空气质量（可选）
  let airQuality: OpenMeteoAirQualityResponse["current"];
  if (/空气质量|aqi|pm\s*2[._]?5|pm10/i.test(queries.join(" "))) {
    try {
      const airQualityURL = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
      airQualityURL.searchParams.set("latitude", String(place.latitude));
      airQualityURL.searchParams.set("longitude", String(place.longitude));
      airQualityURL.searchParams.set("timezone", "auto");
      airQualityURL.searchParams.set("current", "us_aqi,pm2_5,pm10");
      const airQualityResponse = await fetchWithTimeout(airQualityURL, 12000, {
        signal,
        headers: { Accept: "application/json" },
      });
      if (airQualityResponse.ok) {
        airQuality = ((await airQualityResponse.json()) as OpenMeteoAirQualityResponse).current;
      } else {
        logger.warn("weather", "air quality query failed", {
          status: airQualityResponse.status,
          location,
        });
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      logger.warn("weather", "air quality query failed", {
        location,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const forecastIndex = weatherForecastIndex(queries);
  const forecastLabel = ["今日", "明日", "后日"][forecastIndex];
  const forecastDate = daily?.time?.[forecastIndex] ?? "未知日期";
  const displayName = [place.name, place.admin1, place.country]
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .join("，");

  const summary = [
    `地点：${displayName}`,
    `观测时间：${current?.time ?? "未知"}（${forecast.timezone ?? place.timezone ?? "当地时区"}）`,
    forecastIndex === 0
      ? `当前：${weatherCodeText(current?.weather_code)}，${current?.temperature_2m ?? "未知"}°C，体感 ${current?.apparent_temperature ?? "未知"}°C，降水 ${current?.precipitation ?? 0} mm，风速 ${current?.wind_speed_10m ?? "未知"} km/h`
      : "",
    `${forecastLabel}（${forecastDate}）：${weatherCodeText(daily?.weather_code?.[forecastIndex])}，${daily?.temperature_2m_min?.[forecastIndex] ?? "未知"}~${daily?.temperature_2m_max?.[forecastIndex] ?? "未知"}°C`,
    `${forecastLabel}最高降水概率：${daily?.precipitation_probability_max?.[forecastIndex] ?? "未知"}%`,
    `${forecastLabel}预计降水量：${daily?.precipitation_sum?.[forecastIndex] ?? "未知"} mm，最大风速 ${daily?.wind_speed_10m_max?.[forecastIndex] ?? "未知"} km/h`,
    airQuality
      ? `空气质量（${airQuality.time ?? "当前"}）：美标 AQI ${airQuality.us_aqi ?? "未知"}（${usAqiText(airQuality.us_aqi)}），PM2.5 ${airQuality.pm2_5 ?? "未知"} μg/m³，PM10 ${airQuality.pm10 ?? "未知"} μg/m³`
      : "",
  ].filter(Boolean).join("；");

  logger.info("weather", "forecast completed", {
    requestedLocation: location,
    resolvedLocation: displayName,
    latitude: place.latitude,
    longitude: place.longitude,
    observationTime: current?.time,
  });

  return [
    {
      title:
        forecastIndex === 0
          ? `${place.name}实时天气与今日预报`
          : `${place.name}${forecastLabel}天气预报`,
      url: forecastURL.toString(),
      snippet: summary,
      content: summary,
      sourceType: "official" as const,
      score: 100,
      metadata: {
        location: `${place.name}${place.admin1 ? `，${place.admin1}` : ""}${place.country ? `，${place.country}` : ""}`,
        latitude: place.latitude,
        longitude: place.longitude,
        timezone: forecast.timezone,
        observationTime: current?.time,
        forecastDate,
        forecastDayOffset: forecastIndex,
        usAqi: airQuality?.us_aqi,
        pm25: airQuality?.pm2_5,
        pm10: airQuality?.pm10,
        temperatureC: current?.temperature_2m,
        apparentTemperatureC: current?.apparent_temperature,
        precipitationMm: current?.precipitation,
        rainMm: current?.rain,
        windSpeedKmh: current?.wind_speed_10m,
        windDirection: current?.wind_direction_10m,
        weatherCode: current?.weather_code,
        minTemperatureC: daily?.temperature_2m_min?.[forecastIndex],
        maxTemperatureC: daily?.temperature_2m_max?.[forecastIndex],
        precipitationProbability:
          daily?.precipitation_probability_max?.[forecastIndex],
        precipitationSumMm: daily?.precipitation_sum?.[forecastIndex],
      },
    },
  ];
}
