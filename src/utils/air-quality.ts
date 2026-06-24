export function usAqiText(aqi?: number): string {
  if (aqi === undefined || !Number.isFinite(aqi)) return "未知";
  if (aqi <= 50) return "优";
  if (aqi <= 100) return "中等";
  if (aqi <= 150) return "对敏感人群不健康";
  if (aqi <= 200) return "不健康";
  if (aqi <= 300) return "非常不健康";
  return "危险";
}
