const { chromium } = require('playwright');
const config = require('./config');
const logger = require('./logger');

const CATEGORY_IDS = { Business: 3, Technology: 18, Health: 7 };
const MAX_KEYWORDS = 100;

class TrendsScraper {
  async scrapeAll() {
    logger.info('scraper', '启动 Playwright 浏览器...');

    // Try bundled Chromium first; fall back to system Chrome for local dev
    let launchOpts = [
      { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
      { channel: 'chrome', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
    ];
    let browser;
    for (const opts of launchOpts) {
      try {
        browser = await chromium.launch(opts);
        logger.info('scraper', `Chromium 启动方式: ${opts.channel || 'bundled'}`);
        break;
      } catch (e) {
        logger.debug('scraper', `启动方式 ${opts.channel || 'bundled'} 失败: ${e.message}`);
      }
    }
    if (!browser) throw new Error('所有 Chromium 启动方式均失败');

    const allResults = {};
    try {
      for (const [catName, catId] of Object.entries(CATEGORY_IDS)) {
        try {
          const items = await this._scrapeCategory(browser, catName, catId);
          allResults[catName] = items;
          logger.info('scraper', `[${catName}] ${items.length} 条`);
        } catch (e) {
          logger.error('scraper', `[${catName}] 抓取失败: ${e.message}`);
          allResults[catName] = [];
        }
      }
    } finally {
      await browser.close();
      logger.info('scraper', '浏览器已关闭');
    }
    return allResults;
  }

  async _scrapeCategory(browser, catName, catId) {
    const url = `https://trends.google.com/trending?geo=US&category=${catId}&hours=168`;
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

    let rpcData = null;
    page.on('response', async (res) => {
      const u = res.url();
      if (u.includes('batchexecute') && u.includes('i0OFE')) {
        try { rpcData = await res.text(); } catch (_) {}
      }
    });

    // Retry DOM extraction once on failure
    let items = null;
    for (let attempt = 0; attempt < 2 && (!items || items.length === 0); attempt++) {
      if (attempt > 0) {
        logger.debug('scraper', `[${catName}] 重试第${attempt+1}次...`);
      }
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Smart wait: wait until ANY volume data appears (then settle for rendering)
      let preCount = 0;
      try {
        await page.waitForFunction(() => {
          const text = document.body.innerText;
          return /[0-9]+万\+|[0-9]{4,}\+|[0-9]+,[0-9]+\+/.test(text);
        }, { timeout: 20000 });
      } catch (_) {
        logger.info('scraper', `[${catName}] 等待超时(20s)，可能无数据`);
      }
      preCount = await page.evaluate(() => {
        const text = document.body.innerText;
        return (text.match(/[0-9]+万\+|[0-9]{4,}\+|[0-9]+,[0-9]+\+/g) || []).length;
      });
      logger.info('scraper', `[${catName}] 等待后可见趋势: ${preCount} 条, 等待10s渲染...`);

      // Extra settle time for JS rendering
      await page.waitForTimeout(10000);

      items = await this._parseDom(page, catName);
      logger.info('scraper', `[${catName}] 实际提取: ${items.length} 条`);
    }

    if (!items || items.length === 0) {
      // Fallback: RPC (same data across categories, but better than nothing)
      if (rpcData && rpcData.length > 200) {
        items = this._parseRpc(rpcData, catName);
      }
    }

    await page.close();
    return items || [];
  }

  _parseRpc(raw, catName) {
    const clean = raw.replace(/^\)\]\}'\s*\n*/, '');
    let payload = null;
    for (const line of clean.split('\n')) {
      if (line.startsWith('[["wrb.fr","i0OFE"')) {
        try {
          const top = JSON.parse(line);
          if (top[0] && top[0][2]) payload = top[0][2];
        } catch (_) {}
        break;
      }
    }
    if (!payload) return [];

    const data = JSON.parse(payload);
    const trendArr = data[1];
    if (!Array.isArray(trendArr)) return [];

    const today = new Date().toISOString().slice(0, 10);
    return trendArr.map((item, i) => {
      const keyword = (item[0] || '').trim();
      if (!keyword || keyword.length < 2) return null;
      const volume = item[6];
      let score = 50;
      if (typeof volume === 'number' && volume > 0) {
        score = Math.min(100, Math.max(1, Math.round(volume / 10000)));
      } else {
        score = Math.max(1, 100 - i * 2);
      }
      const searchVolume = typeof volume === 'number' && volume > 0 ? String(volume) : '';
      return {
        keyword,
        interest_score: score,
        search_volume: searchVolume,
        rank: i + 1,
        category: catName,
        date: today,
      };
    }).filter(Boolean).slice(0, MAX_KEYWORDS);
  }

  async _parseDom(page, catName) {
    const text = await page.evaluate(() => document.body.innerText);
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);

    const skips = new Set([
      'arrow_upward', 'arrow_downward', 'trending_up', 'trending_down',
      'trending_flat', 'location_on', 'calendar_month', 'grid_3x3', 'sort',
      'ios_share', 'expand_more', 'expand_less', 'arrow_back', 'arrow_forward',
      'search', 'info', 'close', '首页', '探索', '时下流行', '登录',
      '搜索趋势', '导出', '趋势细分', '趋势', '活跃', '新', '按标题排序',
      '按搜索量排序', '按新近度排序', '按相关性', '所有趋势', '搜索趋势',
    ]);

    const items = [];
    const today = new Date().toISOString().slice(0, 10);
    const volRe = /^[0-9,万+倍亿]+$/;

    for (let i = 0; i < lines.length && items.length < MAX_KEYWORDS; i++) {
      const kw = lines[i];
      if (skips.has(kw) || kw.length < 3) continue;
      if (kw.startsWith('上次更新') || kw.startsWith('Trends') || kw.startsWith('Google 趋势')) continue;
      if (kw.match(volRe) || kw.includes('%')) continue; // volume/pct lines

      // Expect next line to be a search volume
      if (i + 1 >= lines.length || !lines[i + 1].match(volRe)) continue;

      const volStr = lines[i + 1];
      let score = 50;

      // Parse various volume formats: "1万+", "5000+", "2000万+", "2亿+"
      if (volStr.includes('亿')) {
        score = 100;
      } else if (volStr.includes('万')) {
        const num = parseFloat(volStr.replace(/[万,+\s]/g, ''));
        score = Math.min(100, Math.max(1, Math.round(num || 50)));
      } else {
        const num = parseInt(volStr.replace(/[,+\s]/g, ''), 10);
        if (!isNaN(num)) score = Math.min(100, Math.max(1, Math.round(num / 500)));
      }

      items.push({
        keyword: kw,
        interest_score: score,
        search_volume: volStr,
        rank: items.length + 1,
        category: catName,
        date: today,
      });
    }

    return items;
  }
}

module.exports = TrendsScraper;
