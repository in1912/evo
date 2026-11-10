// 文生图（Z-image）：提交 Lumina2/AuraFlow 文生图工作流 → 轮询 → 取回静态图。
// 与首尾视频共用本机 8189 后端；支持任务队列、过程可视化、工作流文件下载。
const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { db } = require('../db');
const comfy = require('../services/comfyService');

const router = express.Router();

// ---------- 串行任务队列 ----------
const queue = [];
let pumping = false;

async function runJobSync(jobId, opts) {
  const set = (sql, ...args) => db.prepare(sql).run(...args);
  const startedAt = Date.now();
  set("UPDATE img_jobs SET status='running' WHERE id=?", jobId);
  try {
    // layered=true → Qwen-Image-Layered 广告图（产出 PSD 分层文件）；否则 Z-image 文生图
    const gen = opts.layered ? comfy.generateQilImage : comfy.generateImage;
    const r = await gen(opts, (text, pct) => {
      const p = Math.max(0, Math.min(100, Number(pct) || 0));
      set('UPDATE img_jobs SET progress=?, progress_pct=? WHERE id=?', String(text || '').slice(0, 300), p, jobId);
    }, {
      kind: opts.layered ? 'qil' : 'zimage', jobId,
      // v1.0.14 第14条：工作流在提交成功那一刻就落库（此前只在 done 时写——运行中/失败的任务下载是 '{}'）
      onSubmitted: (pid, base, wf) => set('UPDATE img_jobs SET prompt_id=?, comfy_base=?, workflow=? WHERE id=?', pid, base, wf ? JSON.stringify(wf) : '', jobId),
    });
    set("UPDATE img_jobs SET status='done', image_path=?, psd_path=?, progress='完成', progress_pct=100, workflow=?, duration_ms=? WHERE id=?", r.imagePath, r.psdPath || '', JSON.stringify(r.workflow || {}), Date.now() - startedAt, jobId);
  } catch (e) {
    set("UPDATE img_jobs SET status='failed', error=?, progress_pct=100, duration_ms=? WHERE id=?", String(e.message || '').slice(0, 500), Date.now() - startedAt, jobId);
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
  set("UPDATE img_jobs SET status='running', progress='重启后恢复跟踪…' WHERE id=?", row.id);
  try {
    // 分层（QIL/广告图）任务：从落库工作流读回图层/预览的 filename_prefix，收养后重新取回 + 组装 PSD
    let qil = null;
    try {
      const pp = row.params ? JSON.parse(row.params || '{}') : {};
      if (pp.layered && row.workflow) {
        const wf = JSON.parse(row.workflow);
        const lp = (wf['12'] && wf['12'].inputs && wf['12'].inputs.filename_prefix) || '';
        const pv = (wf['16'] && wf['16'].inputs && wf['16'].inputs.filename_prefix) || '';
        if (lp || pv) qil = { layerPrefix: lp, prevPrefix: pv, width: (wf['6'] && wf['6'].inputs && wf['6'].inputs.width) || 0, height: (wf['6'] && wf['6'].inputs && wf['6'].inputs.height) || 0 };
      }
    } catch { /* 解析失败按普通文生图收养 */ }
    const { out, hist } = await comfy.adoptRun({
      base: row.comfy_base, promptId: row.prompt_id, kind: qil ? 'qil' : 'zimage', jobId: row.id, extract: qil ? 'raw' : 'image', deadlineMin: 30,
      prog: (t, pct) => set('UPDATE img_jobs SET progress=?, progress_pct=COALESCE(?, progress_pct) WHERE id=?', String(t || '').slice(0, 300), Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : null, row.id),
    });
    const wf = (hist && hist[row.prompt_id] && hist[row.prompt_id].prompt) || {};
    let dst, psdPath = '';
    if (qil) {
      const outDir = comfy.outputDir();
      const layerImgs = comfy.extractImages(hist, qil.layerPrefix);
      const prevImgs = comfy.extractImages(hist, qil.prevPrefix);
      const layerFiles = [];
      for (let i = 0; i < layerImgs.length; i++) {
        const f = path.join(outDir, `${row.id}_layer_${i + 1}.png`);
        await comfy.downloadOutput(layerImgs[i], f, row.comfy_base);
        layerFiles.push(f);
      }
      dst = prevImgs.length ? path.join(outDir, `${row.id}.png`) : (layerFiles[0] || '');
      if (prevImgs.length) await comfy.downloadOutput(prevImgs[0], dst, row.comfy_base);
      if (layerFiles.length) {
        psdPath = path.join(outDir, `${row.id}.psd`);
        comfy.assemblePsd({ layers: layerFiles, composite: prevImgs.length ? dst : '', width: qil.width, height: qil.height, outPath: psdPath });
      }
    } else {
      dst = path.join(comfy.outputDir(), `${row.id}.png`);
      await comfy.downloadOutput(out, dst, row.comfy_base);
    }
    set("UPDATE img_jobs SET status='done', image_path=?, psd_path=?, progress='完成', progress_pct=100, workflow=?, duration_ms=? WHERE id=?", dst, psdPath, JSON.stringify(wf), Date.now() - startedAt, row.id);
  } catch (e) {
    set("UPDATE img_jobs SET status='failed', error=?, progress_pct=100, duration_ms=? WHERE id=?", String(e.message || '').slice(0, 500), Date.now() - startedAt, row.id);
  }
}
router.resume = resume;

// ---------- 生成 ----------
router.post('/image/generate', (req, res) => {
  const {
    prompt, negative_prompt, clip_name, clip_type, clip_device, vae_name, unet_name, weight_dtype,
    width, height, batch_size, shift, seed, steps, cfg, sampler_name, scheduler, denoise,
    layered, layers, source, gen_mode, upscale_method, image,
  } = req.body || {};

  if (req.user.quota >= 0) {
    const used = db.prepare('SELECT COUNT(*) c FROM img_jobs WHERE user_id=?').get(req.user.id).c;
    if (used >= req.user.quota) return res.status(403).json({ error: `生成次数已达上限（${req.user.quota} 次）` });
  }
  // v1.0.36 生成模式：t2i=文生图 / hires=重绘放大(img2img) / upscale=纯超分(RealESRGAN，不重绘)
  const genMode = ['hires', 'upscale'].includes(gen_mode) ? gen_mode : 't2i';
  if (genMode !== 'upscale' && !String(prompt || '').trim()) return res.status(400).json({ error: '正向提示词不能为空' });

  // 放大模式：原图落盘（generateRoutes.saveImage 同款 dataURL 解析）
  let srcImagePath = '';
  if (genMode !== 't2i') {
    const b64 = String((image && image.data) || '').replace(/^data:image\/\w+;base64,/, '');
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 64) return res.status(400).json({ error: '放大模式：请先上传原图' });
    const e = (String((image && image.ext) || '').replace('.', '').toLowerCase() || 'png').replace(/[^a-z0-9]/g, '') || 'png';
    srcImagePath = path.join(comfy.UPLOAD_DIR, `zimg_src_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${e}`);
    fs.writeFileSync(srcImagePath, buf);
  }
  const upMethod = ['nearest-exact', 'bicubic', 'bilinear'].includes(upscale_method) ? upscale_method : 'nearest-exact';

  const src = source === 'ad' ? 'ad' : 'zimage'; // 任务来源：广告图/文生图各自只看自己的队列
  const params = { clip_name, clip_type, clip_device, vae_name, unet_name, weight_dtype, width, height, batch_size, shift, seed, steps, cfg, sampler_name, scheduler, denoise, layered: !!layered, layers: Math.max(2, Math.min(8, Math.floor(Number(layers) || 3))), gen_mode: genMode, upscale_method: upMethod };
  const info = db.prepare('INSERT INTO img_jobs(user_id, prompt, negative_prompt, params, status, source) VALUES(?,?,?,?,?,?)')
    .run(req.user.id, String(prompt || '').trim() || (genMode === 'upscale' ? '[纯超分放大]' : ''), String(negative_prompt || ''), JSON.stringify(params), 'pending', src);
  const jobId = Number(info.lastInsertRowid);
  enqueue(jobId, { prompt, negativePrompt: negative_prompt, clipName: clip_name, clipType: clip_type, clipDevice: clip_device, vaeName: vae_name, unetName: unet_name, weightDtype: weight_dtype, width, height, batchSize: batch_size, shift, seed, steps, cfg, samplerName: sampler_name, scheduler, denoise, layered: !!layered, layers: Math.max(2, Math.min(8, Math.floor(Number(layers) || 3))), genMode, srcImagePath, upscaleMethod: upMethod });
  res.json({ ok: true, id: jobId });
});

