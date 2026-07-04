#!/usr/bin/env node

/**
 * 聚合数据 (Juhe.cn) 新闻头条 API 解析器
 *
 * 作为主力数据源，替代慢速/不稳定的 RSS 源。
 * 国内直连，响应快，返回结构化 JSON，无需解析 HTML。
 *
 * 前置条件：
 *   1. 在 https://www.juhe.cn 注册 → 申请「新闻头条」API（有免费额度）
 *   2. 在终端设置环境变量：setx JUHE_NEWS_KEY "你的APIKey"
 *
 * API 文档: https://www.juhe.cn/docs/api/id/235
 * 免费额度: 100 次/天（正常使用完全够用）
 * 支持分类: top(综合) keji(科技) caijing(财经) shehui(社会) guonei(国内) 等
 */

const { fetchJson } = require('../shared/web_utils');

const API_BASE = 'https://v.juhe.cn/toutiao/index';
const API_KEY_ENV = 'JUHE_NEWS_KEY';

// 领域 → 聚合数据分类映射
const DOMAIN_TO_CATEGORY = {
  'general': 'top',
  'ai':       'keji',
  'backend':  'keji',
  'frontend': 'keji',
  'devops':   'keji',
  'mobile':   'keji',
  'security': 'keji',
  'os':       'keji',
  'hardware': 'keji',
};

// 关键词前缀 → 分类
const KEYWORD_TO_CATEGORY = [
  [/^(ai|人工智能|chatgpt|gpt|大模型|机器学习|深度学习|llm|openai|claude)/i, 'keji'],
  [/^(科技|数码|手机|电脑|软件|互联网|编程|代码|算法|数据)/,           'keji'],
  [/^(股票|基金|理财|财经|经济|金融|投资|行情|股市)/,                 'caijing'],
  [/^(军事|武器|国防|军队|战机|导弹|航母)/,                          'junshi'],
  [/^(体育|足球|篮球|nba|cba|奥运|世界杯|冠军)/,                      'tiyu'],
  [/^(娱乐|明星|电影|音乐|综艺|电视剧|歌手)/,                        'yule'],
  [/^(社会|民生|法治|法律|案件|维权)/,                               'shehui'],
];

function getApiKey() {
  const key = process.env[API_KEY_ENV];
  if (!key) return null;
  const trimmed = key.trim();
  return trimmed || null;
}

function mapCategory(keyword, domains) {
  // 先尝试从关键词匹配（更精确）
  if (keyword) {
    for (const [regex, cat] of KEYWORD_TO_CATEGORY) {
      if (regex.test(keyword)) return cat;
    }
  }
  // 其次用已检测到的领域映射
  if (domains && domains.length > 0) {
    for (const d of domains) {
      if (DOMAIN_TO_CATEGORY[d]) return DOMAIN_TO_CATEGORY[d];
    }
  }
  return 'top';
}

async function parseJuheNews(sourceConfig, keyword = null, limit = 15) {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.error(`    ${API_KEY_ENV} 未设置，跳过聚合数据 API（设置后提速 5-10 倍）`);
    return [];
  }

  const category = mapCategory(keyword, sourceConfig.domains);
  const url = `${API_BASE}?key=${apiKey}&type=${category}`;

  try {
    const data = await fetchJson(url, 5000);

    if (!data || data.error_code !== 0) {
      console.error(`    聚合数据 API 错误: ${data?.reason || '请求失败'}`);
      return [];
    }

    const items = data.result?.data || [];
    const articles = [];

    for (const item of items) {
      if (!item.title) continue;

      articles.push({
        title: item.title,
        summary: item.title,
        url: item.url || '',
        published_at: item.date
          ? new Date(item.date).toISOString()
          : new Date().toISOString(),
        source: sourceConfig.name,
        language: 'zh',
        category: item.category || 'general',
      });
    }

    console.error(`    聚合数据 API: 获取到 ${articles.length} 条新闻 (${category})`);
    return articles.slice(0, limit);
  } catch (error) {
    console.error(`    聚合数据 API 请求失败: ${error.message}`);
    return [];
  }
}

module.exports = { parseJuheNews };
