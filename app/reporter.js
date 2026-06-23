const config = require('./config');

class DailyReporter {
  constructor(db, analyzer) {
    this.db = db;
    this.analyzer = analyzer;
  }

  generateDailyReport() {
    const todayStr = new Date().toISOString().slice(0, 10);
    const totalKw = this.db.getTotalKeywords();
    const newKw = this.db.getNewKeywordsCount(1);
    const longTermKw = this.db.getKeywordsByStatus('long_term');
    const eventKw = this.db.getKeywordsByStatus('event_driven');
    const longTermCnt = longTermKw.length;
    const eventCnt = eventKw.length;
    const topOpps = this.db.getTopOpportunities(config.defaults.REPORT_TOP_N);

    const lines = [];
    lines.push(`# Trend Opportunity Radar — 每日报告 (${todayStr})`);
    lines.push('');
    lines.push('## 今日概览');
    lines.push('');
    lines.push('| 指标 | 数值 |');
    lines.push('|---|---|');
    lines.push(`| 关键词总数 | ${totalKw} |`);
    lines.push(`| 今日新增 | ${newKw} |`);
    lines.push(`| 长期需求型 | ${longTermCnt} |`);
    lines.push(`| 事件型 | ${eventCnt} |`);
    lines.push(`| AI分析次数 | ${this.db.getStats().total_analyses} |`);
    lines.push('');

    lines.push('## Top 创业机会');
    lines.push('');
    lines.push('| # | 关键词 | 分类 | 评分 | 分析理由 |');
    lines.push('|---|---|---|---|---|');
    for (let i = 0; i < Math.min(topOpps.length, 10); i++) {
      const opp = topOpps[i];
      lines.push(
        `| ${i + 1} | ${opp.keyword} | ${opp.category_name} | ${opp.opportunity_score} | ${opp.reasoning || ''} |`
      );
    }
    lines.push('');

    lines.push('## 本周趋势上升关键词');
    lines.push('');
    const rising = this.db.getTrendingUpKeywords(3, 10);
    if (rising && rising.length > 0) {
      lines.push('| 关键词 | 分类 | 当前分 |');
      lines.push('|---|---|---|');
      for (const r of rising) {
        lines.push(`| ${r.keyword} | ${r.category_name} | ${r.score_today} |`);
      }
    } else {
      lines.push('(暂无数据)');
    }

    const summaryMd = lines.join('\n');

    const oppList = topOpps.map(opp => ({
      keyword: opp.keyword,
      category: opp.category_name,
      score: opp.opportunity_score,
      reasoning: opp.reasoning || '',
    }));

    this.db.saveReport(todayStr, totalKw, newKw, longTermCnt, eventCnt, oppList, summaryMd);

    return {
      date: todayStr,
      total_keywords: totalKw,
      new_keywords: newKw,
      long_term_cnt: longTermCnt,
      event_cnt: eventCnt,
      top_opportunities: oppList,
      summary_md: summaryMd,
    };
  }
}

module.exports = DailyReporter;
