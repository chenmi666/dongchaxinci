const cron = require('node-cron');
const config = require('./config');

class TrendScheduler {
  constructor(db, fetcher, analyzer, reporter) {
    this.db = db;
    this.fetcher = fetcher;
    this.analyzer = analyzer;
    this.reporter = reporter;
    this.task = null;
  }

  async dailyJob() {
    const todayStr = new Date().toISOString().slice(0, 10);
    const now = new Date();
    console.log(`\n${'='.repeat(50)}`);
    console.log(`[${now.toISOString().slice(0, 19)}] 开始每日任务...`);
    console.log(`${'='.repeat(50)}`);

    // 1. Fetch trends
    console.log('[1/4] 抓取 Google Trends...');
    const allResults = await this.fetcher.fetchAll();

    // 2. Save to DB
    console.log('[2/4] 保存到数据库...');
    let totalFetched = 0;
    for (const [catName, items] of Object.entries(allResults)) {
      if (!items || items.length === 0) {
        console.log(`  ${catName}: 0 条 (失败)`);
        this.db.logFetch(todayStr, catName, 0, 'failed', '返回无数据');
        continue;
      }
      const catId = config.defaults.TRENDS_CATEGORIES[catName];
      let count = 0;
      for (const item of items) {
        const { kwId } = this.db.upsertKeyword(item.keyword, catId, item.date);
        this.db.upsertTrend(kwId, item.date, item.interest_score, item.rank);
        this.db.updateKeywordPeak(kwId, item.interest_score);
        count++;
      }
      totalFetched += count;
      this.db.logFetch(todayStr, catName, count, 'success');
      console.log(`  ${catName}: ${count} 条`);
    }

    // 3. AI Analysis
    console.log('[3/4] AI 分析关键词...');
    const needing = this.db.getKeywordsNeedingAnalysis();
    if (needing && needing.length > 0) {
      console.log(`  待分析: ${needing.length} 个关键词`);
      if (this.analyzer.isConfigured()) {
        const results = await this.analyzer.analyzeKeywordsBatch(needing);
        for (const r of results) {
          this.db.saveAnalysis(
            r.keyword_id, r.is_event_driven, r.opportunity_score, r.reasoning, r.relook_days
          );
        }
        const eventCount = results.filter(r => r.is_event_driven).length;
        const longCount = results.length - eventCount;
        console.log(`  ✓ 已完成 ${results.length} 个分析 (事件型: ${eventCount}, 长期需求: ${longCount})`);
        await new Promise(r => setTimeout(r, 1000));
      } else {
        console.log(`  ⚠ AI 未配置，跳过 AI 分析`);
      }
    } else {
      console.log(`  无待分析关键词`);
    }

    // 4. Generate report
    console.log('[4/4] 生成每日报告...');
    const report = this.reporter.generateDailyReport();
    console.log(`  ✓ 报告已生成: ${report.new_keywords} 新增, ${report.top_opportunities.length} 个机会关键词`);

    // 5. Cleanup
    const deleted = this.db.cleanupOldTrends(90);
    console.log(`  清理: 删除 ${deleted} 条过期趋势数据`);

    console.log(`[✔] 每日任务完成 (${new Date().toISOString().slice(11, 19)})`);
    console.log(`${'='.repeat(50)}\n`);
  }

  start(runImmediately) {
    const { hour, minute } = config.getFetchTime(this.db);
    const cronExpr = `${minute} ${hour} * * *`;

    if (this.task) this.task.stop();
    this.task = cron.schedule(cronExpr, () => {
      this.dailyJob().catch(err => console.error('Scheduler job error:', err));
    });

    console.log(`[调度器] 每日任务设定在 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} 执行 (cron: ${cronExpr})`);
    if (runImmediately) {
      console.log('[调度器] 首次启动，立即执行一次...');
      this.dailyJob().catch(err => console.error('Initial job error:', err));
    }
  }

  stop() {
    if (this.task) {
      this.task.stop();
      this.task = null;
    }
    if (this.db) {
      this.db.close();
    }
  }
}

module.exports = TrendScheduler;
