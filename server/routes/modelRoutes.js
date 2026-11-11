// 模型路径配置 + 在线拉取模型：列出当前模型（默认值）、改路径、扫描本地文件、
// 从线上（HuggingFace hf-mirror / 直链）拉取缺失模型到 ComfyUI/models 对应目录。
const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, setSetting } = require('../db');
const comfy = require('../services/comfyService');

const router = express.Router();

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  next();
}

// ---------- ComfyUI 后端配置（本地 / 内网远端局域网） ----------
router.get('/comfy/config', requireAdmin, (req, res) => {
  const kind = (req.query.kind === 'zimage' || req.query.kind === 'h3') ? req.query.kind : 'i2v';
  res.json({ kind, mode: comfy.getMode(kind), url: comfy.getUrl(kind) });
});
router.put('/comfy/config', requireAdmin, (req, res) => {
  const kind = (req.query.kind === 'zimage' || req.query.kind === 'h3') ? req.query.kind : 'i2v';
  const { mode, url } = req.body || {};
  comfy.setBackend(kind, mode, url);
  res.json({ ok: true, kind, mode: comfy.getMode(kind), url: comfy.getUrl(kind) });
});

// 三个后端（i2v/zimage/h3）一次性读回，供「模型配置」3 个 tab 各显其态
router.get('/comfy/backends', requireAdmin, (req, res) => {
  res.json({
    i2v: { mode: comfy.getMode('i2v'), url: comfy.getUrl('i2v') },
    zimage: { mode: comfy.getMode('zimage'), url: comfy.getUrl('zimage') },
    h3: { mode: comfy.getMode('h3'), url: comfy.getUrl('h3') },
  });
});

// 单个后端连通状态（?kind=i2v|zimage|h3）
router.get('/comfy/status', requireAdmin, async (req, res) => {
  const kind = (req.query.kind === 'zimage' || req.query.kind === 'h3') ? req.query.kind : 'i2v';
  res.json(await comfy.statusFor(kind));
});

// 手动拉起本机 ComfyUI（首次生成也会自动拉起；此接口供「启动本机模型」按钮用）。
// 冷启动加载模型可能较慢，所以后台启动、立即返回，前端轮询 /generate/status 直到在线。
router.post('/comfy/start', requireAdmin, (req, res) => {
  comfy.ensureComfy().then(() => console.log('[comfy] 手动启动完成')).catch((e) => console.warn('[comfy] 启动失败:', e.message));
  res.json({ ok: true, starting: true });
});

