// 认证 / 用户 / 登录日志 / 封禁 路由（多租户：注册、新建、授权、解锁、生成次数额度）。
const express = require('express');
const { db, getSetting, setSetting } = require('../db');
const auth = require('../auth');
const ipBan = require('../services/ipBanService');

const router = express.Router();

// 登录锁定配置（按 IP 计数，2026-11-06 用户定版）：
// 同一 IP 15 分钟内密码错误 5 次 → 锁定该账号（管理员解锁）；10 次 → 封禁该 IP（回环地址除外）。
const LOCK_CFG = { userFails: 5, ipFails: 10, windowMin: 15 };

// 同 IP 近窗口内的密码失败次数（含刚写入的本次；用户不存在/锁定账号后的继续尝试都算暴力尝试）
const ERR_REASONS = "('密码错误','用户不存在','账号已永久锁定','账号临时锁定中')";
function ipErrCount(ip) {
  try {
    return db.prepare(
      `SELECT COUNT(*) c FROM login_logs WHERE ip=? AND success=0
       AND reason IN ${ERR_REASONS}
       AND datetime(created_at) >= datetime('now','localtime','-${LOCK_CFG.windowMin} minutes')`
    ).get(ip).c;
  } catch { return 0; }
}

function writeLoginLog(username, ip, success, reason, attemptedPassword) {
  try {
    db.prepare('INSERT INTO login_logs(username, ip, success, reason, password) VALUES(?,?,?,?,?)')
      .run(String(username || '').slice(0, 64), ip, success ? 1 : 0, String(reason || '').slice(0, 200),
        success ? '' : String(attemptedPassword || '').slice(0, 128));
  } catch { /* 日志写失败不影响登录 */ }
}

function autoBanIp(ip, username) {
  try {
    ipBan.ban(ip, `自动封禁：同 IP ${LOCK_CFG.ipFails} 次密码错误（涉及账号「${username}」）`, 'system');
    return true;
  } catch { return false; /* 回环地址不可封 */ }
}

function publicUser(u) {
  const o = auth.sanitize(u);
  if (!o) return null;
  const used = db.prepare('SELECT COUNT(*) c FROM gen_jobs WHERE user_id=?').get(o.id).c
    + db.prepare('SELECT COUNT(*) c FROM img_jobs WHERE user_id=?').get(o.id).c
    + db.prepare('SELECT COUNT(*) c FROM h3_jobs WHERE user_id=?').get(o.id).c;
  return { ...o, used };
}

