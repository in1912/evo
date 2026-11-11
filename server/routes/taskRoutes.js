// 任务中心（v1.0.11）：页面关掉后后台任务照样在跑——这里统一看三类队列的
// running/pending 任务（实时进度 + 排队位置 + ComfyUI 侧状态），并可「停止」。
//
// 停止的安全语义（8189 是共享 GPU，同一后端上可能还排着别人的任务）：
//   排队中（未提交 ComfyUI）→ 从本模块内存队列移除 + 标记 failed（绝不碰 ComfyUI）；
//   执行中 → 先在 comfyService.activeRuns 里找到本任务的 promptId，GET /queue 确认
//            这个 prompt 确实在排队/执行，才动它：排队 → POST /queue {delete:[id]}，
//            执行 → POST /interrupt（打断的正是当前这个 prompt）。先置 cancelled 标志，
//            轮询循环 2~3s 内自行退出并落 failed，避免空转到超时。
//            找不到登记（刚收尾/已出队）→ 409 如实回报，不盲发 /interrupt。
const express = require('express');
const { db } = require('../db');
const comfy = require('../services/comfyService');
const genRouter = require('./generateRoutes');
const imgRouter = require('./imageRoutes');
const h3Router = require('./h3Routes');

const router = express.Router();

const KINDS = {
  i2v: { table: 'gen_jobs', label: '图生视频', mod: genRouter },
  zimage: { table: 'img_jobs', label: '文生图', mod: imgRouter, where: "AND j.source IN ('zimage','ad')" },
  h3i: { table: 'img_jobs', label: '文生图H3', mod: imgRouter, where: "AND j.source='h3'" }, // v1.0.44 文生图H3 与文生图共表不同 source
  h3: { table: 'h3_jobs', label: 'H3 视频', mod: h3Router },
};

function ownOrAdmin(req, row) {
  return !!(req.user && (req.user.role === 'admin' || req.user.id === row.user_id));
}

// 各后端 /queue 快照（按 base 去重拉一次）：promptId → 'executing' | 'queued'
async function comfyQueueMaps(bases) {
  const out = new Map(); // base → Map(promptId → state)
  await Promise.all([...bases].map(async (base) => {
    try {
      const r = await fetch(base + '/queue', { signal: AbortSignal.timeout(4000) });
      const q = r.ok ? await r.json() : null;
      const m = new Map();
      if (q) {
        for (const e of q.queue_running || []) if (e && e[1]) m.set(e[1], 'executing');
        for (const e of q.queue_pending || []) if (e && e[1]) m.set(e[1], 'queued');
      }
      out.set(base, m);
    } catch { /* 后端不可达：任务侧照常展示，只是没有 comfy 状态 */ }
  }));
  return out;
}

// GET /api/tasks —— running/pending 任务一览（管理员看全部，普通用户只看自己的）
router.get('/tasks', async (req, res) => {
  try {
    const runsByJob = new Map(); // `${kind}:${jobId}` → { run, promptId }
    for (const [promptId, run] of comfy.activeRuns) {
      if (run && run.kind && run.jobId) runsByJob.set(`${run.kind}:${run.jobId}`, { run, promptId });
    }
    const bases = new Set();
    for (const { run } of runsByJob.values()) bases.add(run.base);
    const qmaps = await comfyQueueMaps(bases);

    const tasks = [];
    const mineOnly = !(req.user && req.user.role === 'admin');
    for (const [kind, K] of Object.entries(KINDS)) {
      const sql = `SELECT j.id, j.user_id, j.prompt, j.status, j.progress, j.progress_pct, j.duration_ms, j.created_at, u.username
         FROM ${K.table} j LEFT JOIN users u ON u.id = j.user_id
         WHERE j.status IN ('running','pending') ${K.where || ''} ${mineOnly ? 'AND j.user_id=?' : ''} ORDER BY j.id`;
      const rows = mineOnly ? db.prepare(sql).all(req.user.id) : db.prepare(sql).all();
      const pend = K.mod.queueApi ? K.mod.queueApi.pendingIds() : [];
      for (const row of rows) {
        const hit = runsByJob.get(`${kind}:${row.id}`);
        const run = hit && hit.run;
        const qm = run && qmaps.get(run.base);
        tasks.push({
          kind, kind_label: K.label, id: row.id,
          username: row.username || `#${row.user_id}`,
          prompt: String(row.prompt || '').slice(0, 120),
          status: row.status,
          progress: row.progress || '',
          progress_pct: row.progress_pct || 0,
          duration_ms: row.duration_ms || 0,
          created_at: row.created_at,
          queue_pos: row.status === 'pending' ? pend.indexOf(String(row.id)) : -1,
          comfy: run ? {
            prompt_id: hit.promptId,
            state: qm ? (qm.get(hit.promptId) || 'history/收尾') : '未知',
            base: run.base,
            submitted_at: run.ts,
          } : null,
        });
      }
    }
    tasks.sort((a, b) => (a.status === b.status ? a.id - b.id : a.status === 'running' ? -1 : 1));
    res.json({ tasks, at: Date.now() });
  } catch (e) {
    console.error('[tasks]', e.message);
    res.status(500).json({ error: e.message || '读取任务失败' });
  }
});

