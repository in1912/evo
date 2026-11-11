// 认证与授权：scrypt 口令哈希、7 天会话、页面/路径映射、管理员初始化。
const crypto = require('crypto');
const { db, getSetting, setSetting } = require('./db');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ---------- 口令哈希 ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- 会话 ----------
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare('INSERT INTO sessions(token, user_id, expires_at) VALUES(?,?,?)').run(token, userId, expiresAt);
  return { token, expiresAt };
}
function resolveUser(token) {
  if (!token) return null;
  const row = db.prepare(
    'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?'
  ).get(token, new Date().toISOString());
  if (!row) return null;
  return sanitize(row);
}
function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(token);
}
function cleanupSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
}

// ---------- 用户对象脱敏 ----------
function sanitize(row) {
  if (!row) return null;
  const out = { ...row };
  delete out.password_hash;
  try { out.allowed_pages = JSON.parse(out.allowed_pages || '[]'); } catch { out.allowed_pages = []; }
  try { out.allowed_tabs = JSON.parse(out.allowed_tabs || '{}'); } catch { out.allowed_tabs = {}; }
  return out;
}

// ---------- 页面与路径 ----------
const PAGES = ['generate', 'zimage', 'h3', 'history', 'user-history', 'models', 'voice', 'edit', 'settings', 'ha', 'tasks'];

// 页面显示名（前端「用户管理 → 授权页」按此渲染全部页，逐页勾选）
const PAGE_LABELS = {
  generate: '首尾视频', zimage: '文生图', h3: '生视频H3', history: '我的历史',
  'user-history': '用户历史', models: '模型配置', voice: '语音配音', edit: '视频剪辑',
  settings: '设置', ha: '远程开机', tasks: '任务中心',
};

// 新用户默认开放页（老模型里的「默认开放」集合），注册/新建用户时写入 allowed_pages
// v1.0.13 补 tasks：任务中心本来就是「看自己任务」的页面，普通用户默认就该有
// v1.0.19 补 edit：视频剪辑的素材就是本人的历史生成物，与「我的历史」同级开放
const DEFAULT_OPEN_PAGES = ['generate', 'zimage', 'h3', 'history', 'voice', 'edit', 'tasks'];

// 后端路由（挂 /api，req.path 不带 /api）→ 页面；null = 自身会话端点（登录即可，不做页级拦截）
function pageForPath(p) {
  if (p.startsWith('/auth')) return null;
  if (p.startsWith('/settings/theme')) return null;
  if (p.startsWith('/generate')) return 'generate';
  if (p.startsWith('/image')) return 'zimage';
  if (p.startsWith('/h3')) return 'h3';
  if (p.startsWith('/history')) return 'history';
  if (p.startsWith('/user-history')) return 'user-history';
  if (p.startsWith('/models')) return 'models';
  if (p.startsWith('/tts')) return 'voice';
  if (p.startsWith('/edit')) return 'edit';
  if (p.startsWith('/ai')) return 'settings';
  if (p.startsWith('/ha')) return 'ha';
  if (p.startsWith('/tasks')) return 'tasks';
  if (p.startsWith('/users') || p.startsWith('/ssl') || p.startsWith('/upgrade') || p.startsWith('/ip-bans')) return 'settings';
  return null;
}

// 管理员全开；普通用户按 allowed_pages 逐页授权（v2 模型：allowed_pages 即完整可访问页集合）。
function canAccess(user, page) {
  if (!page) return true;
  if (user.role === 'admin') return true;
  return (user.allowed_pages || []).includes(page);
}

// 一次性迁移：老模型里普通用户 allowed_pages 只存「额外授权页」（默认开放页走硬编码）。
// 这里把默认开放页并入 allowed_pages，使其成为「完整可访问页集合」，之后逐页可撤/可授。
function migratePageModel() {
  if (getSetting('pages_model_v2')) return;
  const users = db.prepare("SELECT id, allowed_pages FROM users WHERE role != 'admin'").all();
  const upd = db.prepare('UPDATE users SET allowed_pages=? WHERE id=?');
  for (const u of users) {
    let pages = [];
    try { pages = JSON.parse(u.allowed_pages || '[]'); } catch { pages = []; }
    if (!Array.isArray(pages)) pages = [];
    const merged = [...new Set([...DEFAULT_OPEN_PAGES, ...pages])];
    upd.run(JSON.stringify(merged), u.id);
  }
  setSetting('pages_model_v2', 1);
}

// v1.0.13 增量迁移：老用户补「任务中心」页（只加不减——已是完整集合模型，缺 tasks 的补上）
function migratePagesV3() {
  if (getSetting('pages_model_v3')) return;
  const users = db.prepare("SELECT id, allowed_pages FROM users WHERE role != 'admin'").all();
  const upd = db.prepare('UPDATE users SET allowed_pages=? WHERE id=?');
  for (const u of users) {
    let pages = [];
    try { pages = JSON.parse(u.allowed_pages || '[]'); } catch { pages = []; }
    if (!Array.isArray(pages)) pages = [];
    if (!pages.includes('tasks')) upd.run(JSON.stringify([...pages, 'tasks']), u.id);
  }
  setSetting('pages_model_v3', 1);
}

// v1.0.19 增量迁移：老用户补「视频剪辑」页（同 v3 逻辑：素材即本人历史，默认开放）
function migratePagesV4() {
  if (getSetting('pages_model_v4')) return;
  const users = db.prepare("SELECT id, allowed_pages FROM users WHERE role != 'admin'").all();
  const upd = db.prepare('UPDATE users SET allowed_pages=? WHERE id=?');
  for (const u of users) {
    let pages = [];
    try { pages = JSON.parse(u.allowed_pages || '[]'); } catch { pages = []; }
    if (!Array.isArray(pages)) pages = [];
    if (!pages.includes('edit')) upd.run(JSON.stringify([...pages, 'edit']), u.id);
  }
  setSetting('pages_model_v4', 1);
}

// 默认管理员（可用环境变量覆盖）
const DEFAULT_ADMIN = process.env.DEFAULT_ADMIN || 'videoadmin';
const DEFAULT_ADMIN_PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD || 'admin123';

function initAdmin() {
  migratePageModel();
  migratePagesV3();
  migratePagesV4();
  const existing = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
  if (existing) return;
  const username = String(DEFAULT_ADMIN).trim() || 'videoadmin';
  const password = String(DEFAULT_ADMIN_PASSWORD || 'admin123');
  db.prepare('INSERT INTO users(username, password_hash, role, display_name, quota) VALUES(?,?,?,?,?)')
    .run(username, hashPassword(password), 'admin', '管理员', -1);
  console.log(`[auth] 已创建默认管理员：${username}`);
}

module.exports = {
  hashPassword, verifyPassword,
  createSession, resolveUser, destroySession, cleanupSessions,
  sanitize, PAGES, PAGE_LABELS, DEFAULT_OPEN_PAGES, pageForPath, canAccess, initAdmin, migratePagesV4,
  DEFAULT_ADMIN, DEFAULT_ADMIN_PASSWORD,
};
