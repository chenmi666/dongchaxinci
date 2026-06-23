import csv
import io
import json
from datetime import date, datetime
from pathlib import Path

from fastapi import FastAPI, Request, Form, Query
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.config import settings, BASE_DIR
from app.database import Database
from app.trends_fetcher import TrendsFetcher
from app.ai_analyzer import AIAnalyzer
from app.reporter import DailyReporter

db = Database()

def get_fetcher():
    return TrendsFetcher()

def get_analyzer():
    return AIAnalyzer(db)

def get_reporter():
    return DailyReporter(db, get_analyzer())

app = FastAPI(title="Trend Opportunity Radar")

templates = Jinja2Templates(directory=str(BASE_DIR / "web" / "templates"))
static_dir = BASE_DIR / "web" / "static"
static_dir.mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


# ─── HTML Pages ──────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
def dashboard(request: Request):
    return templates.TemplateResponse(request, "dashboard.html", {
        "now": datetime.now().strftime("%Y-%m-%d %H:%M"),
    })


@app.get("/keyword/{kw_id}", response_class=HTMLResponse)
def keyword_detail(request: Request, kw_id: int):
    kw = db.get_keyword_by_id(kw_id)
    if not kw:
        return HTMLResponse("关键词不存在", status_code=404)
    return templates.TemplateResponse(request, "keyword_detail.html", {
        "kw": kw,
    })


@app.get("/reports", response_class=HTMLResponse)
def reports_page(request: Request):
    return templates.TemplateResponse(request, "reports.html")


@app.get("/report/{report_date}", response_class=HTMLResponse)
def report_detail(request: Request, report_date: str):
    report = db.get_report(report_date)
    if not report:
        return HTMLResponse("报告不存在", status_code=404)
    return templates.TemplateResponse(request, "report_detail.html", {
        "report": report,
    })


@app.get("/history", response_class=HTMLResponse)
def history_page(request: Request):
    return templates.TemplateResponse(request, "history.html")


@app.get("/settings", response_class=HTMLResponse)
def settings_page(request: Request):
    api_key = settings.get_ai_api_key(db)
    model = settings.get_ai_model(db)
    api_base = settings.get_ai_api_base(db)
    hour, minute = settings.get_fetch_time(db)
    proxy = settings.get_proxy(db)
    return templates.TemplateResponse(request, "settings.html", {
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
    history = db.get_trend_history(kw_id, days=90)
    return {"history": history}


@app.get("/api/reports")
def api_reports():
    reports = db.get_reports(limit=30)
    return {"reports": reports}


@app.get("/api/history")
def api_history(category: str = None, status: str = None, search: str = None):
    if search:
        keywords = db.search_keywords(search)
    elif status:
        keywords = db.get_keywords_by_status(status)
        if category:
            keywords = [k for k in keywords if k["category_name"] == category]
    elif category:
        top = db.get_top_opportunities(limit=200, category=category)
        all_kw = []
        for t in top:
            all_kw.append(t)
            more = db.get_keywords_by_status("event_driven")
            all_kw.extend([m for m in more if m["category_name"] == category])
        keywords = all_kw[:200]
    else:
        lt = db.get_keywords_by_status("long_term")
        ev = db.get_keywords_by_status("event_driven")
        keywords = (lt + ev)[:200]
    return {"keywords": keywords}


@app.get("/api/stats")
def api_stats():
    return db.get_stats()


@app.get("/api/fetch_logs")
def api_fetch_logs():
    return {"logs": db.get_recent_fetch_logs()}


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
    from app.scheduler import TrendScheduler
    sched = TrendScheduler(db, get_fetcher(), get_analyzer(), get_reporter())
    sched.daily_job()
    return {"status": "ok", "message": "Fetch & analysis completed"}
