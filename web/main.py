import csv
import io
from datetime import date, datetime
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Form
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.config import settings, BASE_DIR
from app.database import Database
from app.trends_fetcher import TrendsFetcher
from app.ai_analyzer import AIAnalyzer
from app.reporter import DailyReporter

_db = None
_templates = None


def get_db():
    global _db
    if _db is None:
        _db = Database()
    return _db


def get_templates():
    global _templates
    if _templates is None:
        _templates = Jinja2Templates(directory=str(BASE_DIR / "web" / "templates"))
    return _templates


def get_fetcher():
    return TrendsFetcher()


def get_analyzer():
    return AIAnalyzer(get_db())


def get_reporter():
    return DailyReporter(get_db(), get_analyzer())


@asynccontextmanager
async def lifespan(app: FastAPI):
    get_db()
    yield


app = FastAPI(title="Trend Opportunity Radar", lifespan=lifespan)

static_dir = BASE_DIR / "web" / "static"
static_dir.mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


# ─── HTML Pages ──────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
def dashboard(request: Request):
    return get_templates().TemplateResponse(request, "dashboard.html", {
        "now": datetime.now().strftime("%Y-%m-%d %H:%M"),
    })


@app.get("/keyword/{kw_id}", response_class=HTMLResponse)
def keyword_detail(request: Request, kw_id: int):
    db = get_db()
    kw = db.get_keyword_by_id(kw_id)
    if not kw:
        return HTMLResponse("关键词不存在", status_code=404)
    return get_templates().TemplateResponse(request, "keyword_detail.html", {
        "kw": kw,
    })


@app.get("/reports", response_class=HTMLResponse)
def reports_page(request: Request):
    return get_templates().TemplateResponse(request, "reports.html")


@app.get("/report/{report_date}", response_class=HTMLResponse)
def report_detail(request: Request, report_date: str):
    db = get_db()
    report = db.get_report(report_date)
    if not report:
        return HTMLResponse("报告不存在", status_code=404)
    return get_templates().TemplateResponse(request, "report_detail.html", {
        "report": report,
    })


@app.get("/history", response_class=HTMLResponse)
def history_page(request: Request):
    return get_templates().TemplateResponse(request, "history.html")


@app.get("/settings", response_class=HTMLResponse)
def settings_page(request: Request):
    db = get_db()
    api_key = settings.get_ai_api_key(db)
    model = settings.get_ai_model(db)
    api_base = settings.get_ai_api_base(db)
    hour, minute = settings.get_fetch_time(db)
    proxy = settings.get_proxy(db)
    return get_templates().TemplateResponse(request, "settings.html", {
        "api_key": api_key,
        "model": model,
        "api_base": api_base,
        "fetch_hour": hour,
        "fetch_minute": minute,
        "proxy": proxy,
    })


# ─── API ─────────────────────────────────────────────────────

@app.get("/api/dashboard")
def api_dashboard(category: str = None):
    db = get_db()
    top = db.get_top_opportunities(limit=20, category=category)
    stats = db.get_stats()
    rising = db.get_trending_up_keywords(min_days=3, limit=10)
    last_fetch = db.get_last_fetch_date()
    new_kw = db.get_new_keywords_count(days=1)
    return {
        "top_opportunities": top,
        "stats": stats,
        "rising": rising,
        "last_fetch": last_fetch,
        "new_keywords": new_kw,
    }


@app.get("/api/keyword/{kw_id}")
def api_keyword(kw_id: int):
    db = get_db()
    kw = db.get_keyword_by_id(kw_id)
    if not kw:
        return JSONResponse({"error": "not found"}, status_code=404)
    analysis = db.get_latest_analysis(kw_id)
    all_analyses = db.get_all_analyses(kw_id)
    history = db.get_trend_history(kw_id, days=90)
    bounds = db.get_trend_bounds(kw_id)
    return {
        "keyword": kw,
        "analysis": analysis,
        "all_analyses": all_analyses,
        "history": history,
        "bounds": bounds,
    }


