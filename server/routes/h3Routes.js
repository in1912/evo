// MiniMax-H3 视频生成（图生视频 / 文生视频）：提交 H3 多镜采样工作流 → 轮询 → 取回视频。
// H3 跑在独立 8188 后端（或局域网地址），支持任务队列、过程可视化、工作流文件下载。
const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { db } = require('../db');
const comfy = require('../services/comfyService');

const router = express.Router();

function saveImage(data, ext) {
  const b64 = String(data || '').replace(/^data:image\/\w+;base64,/, '');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 64) throw new Error('图像数据为空或无效');
  const e = (String(ext || '').replace('.', '').toLowerCase() || 'png').replace(/[^a-z0-9]/g, '');
  const name = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${e || 'png'}`;
  const p = path.join(comfy.UPLOAD_DIR, name);
  fs.writeFileSync(p, buf);
  return p;
}

// ---------- 串行任务队列 ----------
const queue = [];
let pumping = false;

async function runJobSync(jobId, opts) {
  const set = (sql, ...args) => db.prepare(sql).run(...args);
  const startedAt = Date.now();
  set("UPDATE h3_jobs SET status='running' WHERE id=?", jobId);
  try {
    const r = await comfy.generateH3Video(opts, (text, pct) => {
      const p = Math.max(0, Math.min(100, Number(pct) || 0));
      set('UPDATE h3_jobs SET progress=?, progress_pct=? WHERE id=?', String(text || '').slice(0, 300), p, jobId);
    }, {
      kind: 'h3', jobId,
      // v1.0.14 第14条：工作流在提交成功那一刻就落库（此前只在 done 时写——运行中/失败的任务下载是 '{}'）
      onSubmitted: (pid, base, wf) => set('UPDATE h3_jobs SET prompt_id=?, comfy_base=?, workflow=? WHERE id=?', pid, base, wf ? JSON.stringify(wf) : '', jobId),
    });
    set("UPDATE h3_jobs SET status='done', video_path=?, progress='完成', progress_pct=100, workflow=?, duration_ms=? WHERE id=?", r.videoPath, JSON.stringify(r.workflow || {}), Date.now() - startedAt, jobId);
  } catch (e) {
    set("UPDATE h3_jobs SET status='failed', error=?, progress_pct=100, duration_ms=? WHERE id=?", String(e.message || '').slice(0, 500), Date.now() - startedAt, jobId);
  }
}

function pump() {
  if (pumping) return;
  pumping = true;
  (async () => {
    while (queue.length) {
      const job = queue.shift();
      await runJobSync(job.jobId, job.opts);
    }
    pumping = false;
  })();
}

function enqueue(jobId, opts) { queue.push({ jobId, opts }); pump(); }

// 任务中心用：排队任务的查询/移除（「停止」排队任务 = 直接出队，模块外标记失败）
const queueApi = {
  pendingIds: () => queue.map((j) => String(j.jobId)),
  cancel(jobId) {
    const i = queue.findIndex((j) => String(j.jobId) === String(jobId));
    if (i < 0) return false;
    queue.splice(i, 1);
    return true;
  },
};
router.queueApi = queueApi;

// v1.0.13 重启收养：应用重启时凭 prompt_id + comfy_base 恢复跟踪，完成后取回产物落库
async function resume(row) {
  const set = (sql, ...a) => db.prepare(sql).run(...a);
  const startedAt = Date.parse(String(row.created_at || '').replace(' ', 'T')) || Date.now();
  set("UPDATE h3_jobs SET status='running', progress='重启后恢复跟踪…' WHERE id=?", row.id);
  try {
    const { out, hist } = await comfy.adoptRun({
      base: row.comfy_base, promptId: row.prompt_id, kind: 'h3', jobId: row.id, extract: 'raw', deadlineMin: 130,
      prog: (t, pct) => set('UPDATE h3_jobs SET progress=?, progress_pct=COALESCE(?, progress_pct) WHERE id=?', String(t || '').slice(0, 300), Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : null, row.id),
    });
    const dst = path.join(comfy.outputDir(), `${row.id}.mp4`);
    await comfy.downloadOutput(out, dst, row.comfy_base);
    const wf = (hist && hist[row.prompt_id] && hist[row.prompt_id].prompt) || {};
    set("UPDATE h3_jobs SET status='done', video_path=?, progress='完成', progress_pct=100, workflow=?, duration_ms=? WHERE id=?", dst, JSON.stringify(wf), Date.now() - startedAt, row.id);
  } catch (e) {
    set("UPDATE h3_jobs SET status='failed', error=?, progress_pct=100, duration_ms=? WHERE id=?", String(e.message || '').slice(0, 500), Date.now() - startedAt, row.id);
  }
}
router.resume = resume;

// ---------- 生成 ----------
router.post('/h3/generate', (req, res) => {
  const {
    image, image_ext, end_image, end_image_ext, ref_images, voice_audio, voice_audio_ext, mute_audio, prompt, model_name, clip_name, clip_type, mmproj_name, video_vae, audio_vae,
    shot_count, width, height, frames_per_shot, seed, steps, seed_per_shot, sampler_name, scheduler,
    self_anchor_voice, output_scale, fps, bit_depth, color_space,
  } = req.body || {};

  if (req.user.quota >= 0) {
    const used = db.prepare('SELECT COUNT(*) c FROM h3_jobs WHERE user_id=?').get(req.user.id).c;
    if (used >= req.user.quota) return res.status(403).json({ error: `生成次数已达上限（${req.user.quota} 次）` });
  }
  if (!String(prompt || '').trim()) return res.status(400).json({ error: '提示词不能为空' });

  let imagePath = '';
  let endImagePath = '';
  let voiceAudioPath = '';
  const refPaths = []; // v1.0.55 人物参考图（≤3 张，ref2va 参考行）
  try {
    if (image) imagePath = saveImage(image, image_ext);
    // v1.0.48 需求29：尾帧（仅在有首帧时生效；两张都在 = 首尾帧模式）
    if (end_image && imagePath) endImagePath = saveImage(end_image, end_image_ext);
    for (const r of (Array.isArray(ref_images) ? ref_images : []).slice(0, 3)) {
      if (r && r.data) refPaths.push(saveImage(r.data, r.ext));
    }
    // v1.0.63 方案A：参考音频（外部 TTS 生成清唱台词 → voice_ref 钉住发音只对口型）
    if (voice_audio) voiceAudioPath = saveImage(voice_audio, voice_audio_ext);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const flf = !!(imagePath && endImagePath);
  // v1.0.55：首尾帧双锚（H3Keyframes）没有参考位，与人物参考图互斥——提前拦成人话报错
  if (flf && refPaths.length) return res.status(400).json({ error: '首尾帧（双锚点）模式不支持人物参考图：请清除尾帧（保留首帧可以）或清空人物参考图' });
  // v1.0.63：H3Keyframes 同样没有音频参考位（voice_ref 只在 H3MultishotSampler 上）
  if (flf && voiceAudioPath) return res.status(400).json({ error: '首尾帧（双锚点）模式不支持参考音频：请清除尾帧（保留首帧可以）或移除参考音频' });

  // v1.0.62 尺寸对齐：H3 引擎要求宽高为 32 的倍数（空间 token 两两配对，854//16=53 奇数直接 reshape 崩）。
  // 落库记实际生效值——队列「尺寸列」与产物一致，不再显示一个跑不了的数。
  const snap32 = (n, dft) => { const v = Math.max(32, Math.floor(Number(n) || dft)); return Math.round(v / 32) * 32; };
  const effW = snap32(width, 480), effH = snap32(height, 832);
  const params = { model_name, clip_name, clip_type, mmproj_name, video_vae, audio_vae, shot_count, width: effW, height: effH, frames_per_shot, seed, steps, seed_per_shot, sampler_name, scheduler, self_anchor_voice, output_scale, fps, bit_depth, color_space, mute_audio: mute_audio ? 1 : undefined, voice_audio: voiceAudioPath ? 1 : undefined, mode: imagePath ? (flf ? 'flf' : 'i2v') : 't2v', end_image_path: endImagePath || undefined, ref_count: refPaths.length || undefined, ref_image_paths: refPaths.length ? refPaths : undefined };
  const info = db.prepare('INSERT INTO h3_jobs(user_id, prompt, image_path, params, status) VALUES(?,?,?,?,?)')
    .run(req.user.id, String(prompt || ''), imagePath, JSON.stringify(params), 'pending');
  const jobId = Number(info.lastInsertRowid);
  enqueue(jobId, { imagePath, endImagePath, refImages: refPaths, voiceAudioPath, muteAudio: !!mute_audio, prompt, modelName: model_name, clipName: clip_name, clipType: clip_type, mmprojName: mmproj_name, videoVae: video_vae, audioVae: audio_vae, shotCount: shot_count, width: effW, height: effH, framesPerShot: frames_per_shot, seed, steps, seedPerShot: seed_per_shot, samplerName: sampler_name, scheduler, selfAnchorVoice: self_anchor_voice, outputScale: output_scale, fps, bitDepth: bit_depth, colorSpace: color_space });
  res.json({ ok: true, id: jobId });
});

// 单个任务
router.get('/h3/job/:id', (req, res) => {
  const job = db.prepare('SELECT * FROM h3_jobs WHERE id=?').get(Number(req.params.id));
  if (!job) return res.status(404).json({ error: '任务不存在' });
  if (req.user.role !== 'admin' && job.user_id !== req.user.id) return res.status(403).json({ error: '无权查看该任务' });
  res.json({ job });
});

// 任务队列
router.get('/h3/queue', (req, res) => {
  const rows = req.user.role === 'admin'
    ? db.prepare('SELECT id, user_id, prompt, image_path, video_path, params, status, progress, progress_pct, duration_ms, error, created_at FROM h3_jobs ORDER BY id DESC LIMIT 60').all()
    : db.prepare('SELECT id, user_id, prompt, image_path, video_path, params, status, progress, progress_pct, duration_ms, error, created_at FROM h3_jobs WHERE user_id=? ORDER BY id DESC LIMIT 60').all(req.user.id);
  res.json({ jobs: rows });
});

// 默认参数（预填示例）
router.get('/h3/defaults', (req, res) => {
  res.json(comfy.h3Defaults());
});

// H3 后端状态
router.get('/h3/status', (req, res) => {
  fetch(comfy.getUrl('h3') + '/system_stats', { signal: AbortSignal.timeout(1500) })
    .then((r) => (r.ok ? r.json() : null))
    .then((h) => res.json({ running: !!h, url: comfy.getUrl('h3'), device: (h && h.devices && h.devices[0] && h.devices[0].name) || '' }))
    .catch(() => res.json({ running: false, url: comfy.getUrl('h3') }));
});

// 输出视频
router.get('/h3/output/:file', (req, res) => {
  const file = path.basename(String(req.params.file));
  const p = path.join(comfy.outputDir(), file);
  if (!fs.existsSync(p)) return res.status(404).json({ error: '文件不存在' });
  res.sendFile(p);
});

// 打开输出目录
router.post('/h3/open-output-dir', (req, res) => {
  const dir = comfy.outputDir();
  try {
    const cmd = process.platform === 'win32' ? 'explorer.exe' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
    const child = spawn(cmd, [dir], { detached: true, stdio: 'ignore' });
    child.unref();
    res.json({ ok: true, dir });
  } catch (e) {
    res.status(500).json({ error: '打开目录失败：' + e.message });
  }
});

// 下载该任务的工作流文件（ComfyUI 标准 API 格式）
router.get('/h3/workflow/:id', (req, res) => {
  const job = db.prepare('SELECT * FROM h3_jobs WHERE id=?').get(Number(req.params.id));
  if (!job) return res.status(404).json({ error: '任务不存在' });
  if (req.user.role !== 'admin' && job.user_id !== req.user.id) return res.status(403).json({ error: '无权查看' });
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="h3-workflow-${job.id}.json"`);
  res.send(job.workflow || '{}');
});

module.exports = router;