// 单个任务
router.get('/image/job/:id', (req, res) => {
  const job = db.prepare('SELECT * FROM img_jobs WHERE id=?').get(Number(req.params.id));
  if (!job) return res.status(404).json({ error: '任务不存在' });
  if (req.user.role !== 'admin' && job.user_id !== req.user.id) return res.status(403).json({ error: '无权查看该任务' });
  res.json({ job });
});

// 任务队列（本人最近；管理员全部；?source=zimage|ad 按任务来源过滤，两页互不串台）
// v1.0.38：补 negative_prompt——「再生成」要把提示词一并还原（此前只还原 params 里的采样参数）
router.get('/image/queue', (req, res) => {
  const cols = 'id, user_id, prompt, negative_prompt, image_path, psd_path, params, status, progress, progress_pct, duration_ms, error, created_at';
  const conds = [];
  const args = [];
  if (req.user.role !== 'admin') { conds.push('user_id=?'); args.push(req.user.id); }
  if (req.query.source === 'ad' || req.query.source === 'zimage') { conds.push('source=?'); args.push(req.query.source); }
  const where = conds.length ? ' WHERE ' + conds.join(' AND ') : '';
  const rows = db.prepare(`SELECT ${cols} FROM img_jobs${where} ORDER BY id DESC LIMIT 60`).all(...args);
  res.json({ jobs: rows });
});

