#!/usr/bin/env node

/**
 * 科技新闻搜索（精简版）
 *
 * 主力：聚合数据 API（国内直连，1-2 秒出结果）
 * 兜底：web_search + 聚合数据综合新闻
 *
 * 不再依赖 RSS / Hacker News / 网络检测等慢速不稳定源。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { parseJuheNews } = require('./parsers/aggregator_parser');
const { calculateHeatScore, findDuplicateSources } = require('./shared/heat_calculator');

const execFileAsync = promisify(execFile);

const SCRIPT_DIR = __dirname;
const ENV_FILE = path.join(SCRIPT_DIR, '..', '.env');
const FALLBACK_THRESHOLD = 3;

// ── .env 加载器 ────────────────────────────────────────────

function loadEnv() {
  try {
    if (!fs.existsSync(ENV_FILE)) return;
    const content = fs.readFileSync(ENV_FILE, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.substring(0, eqIdx).trim();
      const val = trimmed.substring(eqIdx + 1).trim();
      if (key && val && !process.env[key]) {
        process.env[key] = val;
      }
    }
  } catch (_) { /* silent */ }
}

// ── 聚合数据源配置 ─────────────────────────────────────────

function getJuheSource() {
  return {
    id: 'juhe_news',
    name: '聚合数据头条',
    url: 'https://v.juhe.cn/toutiao/index',
    type: 'aggregator_api',
    enabled: true,
    language: 'zh',
    category: 'general',
    domains: ['general'],
    region: 'cn'
  };
}

// ── web-search skill 集成 ──────────────────────────────────

function getWebSearchScriptPath() {
  const skillsRoot = process.env.SKILLS_ROOT
    || process.env.LOBSTERAI_SKILLS_ROOT
    || path.resolve(SCRIPT_DIR, '..', '..');
  const p = path.join(skillsRoot, 'web-search', 'scripts', 'search.sh');
  return fs.existsSync(p) ? p : null;
}

