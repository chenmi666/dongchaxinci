const express = require('express');
const path = require('path');
const fs = require('fs');
const { stringify } = require('csv-stringify/sync');
const config = require('../app/config');
const logger = require('../app/logger');
const DatabaseManager = require('../app/database');
const TrendsFetcher = require('../app/trends-fetcher');
const AIAnalyzer = require('../app/ai-analyzer');
const DailyReporter = require('../app/reporter');
const TrendScheduler = require('../app/scheduler');

// ─── Startup ────────────────────────────────────────────
let STARTUP_OK = false;
let db, fetcher, analyzer, reporter, scheduler;

try {
  logger.info('system', '正在初始化数据库...');
  db = new DatabaseManager();
  logger.info('system', `数据库已连接: ${db.dbPath}`);
  logger.init(db);
  STARTUP_OK = true;
} catch (e) {
  logger.error('system', `数据库初始化失败: ${e.message}`);
  logger.error('system', e.stack);
}

// ─── Express app ────────────────────────────────────────
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/static', express.static(path.join(__dirname, 'static')));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// request logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (req.path.startsWith('/api/')) {
      logger.debug('http', `${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
    }
  });
  next();
});

// ─── Helpers ────────────────────────────────────────────
function initModules() {
  if (!fetcher) fetcher = new TrendsFetcher();
  if (!analyzer) analyzer = new AIAnalyzer(db);
  if (!reporter) reporter = new DailyReporter(db, analyzer);
  if (!scheduler) {
    scheduler = new TrendScheduler(db, fetcher, analyzer, reporter);
    scheduler.start(false);
  }
}

// ─── Debug / Log ────────────────────────────────────────
app.get('/debug', (req, res) => {
  const status = STARTUP_OK ? 'OK' : 'FAILED';
  const lines = [`Status: ${status}`, `Log level: ${logger.getLevel()}`, ''];
  lines.push(...logger.buffer.slice(-50));
  lines.push('');
  if (!db) {
    lines.push('DB is null - startup failed');
  } else {
    try {
      const s = db.getStats();
      lines.push(`Stats: ${JSON.stringify(s)}`);
    } catch (e) {
      lines.push(`Stats error: ${e.message}`);
    }
  }
  res.type('text').send(lines.join('\n'));
});

app.get('/log', (req, res) => {
  const persisted = logger.getPersisted();
  const recent = logger.getRecent(200);
  const combined = persisted + '\n--- recent in-memory ---\n' + recent;
  res.type('text').send(combined || '(empty log)');
});

// ─── Log API ────────────────────────────────────────────
app.get('/api/logs', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 100;
  const level = req.query.level || '';
  const logs = logger.getRecent(limit, level);
  const lines = logs.split('\n').filter(Boolean).map(l => {
    const m = l.match(/^\[(.+?)\] \[(.+?)\] \[(.+?)\] (.+)$/);
    if (m) return { time: m[1], level: m[2], category: m[3], message: m[4] };
    return { time: '', level: '', category: '', message: l };
  });
  res.json({ logs, lines, level: logger.getLevel(), total: logger.buffer.length });
});

app.get('/api/logs/export', (req, res) => {
  const text = logger.getPersisted();
  const recent = logger.getRecent(500);
  const combined = text + '\n\n=== 内存日志 (最近500条) ===\n' + recent;
  const ts = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=app_log_${ts}.txt`);
  res.send(combined || '(empty)');
});

// ─── HTML Pages ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.render('dashboard', {
    now: new Date().toISOString().slice(0, 16).replace('T', ' '),
  });
});

app.get('/keyword/:id', (req, res) => {
  if (!db) return res.status(500).send('数据库未初始化');
  const kw = db.getKeywordById(parseInt(req.params.id, 10));
  if (!kw) return res.status(404).send('关键词不存在');
  res.render('keyword-detail', { kw });
});

app.get('/reports', (req, res) => {
  res.render('reports');
});

app.get('/report/:date', (req, res) => {
  if (!db) return res.status(500).send('数据库未初始化');
  const report = db.getReport(req.params.date);
  if (!report) return res.status(404).send('报告不存在');
  res.render('report-detail', { report });
});

app.get('/history', (req, res) => {
  res.render('history');
});

app.get('/settings', (req, res) => {
  if (!db) return res.status(500).send('数据库未初始化');
  res.render('settings', {
    api_key: config.getAiApiKey(db),
    model: config.getAiModel(db),
    api_base: config.getAiApiBase(db),
    fetch_hour: config.getFetchTime(db).hour,
    fetch_minute: config.getFetchTime(db).minute,
    proxy: config.getProxy(db),
    log_level: logger.getLevel(),
  });
});

// ─── /logs page ─────────────────────────────────────────
app.get('/logs', (req, res) => {
  res.render('logs', {
    level: logger.getLevel(),
  });
});

// ─── API ─────────────────────────────────────────────────
app.get('/api/dashboard', (req, res) => {
  if (!db) return res.json({ error: '数据库未初始化' });
  const top = db.getTopOpportunities(20, req.query.category || null);
  const stats = db.getStats();
  const rising = db.getTrendingUpKeywords(3, 10);
  const lastFetch = db.getLastFetchDate();
  const newKw = db.getNewKeywordsCount(1);
  res.json({ top_opportunities: top, stats, rising, last_fetch: lastFetch, new_keywords: newKw });
});

app.get('/api/keyword/:id', (req, res) => {
  if (!db) return res.status(500).json({ error: '数据库未初始化' });
  const kw = db.getKeywordById(parseInt(req.params.id, 10));
  if (!kw) return res.status(404).json({ error: 'not found' });
  const analysis = db.getLatestAnalysis(kw.id);
  const allAnalyses = db.getAllAnalyses(kw.id);
  const history = db.getTrendHistory(kw.id, 90);
  const bounds = db.getTrendBounds(kw.id);
  res.json({ keyword: kw, analysis, all_analyses: allAnalyses, history, bounds });
});