// POST /api/tasks/:kind/:id/stop
router.post('/tasks/:kind/:id/stop', async (req, res) => {
  const K = KINDS[req.params.kind];
  if (!K) return res.status(400).json({ error: 'kind 只支持 i2v / zimage / h3i / h3' });
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id 不对' });
  const row = db.prepare(`SELECT * FROM ${K.table} WHERE id=?`).get(id);
  if (!row) return res.status(404).json({ error: '任务不存在' });
  if (!ownOrAdmin(req, row)) return res.status(403).json({ error: '只能停止自己的任务' });
  if (row.status !== 'running' && row.status !== 'pending') {
    return res.status(409).json({ error: `任务已是「${row.status}」，无需停止` });
  }

  // ① 排队中（还没提交 ComfyUI）：直接出队 + 标记失败
  if (row.status === 'pending') {
    const removed = K.mod.queueApi ? K.mod.queueApi.cancel(id) : false;
    db.prepare(`UPDATE ${K.table} SET status='failed', error=?, progress_pct=100 WHERE id=?`)
      .run(removed ? '已停止（排队中移除）' : '已停止（重启后遗留的排队记录）', id);
    return res.json({ ok: true, stopped: true, phase: 'pending' });
  }

  // ② 执行中：找本任务的 promptId 登记
  let run = null, promptId = '';
  for (const [pid, r] of comfy.activeRuns) {
    if (r && r.kind === req.params.kind && String(r.jobId) === String(id)) { run = r; promptId = pid; break; }
  }
  if (!run) return res.status(409).json({ error: '任务当前不在 ComfyUI 执行登记里（可能正在收尾，请稍候刷新）' });

  // 先置取消标志（轮询循环 2~3s 内自行退出并落 failed），再动 ComfyUI 队列
  run.cancelled = true;
  let phase = 'flagged';
  try {
    const qr = await fetch(run.base + '/queue', { signal: AbortSignal.timeout(4000) });
    const q = qr.ok ? await qr.json() : null;
    const pending = !!(q && (q.queue_pending || []).some((e) => e && e[1] === promptId));
    const running = !!(q && (q.queue_running || []).some((e) => e && e[1] === promptId));
    if (pending) {
      // 只从队列里删自己这一条（delete 数组按 promptId 精确匹配，不影响别人）
      await fetch(run.base + '/queue', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delete: [promptId] }), signal: AbortSignal.timeout(4000),
      });
      phase = 'comfy-queued';
    } else if (running) {
      // /interrupt 打断的正是当前执行的 prompt（上一行刚验证过就是本任务的）；
      // 若这毫秒级间隙里它刚好自己跑完，interrupt 会落到下一个任务头上——先再核一次
      const q2 = await fetch(run.base + '/queue', { signal: AbortSignal.timeout(4000) });
      const qq = q2.ok ? await q2.json() : null;
      if (qq && (qq.queue_running || []).some((e) => e && e[1] === promptId)) {
        await fetch(run.base + '/interrupt', { method: 'POST', signal: AbortSignal.timeout(4000) });
        phase = 'executing';
      } else {
        phase = 'just-finished';
      }
    } else {
      phase = 'history/收尾'; // 已不在队列：在等历史/取回，取消标志会让它尽快退出
    }
  } catch (e) {
    // ComfyUI 暂时联系不上：取消标志已置，轮询循环仍会自行退出
    phase = 'flagged（ComfyUI 暂不可达：' + e.message + '）';
  }
  return res.json({ ok: true, stopped: true, phase });
});

// GET /api/tasks/busy —— 生成页提交后的「排队提醒」轻量计数（v1.0.34）。
// 只回数字不回内容、不碰 ComfyUI /queue；口径同 GET /tasks：管理员看全部、
// 普通用户只算自己的（跟任务中心页面所见一致）。running=正在执行（提醒的触发条件）。
router.get('/tasks/busy', (req, res) => {
  const mine = !(req.user && req.user.role === 'admin');
  let running = 0, pending = 0;
  const by_kind = {};
  for (const [kind, { table }] of Object.entries(KINDS)) {
    const where = mine ? 'WHERE status=? AND user_id=?' : 'WHERE status=?';
    const extra = mine ? [req.user.id] : [];
    const r = db.prepare(`SELECT COUNT(*) c FROM ${table} ${where}`).get('running', ...extra).c;
    const p = db.prepare(`SELECT COUNT(*) c FROM ${table} ${where}`).get('pending', ...extra).c;
    running += r; pending += p; by_kind[kind] = r + p;
  }
  res.json({ running, pending, total: running + pending, by_kind });
});

module.exports = router;
