---
name: weather
description: >-
  天气查询技能。使用 Open-Meteo API 查询实时天气、气温、降水、风速和空气质量。
official: false
version: 1.0.0
---

# 天气查询

## 概述

查询任意城市的实时天气和未来三日预报，可选空气质量。

## 命令

```
天气 [城市名]
[城市名] 天气
[城市名] 明天天气
[城市名] 空气质量
```

## 数据源

- Open-Meteo Geocoding API — 地理编码
- Open-Meteo Forecast API — 天气预报
- Open-Meteo Air Quality API — 空气质量（可选）

## 参考

实现代码：`../../src/tools/weather-skill.ts`
