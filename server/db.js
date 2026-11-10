// 视频生成系统 数据层（node:sqlite DatabaseSync）。
// 多租户模型（简化版）：主库统一存 用户/会话/登录日志/封禁/升级日志/设置/音色库/模型配置/生成任务。
// 生成任务带 user_id，管理员可跨用户浏览，普通用户只看到自己的。
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

// 数据目录：默认项目 data 目录，可用 DATA_DIR 覆盖。
const defaultDataDir = path.join(__dirname, '..', 'data');
const dataDir = process.env.DATA_DIR || defaultDataDir;
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbFile = process.env.DB_FILE || 'video.sqlite';
const dbPath = path.join(dataDir, dbFile);

function openDatabase(file) {
  const d = new DatabaseSync(file);
  d.exec('PRAGMA journal_mode = DELETE');
  d.exec('PRAGMA foreign_keys = ON');
  d.exec('PRAGMA busy_timeout = 5000');
  d.transaction = (fn) => (...args) => {
    d.exec('BEGIN');
    try {
      const r = fn(...args);
      d.exec('COMMIT');
      return r;
    } catch (e) {
      d.exec('ROLLBACK');
      throw e;
    }
  };
  return d;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  display_name TEXT NOT NULL DEFAULT '',
  quota INTEGER NOT NULL DEFAULT -1,
  allowed_pages TEXT NOT NULL DEFAULT '[]',
  allowed_tabs TEXT NOT NULL DEFAULT '{}',
  fail_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT NOT NULL DEFAULT '',
  lock_permanent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  success INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS ip_bans (
  ip TEXT PRIMARY KEY,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS upgrade_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS tts_voices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'upload',
  file_path TEXT NOT NULL DEFAULT '',
  preset TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS model_configs (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  grp TEXT NOT NULL DEFAULT 'i2v'
);

CREATE TABLE IF NOT EXISTS gen_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  negative_prompt TEXT NOT NULL DEFAULT '',
  image_path TEXT NOT NULL DEFAULT '',
  video_path TEXT NOT NULL DEFAULT '',
  audio_path TEXT NOT NULL DEFAULT '',
  dub_text TEXT NOT NULL DEFAULT '',
  params TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS img_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  negative_prompt TEXT NOT NULL DEFAULT '',
  image_path TEXT NOT NULL DEFAULT '',
  workflow TEXT NOT NULL DEFAULT '',
  params TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT NOT NULL DEFAULT '',
  progress TEXT NOT NULL DEFAULT '',
  progress_pct INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS h3_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  image_path TEXT NOT NULL DEFAULT '',
  video_path TEXT NOT NULL DEFAULT '',
  workflow TEXT NOT NULL DEFAULT '',
  params TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT NOT NULL DEFAULT '',
  progress TEXT NOT NULL DEFAULT '',
  progress_pct INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS ha_event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'hook',
  title TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS edit_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  spec TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT NOT NULL DEFAULT '',
  progress TEXT NOT NULL DEFAULT '',
  progress_pct INTEGER NOT NULL DEFAULT 0,
  output_path TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS tts_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  voice_id INTEGER NOT NULL DEFAULT 0,
  voice_name TEXT NOT NULL DEFAULT '',
  file_path TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS invite_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  used_by INTEGER DEFAULT NULL,
  used_username TEXT NOT NULL DEFAULT '',
  used_at TEXT DEFAULT NULL
);
`;

function initSchema(d) {
  d.exec(SCHEMA);
  // 列迁移（旧库补新列；已存在则忽略）
  const cols = d.prepare('PRAGMA table_info(gen_jobs)').all().map((c) => c.name);
  const add = (name, def) => { if (!cols.includes(name)) d.exec(`ALTER TABLE gen_jobs ADD COLUMN ${name} ${def}`); };
  add('end_image_path', "TEXT NOT NULL DEFAULT ''");
  add('progress', "TEXT NOT NULL DEFAULT ''");
  add('progress_pct', "INTEGER NOT NULL DEFAULT 0");
  add('mode', "TEXT NOT NULL DEFAULT 'single'");
  add('duration_ms', "INTEGER NOT NULL DEFAULT 0");
  // model_configs 分组列（i2v/zimage/h3 三个 tab 拆分）+ 拉取地址（v1.0.11 模型拉取）
  const mcols = d.prepare('PRAGMA table_info(model_configs)').all().map((c) => c.name);
  if (!mcols.includes('grp')) d.exec(`ALTER TABLE model_configs ADD COLUMN grp TEXT NOT NULL DEFAULT 'i2v'`);
  if (!mcols.includes('remote_url')) d.exec(`ALTER TABLE model_configs ADD COLUMN remote_url TEXT NOT NULL DEFAULT ''`);
  // 三张任务表的算力端登记（v1.0.13 重启收养）：prompt_id + comfy_base 在 POST /prompt
  // 成功后立即落库——应用重启时凭这两个字段把已提交算力端的任务「收养」回来继续跟踪/取回产物，
  // 不再无脑置失败（2026-11-06 报障：任务行没了但 GPU 还在算，产物成孤儿）。
  for (const t of ['gen_jobs', 'img_jobs', 'h3_jobs']) {
    const tc = d.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    if (!tc.includes('prompt_id')) d.exec(`ALTER TABLE ${t} ADD COLUMN prompt_id TEXT NOT NULL DEFAULT ''`);
    if (!tc.includes('comfy_base')) d.exec(`ALTER TABLE ${t} ADD COLUMN comfy_base TEXT NOT NULL DEFAULT ''`);
    // v1.0.14 第14条：gen_jobs 补工作流列（img/h3 建表自带）——提交成功即写入，队列里随时可下载还原
    if (t === 'gen_jobs' && !tc.includes('workflow')) d.exec(`ALTER TABLE gen_jobs ADD COLUMN workflow TEXT NOT NULL DEFAULT ''`);
  }
  // login_logs 尝试密码列（失败尝试明文留存，供管理员在登录日志里核查暴力破解）
  const lcols = d.prepare('PRAGMA table_info(login_logs)').all().map((c) => c.name);
  if (!lcols.includes('password')) d.exec(`ALTER TABLE login_logs ADD COLUMN password TEXT NOT NULL DEFAULT ''`);
  // img_jobs PSD 分层图列（广告图/QIL 文生分层图，v1.0.23）：psd_path 存可下载的 .psd 路径
  const icols = d.prepare('PRAGMA table_info(img_jobs)').all().map((c) => c.name);
  if (!icols.includes('psd_path')) d.exec(`ALTER TABLE img_jobs ADD COLUMN psd_path TEXT NOT NULL DEFAULT ''`);
  // img_jobs 任务来源列（v1.0.33）：文生图/广告图共用此表，靠 source 区分、页面各看各的队列。
  // 存量回填：params 带 layered:true 的是广告图分层任务；早期广告图未勾分层的无法辨认，归文生图。
  if (!icols.includes('source')) {
    d.exec(`ALTER TABLE img_jobs ADD COLUMN source TEXT NOT NULL DEFAULT 'zimage'`);
    try { d.exec(`UPDATE img_jobs SET source='ad' WHERE params LIKE '%"layered":true%'`); } catch (e) { /* 回填失败不影响启动 */ }
  }
}

const db = openDatabase(dbPath);
initSchema(db);

// ---------- 设置读写（与工作台同款双签名） ----------
function getSetting(a, b, c) {
  const d = typeof a === 'string' ? db : a;
  const key = typeof a === 'string' ? a : b;
  const def = typeof a === 'string' ? b : c;
  const row = d.prepare('SELECT value FROM settings WHERE key=?').get(key);
  if (!row) return def;
  try { return JSON.parse(row.value); } catch { return row.value; }
}
function setSetting(a, b, c) {
  const d = typeof a === 'string' ? db : a;
  const key = typeof a === 'string' ? a : b;
  const val = typeof a === 'string' ? b : c;
  d.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, JSON.stringify(val));
}

module.exports = {
  db, dbFile, dbPath, dataDir,
  openDatabase, initSchema,
  getSetting, setSetting,
};