async function callWebSearch(query, maxResults) {
  const scriptPath = getWebSearchScriptPath();
  if (!scriptPath) return null;

  const tmpFile = path.join(os.tmpdir(), `news-query-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  fs.writeFileSync(tmpFile, query, 'utf-8');

  try {
    let bashPath = 'bash';
    if (process.platform === 'win32') {
      const candidates = [
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
        'bash',
      ];
      bashPath = null;
      for (const c of candidates) {
        try { await execFileAsync(c, ['--version'], { timeout: 5000 }); bashPath = c; break; }
        catch { continue; }
      }
      if (!bashPath) return null;
    }
    const { stdout } = await execFileAsync(bashPath, [scriptPath, `@${tmpFile}`, String(maxResults)], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
    return stdout || '';
  } catch (err) {
    console.error(`    web-search 失败: ${err.message}`);
    return null;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

function parseWebSearchMarkdown(markdown) {
  const articles = [];
  if (!markdown) return articles;
  const sections = markdown.split(/^---$/m);
  for (const section of sections) {
    const titleMatch = section.match(/^##\s+(.+)$/m);
    const urlMatch = section.match(/\*\*URL:\*\*\s+\[?([^\]\s]+)/m);
    if (!titleMatch || !urlMatch) continue;
    const title = titleMatch[1].trim();
    const url = urlMatch[1].replace(/\].*$/, '').trim();
    const lines = section.split('\n');
    const urlLineIdx = lines.findIndex(l => l.includes('**URL:**'));
    const snippet = lines.slice(urlLineIdx + 1)
      .map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('**'))
      .join(' ').slice(0, 300);
    articles.push({
      title, summary: snippet, url,
      published_at: new Date().toISOString(),
      source: 'Web Search', language: 'auto', category: 'web_search',
      _matchType: 'web_search'
    });
  }
  return articles;
}

// ── 辅助函数 ────────────────────────────────────────────────

function filterByFreshness(articles, maxAgeDays) {
  if (!maxAgeDays || maxAgeDays <= 0) return articles;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  return articles.filter(a => {
    if (!a.published_at) return true;
    try { return new Date(a.published_at).getTime() >= cutoff; }
    catch { return true; }
  });
}

function balanceSources(articles, maxPerSource = 5) {
  const counts = {};
  const balanced = [];
  for (const a of articles) {
    const s = a.source;
    if (!s) continue;
    if ((counts[s] || 0) < maxPerSource) {
      balanced.push(a);
      counts[s] = (counts[s] || 0) + 1;
    }
  }
  return balanced;
}

// ── 主搜索函数 ──────────────────────────────────────────────

async function searchNews(keyword, limit = 15, maxPerSource = 5, balance = true, maxAgeDays = 7) {
  loadEnv();

  const source = getJuheSource();
  console.error(`🔍 搜索「${keyword}」...\n`);

  const startTime = Date.now();
  let articlesList = [];
  let fallbackUsed = 'none';

  // ── 主力：聚合数据 API ──
  const juheArticles = await parseJuheNews(source, keyword, limit);
  articlesList.push(...juheArticles);

  if (juheArticles.length > 0) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`⏱️  聚合数据 API 耗时 ${elapsed}s`);
  }

  // ── 兜底 Layer 1: web-search ──
  if (articlesList.length < FALLBACK_THRESHOLD) {
    const wsScript = getWebSearchScriptPath();
    if (wsScript) {
      const year = new Date().getFullYear();
      const query = `${keyword} 最新新闻 ${year}`;
      console.error(`\n🌐 聚合数据结果较少 (${articlesList.length})，尝试 web-search...\n`);
      const startWs = Date.now();
      const md = await callWebSearch(query, 10);
      const wsArticles = parseWebSearchMarkdown(md);
      if (wsArticles.length > 0) {
        articlesList.push(...wsArticles);
        fallbackUsed = 'web_search';
      }
      console.error(`⏱️  web-search 耗时 ${((Date.now() - startWs) / 1000).toFixed(1)}s`);
    }
  }

  // ── 兜底 Layer 2: 聚合数据综合（不限关键词） ──
  if (articlesList.length < FALLBACK_THRESHOLD) {
    console.error(`\n🔄 结果仍然较少 (${articlesList.length})，获取聚合数据综合新闻...\n`);
    const startJu = Date.now();
    const latest = await parseJuheNews(source, null, limit);
    latest.forEach(a => { a._matchType = 'recommended'; });
    articlesList.push(...latest);
    fallbackUsed = 'latest_articles';
    console.error(`⏱️  综合新闻耗时 ${((Date.now() - startJu) / 1000).toFixed(1)}s`);
  }

  // 新鲜度过滤
  const fresh = filterByFreshness(articlesList, maxAgeDays);
  if (fresh.length < articlesList.length) {
    console.error(`🕐 新鲜度过滤: 保留 ${fresh.length}/${articlesList.length} 条 (最长 ${maxAgeDays} 天)`);
  }

  // 计算热度
  console.error(`\n📊 计算热度...\n`);
  for (const a of fresh) {
    a.heat_score = calculateHeatScore(a, fresh, keyword);
    a.duplicate_sources = findDuplicateSources(a, fresh);
  }
  fresh.sort((a, b) => b.heat_score - a.heat_score);

  // 源平衡
  let final = fresh;
  if (balance) {
    console.error(`⚖️  源平衡 (每源最多 ${maxPerSource} 条)...\n`);
    final = balanceSources(fresh, maxPerSource);
  }

  // 清理输出
  const clean = final.map(a => {
    const { _matchType, ...rest } = a;
    if (_matchType === 'recommended') rest.match = 'recommended';
    else if (_matchType === 'web_search') rest.match = 'web_search';
    return rest;
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  return {
    keyword,
    total_found: clean.length,
    search_time: new Date().toISOString(),
    elapsed_seconds: parseFloat(elapsed),
    fallback_used: fallbackUsed,
    results: clean
  };
}

// ── 入口 ────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const options = {
    keyword: null, limit: 15, 'max-per-source': 5, 'max-age': 7, 'no-balance': false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (key === 'no-balance') { options[key] = true; }
      else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        const val = args[++i];
        if (['limit', 'max-per-source', 'max-age'].includes(key)) {
          options[key] = parseInt(val, 10);
        } else {
          options[key] = val;
        }
      }
    } else if (!options.keyword) {
      options.keyword = arg;
    }
  }

  if (!options.keyword) {
    console.error('用法: search_news.js <关键词> [选项]');
    console.error('选项:');
    console.error('  --limit NUM              每源最大条数 (默认: 15)');
    console.error('  --max-per-source NUM     每源显示条数 (默认: 5)');
    console.error('  --max-age DAYS           新闻时效天数 (默认: 7, 0=不限)');
    console.error('  --no-balance             关闭源平衡');
    process.exit(1);
  }

  try {
    const result = await searchNews(
      options.keyword, options.limit, options['max-per-source'],
      !options['no-balance'], options['max-age']
    );

    console.log(JSON.stringify(result, null, 2));
    console.error(`\n✅ 搜索完成！找到 ${result.total_found} 条，耗时 ${result.elapsed_seconds}s`);
    if (process.env.JUHE_NEWS_KEY === '7f5f82c6f58d1bd4d3bc49d5a19d588b') {
      console.error('⚠️  当前使用演示 API Key，每天限 3 次。');
      console.error('   长期使用请前往 https://www.juhe.cn 注册并替换 .env 中的 Key');
    }
  } catch (error) {
    console.error(`错误: ${error.message}`);
    process.exit(1);
  }
}

main().catch(e => { console.error(`致命错误: ${e.message}`); process.exit(1); });

module.exports = { searchNews };