// ---------- 登录 ----------
router.post('/auth/login', (req, res) => {
  const ip = ipBan.clientIp(req);
  if (ipBan.isBanned(ip)) return res.status(403).json({ error: '该 IP 已被封禁' });
  const { username, password } = req.body || {};
  const uname = String(username || '').trim();
  if (!uname || !password) {
    writeLoginLog(uname, ip, false, '用户名或密码为空');
    return res.status(400).json({ error: '请输入用户名和密码' });
  }
  const row = db.prepare('SELECT * FROM users WHERE username=?').get(uname);
  if (!row) {
    writeLoginLog(uname, ip, false, '用户不存在', password);
    const cnt = ipErrCount(ip);
    if (cnt >= LOCK_CFG.ipFails) {
      autoBanIp(ip, uname);
      return res.status(403).json({ error: '密码尝试次数过多，该 IP 已被封禁' });
    }
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const now = Date.now();
  if (row.lock_permanent || (row.locked_until && new Date(row.locked_until).getTime() > now)) {
    const perm = !!row.lock_permanent;
    writeLoginLog(uname, ip, false, perm ? '账号已永久锁定' : '账号临时锁定中', password);
    const cnt = ipErrCount(ip);
    const banned = cnt >= LOCK_CFG.ipFails ? autoBanIp(ip, uname) : false;
    if (banned) return res.status(403).json({ error: '密码尝试次数过多，该 IP 已被封禁' });
    return perm ? res.status(403).json({ error: '账号已被永久锁定，请联系管理员解锁' })
      : res.status(423).json({ error: '账号暂时锁定，请稍后再试' });
  }
  if (!auth.verifyPassword(password, row.password_hash)) {
    writeLoginLog(uname, ip, false, '密码错误', password);
    const cnt = ipErrCount(ip);
    if (cnt >= LOCK_CFG.ipFails) {
      db.prepare('UPDATE users SET fail_count=fail_count+1, lock_permanent=1 WHERE id=?').run(row.id);
      const banned = autoBanIp(ip, uname);
      writeLoginLog(uname, ip, false, `密码错误，同 IP ${cnt} 次触发账号锁定${banned ? '并封禁 IP' : '（IP 为回环地址不封禁）'}`);
      return res.status(403).json({ error: banned ? '密码尝试次数过多，该 IP 已被封禁' : '密码错误次数过多，账号已禁止登录，请联系管理员解锁' });
    }
    if (cnt >= LOCK_CFG.userFails) {
      db.prepare('UPDATE users SET fail_count=fail_count+1, lock_permanent=1 WHERE id=?').run(row.id);
      writeLoginLog(uname, ip, false, `密码错误，同 IP ${cnt} 次触发账号锁定`);
      return res.status(403).json({ error: '密码错误次数过多（同 IP ' + cnt + ' 次），该账号已被禁止登录，请联系管理员解锁' });
    }
    db.prepare('UPDATE users SET fail_count=fail_count+1 WHERE id=?').run(row.id);
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  // 成功
  db.prepare('UPDATE users SET fail_count=0, locked_until=\'\' WHERE id=?').run(row.id);
  const session = auth.createSession(row.id);
  writeLoginLog(uname, ip, true, '登录成功');
  res.json({ token: session.token, user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(row.id)) });
});

// ---------- 当前用户 ----------
router.get('/auth/me', (req, res) => {
  res.json({ user: req.user });
});

// ---------- 登出 ----------
router.post('/auth/logout', (req, res) => {
  auth.destroySession(req.token);
  res.json({ ok: true });
});

// ---------- 修改密码 ----------
router.post('/auth/password', (req, res) => {
  const { old: oldP, next } = req.body || {};
  if (!auth.verifyPassword(String(oldP || ''), req.user.password_hash)) {
    return res.status(400).json({ error: '原密码错误' });
  }
  const np = String(next || '');
  if (np.length < 4) return res.status(400).json({ error: '新密码至少 4 位' });
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(auth.hashPassword(np), req.user.id);
  res.json({ ok: true });
});

// ---------- 注册（多租户用户自助注册；2026-11-06 起须持未使用的邀请码） ----------
router.post('/auth/register', (req, res) => {
  const { username, password, display_name, invite_code } = req.body || {};
  const uname = String(username || '').trim();
  if (!/^[a-zA-Z0-9_\-.]{2,32}$/.test(uname)) return res.status(400).json({ error: '用户名须为 2-32 位字母数字' });
  if (String(password || '').length < 4) return res.status(400).json({ error: '密码至少 4 位' });
  const code = String(invite_code || '').trim().toUpperCase();
  if (!code) return res.status(403).json({ error: '注册需要邀请码：请联系管理员在「设置 → 邀请码」生成' });
  const inv = db.prepare('SELECT * FROM invite_codes WHERE code=? AND used_by IS NULL').get(code);
  if (!inv) return res.status(403).json({ error: '邀请码无效或已被使用' });
  if (db.prepare('SELECT id FROM users WHERE username=?').get(uname)) return res.status(409).json({ error: '用户名已存在' });
  const r = db.prepare('INSERT INTO users(username, password_hash, role, display_name, quota, allowed_pages) VALUES(?,?,?,?,?,?)')
    .run(uname, auth.hashPassword(password), 'user', String(display_name || '').slice(0, 40), 100, JSON.stringify(auth.DEFAULT_OPEN_PAGES));
  // 一次性使用：注册成功即核销（记录使用者与时间，留档可查）
  db.prepare("UPDATE invite_codes SET used_by=?, used_username=?, used_at=datetime('now','localtime') WHERE id=?")
    .run(Number(r.lastInsertRowid), uname, inv.id);
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});

// ---------- 邀请码（管理员生成 / 列表 / 删除；注册须持未使用的一次性 8 位码） ----------
const INVITE_ABC = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // 去掉易混淆的 0/O/1/I/L
router.get('/invites', requireAdmin, (req, res) => {
  res.json({ invites: db.prepare('SELECT * FROM invite_codes ORDER BY id DESC').all() });
});
router.post('/invites', requireAdmin, (req, res) => {
  const note = String((req.body || {}).note || '').slice(0, 100);
  let lastErr = null;
  for (let t = 0; t < 5; t++) { // 32^8 取值空间，撞码概率极小，重试兜底
    let code = '';
    for (let i = 0; i < 8; i++) code += INVITE_ABC[Math.floor(Math.random() * INVITE_ABC.length)];
    try {
      const r = db.prepare('INSERT INTO invite_codes(code, note, created_by) VALUES(?,?,?)').run(code, note, req.user.username);
      return res.json({ ok: true, id: Number(r.lastInsertRowid), code, note });
    } catch (e) { lastErr = e; }
  }
  res.status(500).json({ error: '生成邀请码失败：' + (lastErr && lastErr.message || '未知错误') });
});
router.delete('/invites/:id', requireAdmin, (req, res) => {
  const info = db.prepare('DELETE FROM invite_codes WHERE id=? AND used_by IS NULL').run(Number(req.params.id));
  if (!info.changes) return res.status(400).json({ error: '已被使用的邀请码不能删除（留档可查）' });
  res.json({ ok: true });
});

// ---------- 用户管理（管理员） ----------
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  next();
}

