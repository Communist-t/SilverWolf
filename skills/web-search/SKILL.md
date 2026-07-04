---
name: web-search
description: >-
  通用联网搜索技能。支持多引擎自动降级（Tavily/Brave/DuckDuckGo/Bing），
  覆盖通用搜索、产品、技术文档、论文、旅游攻略等场景。
official: false
version: 1.0.0
---

# 联网搜索

## 概述

通用联网搜索，默认使用 DuckDuckGo HTML 搜索，不需要 API Key。

## 能力

- 通用信息搜索
- 产品价格/评测查询
- 技术文档/API/GitHub 搜索
- 学术论文检索
- 旅游景点/攻略查询
- 硬件装机行情查询

## 数据源（自动降级）

1. Tavily Search API（需 TAVILY_API_KEY）
2. Brave Search API（需 BRAVE_SEARCH_API_KEY）
3. DuckDuckGo HTML 搜索（无 API Key 兜底）
4. Bing HTML 搜索（DuckDuckGo 结果不足时补充）

## 参考

实现代码：`../../src/tools/web-search.ts`
