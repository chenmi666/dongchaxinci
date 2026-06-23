const cron = require('node-cron');
const config = require('./config');
const logger = require('./logger');

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

    logger.info('scheduler', '========== 开始每日任务 ==========');

    // 1. Fetch trends
    logger.info('scheduler', '[1/4] 抓取 Google Trends...');
    let allResults;
    try {
      allResults = await this.fetcher.fetchAll();
      logger.info('scheduler', '[1/4] Google Trends 抓取完成');
    } catch (e) {
      logger.error('scheduler', `[1/4] 抓取失败: ${e.message}`);
      throw e;
    }

    // 2. Save to DB
    logger.info('scheduler', '[2/4] 保存到数据库...');
    let totalFetched = 0;
    for (const [catName, items] of Object.entries(allResults)) {
      if (!items || items.length === 0) {
        logger.warn('scheduler', `  ${catName}: 0 条 (失败)`);
        this.db.logFetch(todayStr, catName, 0, 'failed', '返回无数据');
        continue;
      }
      const catId = config.defaults.TRENDS_CATEGORIES[catName];
      let count = 0;
      for (const item of items) {
        const { kwId } = this.db.upsertKeyword(item.keyword, catId, item.date);
        this.db.upsertTrend(kwId, item.date, item.interest_score, item.rank, item.search_volume);
        this.db.updateKeywordPeak(kwId, item.interest_score);
        count++;
      }
      totalFetched += count;
      this.db.logFetch(todayStr, catName, count, 'success');
      logger.info('scheduler', `  ${catName}: ${count} 条`);
    }
    logger.info('scheduler', `[2/4] 共保存 ${totalFetched} 条趋势数据`);

    // 3. AI Analysis
    logger.info('scheduler', '[3/4] AI 分析关键词...');
    const needing = this.db.getKeywordsNeedingAnalysis();
    if (needing && needing.length > 0) {
      logger.info('scheduler', `  待分析: ${needing.length} 个关键词`);
      if (this.analyzer.isConfigured()) {
        const results = await this.analyzer.analyzeKeywordsBatch(needing);
        for (const r of results) {
          this.db.saveAnalysis(
            r.keyword_id, r.is_event_driven, r.opportunity_score, r.reasoning, r.relook_days
          );
        }
        const eventCount = results.filter(r => r.is_event_driven).length;
        const longCount = results.length - eventCount;
        logger.info('scheduler', `  ✓ 已完成 ${results.length} 个分析 (事件型: ${eventCount}, 长期需求: ${longCount})`);
      } else {
        logger.warn('scheduler', `  ⚠ AI 未配置，跳过 AI 分析`);
      }
    } else {
      logger.info('scheduler', `  无待分析关键词`);
    }

    // 4. Generate report
    logger.info('scheduler', '[4/4] 生成每日报告...');
    try {
      const report = this.reporter.generateDailyReport();
      logger.info('scheduler', `  ✓ 报告已生成: ${report.new_keywords} 新增, ${report.top_opportunities.length} 个机会关键词`);
    } catch (e) {
      logger.error('scheduler', `  ✗ 报告生成失败: ${e.message}`);
    }

    // 5. Cleanup
    const deleted = this.db.cleanupOldTrends(90);
    if (deleted > 0) logger.info('scheduler', `  清理: 删除 ${deleted} 条过期趋势数据`);
    const logDeleted = this.db.cleanupOldLogs(7);
    if (logDeleted > 0) logger.info('scheduler', `  清理: 删除 ${logDeleted} 条旧抓取日志`);

    logger.info('scheduler', '========== 每日任务完成 ==========');
  }

  start(runImmediately) {
    const { hour, minute } = config.getFetchTime(this.db);
    const cronExpr = `${minute} ${hour} * * *`;

    if (this.task) this.task.stop();
    this.task = cron.schedule(cronExpr, () => {
      this.dailyJob().catch(err => logger.error('scheduler', `定时任务异常: ${err.message}`));
    });

    logger.info('scheduler', `每日任务设定在 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} 执行`);
    if (runImmediately) {
      logger.info('scheduler', '首次启动，立即执行...');
      this.dailyJob().catch(err => logger.error('scheduler', `首次执行异常: ${err.message}`));
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