// 「按算力端配置」：本机改为算力端（监听 0.0.0.0 供局域网连接），并生成 start-model.bat
router.post('/comfy/compute-node', requireAdmin, (req, res) => {
  try { res.json({ ok: true, ...comfy.configureComputeNode() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// kind → ComfyUI/models 下的落盘目录
const KIND_DIRS = {
  unet: 'unet',
  text_encoder: 'text_encoders',
  vae: 'vae',
  clip_vision: 'clip_vision',
  lora: 'loras',
  interpolation: path.join('interpolation', 'gimm-vfi'),
  diffusion_model: 'diffusion_models',
};
const MODELS_ROOT = path.join(comfy.COMFY_DIR, 'models');

// 递归找 basename（模型可能放在子目录里，返回相对 models 的路径或 null）
function findModel(basename) {
  if (!basename) return null;
  const target = String(basename).split(/[\\/]/).pop();
  const found = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === target) found.push(path.relative(MODELS_ROOT, full).split(path.sep).join('/'));
    }
  })(MODELS_ROOT);
  return found[0] || null;
}

// 当前模型配置（按 grp 分组供「模型配置」3 个 tab 拆分）。
// 存在性校验一律问「实际执行生成的那台 ComfyUI」实际枚举的模型列表（按文件名匹配，含子目录）：
// 远端模式 = 配置的 URL；本地模式 = baseUrl()（统一后端 8189；物理扫盘不可靠——模型经
// extra_model_paths 挂载，不一定在本机 ComfyUI/models 下）。列表拿不到时 present=null，
// 前端显示「未校验」，不再误报「缺失」。
async function remoteFolderList(base, folder) {
  try {
    const r = await fetch(base + '/models/' + encodeURIComponent(folder), { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return null;
    const arr = await r.json();
    return Array.isArray(arr) ? arr : null;
  } catch { return null; }
}
// 加载器节点真实枚举的文件列表（object_info 首个文件名数组输入）。
// ⚠ GGUF 主模型不在 /models/{目录} 列表里（/models/unet 404、diffusion_models 只有 safetensors），
// 由 ComfyUI-GGUF 的 UnetLoaderGGUF 单独枚举 —— WAN2.2/H3 的 .gguf 全靠它。
async function remoteLoaderOptions(base, node) {
  try {
    const r = await fetch(base + '/object_info/' + encodeURIComponent(node), { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return null;
    const j = await r.json();
    const inp = (j[node] && j[node].input && j[node].input.required) || {};
    for (const v of Object.values(inp)) {
      const opt = v && v[0];
      if (Array.isArray(opt) && opt.some((x) => typeof x === 'string' && /\.(safetensors|gguf)$/i.test(x))) return opt;
    }
    return null;
  } catch { return null; }
}
// kind → 远端可枚举的文件列表（多来源合并去重；全部拿不到返回 null=未校验）
const REMOTE_KIND_FOLDER = {
  unet: 'diffusion_models', diffusion_model: 'diffusion_models',
  text_encoder: 'text_encoders', vae: 'vae', clip_vision: 'clip_vision',
  lora: 'loras', interpolation: 'interpolation',
};
async function remoteModelList(base, kind) {
  const jobs = [remoteFolderList(base, REMOTE_KIND_FOLDER[kind] || 'diffusion_models')];
  if (kind === 'unet' || kind === 'diffusion_model') jobs.push(remoteLoaderOptions(base, 'UnetLoaderGGUF'));
  const lists = (await Promise.all(jobs)).filter(Array.isArray);
  if (!lists.length) return null;
  return [...new Set(lists.flat())];
}
router.get('/models', async (req, res) => {
  comfy.seedModels();
  const rows = db.prepare('SELECT * FROM model_configs ORDER BY grp, kind, key').all();
  const backends = {};
  for (const g of ['i2v', 'zimage', 'h3']) backends[g] = { mode: comfy.getMode(g), url: comfy.getUrl(g) };
  // qil（广告图分层）与 h3i（文生图H3）都走 baseUrl('zimage') 统一后端（生成时共用同一 8189）。
  // 不把它们算作独立后端，避免 /models 遍历到 grp='qil'/'h3i' 的行时 backends[g] 为 undefined 而崩
  //（h3i 组 v1.0.44 就进了 model_configs，此前 /api/models 一打就 TypeError 崩进程——v1.0.54 根修）。
  for (const alias of ['qil', 'h3i']) backends[alias] = { mode: comfy.getMode('zimage'), url: comfy.getUrl('zimage') };

  // 存在性一律问「实际执行生成的那台 ComfyUI」：本地模式 = baseUrl()（统一后端 8189），
  // 远端模式 = 配置的 URL。物理扫盘已不可靠（模型经 extra_model_paths 挂载，不在本目录）。
  const baseOf = (g) => comfy.baseUrl((g === 'qil' || g === 'h3i') ? 'zimage' : g).replace(/\/+$/, '');
  const listCache = new Map(); // 'base|kind' → string[] | null
  const wanted = new Set();
  for (const r of rows) wanted.add(baseOf(r.grp || 'i2v') + '|' + r.kind);
  await Promise.all([...wanted].map(async (k) => {
    const [base, kind] = k.split('|');
    listCache.set(k, await remoteModelList(base, kind));
  }));

  const out = rows.map((r) => {
    const g = r.grp || 'i2v';
    const base = baseOf(g);
    const folder = REMOTE_KIND_FOLDER[r.kind] || 'diffusion_models';
    const list = listCache.get(base + '|' + r.kind);
    const name = String(r.path || '').split(/[\\/]/).pop();
    // 按文件名匹配（列表项可能带子目录/反斜杠）；.cache 里的 HF 残留不算数
    const hit = list
      ? (list.find((p) => String(p).split(/[\\/]/).pop() === name && !p.includes('.cache'))
        || list.find((p) => String(p).split(/[\\/]/).pop() === name) || null)
      : null;
    const row = { ...r, present: list ? !!hit : null, found_path: hit || '', folder };
    // 拉取来源：该行 remote_url（管理员改过）> 内置注册表 > 空（弹窗提示手填）
    row.remote_url = effectiveSource(r);
    row.builtin_url = !!MODEL_SOURCES[name];
    if (backends[g].mode === 'remote') row.remote = { url: base, folder, checked: list != null };
    return row;
  });
  res.json({
    models: out,
    groups: ['i2v', 'zimage', 'h3'],
    backends,
    models_root: MODELS_ROOT,
    output_dir: comfy.outputDir(),
  });
});

// 输出目录（生成视频保存位置；留空回退默认 data/output）
router.get('/models/output-dir', requireAdmin, (req, res) => {
  res.json({ dir: comfy.outputDir() });
});
router.put('/models/output-dir', requireAdmin, (req, res) => {
  const dir = String((req.body || {}).dir || '').trim();
  setSetting('output_dir', dir);
  res.json({ ok: true, dir: comfy.outputDir() });
});

// 修改单个模型路径/名称/开关/拉取地址
router.put('/models/:key', requireAdmin, (req, res) => {
  const key = String(req.params.key);
  const row = db.prepare('SELECT * FROM model_configs WHERE key=?').get(key);
  if (!row) return res.status(404).json({ error: '模型不存在' });
  const { name, path: p, enabled, remote_url } = req.body || {};
  const ru = remote_url !== undefined ? String(remote_url || '').trim() : row.remote_url;
  if (ru && !/^(https?:\/\/.+|hf:.+)$/i.test(ru)) return res.status(400).json({ error: '拉取地址须以 http://、https:// 或 hf: 开头' });
  db.prepare('UPDATE model_configs SET name=?, path=?, enabled=?, remote_url=? WHERE key=?')
    .run(name !== undefined ? String(name) : row.name,
      p !== undefined ? String(p) : row.path,
      enabled !== undefined ? (enabled ? 1 : 0) : row.enabled,
      ru,
      key);
  res.json({ ok: true, model: db.prepare('SELECT * FROM model_configs WHERE key=?').get(key) });
});

// 扫描 ComfyUI/models 现有模型文件（供下拉选择），按类别目录归类
router.get('/models/available', requireAdmin, (req, res) => {
  const map = { unet: ['unet', 'diffusion_models'], text_encoder: ['text_encoders'], vae: ['vae'], clip_vision: ['clip_vision'], lora: ['loras'], interpolation: ['interpolation'], diffusion_model: ['diffusion_models'] };
  const out = {};
  try {
    for (const [kind, dirs] of Object.entries(map)) {
      const files = [];
      for (const d of dirs) {
        const full = path.join(MODELS_ROOT, d);
        if (!fs.existsSync(full)) continue;
        walk(full, (f) => files.push(path.relative(MODELS_ROOT, f).split(path.sep).join('/')));
      }
      out[kind] = files.sort();
    }
  } catch { /* 扫描失败返回空 */ }
  res.json({ available: out });
});

function walk(dir, cb) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, cb);
    else if (/\.(safetensors|gguf|pt|pth|ckpt|bin|onnx)$/i.test(e.name)) cb(full);
  }
}

// ---------- 文件/文件夹浏览器（选模型文件；导航目录） ----------
router.get('/models/browse', requireAdmin, (req, res) => {
  const dir = String(req.query.dir || '').trim();
  let abs = dir ? path.resolve(dir) : MODELS_ROOT;
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) abs = MODELS_ROOT;
  } catch { abs = MODELS_ROOT; }
  const canUp = abs !== path.parse(abs).root;
  let dirs = [], files = [];
  try {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(abs, e.name);
      let isDir = e.isDirectory();
      if (!isDir) { try { isDir = fs.statSync(full).isDirectory(); } catch {} }
      if (isDir) dirs.push({ name: e.name, path: full });
      else if (/\.(safetensors|gguf|pt|pth|ckpt|bin|onnx)$/i.test(e.name)) files.push({ name: e.name, path: full });
    }
  } catch (e) { return res.status(500).json({ error: '读取目录失败：' + e.message }); }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  // 相对 models/ 的路径（models 之外则返回绝对路径），用于存进 model_configs.path
  const rel = (p) => {
    const r = path.relative(MODELS_ROOT, p);
    return (r.startsWith('..') || path.isAbsolute(r)) ? p.split(path.sep).join('/') : r.split(path.sep).join('/');
  };
  res.json({
    dir: abs, root: MODELS_ROOT, parent: canUp ? path.dirname(abs) : null, canUp,
    dirs, files: files.map((f) => ({ ...f, rel: rel(f.path) })),
  });
});

