const fs = require('fs');
const path = require('path');
const config = require('./config');

const LEVELS = { off: 0, error: 1, warn: 2, info: 3, debug: 4 };
const LEVEL_NAMES = { 0: 'OFF', 1: 'ERROR', 2: 'WARN', 3: 'INFO', 4: 'DEBUG' };

class Logger {
  constructor() {
    this.buffer = [];
    this.maxBuffer = 500;
    this._level = 3;
    this._file = null;
    this._fileStream = null;
    this._db = null;
  }

  /** Call once after DB is ready to read persisted log_level + setup file */
  init(db) {
    this._db = db;
    if (db) {
      const saved = db.getSetting('log_level');
      if (saved && LEVELS[saved] !== undefined) this._level = LEVELS[saved];
    }
    const logDir = path.dirname(config.DATA_DIR);
    const logPath = path.join(config.DATA_DIR, 'app.log');
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      this._file = logPath;
    } catch (_) {}
    this._reopen();
  }

  /** Change log level at runtime (persists to DB) */
  setLevel(level) {
    if (LEVELS[level] === undefined) return false;
    this._level = LEVELS[level];
    if (this._db) this._db.setSetting('log_level', level);
    this.info('logger', `日志级别已切换为 ${level.toUpperCase()}`);
    return true;
  }

  getLevel() {
    for (const [name, val] of Object.entries(LEVELS)) {
      if (val === this._level) return name;
    }
    return 'info';
  }

  _reopen() {
    try {
      if (this._fileStream) this._fileStream.end();
      this._fileStream = fs.createWriteStream(this._file, { flags: 'a', encoding: 'utf-8' });
    } catch (_) {}
  }

  _write(levelNum, category, message) {
    if (levelNum > this._level) return;
    const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const label = LEVEL_NAMES[levelNum] || '?';
    const line = `[${ts}] [${label}] [${category}] ${message}`;

    // memory buffer
    this.buffer.push(line);
    if (this.buffer.length > this.maxBuffer) this.buffer.shift();

    // console
    const fn = levelNum <= 1 ? console.error : levelNum === 2 ? console.warn : console.log;
    fn(line);

    // file
    try {
      if (this._fileStream) this._fileStream.write(line + '\n');
    } catch (_) {}
  }

  debug(cat, msg) { this._write(4, cat, msg); }
  info(cat, msg) { this._write(3, cat, msg); }
  warn(cat, msg) { this._write(2, cat, msg); }
  error(cat, msg) { this._write(1, cat, msg); }

  /** Return recent logs, optionally filtered by level */
  getRecent(limit, minLevel) {
    let logs = this.buffer;
    if (minLevel !== undefined) {
      const min = LEVELS[minLevel] || 0;
      logs = logs.filter(l => {
        const m = l.match(/\[(ERROR|WARN|INFO|DEBUG)\]/);
        return m && (LEVELS[m[1].toLowerCase()] || 0) >= min;
      });
    }
    return logs.slice(-(limit || 100)).join('\n');
  }

  /** Return all persisted logs from file */
  getPersisted() {
    try {
      if (this._file && fs.existsSync(this._file)) {
        return fs.readFileSync(this._file, 'utf-8');
      }
    } catch (_) {}
    return '';
  }

  close() {
    if (this._fileStream) this._fileStream.end();
  }
}

module.exports = new Logger();
