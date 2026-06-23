const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('./config');

class DatabaseManager {
  constructor(dbPath) {
    this.dbPath = dbPath || config.DB_PATH;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode=WAL');
    this.db.pragma('foreign_keys=ON');
    this._initTables();
  }

  _initTables() {
    this.db.exec(`
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
    `);

    const insertCat = this.db.prepare(
      'INSERT OR IGNORE INTO categories(name, pytrends_id) VALUES (?, ?)'
    );
    insertCat.run('Business', 3);
    insertCat.run('Technology', 18);
    insertCat.run('Health', 7);

    // v2.1.0: add search_volume column to trends_daily (safe if already exists)
    try { this.db.exec('ALTER TABLE trends_daily ADD COLUMN search_volume TEXT DEFAULT \'\''); } catch (_) {}
  }

  close() {
    this.db.close();
  }

  // ---- settings ----
  getSetting(key) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? row.value : null;
  }

  setSetting(key, value) {
    this.db.prepare(
      'INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)'
    ).run(key, value);
  }

  // ---- keywords ----
  upsertKeyword(keyword, categoryId, todayStr) {
    if (!todayStr) todayStr = new Date().toISOString().slice(0, 10);
    let row = this.db.prepare(
      'SELECT id, peak_score, first_seen FROM keywords WHERE keyword=? COLLATE NOCASE'
    ).get(keyword);

    let kwId, firstSeen, peakScore;
    if (row) {
      kwId = row.id;
      peakScore = row.peak_score;
      firstSeen = row.first_seen;
      this.db.prepare('UPDATE keywords SET last_seen=? WHERE id=?').run(todayStr, kwId);
    } else {
      this.db.prepare(
        'INSERT INTO keywords(keyword, category_id, first_seen, last_seen) VALUES (?, ?, ?, ?)'
      ).run(keyword, categoryId, todayStr, todayStr);
      kwId = this.db.prepare('SELECT last_insert_rowid() as id').get().id;
      firstSeen = todayStr;
      peakScore = 0;
    }
    return { kwId, firstSeen };
  }

  updateKeywordPeak(kwId, score) {
    this.db.prepare(
      'UPDATE keywords SET peak_score = MAX(peak_score, ?) WHERE id=?'
    ).run(score, kwId);
  }

  updateKeywordStatus(kwId, status) {
    this.db.prepare('UPDATE keywords SET status=? WHERE id=?').run(status, kwId);
  }

  getKeyword(keyword) {
    return this.db.prepare(
      `SELECT k.*, c.name as category_name FROM keywords k
       JOIN categories c ON c.id = k.category_id
       WHERE k.keyword=? COLLATE NOCASE`
    ).get(keyword);
  }

  getKeywordById(kwId) {
    return this.db.prepare(
      `SELECT k.*, c.name as category_name FROM keywords k
       JOIN categories c ON c.id = k.category_id WHERE k.id=?`
    ).get(kwId);
  }

  getKeywordsNeedingAnalysis() {
    const today = new Date().toISOString().slice(0, 10);
    return this.db.prepare(`
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
    `).all(today);
  }

  getTotalKeywords() {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM keywords').get();
    return row.cnt;
  }

  getActiveKeywords(days) {
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    return this.db.prepare(
      `SELECT k.*, c.name as category_name FROM keywords k
       JOIN categories c ON c.id = k.category_id
       WHERE k.last_seen >= ? ORDER BY k.last_seen DESC`
    ).all(since);
  }

  // ---- trends_daily ----
  upsertTrend(keywordId, dateStr, score, rank, searchVolume) {
    this.db.prepare(
      `INSERT OR REPLACE INTO trends_daily(keyword_id, date, interest_score, rank, search_volume)
       VALUES (?, ?, ?, ?, ?)`
    ).run(keywordId, dateStr, score, rank || null, searchVolume || '');
  }

  getTrendHistory(keywordId, days) {
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    return this.db.prepare(
      'SELECT date, interest_score, search_volume FROM trends_daily WHERE keyword_id=? AND date >= ? ORDER BY date'
    ).all(keywordId, since);
  }

  getTrendBounds(keywordId) {
    return this.db.prepare(
      `SELECT MIN(date) as min_date, MAX(date) as max_date,
              MIN(interest_score) as min_score, MAX(interest_score) as max_score
       FROM trends_daily WHERE keyword_id=?`
    ).get(keywordId);
  }

  getTrendingUpKeywords(minDays, limit) {
    const today = new Date().toISOString().slice(0, 10);
    const threeDaysAgo = new Date(Date.now() - (minDays || 3) * 86400000).toISOString().slice(0, 10);
    return this.db.prepare(`
      SELECT k.*, c.name as category_name,
             COALESCE(a.opportunity_score, 0) as opportunity_score,
             COALESCE(a.is_event_driven, 1) as is_event_driven,
              td1.interest_score as score_today,
              td1.search_volume
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
    `).all(today, threeDaysAgo, limit || 20);
  }

  cleanupOldTrends(days) {
    const cutoff = new Date(Date.now() - (days || 90) * 86400000).toISOString().slice(0, 10);
    const result = this.db.prepare('DELETE FROM trends_daily WHERE date < ?').run(cutoff);
    return result.changes;
  }

  cleanupOldLogs(retainDays) {
    const cutoff = new Date(Date.now() - retainDays * 86400000).toISOString();
    const result = this.db.prepare("DELETE FROM fetch_logs WHERE created_at < ?").run(cutoff);
    return result.changes;
  }

  // ---- ai_analyses ----
  saveAnalysis(keywordId, isEventDriven, score, reasoning, relookDays) {
    const today = new Date().toISOString().slice(0, 10);
    this.db.prepare(
      `INSERT INTO ai_analyses(keyword_id, analyzed_date, is_event_driven,
        opportunity_score, reasoning, relook_days)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(keywordId, today, isEventDriven ? 1 : 0, score, reasoning || '', relookDays || 7);
    const status = isEventDriven ? 'event_driven' : 'long_term';
    this.db.prepare('UPDATE keywords SET status=? WHERE id=?').run(status, keywordId);
  }

  getLatestAnalysis(keywordId) {
    return this.db.prepare(
      'SELECT * FROM ai_analyses WHERE keyword_id=? ORDER BY analyzed_date DESC LIMIT 1'
    ).get(keywordId);
  }

  getAllAnalyses(keywordId) {
    return this.db.prepare(
      'SELECT * FROM ai_analyses WHERE keyword_id=? ORDER BY analyzed_date DESC LIMIT 20'
    ).all(keywordId);
  }

  getTopOpportunities(limit, category) {
    const today = new Date().toISOString().slice(0, 10);
    let sql = `
      SELECT k.*, c.name as category_name,
             a.opportunity_score, a.is_event_driven, a.reasoning, a.analyzed_date
      FROM keywords k
      JOIN categories c ON c.id = k.category_id
      JOIN (
          SELECT keyword_id, opportunity_score, is_event_driven, reasoning, analyzed_date,
                 ROW_NUMBER() OVER (PARTITION BY keyword_id ORDER BY analyzed_date DESC) AS rn
          FROM ai_analyses
      ) a ON a.keyword_id = k.id AND a.rn = 1
      WHERE a.is_event_driven = 0
    `;
    const params = [];
    if (category) {
      sql += ' AND c.name = ?';
      params.push(category);
    }
    sql += ' ORDER BY a.opportunity_score DESC LIMIT ?';
    params.push(limit || 20);
    return this.db.prepare(sql).all(...params);
  }

  // ---- daily_reports ----
  saveReport(dateStr, totalKw, newKw, longTermCnt, eventCnt, topOpportunities, summaryMd) {
    this.db.prepare(
      `INSERT OR REPLACE INTO daily_reports
       (report_date, total_keywords, new_keywords, long_term_cnt, event_cnt,
        top_opportunities, summary_md)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(dateStr, totalKw, newKw, longTermCnt, eventCnt,
          JSON.stringify(topOpportunities), summaryMd || '');
  }

  getReports(limit) {
    return this.db.prepare(
      'SELECT * FROM daily_reports ORDER BY report_date DESC LIMIT ?'
    ).all(limit || 30);
  }

  getReport(dateStr) {
    const row = this.db.prepare(
      'SELECT * FROM daily_reports WHERE report_date=?'
    ).get(dateStr);
    if (row) {
      if (row.top_opportunities) {
        row.top_opportunities = JSON.parse(row.top_opportunities);
      }
    }
    return row;
  }

  // ---- fetch_logs ----
  logFetch(fetchDate, category, count, status, error, duration) {
    this.db.prepare(
      `INSERT INTO fetch_logs(fetch_date, category, keywords_count, status, error_msg, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(fetchDate, category, count || 0, status || 'success', error || null, duration || null);
  }

  getRecentFetchLogs(limit) {
    return this.db.prepare(
      'SELECT * FROM fetch_logs ORDER BY created_at DESC LIMIT ?'
    ).all(limit || 20);
  }

  getLastFetchDate() {
    const row = this.db.prepare(
      'SELECT fetch_date FROM fetch_logs ORDER BY created_at DESC LIMIT 1'
    ).get();
    return row ? row.fetch_date : null;
  }

  // ---- stats ----
  getStats() {
    return {
      total_keywords: this.db.prepare('SELECT COUNT(*) as c FROM keywords').get().c,
      long_term: this.db.prepare("SELECT COUNT(*) as c FROM keywords WHERE status='long_term'").get().c,
      event_driven: this.db.prepare("SELECT COUNT(*) as c FROM keywords WHERE status='event_driven'").get().c,
      pending: this.db.prepare("SELECT COUNT(*) as c FROM keywords WHERE status='pending'").get().c,
      total_analyses: this.db.prepare('SELECT COUNT(*) as c FROM ai_analyses').get().c,
      total_reports: this.db.prepare('SELECT COUNT(*) as c FROM daily_reports').get().c,
      total_trends: this.db.prepare('SELECT COUNT(*) as c FROM trends_daily').get().c,
      last_fetch: this.getLastFetchDate(),
    };
  }

  getNewKeywordsCount(days) {
    const since = new Date(Date.now() - (days || 1) * 86400000).toISOString().slice(0, 10);
    return this.db.prepare(
      'SELECT COUNT(*) as c FROM keywords WHERE first_seen >= ?'
    ).get(since).c;
  }

  getKeywordsByStatus(status) {
    return this.db.prepare(
      `SELECT k.*, c.name as category_name FROM keywords k
       JOIN categories c ON c.id = k.category_id WHERE k.status=?
       ORDER BY k.last_seen DESC LIMIT 200`
    ).all(status);
  }

  searchKeywords(query, limit) {
    return this.db.prepare(
      `SELECT k.*, c.name as category_name FROM keywords k
       JOIN categories c ON c.id = k.category_id
       WHERE k.keyword LIKE ? ORDER BY k.last_seen DESC LIMIT ?`
    ).all(`%${query}%`, limit || 50);
  }
}

module.exports = DatabaseManager;