// 新增模型配置（未来新增模型的入口）
router.post('/models', requireAdmin, (req, res) => {
  const { name, path: p, kind, grp } = req.body || {};
  const nm = String(name || '').trim();
  if (!nm) return res.status(400).json({ error: '请填写模型名称' });
  const kd = String(kind || 'unet');
  if (!KIND_DIRS[kd]) return res.status(400).json({ error: '未知类别' });
  const g = (grp === 'zimage' || grp === 'h3') ? grp : 'i2v';
  const base = nm.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'custom';
  let key = base, i = 1;
  while (db.prepare('SELECT 1 FROM model_configs WHERE key=?').get(key)) key = `${base}_${++i}`;
  db.prepare('INSERT INTO model_configs(key,name,path,kind,enabled,grp) VALUES(?,?,?,?,1,?)').run(key, nm, String(p || ''), kd, g);
  res.json({ ok: true, model: db.prepare('SELECT * FROM model_configs WHERE key=?').get(key) });
});

// 删除模型配置（默认模型会在下次刷新时由 seedModels 重建，自定义模型则永久删除）
router.delete('/models/:key', requireAdmin, (req, res) => {
  const key = String(req.params.key);
  if (!db.prepare('SELECT 1 FROM model_configs WHERE key=?').get(key)) return res.status(404).json({ error: '模型不存在' });
  db.prepare('DELETE FROM model_configs WHERE key=?').run(key);
  res.json({ ok: true });
});

