const googleTrends = require('google-trends-api');
const fs = require('fs');
const path = require('path');
const config = require('./config');

class TrendsFetcher {
  constructor() {
    this.geo = config.defaults.TRENDS_GEO;
    this.timeframe = config.defaults.TRENDS_TIMEFRAME;
    this.maxKw = config.defaults.TRENDS_MAX_KEYWORDS;
  }

  async fetchCategoryTrends(categoryName, categoryId) {
    let results = [];

    // Approach 1: daily trending searches
    try {
      const html = await googleTrends.dailyTrends({
        trendDate: new Date(),
        geo: this.geo,
        category: categoryId,
      });
      const parsed = JSON.parse(html);
      const days = parsed.default?.trendingSearchesDays || [];
      if (days.length > 0) {
        const today = new Date().toISOString().slice(0, 10);
        for (const day of days) {
          const searches = day.trendingSearches || [];
          for (let i = 0; i < Math.min(searches.length, this.maxKw); i++) {
            const kw = (searches[i].title?.query || '').trim();
            if (!kw || kw.length < 2) continue;
            results.push({
              keyword: kw,
              interest_score: Math.max(0, 100 - i),
              rank: i + 1,
              category: categoryName,
              date: today,
            });
          }
        }
        if (results.length > 0) return results;
      }
    } catch (_) {}

    // Approach 2: realtime trending searches
    try {
      const data = await googleTrends.realtimeTrends({
        geo: this.geo,
        category: 'all',
        count: this.maxKw,
      });
      const parsed = typeof data === 'string' ? JSON.parse(data) : data;
      const entries = parsed?.storySummaries?.trendingStories || [];
      if (entries.length > 0) {
        const today = new Date().toISOString().slice(0, 10);
        const seen = new Set();
        for (let i = 0; i < entries.length && results.length < this.maxKw; i++) {
          const title = (entries[i].title || '').trim();
          if (title && title.length >= 2 && !seen.has(title.toLowerCase())) {
            seen.add(title.toLowerCase());
            results.push({
              keyword: title,
              interest_score: Math.max(10, 90 - results.length * 2),
              rank: results.length + 1,
              category: categoryName,
              date: today,
            });
          }
        }
        if (results.length > 0) return results;
      }
    } catch (_) {}

    // Approach 3: related queries for category
    try {
      const seedMap = { Business: 'business', Technology: 'technology', Health: 'health' };
      const seed = seedMap[categoryName] || 'news';
      const data = await googleTrends.relatedQueries({
        keyword: seed,
        geo: this.geo,
        timeframe: this.timeframe,
        category: categoryId,
      });
      const parsed = JSON.parse(data);
      const ranked = parsed?.default?.rankedList || [];
      for (const list of ranked) {
        const queries = list.rankedKeyword || [];
        const today = new Date().toISOString().slice(0, 10);
        for (let i = 0; i < Math.min(queries.length, this.maxKw); i++) {
          const kw = (queries[i].query || '').trim();
          if (!kw || kw.length < 2) continue;
          let score = queries[i].value;
          if (score === 'Breakout') score = 85;
          else score = Math.min(100, parseInt(score, 10) || Math.max(0, 80 - i));
          results.push({
            keyword: kw,
            interest_score: score,
            rank: i + 1,
            category: categoryName,
            date: today,
          });
        }
        if (results.length > 0) return results;
      }
    } catch (_) {}

    if (results.length === 0) {
      throw new Error('所有抓取方式均失败');
    }
    return results;
  }

  async fetchAll() {
    const todayStr = new Date().toISOString().slice(0, 10);
    const allResults = {};
    for (const [catName, catId] of Object.entries(config.defaults.TRENDS_CATEGORIES)) {
      try {
        const items = await this.fetchCategoryTrends(catName, catId);
        allResults[catName] = items;
        this._saveCsv(catName, todayStr, items);
        await new Promise(r => setTimeout(r, 3000));
      } catch (e) {
        allResults[catName] = [];
        console.error(`  [WARN] ${catName} fetch failed: ${e.message}`);
      }
    }
    this._saveMergedCsv(todayStr, allResults);
    return allResults;
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
