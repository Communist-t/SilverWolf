---
name: technology-search
description: >-
  Unified skill for news search & trending. Use Juhe.cn aggregate API as primary source (fast, stable, CN direct),
  with web_fetch fallback. Handles tech news search AND daily trending/hot topics.
official: false
version: 2.0.0
---

# Technology News Search

## Overview

统一的数据获取方案，覆盖 **科技搜索** 和 **今日热搜** 两类场景：

1. **聚合数据 API（主力）** — Node.js 脚本调国内聚合数据新闻 API，1-2 秒出结果
2. **web_fetch 兜底** — 直接爬中文新闻门户，无依赖，不限次数

---

## 场景 A：科技/关键词搜索

当用户搜索特定话题（AI、ChatGPT、React、科技新闻等）时使用。

### 搜索命令

```bash
# Windows PowerShell
node "$env:SKILLS_ROOT\technology-news-search\scripts\search_news.js" "[关键词]" --limit 15

# macOS / Linux
node "$SKILLS_ROOT/technology-news-search/scripts/search_news.js" "[关键词]" --limit 15
```

### 参数说明

| 参数 | 默认 | 说明 |
|---|---|---|
| `--limit N` | 15 | 每源最大条数 |
| `--max-per-source N` | 5 | 每源显示条数 |
| `--max-age DAYS` | 7 | 新闻时效天数 (0=不限) |
| `--no-balance` | 关闭 | 关闭源平衡 |

### 关键词推荐

| 意图 | 推荐关键词 |
|---|---|
| 通用科技 | `科技` `技术` |
| AI 话题 | `AI` `人工智能` `ChatGPT` `大模型` |
| 前端开发 | `React` `Vue` `前端` |
| 后端/云 | `Python` `云原生` `数据库` |
| 安全 | `安全` `漏洞` |
| 财经科技 | `财经` `股票` |

---

## 场景 B：今日热搜 / 热点话题

当用户问"今天有什么热搜"、"今日热点"、"微博热搜"等时使用。

### 方式 1：聚合数据 API（推荐）

搜关键词 `热搜` 或 `头条`：

```bash
node "$env:SKILLS_ROOT\technology-news-search\scripts\search_news.js" "热搜" --limit 5 --max-per-source 5 --max-age 1
```

### 方式 2：web_fetch 兜底

当 API Key 未配置或超出免费次数时，直接爬热搜榜单：

| 平台 | URL | 稳定性 |
|---|---|---|
| 百度热搜 | `https://top.baidu.com/board?tab=realtime` | ✅ 直连可用 |
| 知乎热榜 | `https://tophub.today/n/mproPpoq6O` | ✅ tophub 代理 |
| 新浪新闻 | `https://news.sina.com.cn/` | ✅ 综合兜底 |

#### 百度热搜解析要点

```
web_fetch("https://top.baidu.com/board?tab=realtime", maxChars=8000)

解析规则：
1. 找到「热搜榜 / 全部类型」行作为数据起点
2. 第一个「热搜指数」标记之后的行是 #1 标题（无序号）
3. 后面的条目：序号行 → 热度值（6-8位数字）→「热搜指数」→ 标题
4. 「热」/「新」单独成行是标签，可选展示
5. 摘要以「查看更多>」结尾
```

#### 知乎热榜解析要点

```
web_fetch("https://tophub.today/n/mproPpoq6O", maxChars=8000)

解析规则：
1. 找到第一个匹配「数字 + 英文句点」的行（如 1.）作为起点
2. 序号行后第一个非空行是标题（可能跨行）
3. 标题后匹配「数字 + 万热度」为热度值
4. 跳过图标字符行
```

#### 新浪新闻兜底

```
web_fetch("https://news.sina.com.cn/", maxChars=8000)
```

提取有实际内容的标题行（>8 字符，排除导航文字和广告）。

### 热搜执行优先级

1. **聚合数据 API 搜"热搜"** → 最快，1-2s
2. **百度热搜 web_fetch** → 最稳的直连兜底
3. **知乎热榜 web_fetch** → 深度话题补充
4. **新浪新闻 web_fetch** → 最终兜底

> 关于微博热搜：s.weibo.com 反爬极严（Sina Visitor System），tophub.today 的微博代理也不稳定。如用户明确要求，尝试 `web_fetch("https://tophub.today/n/KqndgxeLl9")`，但不保证可用。改用新浪新闻的社会/娱乐板块覆盖。

---

## 热搜过滤规则

**保留：**
- 重大政策、国际关系、社会事件
- 引发广泛讨论的热点话题
- 纯事实内容

**排除：**
- 含主观评论的标题
- 纯娱乐八卦
- 明显推广内容
- 情绪化表达

---

## 输出格式

### Node.js 脚本输出

```json
{
  "keyword": "AI",
  "total_found": 15,
  "search_time": "2026-06-23T12:00:00.000Z",
  "elapsed_seconds": 1.2,
  "fallback_used": "none",
  "results": [...]
}
```

### web_fetch 兜底输出

整理为 Markdown 格式，按主题分类。热搜只输出 5 条最有价值的：

```
======

🔥 今日热搜（6月23日）

1. [完整新闻标题1]
2. [完整新闻标题2]
3. [完整新闻标题3]
4. [完整新闻标题4]
5. [完整新闻标题5]

======
```

---

## API 配置

`.env` 文件路径：`technology-news-search/.env`

```
JUHE_NEWS_KEY=你的APIKey
```

1. 打开 [https://www.juhe.cn](https://www.juhe.cn) 注册
2. 申请「新闻头条」API（免费额度 100 次/天）
3. 替换 `.env` 中的 Key

⚠️ 当前演示 Key 每天限 3 次，仅用于体验。

---

## 注意事项

- 英文内容自动翻译为中文
- web_fetch 兜底不限次数，但返回 HTML 需 AI 解析
- 搜索热搜时用 `--max-age 1` 只看今天的热点
- `daily-trending` 已合并至此，原目录已删除