// ---------- 在线拉取模型（v1.0.11：内置远端地址 + 串行队列 + 断点续传 + 可取消） ----------
// source 两种：完整 URL（http/https，huggingface.co 自动改写为 hf-mirror）；或 `hf:<repo_id>/<path>`
function resolveUrl(source) {
  const s = String(source || '').trim();
  if (!s) throw new Error('请填写模型来源（完整 URL，或 hf:仓库名/文件路径）');
  if (/^https?:\/\//i.test(s)) {
    return s.replace(/^https?:\/\/huggingface\.co\//i, process.env.HF_ENDPOINT || 'https://hf-mirror.com/');
  }
  if (s.startsWith('hf:')) {
    const rest = s.slice(3).replace(/^\//, '');
    const base = (process.env.HF_ENDPOINT || 'https://hf-mirror.com').replace(/\/+$/, '');
    return `${base}/${rest}/resolve/main`;
  }
  throw new Error('来源格式：完整 URL，或 hf:仓库名/文件路径');
}

// 内置远端地址注册表：文件名 → hf: 来源（2026-11-06 逐条在 hf-mirror 上 HEAD 验证过 200）。
// 只有验证过的才进这张表；NSFW-22-H-e8.safetensors 是 civitai 独占（需登录），不内置，
// 弹窗里可手填直链。管理员在 PUT /models/:key 改过的 remote_url 优先于本表。
const MODEL_SOURCES = {
  'wan2.2_i2v_A14b_high_noise_lightx2v_4step_1030-Q4_K_M.gguf': 'hf:jayn7/WAN2.2-I2V_A14B-DISTILL-LIGHTX2V-4STEP-GGUF/high_noise_1030/wan2.2_i2v_A14b_high_noise_lightx2v_4step_1030-Q4_K_M.gguf',
  'wan2.2_i2v_A14b_low_noise_lightx2v_4step-Q4_K_M.gguf': 'hf:jayn7/WAN2.2-I2V_A14B-DISTILL-LIGHTX2V-4STEP-GGUF/low_noise/wan2.2_i2v_A14b_low_noise_lightx2v_4step-Q4_K_M.gguf',
  'umt5_xxl_fp8_e4m3fn_scaled.safetensors': 'hf:Comfy-Org/Wan_2.2_ComfyUI_repackaged/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors',
  'Wan2.1_VAE.safetensors': 'hf:Comfy-Org/Wan_2.1_ComfyUI_repackaged/split_files/vae/wan_2.1_vae.safetensors',
  'clip_vision_h.safetensors': 'hf:Comfy-Org/Wan_2.1_ComfyUI_repackaged/split_files/clip_vision/clip_vision_h.safetensors',
  'lightx2v_I2V_14B_480p_cfg_step_distill_rank128_bf16.safetensors': 'hf:RunningHubAI/rh-lightx2v-i2v-14b-480p-cfg-step-distill-rank128-lora/lightx2v_I2V_14B_480p_cfg_step_distill_rank128_bf16.safetensors',
  'gimmvfi_r_arb_lpips_fp32.safetensors': 'hf:Kijai/GIMM-VFI_safetensors/gimmvfi_r_arb_lpips_fp32.safetensors',
  'qwen_3_4b.safetensors': 'hf:Comfy-Org/Z-Image-Turbo/split_files/text_encoders/qwen_3_4b.safetensors',
  'ae.safetensors': 'hf:Comfy-Org/Z-Image-Turbo/split_files/vae/ae.safetensors',
  'z_image_turbo_bf16.safetensors': 'hf:Comfy-Org/Z-Image-Turbo/split_files/diffusion_models/z_image_turbo_bf16.safetensors',
  'MiniMax-H3-fl2va-curve-Q4_0.gguf': 'hf:joeygambino/MiniMax-H3-curve-GGUF/fl2va/MiniMax-H3-fl2va-curve-Q4_0.gguf',
  'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors': 'hf:Comfy-Org/MiniMax-H3/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
  'minimax_h3_video_vae_fp16.safetensors': 'hf:Comfy-Org/MiniMax-H3/vae/minimax_h3_video_vae_fp16.safetensors',
  'minimax_h3_t1_image_vae_step1597.safetensors': 'hf:Mamad8/MiniMax-H3-Image-VAE/minimax_h3_t1_image_vae_step1597.safetensors', // 需求31 图像 VAE（2026-11-11 HEAD 200 实证 5207808784B）
  'minimax_h3_audio_vae_fp32.safetensors': 'hf:Comfy-Org/MiniMax-H3/vae/minimax_h3_audio_vae_fp32.safetensors',
};
function effectiveSource(row) {
  const name = String(row && row.path || '').split(/[\\/]/).pop();
  return String((row && row.remote_url) || MODEL_SOURCES[name] || '').trim();
}

// 拉取引擎（内存态）：串行队列，一次只下一个（模型动辄十几 GB，并行只会互相抢带宽）
const pull = { seq: 0, queue: [], current: null, history: [] };
let pullPumping = false;

function pushHistory(item) {
  pull.history.unshift({ ...item, endedAt: Date.now() });
  pull.history = pull.history.slice(0, 10);
}

function pullStatusJson() {
  return {
    running: !!pull.current,
    current: pull.current,
    queue: pull.queue.map((q) => ({ ...q })),
    history: pull.history,
  };
}

async function runPullItem(item) {
  const dir = KIND_DIRS[item.kind] || 'unet';
  const dest = path.join(MODELS_ROOT, dir, item.filename);
  const part = dest + '.part';
  const url = resolveUrl(item.source);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) throw new Error('该文件已存在：' + dest);

  // 断点续传：.part 已有内容 → Range 续传；服务器不理 Range（回 200）→ 从头重下
  let got = 0;
  let headers = {};
  if (fs.existsSync(part)) {
    got = fs.statSync(part).size;
    headers = { Range: `bytes=${got}-` };
    item.log = `续传 ${item.filename}（已有 ${(got / 1073741824).toFixed(2)}GB）`;
  }
  const ac = new AbortController();
  item.ac = ac;
  const timer = setTimeout(() => ac.abort(), 6 * 60 * 60 * 1000); // 单文件上限 6 小时
  timer.unref && timer.unref();
  const r = await fetch(url, { headers, redirect: 'follow', signal: ac.signal });
  if (!r.ok && r.status !== 206) throw new Error(`下载失败 HTTP ${r.status}`);
  if (r.status === 206 && got > 0) {
    item.total = got + (Number(r.headers.get('content-length')) || 0);
  } else {
    got = 0; // 服务器不支持 Range：整段重来
    item.total = Number(r.headers.get('content-length')) || 0;
  }
  const fd = fs.openSync(part, got > 0 ? 'a' : 'w');
  item.got = got;
  const startedAt = Date.now();
  try {
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      fs.writeSync(fd, value);
      item.got += value.length;
      const sec = Math.max(1, (Date.now() - startedAt) / 1000);
      item.speed = Math.round(item.got / sec); // B/s（含续传段，取全程平均）
    }
  } finally {
    fs.closeSync(fd);
  }
  if (item.got < 1024) { try { fs.unlinkSync(part); } catch {} throw new Error('下载内容异常（过小）'); }
  fs.renameSync(part, dest);
  item.log = `完成：${dest}`;
}

