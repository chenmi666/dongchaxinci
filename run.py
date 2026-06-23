"""
Trend Opportunity Radar - 启动入口
"""
import sys
import signal
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import uvicorn
from app.database import Database
from app.trends_fetcher import TrendsFetcher
from app.ai_analyzer import AIAnalyzer
from app.reporter import DailyReporter
from app.scheduler import TrendScheduler
from app.config import settings

db = Database()

fetcher = TrendsFetcher()
analyzer = AIAnalyzer(db)
reporter = DailyReporter(db, analyzer)
scheduler = TrendScheduler(db, fetcher, analyzer, reporter)


def main():
    print("=" * 50)
    print("  Trend Opportunity Radar v1.0")
    print("  Python + SQLite + OpenAI")
    print("=" * 50)
    print(f"  Database: {settings.DATABASE_PATH}")
    print(f"  Web:      http://localhost:{settings.PORT}")

    has_key = bool(settings.get_ai_api_key(db))
    if has_key:
        model = settings.get_ai_model(db)
        base = settings.get_ai_api_base(db)
        print(f"  AI:       [OK] {model} @ {base}")
    else:
        print(f"  AI:       [!!] 未配置 - 请在 /settings 页面设置 API Key")

    proxy = settings.get_proxy(db)
    if proxy:
        print(f"  Proxy:    {proxy}")
    else:
        print(f"  Proxy:    直连 (如需代理请在设置页面配置)")

    print(f"  Schedule: 每日 {settings.get_fetch_time(db)[0]:02d}:{settings.get_fetch_time(db)[1]:02d} 自动抓取")
    print("=" * 50)
    print("")

    scheduler.start(run_immediately=False)

    def _first_run():
        import time
        time.sleep(2)
        try:
            print("[启动] 执行首次抓取+分析...")
            scheduler.daily_job()
        except Exception as e:
            print(f"[启动] 首次运行跳过: {e}")

    t = threading.Thread(target=_first_run, daemon=True)
    t.start()

    def graceful_exit(sig, frame):
        print("\n正在关闭...")
        scheduler.stop()
        sys.exit(0)

    signal.signal(signal.SIGINT, graceful_exit)
    signal.signal(signal.SIGTERM, graceful_exit)

    uvicorn.run(
        "web.main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=settings.RELOAD,
        log_level="info",
    )


if __name__ == "__main__":
    main()
