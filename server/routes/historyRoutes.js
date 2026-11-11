// 生成历史：本人历史（/history）与管理员跨用户历史（/user-history，含生成次数统计）。
// 三类任务（首尾视频 gen_jobs / 文生图 img_jobs / 视频生成 h3_jobs）合并成统一列表。
const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, dataDir } = require('../db');

const router = express.Router();

function ownOrAdmin(req, user_id) {
  return req.user.role === 'admin' || user_id === req.user.id;
}

// 统一条目：type = i2v(首尾视频) / zimage(文生图) / h3(视频生成)
function unify(row, type) {
  return {
    id: row.id, type, user_id: row.user_id,
    prompt: row.prompt || '', status: row.status, error: row.error || '',
    created_at: row.created_at, params: row.params || '{}',
    image_path: row.image_path || '', video_path: row.video_path || '',
    file_path: type === 'zimage' ? (row.image_path || '') : (row.video_path || ''),
  };
}

function collect({ userId, limit }) {
  const L = Math.min(Math.max(Number(limit) || 300, 1), 2000);
  const where = userId ? 'WHERE user_id=?' : '';
  const args = userId ? [userId, L] : [L];
  const g = db.prepare(`SELECT id, user_id, prompt, status, error, created_at, params, image_path, video_path FROM gen_jobs ${where} ORDER BY id DESC LIMIT ?`).all(...args).map((r) => unify(r, 'i2v'));
  const im = db.prepare(`SELECT id, user_id, prompt, status, error, created_at, params, image_path, '' AS video_path FROM img_jobs ${where} ORDER BY id DESC LIMIT ?`).all(...args).map((r) => unify(r, 'zimage'));
  const h3 = db.prepare(`SELECT id, user_id, prompt, status, error, created_at, params, image_path, video_path FROM h3_jobs ${where} ORDER BY id DESC LIMIT ?`).all(...args).map((r) => unify(r, 'h3'));
  return [...g, ...im, ...h3].sort((a, b) => b.id - a.id).slice(0, L);
}

// ---------- 本人历史（合并三类） ----------
router.get('/history', (req, res) => {
  res.json({ jobs: collect({ userId: req.user.id }) });
});

// ---------- 删除（本人或管理员；按 type 定位到对应表，并清理落盘文件） ----------
router.delete('/history/:type/:id', (req, res) => {
  const type = String(req.params.type);
  const table = type === 'zimage' ? 'img_jobs' : type === 'h3' ? 'h3_jobs' : 'gen_jobs';
  const id = Number(req.params.id);
  const job = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  if (!ownOrAdmin(req, job.user_id)) return res.status(403).json({ error: '无权删除' });
  // v1.0.13：进行中的任务禁止删除——删行会杀掉轮询协程，算力端却在继续算，
  // 产物会变成无人认领的孤儿（2026-11-06 报障：45% 卡死 + 视频丢失的根因）。先停止再删。
  if (job.status === 'running' || job.status === 'pending') {
    return res.status(409).json({ error: '任务进行中，不能删除——请先在任务中心停止，再删除' });
  }
  const paths = [job.image_path, job.video_path, job.audio_path].filter(Boolean);
  for (const p of paths) {
    if (p.startsWith(dataDir)) { try { fs.unlinkSync(p); } catch { /* 已删 */ } }
  }
  db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
  res.json({ ok: true });
});

// ---------- 管理员：跨用户历史 + 生成次数 ----------
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  next();
}

// 用户生成次数汇总（三类任务合并统计）
router.get('/user-history/summary', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, username, display_name, role, quota FROM users ORDER BY id').all();
  const agg = (table) => (uid) => {
    const r = db.prepare(`SELECT COUNT(*) c, SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) d, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) f FROM ${table} WHERE user_id=?`).get(uid);
    return { c: Number(r.c) || 0, d: Number(r.d) || 0, f: Number(r.f) || 0 };
  };
  const g = agg('gen_jobs'), im = agg('img_jobs'), h3 = agg('h3_jobs');
  const summary = users.map((u) => {
    const a = g(u.id), b = im(u.id), c = h3(u.id);
    return { ...u, used: a.c + b.c + c.c, done: a.d + b.d + c.d, failed: a.f + b.f + c.f };
  }).sort((a, b) => b.used - a.used);
  res.json({ summary });
});

// 全部用户生成历史（可按用户过滤；合并三类）
router.get('/user-history', requireAdmin, (req, res) => {
  const uid = Number(req.query.user_id) || 0;
  const limit = Math.min(Math.max(Number(req.query.limit) || 300, 1), 2000);
  const jobs = collect({ userId: uid || null, limit });
  const names = new Map(db.prepare('SELECT id, username, display_name FROM users').all().map((u) => [u.id, u]));
  for (const j of jobs) {
    const u = names.get(j.user_id);
    // v1.0.47 需求28：username 必须和 /user-history/summary 的 username 一致（登录名），前端按它过滤；
    // 昵称单独给 display_name，表格里优先显示昵称。
    j.username = u ? u.username : '';
    j.display_name = u ? (u.display_name || u.username) : '';
  }
  if (uid) {
    const u = names.get(uid);
    res.json({ jobs, username: u ? u.username : '', display_name: u ? (u.display_name || u.username) : '' });
  } else {
    res.json({ jobs });
  }
});

module.exports = router;