function pumpPull() {
  if (pullPumping) return;
  pullPumping = true;
  (async () => {
    while (pull.queue.length) {
      const item = pull.queue.shift();
      item.status = 'downloading';
      pull.current = item;
      try {
        await runPullItem(item);
        item.status = 'done';
        pushHistory(item);
      } catch (e) {
        const aborted = e && (e.name === 'AbortError' || /aborted/i.test(String(e.message || '')));
        item.status = aborted ? 'cancelled' : 'failed';
        item.error = aborted ? '已取消（已下载部分保留，可续传）' : String(e.message || '下载失败');
        pushHistory(item);
      } finally {
        pull.current = null;
      }
    }
    pullPumping = false;
  })();
}

router.get('/models/pull/status', (req, res) => {
  res.json(pullStatusJson());
});

// 入队（管理员）。source 不给 → 用内置注册表/该行 remote_url；都没有 → 明确报错
router.post('/models/pull', requireAdmin, (req, res) => {
  const { filename, source, kind } = req.body || {};
  const name = path.basename(String(filename || ''));
  if (!name) return res.status(400).json({ error: '请填写目标文件名' });
  const row = db.prepare('SELECT * FROM model_configs WHERE path LIKE ?').get('%' + name)
    || db.prepare('SELECT * FROM model_configs WHERE key=?').get(String((req.body || {}).key || ''));
  const src = String(source || '').trim() || (row ? effectiveSource(row) : '') || MODEL_SOURCES[name] || '';
  if (!src) return res.status(400).json({ error: '该模型没有内置下载地址（如 NSFW LoRA 在 civitai 需登录），请在弹窗里填写完整 URL 或 hf: 来源' });
  if (pull.current && pull.current.filename === name) return res.status(409).json({ error: '该文件正在下载' });
  if (pull.queue.some((q) => q.filename === name)) return res.status(409).json({ error: '该文件已在下载队列' });
  const dir = KIND_DIRS[kind] || (row ? KIND_DIRS[row.kind] : '') || 'unet';
  if (fs.existsSync(path.join(MODELS_ROOT, dir, name))) return res.status(400).json({ error: '该文件已存在：' + name });
  const item = { id: ++pull.seq, filename: name, kind: dir, source: src, status: 'waiting', got: 0, total: 0, speed: 0, log: '', error: '' };
  pull.queue.push(item);
  pumpPull();
  res.json({ ok: true, item: { ...item } });
});

// 取消当前下载（保留 .part 供续传）
router.post('/models/pull/cancel', requireAdmin, (req, res) => {
  if (pull.current && pull.current.ac) {
    try { pull.current.ac.abort(); } catch {}
    return res.json({ ok: true, cancelled: pull.current.filename });
  }
  res.status(409).json({ error: '当前没有正在进行的下载' });
});

// 移除排队中的任务
router.delete('/models/pull/:id', requireAdmin, (req, res) => {
  const i = pull.queue.findIndex((q) => String(q.id) === String(req.params.id));
  if (i < 0) return res.status(404).json({ error: '队列里没有这个任务（可能已在下载）' });
  const [rm] = pull.queue.splice(i, 1);
  res.json({ ok: true, removed: rm.filename });
});

module.exports = router;