app.get('/api/keyword/:id/trend', (req, res) => {
  if (!db) return res.json({ error: '数据库未初始化' });
  const history = db.getTrendHistory(parseInt(req.params.id, 10), 90);
  res.json({ history });
});

app.get('/api/reports', (req, res) => {
  if (!db) return res.json({ reports: [] });
  res.json({ reports: db.getReports(30) });
});

app.get('/api/history', (req, res) => {
  if (!db) return res.json({ keywords: [] });
  const { category, status, search } = req.query;
  let keywords;
  if (search) {
    keywords = db.searchKeywords(search);
  } else if (status) {
    keywords = db.getKeywordsByStatus(status);
    if (category) keywords = keywords.filter(k => k.category_name === category);
  } else if (category) {
    keywords = db.getTopOpportunities(200, category);
  } else {
    const lt = db.getKeywordsByStatus('long_term');
    const ev = db.getKeywordsByStatus('event_driven');
    keywords = [...lt, ...ev].slice(0, 200);
  }
  res.json({ keywords });
});

app.get('/api/stats', (req, res) => {
  if (!db) return res.json({ error: '数据库未初始化', total_keywords: 0 });
  res.json(db.getStats());
});

app.get('/api/fetch-logs', (req, res) => {
  if (!db) return res.json({ logs: [] });
  res.json({ logs: db.getRecentFetchLogs(20) });
});

// ─── Settings API ───────────────────────────────────────
app.post('/api/settings', (req, res) => {
  if (!db) return res.json({ status: 'error', message: '数据库未初始化' });
  const { ai_api_key, ai_model, ai_api_base, fetch_hour, fetch_minute, proxy, log_level } = req.body;
  if (ai_api_key) db.setSetting('ai_api_key', ai_api_key);
  if (ai_model) db.setSetting('ai_model', ai_model);
  if (ai_api_base) db.setSetting('ai_api_base', ai_api_base);
  if (fetch_hour !== undefined) db.setSetting('fetch_hour', String(fetch_hour));
  if (fetch_minute !== undefined) db.setSetting('fetch_minute', String(fetch_minute));
  if (proxy !== undefined) db.setSetting('proxy', proxy);
  if (log_level && logger.setLevel(log_level)) {
    logger.info('settings', `日志级别切换为: ${log_level}`);
  }
  res.json({ status: 'ok' });
});

app.post('/api/settings/test', async (req, res) => {
  const { api_key, model, api_base } = req.body;
  try {
    const { default: OpenAI } = require('openai');
    const client = new OpenAI({ apiKey: api_key, baseURL: api_base });
    const resp = await client.chat.completions.create({
      model: model || 'glm-5.2',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 10,
    });
    logger.info('settings', 'AI连接测试成功');
    res.json({ status: 'ok', message: `成功: ${(resp.choices[0].message.content || '').slice(0, 30)}` });
  } catch (e) {
    logger.error('settings', `AI连接测试失败: ${e.message}`);
    res.json({ status: 'error', message: e.message });
  }
});

// ─── Export CSV ─────────────────────────────────────────
app.get('/api/export/csv', (req, res) => {
  if (!db) return res.status(500).send('数据库未初始化');
  const top = db.getTopOpportunities(200);
  const records = top.map(item => ({
    keyword: item.keyword,
    category: item.category_name,
    opportunity_score: item.opportunity_score,
    is_event_driven: item.is_event_driven ? '事件型' : '长期需求',
    reasoning: item.reasoning || '',
    first_seen: item.first_seen || '',
    last_seen: item.last_seen || '',
    peak_score: item.peak_score || 0,
    status: item.status || '',
  }));
  const csv = '\ufeff' + stringify(records, { header: true });
  const today = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=opportunities_${today}.csv`);
  res.send(csv);
});

// ─── Manual Trigger ────────────────────────────────────
app.post('/api/trigger-fetch', async (req, res) => {
  if (!db) return res.json({ status: 'error', message: '数据库未初始化' });
  initModules();
  try {
    await scheduler.dailyJob();
    res.json({ status: 'ok', message: '同步完成' });
  } catch (e) {
    logger.error('trigger', `手动同步失败: ${e.message}`);
    res.json({ status: 'error', message: e.message });
  }
});

// ─── Start ──────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || String(config.defaults.PORT), 10);

app.listen(PORT, config.defaults.HOST, () => {
  logger.info('system', '='.repeat(50));
  logger.info('system', '  Trend Opportunity Radar v2.1.0 (Node.js)');
  logger.info('system', '  Node.js + SQLite + AI');
  logger.info('system', '='.repeat(50));
  logger.info('system', `  数据库: ${db ? db.dbPath : 'N/A'}`);
  logger.info('system', `  地址:   ${config.defaults.HOST}:${PORT}`);
  logger.info('system', `  日志级别: ${logger.getLevel().toUpperCase()}`);

  const hasKey = !!config.getAiApiKey(db);
  if (hasKey) {
    logger.info('system', `  AI:     [OK] ${config.getAiModel(db)}`);
  } else {
    logger.warn('system', `  AI:     [!!] 请在 /settings 页面配置 API Key`);
  }

  const { hour, minute } = config.getFetchTime(db);
  logger.info('system', `  定时:   每日 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
  logger.info('system', '='.repeat(50));

  initModules();
});

process.on('SIGINT', () => {
  logger.info('system', '\n正在关闭...');
  if (scheduler) scheduler.stop();
  logger.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  if (scheduler) scheduler.stop();
  logger.close();
  process.exit(0);
});

module.exports = app;
