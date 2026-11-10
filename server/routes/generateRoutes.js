// 视频生成：上传图像 → 提交 ComfyUI 工作流（串行队列 + 实时过程可视化）→ 轮询任务状态。
// 支持单图 I2V 与首尾帧 I2V、sage-attn 开关、高清修复、视频放大倍数、Lora_1..4、Qwen3-VL 提示词。
const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { db } = require('../db');
const comfy = require('../services/comfyService');

const router = express.Router();

const APP_ROOT = path.join(__dirname, '..', '..');
const QWEN_SCRIPT = path.join(__dirname, '..', 'services', 'qwen3vl_prompt.py');
const QWEN_DIR = path.join(APP_ROOT, 'qwen3-vl-2b');

// 解析 base64 图像（支持 dataURL 前缀）→ 落盘
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

// ---------- 串行任务队列（单 GPU，避免并行提交把显存打爆） ----------
const queue = [];
let pumping = false;

async function runJobSync(jobId, opts) {
  const set = (sql, ...args) => db.prepare(sql).run(...args);
  const startedAt = Date.now();
  set("UPDATE gen_jobs SET status='running' WHERE id=?", jobId);
  try {
    const r = await comfy.generate(opts, (text, pct) => {
      const p = Math.max(0, Math.min(100, Number(pct) || 0));
      set('UPDATE gen_jobs SET progress=?, progress_pct=? WHERE id=?', String(text || '').slice(0, 300), p, jobId);
    }, {
      kind: 'i2v', jobId,
      // v1.0.14 第14条：工作流随提交落库（gen_jobs 原先没有 workflow 列，队列里也下不了）
      onSubmitted: (pid, base, wf) => set('UPDATE gen_jobs SET prompt_id=?, comfy_base=?, workflow=? WHERE id=?', pid, base, wf ? JSON.stringify(wf) : '', jobId),
    });
    set("UPDATE gen_jobs SET status='done', video_path=?, audio_path=?, progress='完成', progress_pct=100, duration_ms=? WHERE id=?", r.videoPath, r.audioPath || '', Date.now() - startedAt, jobId);
  } catch (e) {
    set("UPDATE gen_jobs SET status='failed', error=?, progress_pct=100, duration_ms=? WHERE id=?", String(e.message || '').slice(0, 500), Date.now() - startedAt, jobId);
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

function enqueue(jobId, opts) {
  queue.push({ jobId, opts });
  pump();
}

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
// （收养只取回算力端已出的主视频；配音/高清修复不在收养路径重做）
async function resume(row) {
  const set = (sql, ...a) => db.prepare(sql).run(...a);
  const startedAt = Date.parse(String(row.created_at || '').replace(' ', 'T')) || Date.now();
  set("UPDATE gen_jobs SET status='running', progress='重启后恢复跟踪…' WHERE id=?", row.id);
  try {
    const { out } = await comfy.adoptRun({
      base: row.comfy_base, promptId: row.prompt_id, kind: 'i2v', jobId: row.id, deadlineMin: 60,
      prog: (t, pct) => set('UPDATE gen_jobs SET progress=?, progress_pct=COALESCE(?, progress_pct) WHERE id=?', String(t || '').slice(0, 300), Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : null, row.id),
    });
    const dst = path.join(comfy.outputDir(), `${row.id}.mp4`);
    await comfy.downloadOutput(out, dst, row.comfy_base);
    set("UPDATE gen_jobs SET status='done', video_path=?, audio_path='', progress='完成', progress_pct=100, duration_ms=? WHERE id=?", dst, Date.now() - startedAt, row.id);
  } catch (e) {
    set("UPDATE gen_jobs SET status='failed', error=?, progress_pct=100, duration_ms=? WHERE id=?", String(e.message || '').slice(0, 500), Date.now() - startedAt, row.id);
  }
}
router.resume = resume;

// ---------- 生成 ----------
router.post('/generate', (req, res) => {
  const {
    image, image_ext, end_image, end_image_ext, prompt, negative_prompt, seed,
    length, width, height, fps, steps, interpolation, dub, mode, sage_attention, high_res, high_res_scale, loras,
  } = req.body || {};

  // 额度检查（-1 = 不限）
  if (req.user.quota >= 0) {
    const used = db.prepare('SELECT COUNT(*) c FROM gen_jobs WHERE user_id=?').get(req.user.id).c;
    if (used >= req.user.quota) return res.status(403).json({ error: `生成次数已达上限（${req.user.quota} 次）` });
  }
  if (!image && !(req.body && req.body.image_path)) return res.status(400).json({ error: '请上传图像' });

  const isFlf = mode === 'flf';
  let imagePath;
  let endImagePath = '';
  try {
    imagePath = image ? saveImage(image, image_ext) : String((req.body || {}).image_path || '');
    if (isFlf) {
      if (!end_image && !(req.body && req.body.end_image_path)) return res.status(400).json({ error: '首尾帧模式需要上传尾帧图像' });
      endImagePath = end_image ? saveImage(end_image, end_image_ext) : String((req.body || {}).end_image_path || '');
    }
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // 规范化 Lora 参数（前端传 {lora_1, strength_1, ...} 或数组）
  const normLoras = [];
  if (Array.isArray(loras)) {
    for (const l of loras) normLoras.push({ name: String((l && l.name) || 'None'), strength: Number(l && l.strength) || 1 });
  } else if (loras && typeof loras === 'object') {
    for (let i = 1; i <= 4; i++) {
      normLoras.push({ name: String(loras['lora_' + i] || 'None'), strength: Number(loras['strength_' + i]) || 1 });
    }
  }

  const params = {
    length: length || 5, width: width || 368, height: height || 704,
    fps: fps || 16, steps: steps || 4, interpolation: interpolation || 2, seed: seed || -1,
    mode: isFlf ? 'flf' : 'single', sage_attention: sage_attention || 'auto',
    high_res: !!high_res, high_res_scale: high_res_scale || 4, loras: normLoras,
  };
  const dubText = (dub && dub.text) ? String(dub.text) : '';
  const info = db.prepare(
    'INSERT INTO gen_jobs(user_id, prompt, negative_prompt, image_path, end_image_path, dub_text, params, status, mode) VALUES(?,?,?,?,?,?,?,?,?)'
  ).run(req.user.id, String(prompt || ''), String(negative_prompt || ''), imagePath, endImagePath, dubText, JSON.stringify(params), 'pending', isFlf ? 'flf' : 'single');
  const jobId = Number(info.lastInsertRowid);
  enqueue(jobId, { imagePath, endImagePath, prompt, negativePrompt: negative_prompt, seed, length, width, height, fps, steps, interpolation, dub, mode, sageAttention: sage_attention, highRes: !!high_res, highResScale: high_res_scale || 4, loras: normLoras });
  res.json({ ok: true, id: jobId });
});

// 单个任务（本人或管理员）
router.get('/generate/job/:id', (req, res) => {
  const job = db.prepare('SELECT * FROM gen_jobs WHERE id=?').get(Number(req.params.id));
  if (!job) return res.status(404).json({ error: '任务不存在' });
  if (req.user.role !== 'admin' && job.user_id !== req.user.id) return res.status(403).json({ error: '无权查看该任务' });
  res.json({ job });
});

// 任务队列（本人最近任务；管理员看全部）—— 生成页实时刷新
// v1.0.38：补 negative_prompt/end_image_path/mode/dub_text——「再生成」要把提示词与首尾帧一并还原
router.get('/generate/queue', (req, res) => {
  const cols = 'id, user_id, prompt, negative_prompt, image_path, end_image_path, video_path, params, status, progress, progress_pct, duration_ms, error, mode, dub_text, created_at';
  const rows = req.user.role === 'admin'
    ? db.prepare(`SELECT ${cols} FROM gen_jobs ORDER BY id DESC LIMIT 60`).all()
    : db.prepare(`SELECT ${cols} FROM gen_jobs WHERE user_id=? ORDER BY id DESC LIMIT 60`).all(req.user.id);
  res.json({ jobs: rows });
});

// ComfyUI 状态
router.get('/generate/status', (req, res) => {
  comfy.status().then((s) => res.json(s)).catch(() => res.json({ running: false }));
});

// 工作流下载（v1.0.14 第14条：gen_jobs 也支持；提交成功即落库，运行中/失败同样可下）
router.get('/generate/workflow/:id', (req, res) => {
  const job = db.prepare('SELECT * FROM gen_jobs WHERE id=?').get(Number(req.params.id));
  if (!job) return res.status(404).json({ error: '任务不存在' });
  if (req.user.role !== 'admin' && job.user_id !== req.user.id) return res.status(403).json({ error: '无权查看' });
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="i2v-workflow-${job.id}.json"`);
  res.send(job.workflow || '{}');
});

// LoRA 列表（Lora_1..4 下拉选择）+ 默认 Lora_1/Lora_2（加速蒸馏 / NSFW）
router.get('/generate/loras', async (req, res) => {
  const models = comfy.modelMap();
  res.json({
    loras: await comfy.listLoras(),
    defaults: {
      lora_1: models.lora_lightx2v || 'None', strength_1: 1,
      lora_2: models.lora_nsfw || 'None', strength_2: 1,
    },
  });
});

// 默认负面提示词
router.get('/generate/negative-default', (req, res) => {
  res.json({ negative: comfy.DEFAULT_NEGATIVE });
});

// Qwen3-VL 引导语 → 提示词（点击生成；纯文本，不传图片）
router.post('/generate/qwen', (req, res) => {
  const guide = String((req.body || {}).text || '').trim();
  if (!guide) return res.status(400).json({ error: '请先输入引导语（主题）' });
  if (!fs.existsSync(QWEN_SCRIPT)) return res.status(500).json({ error: 'Qwen3-VL 脚本缺失' });
  if (!fs.existsSync(path.join(QWEN_DIR, 'config.json'))) return res.status(500).json({ error: 'Qwen3-VL 模型缺失（qwen3-vl-2b/）' });

  const pyRoot = path.join(APP_ROOT, 'py312');
  const env = {
    ...process.env,
    PYTHONHOME: '',
    PYTHONPATH: '',
    PYTHONIOENCODING: 'utf-8',   // 关键：Windows Python 管道默认 GBK，强制 UTF-8 避免提示词乱码
    PATH: `${pyRoot};${path.join(pyRoot, 'Scripts')};${path.join(pyRoot, 'Library', 'bin')};${comfy.FFMPEG_DIR};${process.env.PATH || ''}`,
  };
  const p = spawn(comfy.PYTHON, ['-s', QWEN_SCRIPT, guide, QWEN_DIR], { env });
  const outChunks = [];
  let err = '';
  p.stdout.on('data', (d) => { outChunks.push(d); });
  p.stderr.on('data', (d) => { err += d.toString(); });
  const timer = setTimeout(() => { try { p.kill(); } catch {} }, 5 * 60 * 1000);
  p.on('error', (e) => { clearTimeout(timer); res.status(500).json({ error: 'Qwen3-VL 启动失败：' + e.message }); });
  p.on('exit', (code) => {
    clearTimeout(timer);
    if (code !== 0) return res.status(500).json({ error: 'Qwen3-VL 生成失败：' + (err.slice(-300) || ('exit ' + code)) });
    const prompt = Buffer.concat(outChunks).toString('utf8').trim();
    if (!prompt) return res.status(500).json({ error: 'Qwen3-VL 未产出提示词' });
    res.json({ prompt });
  });
});

// 输出视频文件
router.get('/generate/output/:file', (req, res) => {
  const file = path.basename(String(req.params.file));
  const p = path.join(comfy.outputDir(), file);
  if (!fs.existsSync(p)) return res.status(404).json({ error: '文件不存在' });
  res.sendFile(p);
});

// v1.0.38 再生成：取回存于 uploads 的首帧/尾帧原图（首尾视频与 H3 的 regen 共用；basename 防穿越）
router.get('/generate/upload/:file', (req, res) => {
  const file = path.basename(String(req.params.file));
  const p = path.join(comfy.UPLOAD_DIR, file);
  if (!fs.existsSync(p)) return res.status(404).json({ error: '文件不存在' });
  res.sendFile(p);
});

// 打开输出目录（本机系统文件管理器打开生成视频所在文件夹）
router.post('/generate/open-output-dir', (req, res) => {
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

module.exports = router;
