require('dotenv').config();
const path = require('path');

const BASE_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(BASE_DIR, 'data');
const RAW_DIR = path.join(DATA_DIR, 'raw');
const EXPORT_DIR = path.join(DATA_DIR, 'export');
const DB_PATH = path.join(DATA_DIR, 'trends.db');

const defaults = {
  TRENDS_GEO: 'US',
  TRENDS_TIMEFRAME: 'now 7-d',
  TRENDS_CATEGORIES: { Business: 7, Technology: 5, Health: 8 },
  TRENDS_MAX_KEYWORDS: 100,
  AI_MODEL: 'glm-5.2',
  AI_MAX_TOKENS: 500,
  AI_TEMPERATURE: 0.3,
  AI_API_BASE: 'https://open.bigmodel.cn/api/paas/v4/',
  FETCH_HOUR: 9,
  FETCH_MINUTE: 0,
  REPORT_TOP_N: 20,
  HOST: '0.0.0.0',
  PORT: parseInt(process.env.PORT || '8000', 10),
  PROXY: '',
};

function getSetting(db, key, fallback) {
  try {
    if (db) {
      const row = db.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
      if (row) return row.value;
    }
  } catch (_) {}
  return process.env[key.toUpperCase()] || fallback;
}

function getAiApiKey(db) {
  return getSetting(db, 'ai_api_key', '');
}

function getAiModel(db) {
  return getSetting(db, 'ai_model', defaults.AI_MODEL);
}

function getAiApiBase(db) {
  return getSetting(db, 'ai_api_base', defaults.AI_API_BASE);
}

function getFetchTime(db) {
  let hour = defaults.FETCH_HOUR;
  let minute = defaults.FETCH_MINUTE;
  if (db) {
    const h = db.getSetting('fetch_hour');
    const m = db.getSetting('fetch_minute');
    if (h) hour = parseInt(h, 10);
    if (m) minute = parseInt(m, 10);
  }
  return { hour, minute };
}

function getProxy(db) {
  return getSetting(db, 'proxy', defaults.PROXY);
}

module.exports = {
  BASE_DIR, DATA_DIR, RAW_DIR, EXPORT_DIR, DB_PATH, defaults,
  getAiApiKey, getAiModel, getAiApiBase, getFetchTime, getProxy
};