// 默认参数（正向/负向提示词 + 模型/采样参数预填）
router.get('/image/defaults', (req, res) => {
  res.json(comfy.zimageDefaults());
});

// 广告图（Qwen-Image-Layered）默认参数（提示词内置 PSD 分层引导）
router.get('/image/qil-defaults', (req, res) => {
  res.json(comfy.qilDefaults());
});

// 输出静态图
router.get('/image/output/:file', (req, res) => {
  const file = path.basename(String(req.params.file));
  const p = path.join(comfy.outputDir(), file);
  if (!fs.existsSync(p)) return res.status(404).json({ error: '文件不存在' });
  res.sendFile(p);
});

// 打开输出目录
router.post('/image/open-output-dir', (req, res) => {
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
router.get('/image/workflow/:id', (req, res) => {
  const job = db.prepare('SELECT * FROM img_jobs WHERE id=?').get(Number(req.params.id));
  if (!job) return res.status(404).json({ error: '任务不存在' });
  if (req.user.role !== 'admin' && job.user_id !== req.user.id) return res.status(403).json({ error: '无权查看' });
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="zimage-workflow-${job.id}.json"`);
  res.send(job.workflow || '{}');
});

// 下载广告图任务的 PSD 分层文件（Photoshop 打开即分层）
router.get('/image/psd/:id', (req, res) => {
  const job = db.prepare('SELECT * FROM img_jobs WHERE id=?').get(Number(req.params.id));
  if (!job) return res.status(404).json({ error: '任务不存在' });
  if (req.user.role !== 'admin' && job.user_id !== req.user.id) return res.status(403).json({ error: '无权查看' });
  if (!job.psd_path || !fs.existsSync(job.psd_path)) return res.status(404).json({ error: 'PSD 文件不存在' });
  res.setHeader('Content-Type', 'image/vnd.adobe.photoshop');
  res.setHeader('Content-Disposition', `attachment; filename="ads-${job.id}.psd"`);
  res.sendFile(job.psd_path);
});

module.exports = router;