router.get('/users', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY id').all();
  res.json({ users: rows.map(publicUser) });
});

router.post('/users', requireAdmin, (req, res) => {
  const { username, password, display_name, role, quota, allowed_pages } = req.body || {};
  const uname = String(username || '').trim();
  if (!/^[a-zA-Z0-9_\-.]{2,32}$/.test(uname)) return res.status(400).json({ error: '用户名须为 2-32 位字母数字' });
  if (String(password || '').length < 4) return res.status(400).json({ error: '密码至少 4 位' });
  if (db.prepare('SELECT id FROM users WHERE username=?').get(uname)) return res.status(409).json({ error: '用户名已存在' });
  const q = quota === null || quota === undefined || quota === '' ? -1 : Math.max(-1, Math.floor(Number(quota) || -1));
  const pages = JSON.stringify(Array.isArray(allowed_pages) ? allowed_pages : auth.DEFAULT_OPEN_PAGES);
  const r = db.prepare('INSERT INTO users(username, password_hash, role, display_name, quota, allowed_pages) VALUES(?,?,?,?,?,?)')
    .run(uname, auth.hashPassword(password), role === 'admin' ? 'admin' : 'user', String(display_name || '').slice(0, 40), q, pages);
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});

router.put('/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const { display_name, role, quota, allowed_pages, password, unlock } = req.body || {};
  const sets = [];
  const args = [];
  if (display_name !== undefined) { sets.push('display_name=?'); args.push(String(display_name).slice(0, 40)); }
  if (role !== undefined) { sets.push('role=?'); args.push(role === 'admin' ? 'admin' : 'user'); }
  if (quota !== undefined) { sets.push('quota=?'); args.push(quota === null || quota === '' ? -1 : Math.max(-1, Math.floor(Number(quota) || -1))); }
  if (allowed_pages !== undefined) { sets.push('allowed_pages=?'); args.push(JSON.stringify(Array.isArray(allowed_pages) ? allowed_pages : [])); }
  if (password) { sets.push('password_hash=?'); args.push(auth.hashPassword(String(password))); }
  if (unlock) { sets.push('fail_count=0', 'locked_until=\'\'', 'lock_permanent=0'); }
  if (sets.length) {
    db.prepare(`UPDATE users SET ${sets.join(',')} WHERE id=?`).run(...args, id);
  }
  res.json({ ok: true, user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)) });
});

router.delete('/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: '不能删除自己' });
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  res.json({ ok: true });
});

router.post('/users/:id/unlock', requireAdmin, (req, res) => {
  db.prepare('UPDATE users SET fail_count=0, locked_until=\'\', lock_permanent=0 WHERE id=?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---------- 登录日志 ----------
router.get('/auth/login-logs', requireAdmin, (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
  res.json({ logs: db.prepare('SELECT * FROM login_logs ORDER BY id DESC LIMIT ?').all(limit) });
});

// 全部页面（含显示名），供「用户管理 → 授权页」逐页勾选
router.get('/auth/pages', requireAdmin, (req, res) => {
  res.json({ pages: auth.PAGES.map((key) => ({ key, label: auth.PAGE_LABELS[key] || key })) });
});

// ---------- IP 封禁 ----------
router.get('/ip-bans', requireAdmin, (req, res) => {
  res.json({ bans: ipBan.list() });
});
router.post('/ip-bans', requireAdmin, (req, res) => {
  const { ip, note } = req.body || {};
  try { res.json({ ok: true, ip: ipBan.ban(ip, note, req.user.username) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/ip-bans/:ip', requireAdmin, (req, res) => {
  res.json({ ok: ipBan.unban(req.params.ip) });
});

// ---------- 主题 ----------
router.get('/settings/theme', (req, res) => {
  res.json({ theme: getSetting(db, `theme_${req.user.id}`, 'day') });
});
router.post('/settings/theme', (req, res) => {
  const t = String((req.body || {}).theme || 'day');
  setSetting(db, `theme_${req.user.id}`, t === 'night' ? 'night' : 'day');
  res.json({ ok: true, theme: t === 'night' ? 'night' : 'day' });
});

module.exports = router;
