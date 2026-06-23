import time
from datetime import date, datetime

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from app.database import Database
from app.trends_fetcher import TrendsFetcher
from app.ai_analyzer import AIAnalyzer
from app.reporter import DailyReporter
from app.config import settings


class TrendScheduler:
    def __init__(self, db: Database, fetcher: TrendsFetcher,
                 analyzer: AIAnalyzer, reporter: DailyReporter):
        self.db = db
        self.fetcher = fetcher
        self.analyzer = analyzer
        self.reporter = reporter
        self.scheduler = BackgroundScheduler()

    def daily_job(self):
        today_str = date.today().isoformat()
        print(f"\n{'='*50}")
        print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] 开始每日任务...")
        print(f"{'='*50}")

        # 1. Fetch trends
        print("[1/4] 抓取 Google Trends...")
        all_results = self.fetcher.fetch_all()

        # 2. Save to DB
        print("[2/4] 保存到数据库...")
        total_fetched = 0
        for cat_name, items in all_results.items():
            if not items:
                print(f"  {cat_name}: 0 条 (失败)")
                self.db.log_fetch(today_str, cat_name, 0, "failed",
                                  "pytrends returned no data")
                continue
            cat_id = settings.TRENDS_CATEGORIES[cat_name]
            count = 0
            for item in items:
                kw_id, _ = self.db.upsert_keyword(
                    item["keyword"], cat_id, item["date"])
                self.db.upsert_trend(
                    kw_id, item["date"], item["interest_score"], item["rank"])
                self.db.update_keyword_peak(kw_id, item["interest_score"])
                count += 1
            total_fetched += count
            self.db.log_fetch(today_str, cat_name, count, "success")
            print(f"  {cat_name}: {count} 条")

        # 3. AI Analysis
        print("[3/4] AI 分析关键词...")
        needing = self.db.get_keywords_needing_analysis()
        if needing:
            print(f"  待分析: {len(needing)} 个关键词")
            if self.analyzer.is_configured():
                results = self.analyzer.analyze_keywords_batch(needing)
                for r in results:
                    self.db.save_analysis(
                        r["keyword_id"],
                        r["is_event_driven"],
                        r["opportunity_score"],
                        r["reasoning"],
                        r["relook_days"],
                    )
                analyzed = len(results)
                event_count = sum(1 for r in results if r["is_event_driven"])
                long_count = analyzed - event_count
                print(f"  ✓ 已完成 {analyzed} 个分析 (事件型: {event_count}, 长期需求: {long_count})")
                time.sleep(1)
            else:
                print(f"  ⚠ OpenAI 未配置，跳过 AI 分析")
        else:
            print(f"  无待分析关键词")

        # 4. Generate report
        print("[4/4] 生成每日报告...")
        report = self.reporter.generate_daily_report()
        print(f"  ✓ 报告已生成: {report['new_keywords']} 新增, "
              f"{len(report['top_opportunities'])} 个机会关键词")

        # 5. Cleanup
        deleted = self.db.cleanup_old_trends(90)
        print(f"  清理: 删除 {deleted} 条过期趋势数据")

        print(f"[✔] 每日任务完成 ({datetime.now().strftime('%H:%M:%S')})")
        print(f"{'='*50}\n")

    def start(self, run_immediately=False):
        hour, minute = settings.get_fetch_time(self.db)
        trigger = CronTrigger(hour=hour, minute=minute)
        self.scheduler.add_job(self.daily_job, trigger, id="daily_trend_job",
                               replace_existing=True)
        self.scheduler.start()

        print(f"[调度器] 每日任务设定在 {hour:02d}:{minute:02d} 执行")
        if run_immediately:
            print("[调度器] 首次启动，立即执行一次...")
            self.daily_job()

    def stop(self):
        if self.scheduler.running:
            self.scheduler.shutdown(wait=False)