@app.get("/api/keyword/{kw_id}/trend")
def api_keyword_trend(kw_id: int):
    db = get_db()
    history = db.get_trend_history(kw_id, days=90)
    return {"history": history}


@app.get("/api/reports")
def api_reports():
    db = get_db()
    reports = db.get_reports(limit=30)
    return {"reports": reports}


@app.get("/api/history")
def api_history(category: str = None, status: str = None, search: str = None):
    db = get_db()
    if search:
        keywords = db.search_keywords(search)
    elif status:
        keywords = db.get_keywords_by_status(status)
        if category:
            keywords = [k for k in keywords if k["category_name"] == category]
    elif category:
        top = db.get_top_opportunities(limit=200, category=category)
        results = []
        for t in top:
            results.append(t)
        keywords = results[:200]
    else:
        lt = db.get_keywords_by_status("long_term")
        ev = db.get_keywords_by_status("event_driven")
        keywords = (lt + ev)[:200]
    return {"keywords": keywords}


@app.get("/api/stats")
def api_stats():
    return get_db().get_stats()


@app.get("/api/fetch_logs")
def api_fetch_logs():
    return {"logs": get_db().get_recent_fetch_logs()}


# ─── Settings API ────────────────────────────────────────────

@app.post("/api/settings")
def api_save_settings(
    ai_api_key: str = Form(""),
    ai_model: str = Form("glm-5.2"),
    ai_api_base: str = Form("https://open.bigmodel.cn/api/paas/v4/"),
    fetch_hour: int = Form(9),
    fetch_minute: int = Form(0),
    proxy: str = Form(""),
):
    db = get_db()
    if ai_api_key:
        db.set_setting("ai_api_key", ai_api_key)
    db.set_setting("ai_model", ai_model)
    db.set_setting("ai_api_base", ai_api_base)
    db.set_setting("fetch_hour", str(fetch_hour))
    db.set_setting("fetch_minute", str(fetch_minute))
    db.set_setting("proxy", proxy)
    return {"status": "ok"}


@app.post("/api/settings/test")
def api_test_openai(
    api_key: str = Form(""),
    model: str = Form("glm-5.2"),
    api_base: str = Form("https://open.bigmodel.cn/api/paas/v4/"),
):
    import openai
    client = openai.OpenAI(api_key=api_key, base_url=api_base)
    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": "Hi"}],
            max_tokens=10,
        )
        return {"status": "ok", "message": f"成功: {resp.choices[0].message.content[:30]}"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


# ─── Export ──────────────────────────────────────────────────

@app.get("/api/export/csv")
def export_csv():
    db = get_db()
    top = db.get_top_opportunities(limit=200)
    output = io.StringIO()
    w = csv.DictWriter(output, fieldnames=[
        "keyword", "category", "opportunity_score", "is_event_driven",
        "reasoning", "first_seen", "last_seen", "peak_score", "status",
    ])
    w.writeheader()
    for item in top:
        w.writerow({
            "keyword": item["keyword"],
            "category": item["category_name"],
            "opportunity_score": item["opportunity_score"],
            "is_event_driven": "长期需求" if not item.get("is_event_driven") else "事件型",
            "reasoning": item.get("reasoning", ""),
            "first_seen": item.get("first_seen", ""),
            "last_seen": item.get("last_seen", ""),
            "peak_score": item.get("peak_score", 0),
            "status": item.get("status", ""),
        })
    output.seek(0)
    today = date.today().isoformat()
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=opportunities_{today}.csv"},
    )


# ─── Manual Trigger ──────────────────────────────────────────

@app.post("/api/trigger_fetch")
def trigger_fetch():
    db = get_db()
    from app.scheduler import TrendScheduler
    sched = TrendScheduler(db, get_fetcher(), get_analyzer(), get_reporter())
    sched.daily_job()
    return {"status": "ok", "message": "Fetch & analysis completed"}
