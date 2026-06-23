import sqlite3
import json
from datetime import date, datetime, timedelta
from pathlib import Path
from app.config import settings


class Database:
    def __init__(self, db_path=None):
        self.db_path = db_path or settings.DATABASE_PATH
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _get_conn(self):
        conn = sqlite3.connect(self.db_path)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self):
        conn = self._get_conn()
        cur = conn.cursor()
        cur.executescript("""
            CREATE TABLE IF NOT EXISTS categories (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT NOT NULL UNIQUE,
                pytrends_id INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS keywords (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                keyword      TEXT NOT NULL UNIQUE COLLATE NOCASE,
                category_id  INTEGER NOT NULL REFERENCES categories(id),
                first_seen   TEXT NOT NULL,
                last_seen    TEXT NOT NULL,
                status       TEXT NOT NULL DEFAULT 'pending',
                peak_score   INTEGER DEFAULT 0,
                created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
            );
            CREATE INDEX IF NOT EXISTS idx_kw_status ON keywords(status);
            CREATE INDEX IF NOT EXISTS idx_kw_cat ON keywords(category_id);

            CREATE TABLE IF NOT EXISTS trends_daily (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                keyword_id     INTEGER NOT NULL REFERENCES keywords(id),
                date           TEXT NOT NULL,
                interest_score INTEGER NOT NULL DEFAULT 0,
                rank           INTEGER,
                UNIQUE(keyword_id, date)
            );
            CREATE INDEX IF NOT EXISTS idx_td_kw ON trends_daily(keyword_id);
            CREATE INDEX IF NOT EXISTS idx_td_date ON trends_daily(date);

            CREATE TABLE IF NOT EXISTS ai_analyses (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                keyword_id        INTEGER NOT NULL REFERENCES keywords(id),
                analyzed_date     TEXT NOT NULL,
                is_event_driven   INTEGER NOT NULL DEFAULT 1,
                opportunity_score INTEGER DEFAULT 0,
                reasoning         TEXT,
                relook_days       INTEGER DEFAULT 7,
                created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
            );
            CREATE INDEX IF NOT EXISTS idx_ai_kw ON ai_analyses(keyword_id);
            CREATE INDEX IF NOT EXISTS idx_ai_date ON ai_analyses(analyzed_date);
            CREATE INDEX IF NOT EXISTS idx_ai_score ON ai_analyses(opportunity_score);

            CREATE TABLE IF NOT EXISTS daily_reports (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                report_date      TEXT NOT NULL UNIQUE,
                total_keywords   INTEGER NOT NULL DEFAULT 0,
                new_keywords     INTEGER NOT NULL DEFAULT 0,
                long_term_cnt    INTEGER NOT NULL DEFAULT 0,
                event_cnt        INTEGER NOT NULL DEFAULT 0,
                top_opportunities TEXT,
                summary_md       TEXT,
                generated_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
            );

            CREATE TABLE IF NOT EXISTS fetch_logs (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                fetch_date     TEXT NOT NULL,
                category       TEXT NOT NULL,
                keywords_count INTEGER DEFAULT 0,
                status         TEXT NOT NULL DEFAULT 'success',
                error_msg      TEXT,
                duration_ms    INTEGER,
                created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
            );

            CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        """)

        for name, pid in [("Business", 7), ("Technology", 5), ("Health", 8)]:
            cur.execute(
                "INSERT OR IGNORE INTO categories(name, pytrends_id) VALUES (?, ?)",
                (name, pid),
            )
        conn.commit()
        conn.close()

    # --- settings ---
    def get_setting(self, key):
        conn = self._get_conn()
        row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        conn.close()
        return row["value"] if row else None

    def set_setting(self, key, value):
        conn = self._get_conn()
        conn.execute(
            "INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)", (key, value)
        )
        conn.commit()
        conn.close()

    # --- keywords ---
    def upsert_keyword(self, keyword, category_id, today_str=None):
        if not today_str:
            today_str = date.today().isoformat()
        conn = self._get_conn()
        existing = conn.execute(
            "SELECT id, peak_score, first_seen FROM keywords WHERE keyword=? COLLATE NOCASE",
            (keyword,),
        ).fetchone()
        if existing:
            kw_id = existing["id"]
            peak = existing["peak_score"]
            first = existing["first_seen"]
            conn.execute(
                "UPDATE keywords SET last_seen=? WHERE id=?", (today_str, kw_id)
            )
        else:
            conn.execute(
                "INSERT INTO keywords(keyword, category_id, first_seen, last_seen) VALUES (?, ?, ?, ?)",
                (keyword, category_id, today_str, today_str),
            )
            kw_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
            first = today_str
            peak = 0
        conn.commit()
        conn.close()
        return kw_id, first

    def update_keyword_peak(self, kw_id, score):
        conn = self._get_conn()
        conn.execute(
            "UPDATE keywords SET peak_score = MAX(peak_score, ?) WHERE id=?",
            (score, kw_id),
        )
        conn.commit()
        conn.close()

    def update_keyword_status(self, kw_id, status):
        conn = self._get_conn()
        conn.execute("UPDATE keywords SET status=? WHERE id=?", (status, kw_id))
        conn.commit()
        conn.close()

    def get_keyword(self, keyword):
        conn = self._get_conn()
        row = conn.execute(
            "SELECT k.*, c.name as category_name FROM keywords k "
            "JOIN categories c ON c.id = k.category_id "
            "WHERE k.keyword=? COLLATE NOCASE",
            (keyword,),
        ).fetchone()
        conn.close()
        return dict(row) if row else None

    def get_keyword_by_id(self, kw_id):
        conn = self._get_conn()
        row = conn.execute(
            "SELECT k.*, c.name as category_name FROM keywords k "
            "JOIN categories c ON c.id = k.category_id WHERE k.id=?",
            (kw_id,),
        ).fetchone()
        conn.close()
        return dict(row) if row else None

    def get_keywords_needing_analysis(self):
        conn = self._get_conn()
        today = date.today().isoformat()
        rows = conn.execute(
            """
            SELECT k.*, c.name as category_name
            FROM keywords k
            JOIN categories c ON c.id = k.category_id
            WHERE k.status = 'pending'
               OR k.id NOT IN (
                   SELECT keyword_id FROM ai_analyses
                   WHERE analyzed_date = ?
               )
            ORDER BY k.last_seen DESC
            LIMIT 100
            """,
            (today,),
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    def get_total_keywords(self):
        conn = self._get_conn()
        row = conn.execute("SELECT COUNT(*) as cnt FROM keywords").fetchone()
        conn.close()
        return row["cnt"]

    def get_active_keywords(self, days=7):
        conn = self._get_conn()
        since = (date.today() - timedelta(days=days)).isoformat()
        rows = conn.execute(
            "SELECT k.*, c.name as category_name FROM keywords k "
            "JOIN categories c ON c.id = k.category_id "
            "WHERE k.last_seen >= ? ORDER BY k.last_seen DESC",
            (since,),
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    # --- trends_daily ---
    def upsert_trend(self, keyword_id, date_str, score, rank=None):
        conn = self._get_conn()
        conn.execute(
            """INSERT OR REPLACE INTO trends_daily(keyword_id, date, interest_score, rank)
               VALUES (?, ?, ?, ?)""",
            (keyword_id, date_str, score, rank),
        )
        conn.commit()
        conn.close()

    def get_trend_history(self, keyword_id, days=90):
        conn = self._get_conn()
        since = (date.today() - timedelta(days=days)).isoformat()
        rows = conn.execute(
            "SELECT date, interest_score FROM trends_daily "
            "WHERE keyword_id=? AND date >= ? ORDER BY date",
            (keyword_id, since),
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    def get_trend_bounds(self, keyword_id):
        conn = self._get_conn()
        row = conn.execute(
            "SELECT MIN(date) as min_date, MAX(date) as max_date, "
            "MIN(interest_score) as min_score, MAX(interest_score) as max_score "
            "FROM trends_daily WHERE keyword_id=?",
            (keyword_id,),
        ).fetchone()
        conn.close()
        return dict(row) if row else {}

    def get_trending_up_keywords(self, min_days=3, limit=20):
        conn = self._get_conn()
        today = date.today().isoformat()
        rows = conn.execute(
            """
            SELECT k.*, c.name as category_name,
                   COALESCE(a.opportunity_score, 0) as opportunity_score,
                   COALESCE(a.is_event_driven, 1) as is_event_driven,
                   td1.interest_score as score_today,
                   td3.interest_score as score_3days_ago
            FROM keywords k
            JOIN categories c ON c.id = k.category_id
            JOIN trends_daily td1 ON td1.keyword_id = k.id AND td1.date = ?
            LEFT JOIN trends_daily td3 ON td3.keyword_id = k.id AND td3.date = ?
            LEFT JOIN (
                SELECT keyword_id, opportunity_score, is_event_driven,
                       ROW_NUMBER() OVER (PARTITION BY keyword_id ORDER BY analyzed_date DESC) AS rn
                FROM ai_analyses
            ) a ON a.keyword_id = k.id AND a.rn = 1
            WHERE td1.interest_score > COALESCE(td3.interest_score, 0)
            ORDER BY (td1.interest_score - COALESCE(td3.interest_score, 0)) DESC
            LIMIT ?
            """,
            (today, (date.today() - timedelta(days=min_days)).isoformat(), limit),
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    def cleanup_old_trends(self, days=90):
        conn = self._get_conn()
        cutoff = (date.today() - timedelta(days=days)).isoformat()
        conn.execute("DELETE FROM trends_daily WHERE date < ?", (cutoff,))
        deleted = conn.total_changes
        conn.commit()
        conn.close()
        return deleted

    # --- ai_analyses ---
    def save_analysis(self, keyword_id, is_event_driven, score, reasoning, relook_days=7):
        today_str = date.today().isoformat()
        conn = self._get_conn()
        conn.execute(
            """INSERT INTO ai_analyses(keyword_id, analyzed_date, is_event_driven,
               opportunity_score, reasoning, relook_days)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (keyword_id, today_str, 1 if is_event_driven else 0, score, reasoning, relook_days),
        )
        status = "event_driven" if is_event_driven else "long_term"
        conn.execute("UPDATE keywords SET status=? WHERE id=?", (status, keyword_id))
        conn.commit()
        conn.close()

    def get_latest_analysis(self, keyword_id):
        conn = self._get_conn()
        row = conn.execute(
            "SELECT * FROM ai_analyses WHERE keyword_id=? ORDER BY analyzed_date DESC LIMIT 1",
            (keyword_id,),
        ).fetchone()
        conn.close()
        return dict(row) if row else None

    def get_all_analyses(self, keyword_id):
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT * FROM ai_analyses WHERE keyword_id=? ORDER BY analyzed_date DESC LIMIT 20",
            (keyword_id,),
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    def get_top_opportunities(self, limit=20, category=None):
        conn = self._get_conn()
        today = date.today().isoformat()
        sql = """
            SELECT k.*, c.name as category_name,
                   a.opportunity_score, a.is_event_driven, a.reasoning,
                   a.analyzed_date
            FROM keywords k
            JOIN categories c ON c.id = k.category_id
            JOIN (
                SELECT keyword_id, opportunity_score, is_event_driven, reasoning, analyzed_date,
                       ROW_NUMBER() OVER (PARTITION BY keyword_id ORDER BY analyzed_date DESC) AS rn
                FROM ai_analyses
            ) a ON a.keyword_id = k.id AND a.rn = 1
            WHERE a.is_event_driven = 0
        """
        params = []
        if category:
            sql += " AND c.name = ?"
            params.append(category)
        sql += " ORDER BY a.opportunity_score DESC LIMIT ?"
        params.append(limit)
        rows = conn.execute(sql, params).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    # --- daily_reports ---
    def save_report(self, date_str, total_kw, new_kw, long_term_cnt,
                    event_cnt, top_opportunities, summary_md):
        conn = self._get_conn()
        conn.execute(
            """INSERT OR REPLACE INTO daily_reports
               (report_date, total_keywords, new_keywords, long_term_cnt, event_cnt,
                top_opportunities, summary_md)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (date_str, total_kw, new_kw, long_term_cnt, event_cnt,
             json.dumps(top_opportunities, ensure_ascii=False), summary_md),
        )
        conn.commit()
        conn.close()

    def get_reports(self, limit=30):
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT * FROM daily_reports ORDER BY report_date DESC LIMIT ?",
            (limit,),
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    def get_report(self, date_str):
        conn = self._get_conn()
        row = conn.execute(
            "SELECT * FROM daily_reports WHERE report_date=?", (date_str,)
        ).fetchone()
        conn.close()
        if row:
            r = dict(row)
            if r["top_opportunities"]:
                r["top_opportunities"] = json.loads(r["top_opportunities"])
            return r
        return None

    # --- fetch_logs ---
    def log_fetch(self, fetch_date, category, count, status="success", error=None, duration=None):
        conn = self._get_conn()
        conn.execute(
            """INSERT INTO fetch_logs(fetch_date, category, keywords_count, status, error_msg, duration_ms)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (fetch_date, category, count, status, error, duration),
        )
        conn.commit()
        conn.close()

    def get_recent_fetch_logs(self, limit=20):
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT * FROM fetch_logs ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    def get_last_fetch_date(self):
        conn = self._get_conn()
        row = conn.execute(
            "SELECT fetch_date FROM fetch_logs ORDER BY created_at DESC LIMIT 1"
        ).fetchone()
        conn.close()
        return row["fetch_date"] if row else None

    # --- stats ---
    def get_stats(self):
        conn = self._get_conn()
        data = {}
        data["total_keywords"] = conn.execute(
            "SELECT COUNT(*) as c FROM keywords"
        ).fetchone()["c"]
        data["long_term"] = conn.execute(
            "SELECT COUNT(*) as c FROM keywords WHERE status='long_term'"
        ).fetchone()["c"]
        data["event_driven"] = conn.execute(
            "SELECT COUNT(*) as c FROM keywords WHERE status='event_driven'"
        ).fetchone()["c"]
        data["pending"] = conn.execute(
            "SELECT COUNT(*) as c FROM keywords WHERE status='pending'"
        ).fetchone()["c"]
        data["total_analyses"] = conn.execute(
            "SELECT COUNT(*) as c FROM ai_analyses"
        ).fetchone()["c"]
        data["total_reports"] = conn.execute(
            "SELECT COUNT(*) as c FROM daily_reports"
        ).fetchone()["c"]
        data["total_trends"] = conn.execute(
            "SELECT COUNT(*) as c FROM trends_daily"
        ).fetchone()["c"]
        data["last_fetch"] = self.get_last_fetch_date()
        conn.close()
        return data

    def get_new_keywords_count(self, days=1):
        conn = self._get_conn()
        since = (date.today() - timedelta(days=days)).isoformat()
        row = conn.execute(
            "SELECT COUNT(*) as c FROM keywords WHERE first_seen >= ?", (since,)
        ).fetchone()
        conn.close()
        return row["c"]

    def get_keywords_by_status(self, status):
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT k.*, c.name as category_name FROM keywords k "
            "JOIN categories c ON c.id = k.category_id WHERE k.status=? "
            "ORDER BY k.last_seen DESC LIMIT 200",
            (status,),
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]

    def search_keywords(self, query, limit=50):
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT k.*, c.name as category_name FROM keywords k "
            "JOIN categories c ON c.id = k.category_id "
            "WHERE k.keyword LIKE ? ORDER BY k.last_seen DESC LIMIT ?",
            (f"%{query}%", limit),
        ).fetchall()
        conn.close()
        return [dict(r) for r in rows]
