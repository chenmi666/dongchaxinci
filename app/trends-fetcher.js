const fs = require('fs');
const path = require('path');
const https = require('https');
const { parseString } = require('xml2js');
const config = require('./config');
const logger = require('./logger');
const TrendsScraper = require('./trends-scraper');

const CATEGORY_DB_IDS = { Business: 1, Technology: 2, Health: 3 };
const RSS_URL = 'https://trends.google.com/trending/rss?geo=US';

class TrendsFetcher {
  constructor() {
    this.geo = config.defaults.TRENDS_GEO;
    this.maxKw = config.defaults.TRENDS_MAX_KEYWORDS;
  }

  async fetchAll() {
    const todayStr = new Date().toISOString().slice(0, 10);
    const allResults = {};

    // Approach 1: Playwright scraper
    logger.info('fetcher', '尝试方式1: Playwright 渲染抓取');
    try {
      const scraper = new TrendsScraper();
      const scraped = await scraper.scrapeAll();
      let hasData = false;
      for (const [catName, items] of Object.entries(scraped)) {
        if (items && items.length > 0) {
          allResults[catName] = items;
          this._saveCsv(catName, todayStr, items);
          logger.info('fetcher', `[${catName}] 方式1成功: ${items.length} 条`);
          hasData = true;
        } else {
          allResults[catName] = [];
          logger.warn('fetcher', `[${catName}] 方式1无数据`);
        }
      }
      if (hasData) {
        this._saveMergedCsv(todayStr, allResults);
        return allResults;
      }
    } catch (e) {
      logger.warn('fetcher', `方式1全失败: ${e.message}`);
    }

    // Approach 2: RSS feed
    for (const catName of Object.keys(CATEGORY_DB_IDS)) {
      try {
        logger.info('fetcher', `[${catName}] 尝试方式2: RSS`);
        const items = await this._fetchRss(catName);
        if (items.length > 0) {
          allResults[catName] = items;
          this._saveCsv(catName, todayStr, items);
          logger.info('fetcher', `[${catName}] 方式2成功: ${items.length} 条`);
        } else {
          allResults[catName] = [];
          logger.warn('fetcher', `[${catName}] 方式2无数据`);
        }
      } catch (e) {
        allResults[catName] = [];
        logger.warn('fetcher', `[${catName}] 方式2失败: ${e.message}`);
      }
    }

    const hasAny = Object.values(allResults).some(a => a.length > 0);
    if (hasAny) {
      this._saveMergedCsv(todayStr, allResults);
      return allResults;
    }

    // Approach 3: empty
    logger.error('fetcher', '所有方式全部失败，返回空数据');
    for (const catName of Object.keys(CATEGORY_DB_IDS)) {
      allResults[catName] = [];
    }
    return allResults;
  }

  _fetchRss(catName) {
    return new Promise((resolve, reject) => {
      https.get(RSS_URL, { timeout: 15000 }, (res) => {
        let xml = '';
        res.on('data', c => xml += c);
        res.on('end', () => {
          parseString(xml, (err, result) => {
            if (err) return reject(err);
            try {
              const entries = result?.rss?.channel?.[0]?.item || [];
              const today = new Date().toISOString().slice(0, 10);
              const items = entries.slice(0, this.maxKw).map((entry, i) => {
                const keyword = (entry.title?.[0] || '').trim();
                const traffic = (entry['ht:approx_traffic']?.[0] || '').replace(/,/g, '');
                const trafficNum = parseInt(traffic, 10) || 0;
                const score = Math.min(100, Math.max(1, Math.round(trafficNum / 500)));
                return {
                  keyword,
                  interest_score: score || Math.max(1, 100 - i * 2),
                  rank: i + 1,
                  category: catName,
                  date: today,
                };
              }).filter(i => i.keyword && i.keyword.length >= 2);
              resolve(items);
            } catch (e) {
              reject(e);
            }
          });
        });
      }).on('error', reject);
    });
  }

  _saveCsv(category, dateStr, items) {
    const dirPath = path.join(config.RAW_DIR, dateStr);
    fs.mkdirSync(dirPath, { recursive: true });
    const filepath = path.join(dirPath, `${category.toLowerCase()}.csv`);
    const header = 'keyword,interest_score,rank,category,date\n';
    const rows = items.map(i =>
      `"${i.keyword.replace(/"/g, '""')}",${i.interest_score},${i.rank},"${i.category}","${i.date}"`
    ).join('\n');
    fs.writeFileSync(filepath, '\ufeff' + header + rows, 'utf-8');
  }

  _saveMergedCsv(dateStr, allResults) {
    const dirPath = path.join(config.RAW_DIR, dateStr);
    fs.mkdirSync(dirPath, { recursive: true });
    const filepath = path.join(dirPath, 'all_merged.csv');
    const allItems = Object.values(allResults).flat();
    allItems.sort((a, b) => b.interest_score - a.interest_score);
    const header = 'keyword,interest_score,rank,category,date\n';
    const rows = allItems.map(i =>
      `"${i.keyword.replace(/"/g, '""')}",${i.interest_score},${i.rank},"${i.category}","${i.date}"`
    ).join('\n');
    fs.writeFileSync(filepath, '\ufeff' + header + rows, 'utf-8');
  }
}

module.exports = TrendsFetcher;
